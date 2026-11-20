# In-chat Code Runner — architecture, security and deployment

Students can run Python code blocks from SocratiQ AI replies, edit them first, and see stdout, stderr, the exit code and the run state
(Running / Completed / Failed / Stopped) under the block.

## Components

| Piece | Where | Role |
|---|---|---|
| `RunnableCodeBlock`, `CodeEditor` | `frontend/src/components/socratiq/` | Toolbar (Copy, Edit/Reset, Run / Run again / Stop, Clear), editor, output. Only languages the server reports get Run. |
| `lib/codeRunner.ts`, `lib/syntax.ts` | `frontend/src/lib/` | API client, per-block result store, display-only Python highlighter (React text nodes, never HTML). |
| `routers/code.py`, `code_runner.py` | `backend/app/` | Authenticated API, server-side limits, run ownership, rate limit, availability check. **Executes nothing.** |
| Runner service | `sandbox/code_runner/` | The only place student code runs. Stdlib-only Python, its own container. |

```
browser ──HTTPS──> FastAPI (auth, validation, limits, ownership) ──internal network, bearer token──> code-runner container
                                                                                                    └─ per job: launcher → uid 6000N, rlimits, seccomp → python main.py
```

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/v1/student/code/runtime` | `{enabled, languages[{id,label,aliases}], limits}`. `enabled:false` when the runner is not configured, unreachable, or failed its isolation self-check. |
| POST | `/api/v1/student/code/executions` | `{run_id, language, source, stdin?}` → `{run_id, language, status, exit_code, signal, stdout, stderr, stdout_truncated, stderr_truncated, duration_ms, limits}`. `status` ∈ completed, failed, timeout, memory_limit, output_limit, cancelled. |
| DELETE | `/api/v1/student/code/executions/{run_id}` | Stops one of **your** runs (202). Anyone else's run id → 404, identical to a run that does not exist. |

Students only (instructors get 403), bearer token required (401). Body: source ≤ 20 000 chars, stdin ≤ 16 000, unknown fields rejected (422), so
limits and identity can never come from the browser. One active run per student (409 `run_in_progress`), duplicate `run_id` → 409,
`CODE_RUN_RATE_LIMIT_PER_MINUTE` per student (429). If the browser disconnects, the API cancels the job.

## Security architecture and threat boundaries

Threat: a student (or a prompt-injected AI reply the student runs) submits hostile code.

1. **Never in the API process.** No `exec`/`eval`/`subprocess` of student code in `backend/`. The API forwards to the runner with
   server-chosen limits and an unguessable job id the browser never sees.
2. **Separate container, nothing to steal.** The runner image contains only Python and the runner. No `.env`, no Supabase or DB
   credentials, no AI keys. Its only secret is the backend↔runner token, read from a file the job uids cannot read.
3. **No network.** The container sits only on `code_runner_net` (`internal: true`: no internet, no database, no host). Independently, the
   seccomp filter makes `socket()` fail for every family except `AF_UNIX`, so even the internal network is unreachable from a job.
4. **Per-job uid.** Each concurrency slot runs as its own uid (60000 + slot), never root, no supplementary groups; root cannot be regained
   (`no-new-privileges`, capabilities cleared on uid change). Jobs cannot read, signal or ptrace each other or the runner (`/proc/1/environ`,
   token file, other jobs' directories are all denied — tested).
5. **Hard limits** (applied by the launcher before `execve`, clamped to operator maxima — a caller can only ask for less):
   wall-clock timeout (default 5 s), `RLIMIT_CPU`, `RLIMIT_AS`/`RLIMIT_DATA` (256 MB), `RLIMIT_NPROC` (32 per uid), `RLIMIT_FSIZE` (1 MB),
   `RLIMIT_NOFILE` (64), no core dumps; stdout/stderr capped (64 KB each) — a flooding program is killed.
6. **seccomp deny-list** on top of Docker's/gVisor's profile: ptrace, process_vm_*, mount/umount/pivot_root/chroot, unshare/setns,
   keyctl/add_key, bpf, perf_event_open, userfaultfd, module loading, kexec, swap, reboot, io_uring, new mount API, setsid/setpgid (a job
   cannot leave the process group). Foreign ABIs (x32) kill the process.
7. **Filesystem.** Read-only root filesystem; jobs write only to their own `0700` directory on a size-limited `noexec` tmpfs; the directory
   is deleted after every outcome.
8. **Cleanup.** After completion, timeout, output overflow or cancellation the runner kills the process group **and** everything owned by the
   slot uid (`kill(-1)` issued as that uid, then a `/proc` sweep); a slot whose processes cannot be killed is quarantined, never reused.
9. **Fail closed.** At start-up the runner runs probe jobs that try to open a socket, read the token file and stay root; if any succeeds it
   refuses to start. The API enables the feature only when the runner reports a passing self-check (and, in production, not insecure dev mode).

**What Docker alone does not give you.** Containers share the host kernel; a kernel exploit from inside the job is the residual risk. The
layers above shrink the reachable kernel surface, but for production run the runner under **gVisor** (`runsc`) or on a **separate VM** with no
access to your private network. That is a deployment requirement, not optional hardening.

## Deployment

1. Create the shared token (once):
   ```bash
   mkdir -p secrets && openssl rand -hex 32 > secrets/code_runner_token && chmod 600 secrets/code_runner_token
   ```
   Put the same value in `.env` as `CODE_RUNNER_TOKEN=...`, plus `CODE_RUNNER_URL=http://code-runner:8080`.
