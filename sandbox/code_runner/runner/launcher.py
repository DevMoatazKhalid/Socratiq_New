"""Trusted first stage of every job, run as a fresh process by the executor:  python -I -B launcher.py '<json spec>'

It turns itself into the jail and then execs the untrusted program, so nothing runs between "untrusted code starts" and "all limits apply":
  1. drop to the job's unprivileged uid/gid (never root; no supplementary groups),
  2. apply hard resource limits (CPU seconds, address space, processes, file size, open files, no core dumps),
  3. close every inherited descriptor except stdin/stdout/stderr,
  4. install the seccomp filter (no network sockets, no ptrace/namespaces/mounts, no escaping the process group),
  5. execve the language runtime with a minimal, explicit environment (no runner secrets are ever in it).

A step that fails aborts the job with exit status 125 and a one-line reason on stderr; the untrusted program never starts half-confined.
Kept free of imports outside the stdlib, and never imports anything from the job's directory (-I).
"""
from __future__ import annotations

import json
import os
import resource
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))     # the runner's own read-only directory, never the job's (-I drops cwd)
import seccomp_filter  # noqa: E402

EXIT_SETUP_FAILED = 125


def _fail(msg: str) -> None:
    os.write(2, f"sandbox setup failed: {msg}\n".encode())
    os._exit(EXIT_SETUP_FAILED)


def _drop_privileges(uid: int, gid: int) -> None:
    os.setgroups([])
    os.setresgid(gid, gid, gid)
    os.setresuid(uid, uid, uid)
    if os.getuid() == 0 or os.geteuid() == 0 or os.getgid() == 0:
        _fail("still privileged after dropping")
    try:                                   # regaining root must be impossible
        os.setuid(0)
    except PermissionError:
        pass
    else:
        _fail("could regain uid 0")


def _limits(spec: dict) -> None:
    cpu = int(spec["cpu_seconds"])
    mem = int(spec["memory_bytes"])
    pairs = [
        (resource.RLIMIT_CPU, (cpu, cpu + 1)),          # SIGXCPU at the soft limit, SIGKILL at the hard one
        (resource.RLIMIT_AS, (mem, mem)),
        (resource.RLIMIT_DATA, (mem, mem)),
        (resource.RLIMIT_FSIZE, (int(spec["file_bytes"]),) * 2),
        (resource.RLIMIT_NOFILE, (int(spec["open_files"]),) * 2),
        (resource.RLIMIT_CORE, (0, 0)),
        (resource.RLIMIT_MEMLOCK, (0, 0)),
    ]
    if spec.get("nproc") is not None:                   # per-uid: only meaningful with a dedicated uid per job slot
        pairs.append((resource.RLIMIT_NPROC, (int(spec["nproc"]),) * 2))
    for which, value in pairs:
        resource.setrlimit(which, value)


def main() -> None:
    try:
        spec = json.loads(sys.argv[1])
    except Exception:  # noqa: BLE001
        _fail("bad spec")
    try:
        os.chdir(spec["workdir"])
        if os.geteuid() == 0:
            _drop_privileges(int(spec["uid"]), int(spec["gid"]))
        elif not spec.get("allow_unprivileged"):
            _fail("runner is not root, so the job cannot get a separate uid (set RUNNER_ALLOW_INSECURE_DEV=1 for local development only)")
        _limits(spec)
        os.closerange(3, 1 << 16)
        seccomp_filter.install()
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001
        _fail(f"{type(exc).__name__}: {exc}")
    argv = [str(a) for a in spec["argv"]]
    env = {str(k): str(v) for k, v in spec["env"].items()}
    try:
        os.execve(argv[0], argv, env)
    except OSError as exc:
        _fail(f"exec failed: {exc}")


if __name__ == "__main__":
    main()
