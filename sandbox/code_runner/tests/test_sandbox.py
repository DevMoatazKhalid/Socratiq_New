"""REAL sandbox tests: every test executes untrusted Python through the actual launcher, rlimits and seccomp filter. Nothing is mocked.

Tests that need uid separation (the production configuration) run when the suite runs as root (as the runner does inside its container) and
are skipped otherwise, with the reason printed. Everything else also runs unprivileged, in the runner's development mode.
"""
from __future__ import annotations

import json
import os
import platform
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from runner.executor import BadRequest, Executor, Limits, RunnerBusy, Settings  # noqa: E402

pytestmark = pytest.mark.skipif(sys.platform != "linux" or platform.machine() not in ("x86_64", "aarch64"),
                                reason="the sandbox (rlimits + seccomp) is Linux x86_64/aarch64 only")
IS_ROOT = os.geteuid() == 0
needs_root = pytest.mark.skipif(not IS_ROOT, reason="uid separation needs the runner to start as root (as it does in its container)")
BASE_UID = 61000


def jobs_root() -> Path:
    """A jobs directory the per-job uids can reach (pytest's tmp_path parents are 0700)."""
    d = Path(tempfile.mkdtemp(prefix="sbx-test-", dir="/tmp"))
    d.chmod(0o711)
    return d


def make(tmp_path, **kw) -> Executor:
    lim = Limits(timeout_ms=kw.pop("timeout_ms", 3000), memory_mb=kw.pop("memory_mb", 128), output_bytes=kw.pop("output_bytes", 8192),
                 cpu_seconds=3, nproc=16, file_bytes=256 * 1024, open_files=32)
    return Executor(Settings(jobs_dir=jobs_root() / "jobs", base_uid=BASE_UID, limits=lim, allow_unprivileged=not IS_ROOT, **kw))


_n = 0


def jid() -> str:
    global _n
    _n += 1
    return f"test{os.getpid()}x{_n}x{time.monotonic_ns()}"


def run(ex: Executor, src: str, **kw) -> dict:
    return ex.run(jid(), "python", src, **kw)


def leftover(uid: int) -> list[int]:
    from runner.executor import _live_pids
    return _live_pids(uid)


# ------------------------------------------------------------------ ordinary programs
def test_successful_execution_returns_stdout_and_exit_zero(tmp_path):
    r = run(make(tmp_path), "print('hello', 6 * 7)")
    assert r["status"] == "completed" and r["exit_code"] == 0 and r["stdout"] == "hello 42\n" and r["stderr"] == ""


def test_stdout_and_stderr_are_separate_and_nonzero_exit_is_failed(tmp_path):
    r = run(make(tmp_path), "import sys\nprint('out')\nprint('err', file=sys.stderr)\nsys.exit(3)")
    assert r["status"] == "failed" and r["exit_code"] == 3 and r["stdout"] == "out\n" and r["stderr"] == "err\n"


def test_syntax_error_is_reported(tmp_path):
    r = run(make(tmp_path), "def f(:\n    pass")
    assert r["status"] == "failed" and r["exit_code"] == 1 and "SyntaxError" in r["stderr"]


def test_runtime_error_is_reported_with_traceback(tmp_path):
    r = run(make(tmp_path), "xs = [1, 2]\nprint(xs[5])")
    assert r["status"] == "failed" and "IndexError" in r["stderr"] and "Traceback" in r["stderr"]
    assert 'File "main.py", line 2' in r["stderr"] and "/jobs/" not in r["stderr"]             # no internal paths leak


def test_stdin_is_delivered(tmp_path):
    r = run(make(tmp_path), "a = input(); b = input(); print(int(a) + int(b))", stdin="2\n40\n")
    assert r["stdout"] == "42\n"


def test_unicode_round_trips(tmp_path):
    r = run(make(tmp_path), "print('معدل التعلّم', '✓')")
    assert r["stdout"] == "معدل التعلّم ✓\n"


def test_unsupported_language_and_oversized_input_are_rejected(tmp_path):
    ex = make(tmp_path)
    with pytest.raises(BadRequest):
        ex.run(jid(), "bash", "echo hi")
    with pytest.raises(BadRequest):
        ex.run(jid(), "python", "x" * (ex.s.max_source_bytes + 1))
    with pytest.raises(BadRequest):
        ex.run(jid(), "python", "print(1)", "x" * (ex.s.max_stdin_bytes + 1))


