"""Job execution: one untrusted program per job, in its own directory, as its own uid, under hard limits, always cleaned up.

Isolation layers (outermost first; each one holds even if the next is bypassed):
  * the runner's container/VM: no application secrets, no database credentials, read-only image, internal-only network (deployment);
  * per-slot uid: concurrent jobs run as DIFFERENT unprivileged uids, so they cannot read, signal or ptrace each other or the runner;
  * rlimits (CPU, memory, processes, file size, descriptors) set by the launcher before exec;
  * seccomp: no network sockets, no ptrace / namespaces / mounts / new sessions;
  * wall-clock deadline, output caps and a kill-everything-owned-by-the-slot-uid sweep after every job.
Limits requested by the caller are CLAMPED to the operator's maxima; the caller can only ask for less.
"""
from __future__ import annotations

import dataclasses
import json
import os
import queue
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Optional

HERE = Path(__file__).resolve().parent
LAUNCHER = HERE / "launcher.py"


@dataclasses.dataclass(frozen=True)
class Language:
    id: str
    label: str
    filename: str
    argv: tuple[str, ...]               # {file} is replaced by the source file name


def _python() -> Language:
    exe = os.environ.get("RUNNER_PYTHON") or sys.executable
    return Language("python", f"Python {sys.version_info.major}.{sys.version_info.minor}", "main.py", (exe, "-I", "-B", "{file}"))


LANGUAGES: dict[str, Language] = {"python": _python()}


