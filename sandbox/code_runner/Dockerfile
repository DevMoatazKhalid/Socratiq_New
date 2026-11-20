# SocratiQ code runner: executes untrusted student code. Build context = sandbox/code_runner.
#
# This image holds NO application code, secrets or credentials: only the Python runtime and the runner (stdlib only, no pip installs).
# Run it ONLY with the hardening in docker-compose.yml (read-only rootfs, tmpfs jobs dir, cap_drop ALL + the five caps it needs,
# no-new-privileges, pids/memory/cpu limits, internal-only network), and in production under gVisor (runtime: runsc). See docs/CODE_RUNNER.md.
#
# The runner process starts as root INSIDE the container (with almost every capability dropped) for one reason: so that each job can be
# given its own unprivileged uid (60000 + slot). Untrusted code never runs as root: the launcher drops to that uid, applies rlimits and a
# seccomp filter before exec, and the self-check at start-up refuses to serve if any of that is not effective.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    RUNNER_HOST=0.0.0.0 RUNNER_PORT=8080 RUNNER_JOBS_DIR=/tmp/jobs RUNNER_TOKEN_FILE=/run/secrets/code_runner_token

COPY runner /opt/code-runner/runner
RUN chmod -R a=rX,u+w /opt/code-runner && rm -rf /root/.cache

WORKDIR /opt/code-runner
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["python", "-I", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3)"]
CMD ["python", "-I", "/opt/code-runner/runner/server.py"]
