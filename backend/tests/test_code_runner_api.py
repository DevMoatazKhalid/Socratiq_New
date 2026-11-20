"""In-chat code runner API.

Two layers:
  * contract/authorization tests with a recording runner (server-side limits, ownership of runs, duplicates, availability failing closed);
  * END-TO-END tests through the REAL runner service (sandbox/code_runner, started on localhost): real execution, real timeouts, real
    memory/output limits, blocked network, cancellation. No mock decides any security outcome there.
"""
from __future__ import annotations

import concurrent.futures as cf
import os
import sys
import threading
import time
import uuid
from pathlib import Path

import pytest

from .conftest import FakeVerifier
from .helpers import API

ROOT = Path(__file__).resolve().parents[2]
EXE = f"{API}/student/code/executions"
RT = f"{API}/student/code/runtime"
SECURE = {"ok": True, "uid_separation": True, "network_blocked": True, "secrets_unreadable": True, "insecure_dev_mode": False}


def rid() -> str:
    return "r" + uuid.uuid4().hex[:20]


class RecordingRunner:
    def __init__(self, isolation=None, result=None):
        self.isolation = SECURE if isolation is None else isolation
        self.result = result or {"status": "completed", "exit_code": 0, "signal": None, "stdout": "ok\n", "stderr": "", "stdout_truncated": False,
                                 "stderr_truncated": False, "duration_ms": 12, "limits": {}}
        self.calls, self.cancelled = [], []
        self.release = threading.Event()
        self.release.set()

    def info(self):
        return {"languages": [{"id": "python", "label": "Python 3.12"}], "limits": {}, "isolation": self.isolation}

    def execute(self, job_id, language, source, stdin, limits):
        self.calls.append({"job_id": job_id, "language": language, "source": source, "stdin": stdin, "limits": limits})
        self.release.wait(10)
        return dict(self.result, status="cancelled") if job_id in self.cancelled else dict(self.result)

    def cancel(self, job_id):
        self.cancelled.append(job_id)
        self.release.set()
        return True


def with_runner(world, runner):
    """The same real database/app wiring as `world`, with a code runner plugged in."""
    from fastapi.testclient import TestClient
    from app.main import create_app
    app = create_app(db=world.db, storage=world.storage, token_verifier=FakeVerifier(), ai_adapter=world.ai, rag=world.rag, run_worker=False, code_runner=runner)
    return TestClient(app, raise_server_exceptions=False)


def run(client, world, who="S1", **body):
    body.setdefault("run_id", rid())
    body.setdefault("language", "python")
    body.setdefault("source", "print('hi')")
    return client.post(EXE, json=body, headers=world.h(who))


# ------------------------------------------------------------------ availability fails closed
def test_without_a_runner_the_feature_is_off(world):
    assert world.client.get(RT, headers=world.h("S1")).json()["enabled"] is False
    r = world.client.post(EXE, json={"run_id": rid(), "language": "python", "source": "print(1)"}, headers=world.h("S1"))
    assert r.status_code == 503 and r.json()["error"]["code"] == "code_runner_unavailable"


def test_a_runner_that_failed_its_isolation_check_is_never_used(world):
    runner = RecordingRunner(isolation={"ok": False, "uid_separation": False, "network_blocked": False, "insecure_dev_mode": False})
    c = with_runner(world, runner)
    assert c.get(RT, headers=world.h("S1")).json() == {"enabled": False, "languages": [], "limits": c.get(RT, headers=world.h("S1")).json()["limits"]}
    assert run(c, world).status_code == 503 and runner.calls == []


def test_runtime_lists_supported_languages_and_server_limits(world):
    body = with_runner(world, RecordingRunner()).get(RT, headers=world.h("S1")).json()
    assert body["enabled"] is True and body["languages"] == [{"id": "python", "label": "Python 3.12", "aliases": ["py", "python", "python3"]}]
    assert set(body["limits"]) == {"timeout_ms", "memory_mb", "output_bytes"}


# ------------------------------------------------------------------ validation and server-side limits
def test_unsupported_languages_and_bad_input_are_rejected(world):
    runner = RecordingRunner()
    c = with_runner(world, runner)
    assert run(c, world, language="bash", source="rm -rf /").status_code == 422
    assert run(c, world, language="javascript").status_code == 422
    assert run(c, world, source="x" * 20_001).status_code == 422
    assert run(c, world, stdin="x" * 16_001).status_code == 422
    assert run(c, world, run_id="bad id").status_code == 422
    assert run(c, world, source="").status_code == 422
    assert runner.calls == []


