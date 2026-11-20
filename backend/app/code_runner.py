"""Client for the isolated code-runner service, plus the per-student bookkeeping the execution API needs.

Student code is NEVER executed in this process (no exec/eval/subprocess here). It is forwarded to the runner service (sandbox/code_runner),
which runs it as a separate unprivileged uid under rlimits and a seccomp filter, in a container with no application secrets and no
network egress. This module only:
  * decides whether the feature is available (configured AND the runner's own isolation self-check passed),
  * sends server-chosen limits (never the browser's) and an unguessable job id the browser never sees,
  * tracks which runs belong to which student so a run can be cancelled only by its owner.
"""
from __future__ import annotations

import logging
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Any, Optional, Protocol

from .config import BackendConfig
from .errors import AppError

log = logging.getLogger("socratiq.code_runner")

# Language ids the UI may send, mapped to the runner's language id. Only languages the runner reports are offered.
ALIASES: dict[str, str] = {"python": "python", "py": "python", "python3": "python"}

RESULT_KEYS = ("status", "exit_code", "signal", "stdout", "stderr", "stdout_truncated", "stderr_truncated", "duration_ms")
STATUSES = {"completed", "failed", "timeout", "memory_limit", "output_limit", "cancelled", "sandbox_error"}


class CodeRunner(Protocol):
    def info(self) -> dict: ...
    def execute(self, job_id: str, language: str, source: str, stdin: str, limits: dict) -> dict: ...
    def cancel(self, job_id: str) -> bool: ...


def unavailable(message: str = "Running code is unavailable right now. Please try again later.") -> AppError:
    return AppError(503, message, code="code_runner_unavailable")


class HttpCodeRunner:
    """Talks to the runner service over its internal network. Errors never expose the runner's address or responses."""

    def __init__(self, url: str, token: str, request_timeout_s: float):
        import httpx
        self._client = httpx.Client(base_url=url, headers={"Authorization": f"Bearer {token}"}, timeout=httpx.Timeout(request_timeout_s, connect=3.0),
                                    follow_redirects=False, trust_env=False)       # never send the token through an environment proxy

    def _post(self, path: str, body: dict) -> dict:
        import httpx
        try:
            r = self._client.post(path, json=body)
        except httpx.HTTPError:
            log.warning("code runner unreachable (%s)", path)
            raise unavailable() from None
        if r.status_code == 429:
            raise AppError(429, "Many students are running code right now. Please try again in a moment.", code="runner_busy")
        if r.status_code != 200:
            log.warning("code runner answered %s on %s", r.status_code, path)
            raise unavailable()
        return r.json()

    def info(self) -> dict:
        import httpx
        try:
            r = self._client.get("/v1/info")
        except httpx.HTTPError:
            raise unavailable() from None
        if r.status_code != 200:
            raise unavailable()
        return r.json()

    def execute(self, job_id: str, language: str, source: str, stdin: str, limits: dict) -> dict:
        return self._post("/v1/execute", {"job_id": job_id, "language": language, "source": source, "stdin": stdin, "limits": limits})

    def cancel(self, job_id: str) -> bool:
        try:
            return bool(self._post(f"/v1/jobs/{job_id}/cancel", {}).get("cancelled"))
        except AppError:
            return False


@dataclass
class _Run:
    user_id: str
    run_id: str
    job_id: str
    started: float
    cancelled: bool = False