# ------------------------------------------------------------------ limits
def test_infinite_loop_hits_the_wall_clock_timeout_and_is_killed(tmp_path):
    t = time.monotonic()
    r = run(make(tmp_path), "while True:\n    pass", timeout_ms=1000)
    assert r["status"] == "timeout" and time.monotonic() - t < 3


def test_sleeping_program_cannot_outlive_the_deadline(tmp_path):
    r = run(make(tmp_path), "import time\ntime.sleep(30)", timeout_ms=800)
    assert r["status"] == "timeout" and r["duration_ms"] < 2500


def test_memory_limit_stops_large_allocations(tmp_path):
    r = run(make(tmp_path, memory_mb=96), "x = bytearray(400 * 1024 * 1024)\nprint('allocated')")
    assert r["status"] == "memory_limit" and "allocated" not in r["stdout"]


def test_caller_cannot_raise_limits_above_the_operator_maximum(tmp_path):
    ex = make(tmp_path, timeout_ms=1000, memory_mb=96)
    r = run(ex, "import time\ntime.sleep(5)", timeout_ms=10 ** 9, memory_mb=10 ** 6, output_bytes=10 ** 9)
    assert r["status"] == "timeout" and r["limits"] == {"timeout_ms": 1000, "memory_mb": 96, "output_bytes": 8192}


def test_output_is_capped_and_a_flooding_program_is_stopped(tmp_path):
    t = time.monotonic()
    r = run(make(tmp_path, output_bytes=4096), "while True:\n    print('x' * 1000)")
    assert r["status"] == "output_limit" and r["stdout_truncated"] and len(r["stdout"].encode()) == 4096 and time.monotonic() - t < 3


def test_file_size_limit(tmp_path):
    r = run(make(tmp_path), "open('big.bin', 'wb').write(b'0' * (2 * 1024 * 1024))")
    assert r["status"] == "failed" and r["exit_code"] != 0          # SIGXFSZ / EFBIG at 256 KiB


@needs_root
def test_fork_bomb_is_contained_and_cleaned_up(tmp_path):
    ex = make(tmp_path)
    r = run(ex, "import os\nfor _ in range(500):\n    try:\n        os.fork()\n    except OSError:\n        pass\nimport time\ntime.sleep(10)", timeout_ms=1500)
    assert r["status"] in ("timeout", "failed")
    time.sleep(0.1)
    assert leftover(BASE_UID) == []


# ------------------------------------------------------------------ restricted resources
def test_network_sockets_are_blocked(tmp_path):
    src = ("import socket\nres = []\nfor fam, typ in ((socket.AF_INET, socket.SOCK_STREAM), (socket.AF_INET6, socket.SOCK_DGRAM), "
           "(socket.AF_INET, socket.SOCK_DGRAM)):\n    try:\n        socket.socket(fam, typ); res.append('open')\n"
           "    except OSError as e:\n        res.append(e.errno)\nprint(res)")
    r = run(make(tmp_path), src)
    assert r["status"] == "completed" and "open" not in r["stdout"], r


def test_dns_and_http_fail(tmp_path):
    r = run(make(tmp_path), "import urllib.request\nurllib.request.urlopen('http://example.com', timeout=2)")
    assert r["status"] == "failed" and ("PermissionError" in r["stderr"] or "URLError" in r["stderr"])


def test_ptrace_setsid_and_unshare_are_denied(tmp_path):
    src = ("import ctypes, os\nlibc = ctypes.CDLL(None, use_errno=True)\nout = {}\n"
           "out['ptrace'] = libc.ptrace(16, 1, 0, 0)\n"        # PTRACE_ATTACH to pid 1
           "out['unshare'] = libc.unshare(0x40000000)\n"       # CLONE_NEWNET
           "try:\n    os.setsid(); out['setsid'] = 0\nexcept OSError:\n    out['setsid'] = -1\nprint(out)")
    r = run(make(tmp_path), src)
    assert r["status"] == "completed" and r["stdout"].strip() == "{'ptrace': -1, 'unshare': -1, 'setsid': -1}", r


