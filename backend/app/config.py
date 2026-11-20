"""
Backend configuration.

All values come from environment variables (or the project's .env, which is never committed). Blank = unset.
No secrets live in code. Historical variable names are accepted as aliases so existing deployments keep working:
  CORS_ORIGINS | CORS_ALLOWED_ORIGINS,   SUPABASE_BUCKET | STORAGE_BUCKET.
`validate()` reports every problem at once; in production the app refuses to start on any of them.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from pathlib import Path
from typing import List, Optional, Tuple

from dotenv import load_dotenv

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_ENV_PATH = _PROJECT_ROOT / ".env"
load_dotenv(dotenv_path=_ENV_PATH if _ENV_PATH.is_file() else None)   # never overrides real environment variables


def _clean(*names: str) -> Optional[str]:
    for name in names:
        val = os.getenv(name)
        if val is not None and val.strip():
            return val.strip()
    return None


def _int(name: str, default: int, lo: int = 0) -> int:
    val = _clean(name)
    if val is None:
        return default
    try:
        n = int(val)
    except ValueError:
        raise ValueError(f"{name} must be an integer, got {val!r}") from None
    if n < lo:
        raise ValueError(f"{name} must be >= {lo}")
    return n


class BackendConfig:
    def __init__(self) -> None:
        env = (_clean("ENVIRONMENT") or "development").lower()
        self.environment: str = "production" if env in ("prod", "production") else env
        self.project_root: Path = _PROJECT_ROOT

        # --- Postgres (transactions, RLS-bypassing service connection; authorisation lives in app/access.py)
        self.database_url: Optional[str] = _clean("DATABASE_URL")
        self.db_pool_min: int = _int("DB_POOL_MIN", 1, 1)
        self.db_pool_max: int = _int("DB_POOL_MAX", 10, 1)

        # --- Supabase (Auth + Storage). The service-role key is server-side only.
        self.supabase_url: Optional[str] = _clean("SUPABASE_URL")
        self.supabase_service_role_key: Optional[str] = _clean("SUPABASE_SERVICE_ROLE_KEY")
        self.storage_bucket: str = _clean("SUPABASE_BUCKET", "STORAGE_BUCKET") or "course-materials"

        # --- File storage
        default_backend = "supabase" if (self.supabase_url and self.supabase_service_role_key) else "local"
        self.storage_backend: str = (_clean("STORAGE_BACKEND") or default_backend).lower()
        self.local_storage_dir: Path = Path(_clean("LOCAL_STORAGE_DIR") or (_PROJECT_ROOT / "data" / "uploads"))
        self.file_link_secret: Optional[str] = _clean("FILE_LINK_SECRET")
        # HMAC key for SmartBoard provenance (signed Coach element ids, single-use visual grants). Optional: see board_signing_key().
        self.board_signing_secret: Optional[str] = _clean("BOARD_SIGNING_SECRET")
        self.file_link_ttl_seconds: int = _int("FILE_LINK_TTL_SECONDS", 300, 30)
        self.max_upload_mb: int = _int("MAX_UPLOAD_MB", 50, 1)      # global ceiling; per-format limits are lower
        self.public_api_url: str = (_clean("PUBLIC_API_URL") or "http://localhost:8000").rstrip("/")

        # --- Ingestion worker
        self.ingest_workers: int = _int("INGEST_WORKERS", 2, 1)
        self.ingest_poll_seconds: int = _int("INGEST_POLL_SECONDS", 5, 1)
        self.ingest_max_attempts: int = _int("INGEST_MAX_ATTEMPTS", 3, 1)
        self.ingest_stale_minutes: int = _int("INGEST_STALE_MINUTES", 15, 1)
        self.run_worker: bool = (_clean("RUN_INGEST_WORKER") or "true").lower() not in ("0", "false", "no")

        # --- HTTP
        raw = _clean("CORS_ORIGINS", "CORS_ALLOWED_ORIGINS") or "http://localhost:5173"
        self.cors_origins: List[str] = [o.strip() for o in raw.split(",") if o.strip()]
        # Extra origins as ONE regular expression (for example temporary tunnels: ^https://[a-z0-9-]+\.trycloudflare\.com$).
        # Unset = none. It used to be hard-coded to every trycloudflare.com subdomain in every environment.
        self.cors_origin_regex: Optional[str] = _clean("CORS_ORIGIN_REGEX")
        # Unauthenticated Live Voice on the public /smartboard-demo page. Off unless explicitly enabled, and never in production.
        # When set, an instructor account can only be created with this code (given out by the institution). Unset = previous behaviour
        # (anyone can choose "instructor" at signup), so existing deployments keep working until an operator opts in.
        self.teacher_signup_code: Optional[str] = _clean("TEACHER_SIGNUP_CODE")
        self.public_demo_voice: bool = (_clean("SMARTBOARD_PUBLIC_DEMO_VOICE") or "false").lower() in ("1", "true", "yes")

        # --- Product rules
        self.ai_rate_limit_per_minute: int = _int("AI_RATE_LIMIT_PER_MINUTE", 10, 1)
        self.coach_history_window: int = _int("COACH_HISTORY_WINDOW", 10, 1)
        self.upload_rate_limit_per_minute: int = _int("UPLOAD_RATE_LIMIT_PER_MINUTE", 30, 1)

        # --- In-chat code runner. Student code NEVER runs in this process: it is sent to the isolated runner service
        # (sandbox/code_runner, see docs/CODE_RUNNER.md). Unset URL = the feature is off and the UI shows no Run buttons.
        self.code_runner_url: Optional[str] = (_clean("CODE_RUNNER_URL") or "").rstrip("/") or None
        token = _clean("CODE_RUNNER_TOKEN")
        token_file = _clean("CODE_RUNNER_TOKEN_FILE")
        if not token and token_file and Path(token_file).is_file():
            token = Path(token_file).read_text(encoding="utf-8").strip() or None
        self.code_runner_token: Optional[str] = token
        # Server-side limits for every run. The browser cannot change them, and the runner clamps them again to its own maxima.
        self.code_runner_timeout_ms: int = _int("CODE_RUNNER_TIMEOUT_MS", 5000, 500)
        self.code_runner_memory_mb: int = _int("CODE_RUNNER_MEMORY_MB", 256, 32)
        self.code_runner_output_bytes: int = _int("CODE_RUNNER_OUTPUT_BYTES", 64 * 1024, 1024)
        self.code_run_rate_limit_per_minute: int = _int("CODE_RUN_RATE_LIMIT_PER_MINUTE", 12, 1)
        # Development only: accept a runner started without uid separation (RUNNER_ALLOW_INSECURE_DEV on the runner). Refused in production.
        self.code_runner_allow_insecure: bool = (_clean("CODE_RUNNER_ALLOW_INSECURE_DEV") or "false").lower() in ("1", "true", "yes")

    # ------------------------------------------------------------------
    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    def link_secret(self) -> str:
        """HMAC key for local-storage download links. Random per process in dev; must be set in production."""
        if self.file_link_secret:
            return self.file_link_secret
        if self.is_production:
            raise RuntimeError("FILE_LINK_SECRET is required in production")
        if not hasattr(self, "_dev_secret"):
            self._dev_secret = secrets.token_urlsafe(32)
        return self._dev_secret

    def board_signing_key(self) -> bytes:
        """HMAC key for SmartBoard provenance. Order: BOARD_SIGNING_SECRET, FILE_LINK_SECRET, then a key DERIVED from the
        Supabase service-role key (server-only, required in production, stable across restarts, so no extra setting is needed).
        Development without any of them gets a random per-process key. Never a constant: a constant ships with the source code."""
        if self.board_signing_secret:
            return self.board_signing_secret.encode("utf-8")
        if self.file_link_secret:
            return self.file_link_secret.encode("utf-8")
        if self.supabase_service_role_key:
            return hmac.new(self.supabase_service_role_key.encode("utf-8"), b"socratiq/board-signing/v1", hashlib.sha256).digest()
        if self.is_production:
            raise RuntimeError("BOARD_SIGNING_SECRET (or SUPABASE_SERVICE_ROLE_KEY) is required in production")
        if not hasattr(self, "_dev_board_key"):
            self._dev_board_key = secrets.token_bytes(32)
        return self._dev_board_key

    def require_supabase(self) -> Tuple[str, str]:
        missing = [n for n, v in (("SUPABASE_URL", self.supabase_url),
                                  ("SUPABASE_SERVICE_ROLE_KEY", self.supabase_service_role_key)) if not v]
        if missing:
            raise RuntimeError(f"Missing required environment variables: {', '.join(missing)}")
        return self.supabase_url, self.supabase_service_role_key  # type: ignore[return-value]

    def validate(self) -> List[str]:
        """Every configuration problem, human-readable. Production refuses to start when this is non-empty."""
        problems: List[str] = []
        if not self.database_url:
            problems.append("DATABASE_URL is required")
        if self.storage_backend not in ("supabase", "local"):
            problems.append("STORAGE_BACKEND must be 'supabase' or 'local'")
        if self.db_pool_min > self.db_pool_max:
            problems.append("DB_POOL_MIN must be <= DB_POOL_MAX")
        if self.code_runner_url:
            if not self.code_runner_url.startswith(("http://", "https://")):
                problems.append("CODE_RUNNER_URL must be an http(s) URL")
            if not self.code_runner_token or len(self.code_runner_token) < 32:
                problems.append("CODE_RUNNER_TOKEN (or CODE_RUNNER_TOKEN_FILE) of at least 32 characters is required when CODE_RUNNER_URL is set")
        if self.code_runner_timeout_ms > 15000:
            problems.append("CODE_RUNNER_TIMEOUT_MS must be <= 15000")
        if self.is_production:
            if not (self.supabase_url and self.supabase_service_role_key):
                problems.append("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required in production (Auth)")
            if "*" in self.cors_origins:
                problems.append("CORS_ORIGINS must list explicit origins in production (no '*')")
            if self.storage_backend == "local":
                problems.append("STORAGE_BACKEND=local is not allowed in production; use Supabase Storage")
            if self.code_runner_allow_insecure:
                problems.append("CODE_RUNNER_ALLOW_INSECURE_DEV must be off in production (it accepts a runner without uid separation)")
            if self.public_demo_voice:
                problems.append("SMARTBOARD_PUBLIC_DEMO_VOICE must be off in production (it opens unauthenticated Gemini Live sessions)")
        return problems


_config: Optional[BackendConfig] = None


def get_backend_config() -> BackendConfig:
    global _config
    if _config is None:
        _config = BackendConfig()
    return _config


def reset_backend_config() -> None:   # tests
    global _config
    _config = None