@dataclasses.dataclass(frozen=True)
class Limits:
    timeout_ms: int
    memory_mb: int
    output_bytes: int
    cpu_seconds: int
    nproc: int
    file_bytes: int
    open_files: int

    def clamp(self, timeout_ms: Optional[int], memory_mb: Optional[int], output_bytes: Optional[int]) -> "Limits":
        def lo(req, cap):
            return cap if req is None else max(1, min(int(req), cap))
        t = lo(timeout_ms, self.timeout_ms)
        return dataclasses.replace(self, timeout_ms=t, memory_mb=lo(memory_mb, self.memory_mb), output_bytes=lo(output_bytes, self.output_bytes),
                                   cpu_seconds=max(1, min(self.cpu_seconds, -(-t // 1000))))

    def public(self) -> dict:
        return {"timeout_ms": self.timeout_ms, "memory_mb": self.memory_mb, "output_bytes": self.output_bytes}


@dataclasses.dataclass
class Settings:
    jobs_dir: Path
    max_concurrency: int = 2
    queue_wait_seconds: float = 3.0
    base_uid: int = 60000                 # slot i runs as uid/gid base_uid + i
    limits: Limits = dataclasses.field(default_factory=lambda: Limits(timeout_ms=5000, memory_mb=256, output_bytes=64 * 1024,
                                                                      cpu_seconds=5, nproc=32, file_bytes=1024 * 1024, open_files=64))
    max_source_bytes: int = 64 * 1024
    max_stdin_bytes: int = 16 * 1024
    allow_unprivileged: bool = False      # development only: jobs then share the runner's uid (no uid separation)

    @classmethod
    def from_env(cls) -> "Settings":
        env = os.environ.get
        lim = Limits(timeout_ms=int(env("RUNNER_MAX_TIMEOUT_MS", "5000")), memory_mb=int(env("RUNNER_MAX_MEMORY_MB", "256")),
                     output_bytes=int(env("RUNNER_MAX_OUTPUT_BYTES", str(64 * 1024))), cpu_seconds=int(env("RUNNER_MAX_CPU_SECONDS", "5")),
                     nproc=int(env("RUNNER_MAX_PROCESSES", "32")), file_bytes=int(env("RUNNER_MAX_FILE_BYTES", str(1024 * 1024))),
                     open_files=int(env("RUNNER_MAX_OPEN_FILES", "64")))
        return cls(jobs_dir=Path(env("RUNNER_JOBS_DIR", "/tmp/jobs")), max_concurrency=int(env("RUNNER_MAX_CONCURRENCY", "2")),
                   base_uid=int(env("RUNNER_BASE_UID", "60000")), limits=lim,
                   allow_unprivileged=env("RUNNER_ALLOW_INSECURE_DEV", "") in ("1", "true", "yes"))


class RunnerBusy(Exception):
    pass


class BadRequest(Exception):
    pass


@dataclasses.dataclass
class _Job:
    job_id: str
    slot: int
    proc: Optional[subprocess.Popen] = None
    cancelled: bool = False
    poisoned: bool = False                 # its processes could not be cleaned up: the slot (uid) is never reused


def _live_pids(uid: int) -> list[int]:
    """Processes owned by uid that are not already dead (zombies are dead; init reaps them)."""
    pids = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            if os.stat(f"/proc/{pid}").st_uid != uid:
                continue
            with open(f"/proc/{pid}/stat", "rb") as f:
                state = f.read().rsplit(b")", 1)[1].split()[0]
            if state not in (b"Z", b"X"):
                pids.append(int(pid))
        except (FileNotFoundError, ProcessLookupError, IndexError, PermissionError):
            pass
    return pids


_KILL_ALL = "import os, sys\nu = int(sys.argv[1])\nos.setgroups([]); os.setresgid(u, u, u); os.setresuid(u, u, u)\nos.kill(-1, 9)\n"


def _sweep_uid(uid: int) -> None:
    """Kill every process owned by the slot uid (used by nothing else), including anything that left the process group or is still forking.
    kill(-1) issued AS that uid reaches all of its processes in one kernel pass, so a fork loop cannot outrun it; the /proc scan confirms."""
    for _ in range(50):
        subprocess.run([sys.executable, "-I", "-S", "-c", _KILL_ALL, str(uid)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, close_fds=True, timeout=5, check=False)
        pids = _live_pids(uid)
        if not pids:
            return
        for pid in pids:
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        time.sleep(0.01)
    raise RuntimeError(f"could not clean up processes of uid {uid}")


class Executor:
    def __init__(self, settings: Settings):
        self.s = settings
        self.privileged = os.geteuid() == 0
        if not self.privileged and not settings.allow_unprivileged:
            raise RuntimeError("the code runner must start as root inside its container so each job gets its own unprivileged uid "
                               "(set RUNNER_ALLOW_INSECURE_DEV=1 only for local development)")
        settings.jobs_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(settings.jobs_dir, 0o711)               # traverse only: nobody can list other jobs' directories
        if self.privileged:
            for parent in settings.jobs_dir.resolve().parents:   # the job uid must be able to reach its own directory
                if not os.stat(parent).st_mode & 0o001:
                    raise RuntimeError(f"RUNNER_JOBS_DIR must be reachable by the job uids: {parent} is not world-traversable")
        self._slots: queue.Queue[int] = queue.Queue()
        for i in range(settings.max_concurrency):
            self._slots.put(i)
        self._jobs: dict[str, _Job] = {}
        self._lock = threading.Lock()

    # ------------------------------------------------------------------ public
    def languages(self) -> list[dict]:
        return [{"id": l.id, "label": l.label} for l in LANGUAGES.values()]

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return False
            job.cancelled = True
            proc = job.proc
        if proc is not None:
            self._kill(proc, job.slot)
        return True

    def run(self, job_id: str, language: str, source: str, stdin: str = "", *, timeout_ms: Optional[int] = None,
            memory_mb: Optional[int] = None, output_bytes: Optional[int] = None) -> dict:
        lang = LANGUAGES.get(language)
        if lang is None:
            raise BadRequest("unsupported language")
        if len(source.encode("utf-8")) > self.s.max_source_bytes:
            raise BadRequest("source too large")
        if len(stdin.encode("utf-8")) > self.s.max_stdin_bytes:
            raise BadRequest("stdin too large")
        limits = self.s.limits.clamp(timeout_ms, memory_mb, output_bytes)
        with self._lock:
            if job_id in self._jobs:
                raise BadRequest("duplicate job id")
            self._jobs[job_id] = job = _Job(job_id, -1)
        try:
            try:
                job.slot = self._slots.get(timeout=self.s.queue_wait_seconds)
            except queue.Empty:
                raise RunnerBusy() from None
            try:
                if job.cancelled:
                    return self._result("cancelled", None, b"", b"", False, False, 0, limits)
                return self._execute(job, lang, source, stdin, limits)
            finally:
                if not job.poisoned:
                    self._slots.put(job.slot)
        finally:
            with self._lock:
                self._jobs.pop(job_id, None)

    # ------------------------------------------------------------------ internals
    def _uid(self, slot: int) -> int:
        return self.s.base_uid + slot

    def _kill(self, proc: subprocess.Popen, slot: int) -> None:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        if self.privileged:
            _sweep_uid(self._uid(slot))

    def _execute(self, job: _Job, lang: Language, source: str, stdin: str, limits: Limits) -> dict:
        uid = gid = self._uid(job.slot)
        workdir = Path(tempfile.mkdtemp(prefix="job-", dir=self.s.jobs_dir))
        try:
            src = workdir / lang.filename
            src.write_text(source, encoding="utf-8")
            if self.privileged:
                os.chown(workdir, uid, gid)
                os.chmod(workdir, 0o700)
                os.chmod(src, 0o444)                  # root-owned and read-only: the job reads its program, nothing else of the runner's
            env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(workdir), "TMPDIR": str(workdir), "LANG": "C.UTF-8",
                   "LC_ALL": "C.UTF-8", "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1",
                   "MALLOC_ARENA_MAX": "2"}
            spec = {"workdir": str(workdir), "uid": uid, "gid": gid, "cpu_seconds": limits.cpu_seconds,
                    "memory_bytes": limits.memory_mb * 1024 * 1024, "file_bytes": limits.file_bytes, "open_files": limits.open_files,
                    "nproc": limits.nproc if self.privileged else None, "allow_unprivileged": self.s.allow_unprivileged,
                    "argv": [a.replace("{file}", lang.filename) for a in lang.argv], "env": env}
            started = time.monotonic()
            proc = subprocess.Popen([sys.executable, "-I", "-B", str(LAUNCHER), json.dumps(spec)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, cwd=str(workdir), env={"PATH": env["PATH"], "LANG": "C.UTF-8"},
                                    start_new_session=True, close_fds=True)
            with self._lock:
                job.proc = proc
            if job.cancelled:
                self._kill(proc, job.slot)
            out, err, reason = self._pump(proc, stdin.encode("utf-8"), limits, started)
            if reason:
                self._kill(proc, job.slot)
            try:
                rc = proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._kill(proc, job.slot)
                rc = proc.wait()
            duration = int((time.monotonic() - started) * 1000)
            prefix = (str(workdir) + os.sep).encode()                  # tracebacks show "main.py", not the runner's internal paths
            out_trunc, err_trunc = len(out) >= limits.output_bytes, len(err) >= limits.output_bytes
            out, err = out.replace(prefix, b""), err.replace(prefix, b"")
            if job.cancelled:
                status = "cancelled"
            elif reason == "timeout" or rc == -signal.SIGXCPU:
                status = "timeout"
            elif reason == "output_limit":
                status = "output_limit"
            elif rc == 125 and err.startswith(b"sandbox setup failed"):
                status = "sandbox_error"
            elif rc != 0 and b"MemoryError" in err[-4096:]:
                status = "memory_limit"
            else:
                status = "completed" if rc == 0 else "failed"
            return self._result(status, rc, out, err, out_trunc, err_trunc, duration, limits)
        finally:
            try:
                if job.proc is not None:
                    self._kill(job.proc, job.slot)   # nothing of the job survives it, whatever happened
            except Exception:  # noqa: BLE001
                job.poisoned = True                  # never hand this uid to another job
                import logging
                logging.getLogger("code-runner").critical("slot %s quarantined: its processes could not be killed", job.slot)
            shutil.rmtree(workdir, ignore_errors=True)

    def _pump(self, proc: subprocess.Popen, stdin: bytes, limits: Limits, started: float) -> tuple[bytes, bytes, Optional[str]]:
        """Feed stdin, collect stdout/stderr up to the cap, enforce the wall-clock deadline. Returns (out, err, reason-to-kill)."""
        assert proc.stdin and proc.stdout and proc.stderr
        try:
            if stdin:
                proc.stdin.write(stdin)
            proc.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        cap = limits.output_bytes
        bufs = {proc.stdout: bytearray(), proc.stderr: bytearray()}
        sel = selectors.DefaultSelector()
        for f in bufs:
            os.set_blocking(f.fileno(), False)
            sel.register(f, selectors.EVENT_READ)
        deadline = started + limits.timeout_ms / 1000
        reason: Optional[str] = None
        try:
            while sel.get_map():
                left = deadline - time.monotonic()
                if left <= 0:
                    reason = "timeout"
                    break
                for key, _ in sel.select(timeout=min(left, 0.25)):
                    try:
                        chunk = os.read(key.fd, 16384)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        sel.unregister(key.fileobj)
                        continue
                    b = bufs[key.fileobj]
                    room = cap - len(b)
                    b += chunk[:max(room, 0)]
                    if len(chunk) > room:
                        reason = "output_limit"
                if reason:
                    break
                if proc.poll() is not None and not sel.select(timeout=0):
                    # exited and nothing more to read right now; drain whatever is buffered then stop
                    for key in list(sel.get_map().values()):
                        try:
                            while chunk := os.read(key.fd, 16384):
                                b = bufs[key.fileobj]
                                b += chunk[:max(cap - len(b), 0)]
                        except (BlockingIOError, OSError):
                            pass
                    break
        finally:
            sel.close()
            for f in bufs:
                try:
                    f.close()
                except OSError:
                    pass
        return bytes(bufs[proc.stdout]), bytes(bufs[proc.stderr]), reason

    @staticmethod
    def _result(status: str, rc: Optional[int], out: bytes, err: bytes, out_trunc: bool, err_trunc: bool, duration_ms: int, limits: Limits) -> dict:
        sig = None
        if rc is not None and rc < 0:
            try:
                sig = signal.Signals(-rc).name
            except ValueError:
                sig = str(-rc)
        return {"status": status, "exit_code": rc, "signal": sig, "stdout": out.decode("utf-8", "replace"), "stderr": err.decode("utf-8", "replace"),
                "stdout_truncated": out_trunc, "stderr_truncated": err_trunc, "duration_ms": duration_ms, "limits": limits.public()}