def test_job_environment_contains_no_runner_secrets(tmp_path, monkeypatch):
    monkeypatch.setenv("RUNNER_TOKEN", "super-secret-token-value-for-the-test-123456")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "sk-test")
    r = run(make(tmp_path), "import os\nprint(sorted(os.environ))")
    assert "RUNNER_TOKEN" not in r["stdout"] and "SUPABASE" not in r["stdout"] and "super-secret" not in r["stdout"]


@needs_root
def test_job_runs_as_an_unprivileged_uid_and_cannot_regain_root(tmp_path):
    r = run(make(tmp_path), "import os\nprint(os.getuid(), os.geteuid(), os.getgid(), os.getgroups())\ntry:\n    os.setuid(0)\nexcept PermissionError:\n    print('denied')")
    assert r["stdout"] == f"{BASE_UID} {BASE_UID} {BASE_UID} []\ndenied\n"


@needs_root
def test_job_cannot_read_root_only_files_or_the_runner_process(tmp_path):
    secret = jobs_root() / "token"
    secret.write_text("runner-token")
    secret.chmod(0o400)
    src = (f"import os\nres = []\nfor p in ({str(secret)!r}, '/proc/1/environ', '/proc/{os.getpid()}/environ', '/etc/shadow'):\n"
           "    try:\n        open(p).read(); res.append('READ ' + p)\n    except OSError:\n        res.append('denied')\nprint(res)")
    r = run(make(tmp_path), src)
    assert "READ" not in r["stdout"] and r["stdout"].count("denied") == 4, r


@needs_root
def test_job_cannot_write_outside_its_own_directory(tmp_path):
    src = ("import os\nres = []\nfor p in ('/etc/x', '/usr/x', os.path.dirname(os.getcwd()) + '/x', '/root/x'):\n"
           "    try:\n        open(p, 'w').write('x'); res.append('WROTE ' + p)\n    except OSError:\n        res.append('denied')\n"
           "open('mine.txt', 'w').write('ok')\nprint(res)")
    r = run(make(tmp_path), src)
    assert "WROTE" not in r["stdout"] and r["stdout"].count("denied") == 4, r


@needs_root
def test_concurrent_jobs_are_isolated_from_each_other(tmp_path):
    ex = make(tmp_path, max_concurrency=2)
    holder: dict = {}
    jobs = str(ex.s.jobs_dir)

    def a():
        holder["a"] = run(ex, "import os, time\nopen('secret.txt', 'w').write('A-SECRET')\nprint(os.getcwd(), flush=True)\ntime.sleep(1.5)")
    t = threading.Thread(target=a)
    t.start()
    time.sleep(0.4)
    rb = run(ex, f"import os, glob\nres = []\ntry:\n    res.append(os.listdir({jobs!r}))\nexcept OSError:\n    res.append('nolist')\n"
                 f"for f in glob.glob({jobs!r} + '/*/secret.txt'):\n    res.append(open(f).read())\n"
                 "import signal\ntry:\n    os.kill(-1, signal.SIGKILL)\nexcept OSError:\n    pass\nprint(res, os.getuid())")
    t.join()
    assert "A-SECRET" not in rb["stdout"] and "nolist" in rb["stdout"]
    assert holder["a"]["status"] == "completed"                                  # B's kill(-1) could not touch A
    assert rb["stdout"].split()[-1] != holder["a"]["stdout"]                       # different uid


# ------------------------------------------------------------------ cancellation, concurrency limits, cleanup
def test_cancel_stops_a_running_job_and_cleans_up(tmp_path):
    ex = make(tmp_path, timeout_ms=5000)
    holder: dict = {}
    job = jid()

    def go():
        holder["r"] = ex.run(job, "python", "import time\nprint('started', flush=True)\ntime.sleep(30)")
    t = threading.Thread(target=go)
    t0 = time.monotonic()
    t.start()
    time.sleep(0.4)
    assert ex.cancel(job) is True
    t.join(5)
    assert holder["r"]["status"] == "cancelled" and time.monotonic() - t0 < 3
    assert list(ex.s.jobs_dir.iterdir()) == []                       # work directory removed
    assert ex.cancel(job) is False                                         # finished jobs are gone
    if IS_ROOT:
        assert leftover(BASE_UID) == []


