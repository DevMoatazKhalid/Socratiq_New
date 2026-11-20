"""
SmartBoard authorship authentication and tamper prevention.
Enforces that:
1. Coach element IDs issued by the server are cryptographically signed and tied to the student attempt.
2. Students cannot claim coach authorship by simply prefixing an ID (e.g. 'ai_', 'v_', 'sim_').
3. Modifications to coach elements by students are tracked with provenance ('original_author': 'coach', 'student_modified': True).
4. Trusted server-side evidence (HMAC signature or database event registration) is required to grant 'author': 'coach' to any new element.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import time
from typing import Optional

from .config import get_backend_config
from .db import one


def _get_secret() -> bytes:
    """The HMAC key for Coach element ids and visual grants. Resolved by config (see `BackendConfig.board_signing_key`):
    an explicit BOARD_SIGNING_SECRET, else FILE_LINK_SECRET, else a key derived from the server-only Supabase service-role key.
    There is deliberately NO constant fallback: a key that ships with the source code lets anyone forge Coach authorship."""
    return get_backend_config().board_signing_key()


def sign_coach_element_id(attempt_id: str, prefix: str = "ai") -> str:
    """Generate a server-issued element ID with an HMAC signature tied to the student's attempt."""
    raw = secrets.token_hex(4)  # 8 hex characters
    secret = _get_secret()
    msg = f"{attempt_id}:{prefix}:{raw}".encode("utf-8")
    sig = hmac.new(secret, msg, hashlib.sha256).hexdigest()[:8]
    return f"{prefix}_{raw}_{sig}"


def verify_coach_element_id(attempt_id: str, element_id: Optional[str]) -> bool:
    """Verify whether an element ID contains a valid HMAC signature issued by the server for this attempt."""
    if not element_id or not isinstance(element_id, str):
        return False
    parts = element_id.split("_")
    if len(parts) < 3:
        return False
    prefix = parts[0]
    raw = parts[1]
    sig = parts[2]
    secret = _get_secret()
    msg = f"{attempt_id}:{prefix}:{raw}".encode("utf-8")
    expected = hmac.new(secret, msg, hashlib.sha256).hexdigest()[:8]
    return hmac.compare_digest(sig, expected)


def is_registered_coach_element(conn, attempt_id: str, element_id: Optional[str]) -> bool:
    """Check if the element ID was recorded in learning_events telemetry as coach-authored for this attempt."""
    if not element_id or not isinstance(element_id, str):
        return False
    try:
        row = one(conn, """
            SELECT 1 FROM learning_events
             WHERE attempt_id = %s
               AND event_type = 'AI_INTERACTION'
               AND payload->'coach_element_ids' ? %s
             LIMIT 1
        """, (attempt_id, element_id))
        return row is not None
    except Exception:
        return False


# ----------------------------------------------------------------------------------------------------------------------------------------------
# Visual grants: the server's permission for the board to draw ONE Coach-initiated visual. Issued only inside a validated Coach turn, bound to the
# student, the attempt, the kind and the exact plan, short-lived, and single-use (redemption is recorded; see brain.redeem_visual_grant).
# ----------------------------------------------------------------------------------------------------------------------------------------------
VISUAL_GRANT_TTL_SECONDS = 600


def visual_plan_hash(plan: dict) -> str:
    body = json.dumps({k: plan.get(k) for k in ("kind", "request", "why", "explore_prompt")}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:24]


def _grant_sig(attempt_id: str, student_id: str, grant_id: str, kind: str, plan_hash: str, exp: int) -> str:
    msg = f"vg1|{attempt_id}|{student_id}|{grant_id}|{kind}|{plan_hash}|{exp}".encode("utf-8")
    return hmac.new(_get_secret(), msg, hashlib.sha256).hexdigest()[:32]


def sign_visual_grant(*, attempt_id: str, student_id: str, grant_id: str, kind: str, plan_hash: str, now: Optional[float] = None) -> str:
    exp = int((now if now is not None else time.time()) + VISUAL_GRANT_TTL_SECONDS)
    return f"{grant_id}.{exp}.{_grant_sig(attempt_id, student_id, grant_id, kind, plan_hash, exp)}"


def grant_id_of(token: Optional[str]) -> Optional[str]:
    parts = (token or "").split(".")
    return parts[0] if len(parts) == 3 and parts[0] and parts[1].isdigit() else None


def verify_visual_grant(token: Optional[str], *, attempt_id: str, student_id: str, kind: str, plan_hash: str, now: Optional[float] = None) -> str:
    """'ok' | 'expired' | 'invalid'. The signature is checked before the expiry is trusted."""
    gid = grant_id_of(token)
    if gid is None:
        return "invalid"
    _, exp_s, sig = token.split(".")
    exp = int(exp_s)
    if not hmac.compare_digest(sig, _grant_sig(attempt_id, student_id, gid, kind, plan_hash, exp)):
        return "invalid"
    return "ok" if (now if now is not None else time.time()) <= exp else "expired"
