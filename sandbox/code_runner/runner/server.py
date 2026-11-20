"""SocratiQ code runner: a tiny internal HTTP service that executes untrusted student code in the jail described in executor.py.

    python -m runner.server            (inside the code-runner container; see ../Dockerfile and docs/CODE_RUNNER.md)

Only the SocratiQ backend talks to it, over an internal network, with a shared bearer token. It has NO access to application secrets:
its only secret is that token, read from a root-only file and never placed in a job's environment.

    GET  /healthz                    -> {"ok": true}                                         (no auth: liveness only)
    GET  /v1/info                    -> languages, limits, isolation self-check               (auth)
    POST /v1/execute                 -> run one job synchronously, return its result          (auth)
    POST /v1/jobs/<job_id>/cancel    -> stop a running job                                    (auth)

At start-up the runner executes probe jobs that try to break out (open a network socket, read the token file, stay root). If any probe
succeeds the runner refuses to start, unless RUNNER_ALLOW_INSECURE_DEV=1 (local development only, reported as insecure in /v1/info).
"""
from __future__ import annotations

import hmac
import json
import logging
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from runner.executor import BadRequest, Executor, RunnerBusy, Settings  # noqa: E402

log = logging.getLogger("code-runner")
JOB_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
MAX_BODY = 256 * 1024

PROBE = r"""
import json, os, socket
r = {"uid": os.getuid(), "network_blocked": False, "token_unreadable": True}
try:
    socket.socket(socket.AF_INET, socket.SOCK_STREAM)
except OSError:
    r["network_blocked"] = True
tf = os.environ.get("PROBE_TOKEN_FILE") or ""
if tf:
    try:
        open(tf).read(1); r["token_unreadable"] = False
    except OSError:
        pass
print(json.dumps(r))
"""


def _load_token() -> str:
    path = os.environ.get("RUNNER_TOKEN_FILE")
    token: Optional[str] = None
    if path and Path(path).is_file():
        token = Path(path).read_text(encoding="utf-8").strip()
    if not token:
        token = (os.environ.pop("RUNNER_TOKEN", "") or "").strip()      # development fallback; removed from our own environment
    if len(token) < 32:
        raise SystemExit("code runner: a token of at least 32 characters is required (RUNNER_TOKEN_FILE or RUNNER_TOKEN)")
    return token


def self_check(executor: Executor, token_file: Optional[str]) -> dict:
    """Run a probe job inside the real jail and report what it could do. Every value must be the safe one."""
    src = PROBE.replace('os.environ.get("PROBE_TOKEN_FILE") or ""', repr(token_file or ""))
    res = executor.run("selfcheck" + os.urandom(6).hex(), "python", src)
    try:
        probe = json.loads(res["stdout"].strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        return {"ok": False, "reason": "probe did not run", "probe_status": res["status"], "stderr": res["stderr"][-300:]}
    checks = {"uid_separation": probe["uid"] != 0 and probe["uid"] != os.geteuid(), "network_blocked": probe["network_blocked"],
              "secrets_unreadable": probe["token_unreadable"] if token_file else True}
    return {"ok": all(checks.values()), **checks}


class Handler(BaseHTTPRequestHandler):
    server_version = "socratiq-code-runner"
    sys_version = ""
    timeout = 15                                  # seconds to receive a request: slow clients cannot pin threads

    def log_message(self, fmt, *args):            # never log bodies (student code); just the request line
        log.info("%s %s", self.address_string(), fmt % args)

    # ---------------------------------------------------------------- helpers
    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        scheme, _, token = (self.headers.get("Authorization") or "").partition(" ")
        ok = scheme.lower() == "bearer" and hmac.compare_digest(token.strip().encode(), self.server.token.encode())  # type: ignore[attr-defined]
        if not ok:
            self._send(401, {"error": "unauthorized"})
        return ok

    def _json(self) -> Optional[dict]:
        try:
            n = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            n = -1
        if n <= 0 or n > MAX_BODY:
            self._send(413 if n > MAX_BODY else 400, {"error": "bad body size"})
            return None
        try:
            body = json.loads(self.rfile.read(n))
        except Exception:  # noqa: BLE001
            self._send(400, {"error": "invalid json"})
            return None
        if not isinstance(body, dict):
            self._send(400, {"error": "invalid json"})
            return None
        return body

    # ---------------------------------------------------------------- routes
    def do_GET(self):
        if self.path == "/healthz":
            return self._send(200, {"ok": True})
        if self.path == "/v1/info":
            if not self._authorized():
                return
            ex: Executor = self.server.executor  # type: ignore[attr-defined]
            return self._send(200, {"languages": ex.languages(), "limits": ex.s.limits.public(), "isolation": self.server.isolation})  # type: ignore[attr-defined]
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._authorized():
            return
        ex: Executor = self.server.executor  # type: ignore[attr-defined]
        m = re.fullmatch(r"/v1/jobs/([^/]+)/cancel", self.path)
        if m:
            if not JOB_ID.match(m.group(1)):
                return self._send(400, {"error": "bad job id"})
            return self._send(200, {"cancelled": ex.cancel(m.group(1))})
        if self.path != "/v1/execute":
            return self._send(404, {"error": "not found"})
        body = self._json()
        if body is None:
            return
        job_id, language, source, stdin = body.get("job_id"), body.get("language"), body.get("source"), body.get("stdin", "")
        if not isinstance(job_id, str) or not JOB_ID.match(job_id) or not isinstance(language, str) or not isinstance(source, str) or not isinstance(stdin, str):
            return self._send(400, {"error": "invalid request"})
        lim = body.get("limits") or {}
        if not isinstance(lim, dict):
            return self._send(400, {"error": "invalid request"})

        def num(k):
            v = lim.get(k)
            return v if isinstance(v, int) and not isinstance(v, bool) and v > 0 else None
        try:
            res = ex.run(job_id, language, source, stdin, timeout_ms=num("timeout_ms"), memory_mb=num("memory_mb"), output_bytes=num("output_bytes"))
        except BadRequest as e:
            return self._send(400, {"error": str(e)})
        except RunnerBusy:
            return self._send(429, {"error": "busy"})
        except Exception:  # noqa: BLE001
            log.exception("job failed")
            return self._send(500, {"error": "internal error"})
        self._send(200, res)


def build_server(host: str, port: int, settings: Settings, token: str, token_file: Optional[str]) -> ThreadingHTTPServer:
    executor = Executor(settings)
    isolation = self_check(executor, token_file)
    if not isolation["ok"]:
        if not settings.allow_unprivileged:
            raise SystemExit(f"code runner: isolation self-check failed, refusing to start: {isolation}")
        log.warning("INSECURE DEVELOPMENT MODE: isolation self-check failed: %s", isolation)
    isolation["insecure_dev_mode"] = settings.allow_unprivileged
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    srv.executor, srv.token, srv.isolation = executor, token, isolation  # type: ignore[attr-defined]
    return srv


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    token = _load_token()
    srv = build_server(os.environ.get("RUNNER_HOST", "0.0.0.0"), int(os.environ.get("RUNNER_PORT", "8080")), Settings.from_env(), token,
                       os.environ.get("RUNNER_TOKEN_FILE"))
    log.info("code runner listening on %s:%s isolation=%s", *srv.server_address[:2], srv.isolation)  # type: ignore[attr-defined]
    try:
        srv.serve_forever()
    finally:
        srv.server_close()


if __name__ == "__main__":
    threading.current_thread().name = "main"
    main()