class CodeService:
    """Availability check, server-side limits and run ownership. One per app (state is per process, like the rate limiter)."""

    INFO_TTL_S = 60.0

    def __init__(self, runner: Optional[CodeRunner], cfg: BackendConfig, max_active_per_user: int = 1):
        self.runner, self.cfg, self.max_active = runner, cfg, max_active_per_user
        self._runs: dict[tuple[str, str], _Run] = {}
        self._lock = threading.Lock()
        self._info: Optional[dict] = None
        self._info_at = 0.0

    # ------------------------------------------------------------------ availability
    def limits(self) -> dict:
        return {"timeout_ms": self.cfg.code_runner_timeout_ms, "memory_mb": self.cfg.code_runner_memory_mb, "output_bytes": self.cfg.code_runner_output_bytes}

    def _runner_info(self) -> Optional[dict]:
        if self.runner is None:
            return None
        now = time.monotonic()
        if self._info is not None and now - self._info_at < self.INFO_TTL_S:
            return self._info
        try:
            info = self.runner.info()
        except AppError:
            info = None
        self._info, self._info_at = info, now
        return info

    def runtime(self) -> dict:
        """What the UI may offer. Fails closed: no runner, unreachable runner, or a runner whose isolation self-check failed => disabled."""
        info = self._runner_info()
        iso = (info or {}).get("isolation") or {}
        if self.cfg.is_production:
            secure = bool(iso.get("ok")) and not iso.get("insecure_dev_mode")
        else:   # development may opt in to a runner without uid separation; seccomp + rlimits still apply there
            secure = bool(iso.get("ok")) or (self.cfg.code_runner_allow_insecure and bool(iso.get("insecure_dev_mode")) and bool(iso.get("network_blocked")))
        if info is None or not secure:
            if info is not None:
                log.error("code runner isolation check failed; execution disabled: %s", iso)
            return {"enabled": False, "languages": [], "limits": self.limits()}
        offered = {l.get("id"): l.get("label") for l in info.get("languages", []) if isinstance(l, dict)}
        langs = [{"id": lid, "label": offered[lid], "aliases": sorted(a for a, t in ALIASES.items() if t == lid)}
                 for lid in sorted(set(ALIASES.values())) if lid in offered]
        return {"enabled": bool(langs), "languages": langs, "limits": self.limits()}

    def resolve_language(self, requested: str) -> str:
        lang = ALIASES.get(requested)
        rt = self.runtime()
        if not rt["enabled"]:
            raise unavailable()
        if lang is None or lang not in {l["id"] for l in rt["languages"]}:
            raise AppError(422, "This language can't be run here.", code="unsupported_language")
        return lang

    # ------------------------------------------------------------------ ownership
    def begin(self, user_id: str, run_id: str) -> _Run:
        with self._lock:
            if (user_id, run_id) in self._runs:
                raise AppError(409, "This run has already started.", code="duplicate_run")
            if sum(1 for (u, _) in self._runs if u == user_id) >= self.max_active:
                raise AppError(409, "Your previous run is still going. Wait for it to finish or stop it first.", code="run_in_progress")
            run = _Run(user_id, run_id, "j" + secrets.token_hex(16), time.monotonic())
            self._runs[(user_id, run_id)] = run
            return run

    def end(self, run: _Run) -> None:
        with self._lock:
            self._runs.pop((run.user_id, run.run_id), None)

    def cancel(self, user_id: str, run_id: str) -> bool:
        """Only the student who started a run can stop it; anyone else gets the same answer as for a run that does not exist."""
        with self._lock:
            run = self._runs.get((user_id, run_id))
            if run is None:
                return False
            run.cancelled = True
        if self.runner is not None:
            self.runner.cancel(run.job_id)
        return True

    def execute(self, run: _Run, language: str, source: str, stdin: str) -> dict:
        if self.runner is None:
            raise unavailable()
        raw = self.runner.execute(run.job_id, language, source, stdin, self.limits())
        out: dict[str, Any] = {k: raw.get(k) for k in RESULT_KEYS}
        if out["status"] not in STATUSES:
            raise unavailable()
        if run.cancelled:
            out["status"] = "cancelled"
        if out["status"] == "sandbox_error":                      # an infrastructure fault, not the student's program: don't show its text
            log.error("code runner sandbox setup failed for a job")
            raise unavailable()
        out["limits"] = self.limits()
        return out


def build_code_service(cfg: BackendConfig, runner: Any = None) -> CodeService:
    if runner is None and cfg.code_runner_url and cfg.code_runner_token:
        runner = HttpCodeRunner(cfg.code_runner_url, cfg.code_runner_token, request_timeout_s=cfg.code_runner_timeout_ms / 1000 + 10)
    return CodeService(runner, cfg)
