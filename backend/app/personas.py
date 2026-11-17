"""Backend side of the Teaching Persona system: the student's stored choice, and its attribution.

The persona itself (what it means, how it is worded) lives in `ai/brain/personas.py`. This module only stores WHICH persona a student chose and reads
it back for every channel. The client never sends a persona with a Coach request: the server reads the stored choice, so a persona selected in
Chat is the one the board and Live Voice use too, and a forged request field cannot change it. A missing or unknown value is the default persona.
A persona carries no authority: it never touches the assignment policy (see `ai/brain/personas.py`).
"""
from __future__ import annotations

from typing import Optional

from ai.brain.personas import DEFAULT_PERSONA_ID, get_persona, persona_ids, persona_public_view, persona_ref

from .auth import CurrentUser
from .db import one
from .errors import AppError
from .records import insert_event

OPEN_ATTEMPT = ("DRAFT", "IN_PROGRESS")


def load_persona(c, user: CurrentUser) -> dict:
    """{'id', 'version'} the student chose, as the registry defines it TODAY (so attribution always names a persona version that really exists)."""
    row = one(c, "SELECT teaching_persona FROM student_preferences WHERE student_id=%s AND university_id=%s", (user.user_id, user.university_id))
    return persona_ref(row["teaching_persona"] if row else DEFAULT_PERSONA_ID)


def persona_state(c, user: CurrentUser) -> dict:
    return {"personas": persona_public_view(), "selected": load_persona(c, user), "default": DEFAULT_PERSONA_ID}


def save_persona(c, user: CurrentUser, persona_id: str, assignment_id: Optional[str] = None) -> dict:
    """Store the choice. Strict: an id the registry does not know is rejected (the lenient default is for READING, not for choosing).
    The change is also written to the learning timeline when it happens inside an assignment with an open attempt, so teachers and the Brain can see
    which style was active when. Re-selecting the same persona changes and records nothing. Learning memory and the session are never touched."""
    if persona_id not in persona_ids():
        raise AppError(422, "That teaching style does not exist.", "unknown_persona")
    before = load_persona(c, user)
    after = persona_ref(persona_id)
    c.execute("""INSERT INTO student_preferences (student_id, university_id, teaching_persona, persona_version) VALUES (%s,%s,%s,%s)
                 ON CONFLICT (student_id) DO UPDATE SET teaching_persona=EXCLUDED.teaching_persona, persona_version=EXCLUDED.persona_version, updated_at=now()""",
              (user.user_id, user.university_id, after["id"], after["version"]))
    if assignment_id and before["id"] != after["id"]:
        _record_change(c, user, assignment_id, before, after)
    return after


def _record_change(c, user: CurrentUser, assignment_id: str, before: dict, after: dict) -> Optional[str]:
    att = one(c, """SELECT a.attempt_id, a.assignment_id, s.session_id FROM attempts a
                      LEFT JOIN ai_sessions s ON s.attempt_id = a.attempt_id AND s.status='ACTIVE'
                     WHERE a.student_id=%s AND a.university_id=%s AND a.assignment_id=%s AND a.status = ANY(%s) ORDER BY a.attempt_number DESC LIMIT 1""",
              (user.user_id, user.university_id, assignment_id, list(OPEN_ATTEMPT)))
    if att is None:
        return None
    return insert_event(c, student_id=user.user_id, university_id=user.university_id, event_type="AI_INTERACTION", assignment_id=att["assignment_id"],
                        session_id=att["session_id"], attempt_id=att["attempt_id"],
                        payload={"channel": "persona", "stage": "changed", "from": before, "persona": after})
