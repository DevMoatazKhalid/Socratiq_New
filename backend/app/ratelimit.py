"""Per-user sliding-window limits (LLM calls, uploads, invite-code guesses). In-memory = per process;
use Redis/edge limits if you run several workers."""
from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from typing import Callable

from fastapi import Depends

from .auth import CurrentUser, get_current_user
from .config import get_backend_config
from .errors import AppError

_hits: dict[tuple[str, str], deque] = defaultdict(deque)
_lock = threading.Lock()


def limiter(name: str, per_minute: Callable[[], int], message: str):
    def dep(user: CurrentUser = Depends(get_current_user)) -> None:
        limit, now = per_minute(), time.monotonic()
        with _lock:
            q = _hits[(name, user.user_id)]
            while q and now - q[0] > 60:
                q.popleft()
            if len(q) >= limit:
                raise AppError(429, message, code="rate_limited")
            q.append(now)
    return dep


ai_rate_limit = limiter("ai", lambda: get_backend_config().ai_rate_limit_per_minute, "You're sending messages too fast. Please wait a moment.")
upload_rate_limit = limiter("upload", lambda: get_backend_config().upload_rate_limit_per_minute, "Too many uploads. Please wait a moment.")
join_rate_limit = limiter("join", lambda: 10, "Too many attempts. Please wait a minute before trying another code.")
# Per USER (these endpoints all require a signed-in user). This used to be keyed on a hash of the first 33 characters of the bearer token,
# which is the JWT header -- identical for every user of the project -- so all students shared ONE bucket and one student could lock out the rest.
smartboard_rate_limit = limiter("smartboard_gen", lambda: 20, "Too many generation requests. Please wait a moment.")
board_chat_rate_limit = limiter("board_chat", lambda: get_backend_config().ai_rate_limit_per_minute, "You're sending messages too fast. Please wait a moment.")

code_run_rate_limit = limiter("code_run", lambda: get_backend_config().code_run_rate_limit_per_minute,
                              "You're running code very quickly. Please wait a moment and try again.")
# Instructor AI grading actions (one bulk "grade all" is ONE request however many submissions it queues).
grading_rate_limit = limiter("grading", lambda: 30, "Too many AI grading requests. Please wait a moment.")
# Notes auto-save on a debounce (about one save per second of typing at most); this only stops runaway clients.
notes_write_rate_limit = limiter("notes_write", lambda: 240, "Your notes are saving too often. Please wait a moment.")


def reset_limits() -> None:   # tests
    with _lock:
        _hits.clear()