def test_the_browser_cannot_choose_limits_or_identity(world):
    runner = RecordingRunner()
    c = with_runner(world, runner)
    assert run(c, world, limits={"timeout_ms": 10 ** 9}).status_code == 422          # extra fields are refused, not ignored
    assert run(c, world, student_id="S2").status_code == 422
    r = run(c, world, language="py", source="  x = 1\n\n")                          # aliases map to the runner language; code kept verbatim
    assert r.status_code == 200 and r.json()["status"] == "completed"
    call = runner.calls[-1]
    from app.config import get_backend_config
    cfg = get_backend_config()
    assert call["language"] == "python" and call["source"] == "  x = 1\n\n"
    assert call["limits"] == {"timeout_ms": cfg.code_runner_timeout_ms, "memory_mb": cfg.code_runner_memory_mb, "output_bytes": cfg.code_runner_output_bytes}
    assert call["job_id"] not in r.text                                              # the runner's job id is never exposed


def test_sandbox_infrastructure_errors_are_not_shown_to_students(world):
    runner = RecordingRunner(result={"status": "sandbox_error", "exit_code": 125, "stdout": "", "stderr": "sandbox setup failed: internal detail"})
    r = run(with_runner(world, runner), world)
    assert r.status_code == 503 and "internal detail" not in r.text


# ------------------------------------------------------------------ authorization, duplicates, concurrency, cancellation
def test_authentication_and_student_role_are_required(world):
    c = with_runner(world, RecordingRunner())
    for m, url in (("GET", RT), ("POST", EXE), ("DELETE", f"{EXE}/{rid()}")):
        assert c.request(m, url).status_code == 401
        assert c.request(m, url, headers={"Authorization": "Bearer forged"}).status_code == 401
    assert run(c, world, "P1").status_code == 403
    assert c.get(RT, headers=world.h("P1")).status_code == 403


def test_one_run_at_a_time_per_student_and_no_duplicate_runs(world):
    runner = RecordingRunner()
    runner.release.clear()
    c = with_runner(world, runner)
    first_id = rid()
    with cf.ThreadPoolExecutor(1) as ex:
        first = ex.submit(run, c, world, run_id=first_id)
        for _ in range(50):
            if runner.calls:
                break
            time.sleep(0.02)
        dup = run(c, world, run_id=first_id)
        second = run(c, world)
        other_student = ex.submit(run, c, world, "S2")       # another student is not blocked by S1's run
        time.sleep(0.2)
        runner.release.set()
        assert first.result().status_code == 200 and other_student.result().status_code == 200
    assert dup.status_code == 409 and dup.json()["error"]["code"] == "duplicate_run"
    assert second.status_code == 409 and second.json()["error"]["code"] == "run_in_progress"
    assert run(c, world).status_code == 200                  # the slot is released afterwards


def test_only_the_owner_can_cancel_a_run(world):
    runner = RecordingRunner()
    runner.release.clear()
    c = with_runner(world, runner)
    run_id = rid()
    with cf.ThreadPoolExecutor(1) as ex:
        fut = ex.submit(run, c, world, run_id=run_id)
        for _ in range(50):
            if runner.calls:
                break
            time.sleep(0.02)
        for who in ("S2", "S3"):                            # someone else, even with the right run id: same answer as a run that doesn't exist
            assert c.delete(f"{EXE}/{run_id}", headers=world.h(who)).status_code == 404
        assert runner.cancelled == []
        assert c.delete(f"{EXE}/{run_id}", headers=world.h("S1")).status_code == 202
        res = fut.result(10)
    assert res.status_code == 200 and res.json()["status"] == "cancelled"
    assert c.delete(f"{EXE}/{run_id}", headers=world.h("S1")).status_code == 404     # finished runs are gone


def test_run_rate_limit(world, monkeypatch):
    monkeypatch.setenv("CODE_RUN_RATE_LIMIT_PER_MINUTE", "3")
    from app.config import reset_backend_config
    reset_backend_config()
    c = with_runner(world, RecordingRunner())
    codes = [run(c, world).status_code for _ in range(4)]
    assert codes == [200, 200, 200, 429]