2. Production: install gVisor on the Docker host (https://gvisor.dev/docs/user_guide/install/), register the `runsc` runtime, and set
   `CODE_RUNNER_RUNTIME=runsc` in `.env`.
3. Start: `docker compose --profile code-runner up -d --build`. Check `docker compose logs code-runner` shows
   `isolation={'ok': True, 'uid_separation': True, 'network_blocked': True, 'secrets_unreadable': True, ...}`.
4. Without these settings nothing changes: `CODE_RUNNER_URL` empty ⇒ the API reports `enabled:false` and no Run buttons appear.

Hosting the API elsewhere (e.g. a PaaS without Docker): run the runner on a small dedicated VM (gVisor) reachable only from the API over a
private network or a TLS tunnel; never expose port 8080 publicly.

Runner settings (environment of the runner container): `RUNNER_MAX_CONCURRENCY` (2), `RUNNER_MAX_TIMEOUT_MS` (5000), `RUNNER_MAX_MEMORY_MB` (256),
`RUNNER_MAX_OUTPUT_BYTES` (65536), `RUNNER_MAX_CPU_SECONDS` (5), `RUNNER_MAX_PROCESSES` (32), `RUNNER_MAX_FILE_BYTES` (1 MiB),
`RUNNER_MAX_OPEN_FILES` (64), `RUNNER_BASE_UID` (60000), `RUNNER_TOKEN_FILE`, `RUNNER_JOBS_DIR`.
`RUNNER_ALLOW_INSECURE_DEV=1` (development only) lets the runner start as a normal user without uid separation; the API accepts such a runner
only when `CODE_RUNNER_ALLOW_INSECURE_DEV=true` and never in production.

## Local development without Docker

```bash
openssl rand -hex 32 > /tmp/runner_token
RUNNER_TOKEN_FILE=/tmp/runner_token RUNNER_JOBS_DIR=/tmp/sq-jobs RUNNER_ALLOW_INSECURE_DEV=1 python3 sandbox/code_runner/runner/server.py
# API (.env): CODE_RUNNER_URL=http://127.0.0.1:8080  CODE_RUNNER_TOKEN=<same token>  CODE_RUNNER_ALLOW_INSECURE_DEV=true
```
(Run the runner with `sudo` to get the full uid separation, as in the container.)

## Extending to more languages

Add a `Language` to `LANGUAGES` in `sandbox/code_runner/runner/executor.py` (install the toolchain in the runner Dockerfile), add its aliases to
`ALIASES` in `backend/app/code_runner.py`, and (optionally) a tokenizer in `frontend/src/lib/syntax.ts`. The UI shows Run only for languages
the runner reports.

## Tests

* `sandbox/code_runner/tests/test_sandbox.py` — real executions: success, syntax/runtime errors, stdin, timeout, sleeping past the deadline,
  memory, file size, output flood, fork bomb + cleanup, sockets/DNS/HTTP blocked, ptrace/unshare/setsid denied, clean environment, uid
  separation and no root regain, unreadable token / `/proc/1/environ`, no writes outside the job dir, concurrent jobs isolated from each other,
  cancellation + cleanup, busy slots, duplicate job ids, HTTP auth/validation/cancel. 30 tests as root (5 need root and skip otherwise).
* `backend/tests/test_code_runner_api.py` — API contract and authorization, plus end-to-end runs through the real runner service.
