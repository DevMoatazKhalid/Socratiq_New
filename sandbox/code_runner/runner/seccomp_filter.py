"""A small seccomp-BPF filter installed in the child right before untrusted code is exec'd.

Why hand-written BPF: it needs no third-party library (libseccomp bindings are not in the stdlib) and the rules are few enough to review.
The filter is a deny-list on top of the container's own (Docker/gVisor) seccomp profile; it exists so that the guarantees below hold
per process even when the container runtime's profile is permissive:

* no network sockets of any family except AF_UNIX (so no TCP/UDP/raw/netlink/packet traffic, whatever the container network allows);
* no debugging or reading of other processes (ptrace, process_vm_*), no namespace / mount / module / keyring / bpf / perf / io_uring calls;
* no new sessions or process groups (setsid / setpgid), so a job can never leave the process group the runner kills on timeout.

Anything else is allowed (CPython needs a broad set of ordinary calls). A syscall from a foreign ABI (x32 on x86_64, or a mismatching
audit arch) kills the process: those are the classic ways around a filter that only checks syscall numbers.
"""
from __future__ import annotations

import ctypes
import errno
import platform
import struct

# ---------------------------------------------------------------- BPF / seccomp constants (linux/filter.h, linux/seccomp.h, linux/audit.h)
BPF_LD_W_ABS = 0x20          # BPF_LD | BPF_W | BPF_ABS
BPF_JEQ_K = 0x15             # BPF_JMP | BPF_JEQ | BPF_K
BPF_JGE_K = 0x35             # BPF_JMP | BPF_JGE | BPF_K
BPF_RET_K = 0x06             # BPF_RET | BPF_K

SECCOMP_RET_KILL_PROCESS = 0x80000000
SECCOMP_RET_ERRNO = 0x00050000
SECCOMP_RET_ALLOW = 0x7FFF0000

PR_SET_NO_NEW_PRIVS = 38
PR_SET_SECCOMP = 22
SECCOMP_MODE_FILTER = 2

OFF_NR, OFF_ARCH, OFF_ARG0 = 0, 4, 16      # struct seccomp_data: int nr; __u32 arch; __u64 ip; __u64 args[6] (little-endian low word first)

AF_UNIX = 1
X32_SYSCALL_BIT = 0x40000000

_DENIED = ("ptrace", "process_vm_readv", "process_vm_writev", "mount", "umount2", "pivot_root", "chroot", "unshare", "setns",
           "keyctl", "add_key", "request_key", "bpf", "perf_event_open", "userfaultfd", "kexec_load", "init_module",
           "finit_module", "delete_module", "swapon", "swapoff", "reboot", "setsid", "setpgid",
           "io_uring_setup", "io_uring_enter", "io_uring_register",
           "open_tree", "move_mount", "fsopen", "fsconfig", "fsmount", "fspick", "mount_setattr")

ARCHES = {
    # audit arch, syscall numbers (arch/x86/entry/syscalls/syscall_64.tbl)
    "x86_64": (0xC000003E, {
        "socket": 41, "ptrace": 101, "process_vm_readv": 310, "process_vm_writev": 311, "mount": 165, "umount2": 166,
        "pivot_root": 155, "chroot": 161, "unshare": 272, "setns": 308, "keyctl": 250, "add_key": 248, "request_key": 249,
        "bpf": 321, "perf_event_open": 298, "userfaultfd": 323, "kexec_load": 246, "init_module": 175, "finit_module": 313,
        "delete_module": 176, "swapon": 167, "swapoff": 168, "reboot": 169, "setsid": 112, "setpgid": 109,
        "io_uring_setup": 425, "io_uring_enter": 426, "io_uring_register": 427, "open_tree": 428, "move_mount": 429,
        "fsopen": 430, "fsconfig": 431, "fsmount": 432, "fspick": 433, "mount_setattr": 442}),
    # include/uapi/asm-generic/unistd.h
    "aarch64": (0xC00000B7, {
        "socket": 198, "ptrace": 117, "process_vm_readv": 270, "process_vm_writev": 271, "mount": 40, "umount2": 39,
        "pivot_root": 41, "chroot": 51, "unshare": 97, "setns": 268, "keyctl": 219, "add_key": 217, "request_key": 218,
        "bpf": 280, "perf_event_open": 241, "userfaultfd": 282, "kexec_load": 104, "init_module": 105, "finit_module": 273,
        "delete_module": 106, "swapon": 224, "swapoff": 225, "reboot": 142, "setsid": 157, "setpgid": 154,
        "io_uring_setup": 425, "io_uring_enter": 426, "io_uring_register": 427, "open_tree": 428, "move_mount": 429,
        "fsopen": 430, "fsconfig": 431, "fsmount": 432, "fspick": 433, "mount_setattr": 442}),
}


class SeccompUnavailable(RuntimeError):
    pass


def _ins(code: int, jt: int, jf: int, k: int) -> bytes:
    return struct.pack("=HBBI", code, jt, jf, k & 0xFFFFFFFF)


def build_program(machine: str | None = None) -> bytes:
    machine = machine or platform.machine()
    if machine not in ARCHES:
        raise SeccompUnavailable(f"no seccomp syscall table for architecture {machine!r}")
    audit_arch, nr = ARCHES[machine]
    deny_eperm = SECCOMP_RET_ERRNO | errno.EPERM
    prog = [
        _ins(BPF_LD_W_ABS, 0, 0, OFF_ARCH),
        _ins(BPF_JEQ_K, 1, 0, audit_arch),          # right ABI -> skip the kill
        _ins(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS),
        _ins(BPF_LD_W_ABS, 0, 0, OFF_NR),
    ]
    if machine == "x86_64":                         # x32 ABI shares the arch value: refuse it explicitly
        prog += [_ins(BPF_JGE_K, 0, 1, X32_SYSCALL_BIT), _ins(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS)]
    # socket(domain, ...): only AF_UNIX. Afterwards the accumulator still holds nr (the LD of arg0 is skipped when nr != socket).
    prog += [
        _ins(BPF_JEQ_K, 0, 4, nr["socket"]),
        _ins(BPF_LD_W_ABS, 0, 0, OFF_ARG0),
        _ins(BPF_JEQ_K, 0, 1, AF_UNIX),
        _ins(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW),
        _ins(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | errno.EACCES),
    ]
    for name in _DENIED:
        prog += [_ins(BPF_JEQ_K, 0, 1, nr[name]), _ins(BPF_RET_K, 0, 0, deny_eperm)]
    prog.append(_ins(BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW))
    return b"".join(prog)


class _SockFprog(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.c_void_p)]


def install() -> None:
    """Install the filter for the CURRENT process (inherited by everything it execs or forks). Irreversible."""
    program = build_program()
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        raise SeccompUnavailable(f"PR_SET_NO_NEW_PRIVS failed: errno {ctypes.get_errno()}")
    buf = ctypes.create_string_buffer(program, len(program))
    fprog = _SockFprog(len(program) // 8, ctypes.cast(buf, ctypes.c_void_p).value)
    if libc.prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, ctypes.addressof(fprog), 0, 0) != 0:
        raise SeccompUnavailable(f"PR_SET_SECCOMP failed: errno {ctypes.get_errno()}")