def test_work_directory_is_removed_after_every_outcome(tmp_path):
    ex = make(tmp_path)
    for src in ("print(1)", "raise SystemExit(2)", "while True: pass"):
        run(ex, src, timeout_ms=600)
    assert list(ex.s.jobs_dir.iterdir()) == []


def test_more_jobs_than_slots_wait_then_report_busy(tmp_path):
    ex = make(tmp_path, max_concurrency=1, queue_wait_seconds=0.3)
    t = threading.Thread(target=lambda: run(ex, "import time\ntime.sleep(1.2)"))
    t.start()
    time.sleep(0.2)
    with pytest.raises(RunnerBusy):
        run(ex, "print(1)")
    t.join()
    assert run(ex, "print(1)")["status"] == "completed"                   # the slot came back


def test_duplicate_job_ids_are_refused_while_running(tmp_path):
    ex = make(tmp_path)
    job = jid()
    t = threading.Thread(target=lambda: ex.run(job, "python", "import time\ntime.sleep(0.8)"))
    t.start()
    time.sleep(0.2)
    with pytest.raises(BadRequest):
        ex.run(job, "python", "print(1)")
    t.join()


# ------------------------------------------------------------------ HTTP service (real server on localhost)
TOKEN = "t" * 40


@pytest.fixture()
def server(tmp_path):
    from runner.server import build_server
    lim = Limits(timeout_ms=2000, memory_mb=128, output_bytes=8192, cpu_seconds=2, nproc=16, file_bytes=256 * 1024, open_files=32)
    srv = build_server("127.0.0.1", 0, Settings(jobs_dir=jobs_root() / "jobs", base_uid=BASE_UID, limits=lim, allow_unprivileged=not IS_ROOT), TOKEN, None)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", srv
    srv.shutdown()
    srv.server_close()


def call(url, path, body=None, token=TOKEN):
    req = urllib.request.Request(url + path, data=None if body is None else json.dumps(body).encode(), method="GET" if body is None else "POST",
                                 headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_http_requires_the_token(server):
    url, _ = server
    assert call(url, "/healthz", token=None) == (200, {"ok": True})
    assert call(url, "/v1/info", token=None)[0] == 401
    assert call(url, "/v1/info", token="wrong")[0] == 401
    assert call(url, "/v1/execute", {"job_id": "abcdefgh", "language": "python", "source": "print(1)"}, token="x" * 40)[0] == 401


def test_http_execute_and_info(server):
    url, srv = server
    status, info = call(url, "/v1/info")
    assert status == 200 and info["languages"][0]["id"] == "python" and info["isolation"]["network_blocked"] is True
    if IS_ROOT:
        assert info["isolation"]["ok"] is True and info["isolation"]["uid_separation"] is True
    status, res = call(url, "/v1/execute", {"job_id": "abcdefgh1", "language": "python", "source": "print(sum(range(10)))", "limits": {"timeout_ms": 99999}})
    assert status == 200 and res["stdout"] == "45\n" and res["limits"]["timeout_ms"] == 2000


def test_http_rejects_bad_requests(server):
    url, _ = server
    assert call(url, "/v1/execute", {"job_id": "bad id!", "language": "python", "source": "1"})[0] == 400
    assert call(url, "/v1/execute", {"job_id": "abcdefgh2", "language": "ruby", "source": "1"})[0] == 400
    assert call(url, "/v1/execute", {"job_id": "abcdefgh3", "language": "python", "source": 5})[0] == 400


def test_http_cancel(server):
    url, _ = server
    holder: dict = {}
    t = threading.Thread(target=lambda: holder.update(r=call(url, "/v1/execute", {"job_id": "canceltest1", "language": "python", "source": "import time\ntime.sleep(30)"})))
    t.start()
    time.sleep(0.4)
    assert call(url, "/v1/jobs/canceltest1/cancel", {}) == (200, {"cancelled": True})
    t.join(5)
    assert holder["r"][1]["status"] == "cancelled"
    assert call(url, "/v1/jobs/canceltest1/cancel", {}) == (200, {"cancelled": False})