# ------------------------------------------------------------------ END TO END through the real runner service
@pytest.fixture()
def real(world, tmp_path):
    if sys.platform != "linux":
        pytest.skip("the code runner sandbox is Linux-only")
    sys.path.insert(0, str(ROOT / "sandbox" / "code_runner"))
    from runner.executor import Limits, Settings
    from runner.server import build_server
    import tempfile
    from app.code_runner import HttpCodeRunner
    from app.config import reset_backend_config
    jobs = Path(tempfile.mkdtemp(prefix="sbx-backend-", dir="/tmp"))
    jobs.chmod(0o711)
    privileged = os.geteuid() == 0
    os.environ["CODE_RUNNER_ALLOW_INSECURE_DEV"] = "" if privileged else "1"        # unprivileged CI: no uid separation, seccomp + rlimits still real
    reset_backend_config()
    token = "k" * 48
    lim = Limits(timeout_ms=2000, memory_mb=128, output_bytes=8192, cpu_seconds=2, nproc=32, file_bytes=256 * 1024, open_files=32)
    srv = build_server("127.0.0.1", 0, Settings(jobs_dir=jobs / "jobs", base_uid=62000, limits=lim, allow_unprivileged=not privileged), token, None)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    client = with_runner(world, HttpCodeRunner(f"http://127.0.0.1:{srv.server_address[1]}", token, request_timeout_s=20))
    yield client
    srv.shutdown()
    srv.server_close()
    os.environ.pop("CODE_RUNNER_ALLOW_INSECURE_DEV", None)
    reset_backend_config()


def test_e2e_runtime_is_enabled_by_a_runner_that_passed_its_self_check(real, world):
    assert real.get(RT, headers=world.h("S1")).json()["enabled"] is True


def test_e2e_success_stdout_stderr_and_exit_code(real, world):
    r = run(real, world, source="import sys\nprint(sum(range(5)))\nprint('warn', file=sys.stderr)").json()
    assert r["status"] == "completed" and r["exit_code"] == 0 and r["stdout"] == "10\n" and r["stderr"] == "warn\n"


def test_e2e_stdin(real, world):
    assert run(real, world, source="print(input()[::-1])", stdin="olleh\n").json()["stdout"] == "hello\n"


def test_e2e_syntax_and_runtime_errors(real, world):
    s = run(real, world, source="def f(:\n  pass").json()
    e = run(real, world, source="1/0").json()
    assert s["status"] == "failed" and "SyntaxError" in s["stderr"]
    assert e["status"] == "failed" and e["exit_code"] == 1 and "ZeroDivisionError" in e["stderr"] and 'File "main.py"' in e["stderr"]


def test_e2e_timeout(real, world):
    t = time.monotonic()
    r = run(real, world, source="while True:\n  pass").json()
    assert r["status"] == "timeout" and time.monotonic() - t < 8


def test_e2e_memory_and_output_limits(real, world):
    assert run(real, world, source="x = bytearray(512 * 1024 * 1024)").json()["status"] == "memory_limit"
    o = run(real, world, source="while True:\n  print('y' * 500)").json()
    assert o["status"] == "output_limit" and o["stdout_truncated"] is True


def test_e2e_restricted_resources(real, world):
    src = ("import os, socket\nres = []\ntry:\n    socket.create_connection(('127.0.0.1', 5432), timeout=1); res.append('NET')\nexcept OSError:\n    res.append('no-net')\n"
           "res.append('SECRETS' if any(k for k in os.environ if 'KEY' in k or 'TOKEN' in k or 'DATABASE' in k or 'SUPABASE' in k) else 'clean-env')\n"
           "print(res)")
    r = run(real, world, source=src).json()
    assert r["stdout"].strip() == "['no-net', 'clean-env']", r


def test_e2e_cancel_stops_the_real_job(real, world):
    run_id = rid()
    with cf.ThreadPoolExecutor(1) as ex:
        fut = ex.submit(run, real, world, run_id=run_id, source="import time\nprint('start', flush=True)\ntime.sleep(60)")
        time.sleep(0.6)
        assert real.delete(f"{EXE}/{run_id}", headers=world.h("S1")).status_code == 202
        t = time.monotonic()
        res = fut.result(10).json()
    assert res["status"] == "cancelled" and time.monotonic() - t < 3


def test_e2e_concurrent_students_run_in_parallel(real, world):
    with cf.ThreadPoolExecutor(2) as ex:
        a, b = ex.map(lambda who: run(real, world, who, source=f"print('{who}')"), ("S1", "S2"))
    assert a.json()["stdout"] == "S1\n" and b.json()["stdout"] == "S2\n"
