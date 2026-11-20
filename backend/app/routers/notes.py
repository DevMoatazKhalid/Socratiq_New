"""Student notes: a personal notes space, independent of any course or conversation.

Ownership is enforced here on every statement (student_id = the authenticated student); a note id that is not yours behaves exactly like one
that does not exist. Writes are safe to retry:
  * create uses a client-chosen id, so a retried create returns the note it already made instead of making a second one;
  * update carries the version the text is based on; a lost-response retry of the same text is recognised and answered as saved, while a
    different edit made meanwhile (another tab or device) is reported as a conflict instead of being silently overwritten.
"""
from __future__ import annotations

import re
from typing import Optional

from fastapi import APIRouter, Depends, Query, Response

from ..auth import CurrentUser, get_db, require_student
from ..db import Database, many, one
from ..errors import AppError, conflict, not_found
from ..ratelimit import notes_write_rate_limit
from ..schemas import NOTE_ID, NoteCreateIn, NotePatchIn
from ..views import iso

router = APIRouter(prefix="/student/notes", tags=["notes"])
_ID = re.compile(NOTE_ID)
PREVIEW_CHARS = 240
LIST_LIMIT = 500


def note_view(r) -> dict:
    return {"id": r["note_id"], "title": r["title"], "content": r["content"], "version": r["version"], "source_kind": r["source_kind"],
            "source_ref": r["source_ref"], "created_at": iso(r["created_at"]), "updated_at": iso(r["updated_at"])}


def summary_view(r) -> dict:
    return {"id": r["note_id"], "title": r["title"], "preview": r["preview"], "version": r["version"], "source_kind": r["source_kind"],
            "source_ref": r["source_ref"], "created_at": iso(r["created_at"]), "updated_at": iso(r["updated_at"])}


def _own(c, user: CurrentUser, note_id: str):
    if not _ID.match(note_id):
        return None
    return one(c, "SELECT * FROM student_notes WHERE note_id = %s AND student_id = %s", (note_id, user.user_id))


def _like(q: str) -> str:
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


@router.get("")
def list_notes(q: Optional[str] = Query(default=None, max_length=100), user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    """All of the student's notes, newest first, as summaries (the full text is fetched per note). `q` filters title and text."""
    params: list = [PREVIEW_CHARS, user.user_id]
    where = "student_id = %s"
    if q and q.strip():
        where += " AND (title ILIKE %s ESCAPE '\\' OR content ILIKE %s ESCAPE '\\')"
        params += [_like(q.strip())] * 2
    with db.tx() as c:
        rows = many(c, f"""SELECT note_id, title, left(content, %s) AS preview, version, source_kind, source_ref, created_at, updated_at
                             FROM student_notes WHERE {where} ORDER BY updated_at DESC, note_id LIMIT {LIST_LIMIT}""", params)
    return {"notes": [summary_view(r) for r in rows]}


@router.get("/{note_id}")
def get_note(note_id: str, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    with db.tx() as c:
        row = _own(c, user, note_id)
    if row is None:
        raise not_found("Note not found.")
    return note_view(row)


@router.post("", status_code=201, dependencies=[Depends(notes_write_rate_limit)])
def create_note(body: NoteCreateIn, response: Response, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    with db.tx() as c:
        row = one(c, """INSERT INTO student_notes (note_id, student_id, university_id, title, content, source_kind, source_ref)
                        VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING RETURNING *""",
                  (body.id, user.user_id, user.university_id, body.title, body.content, body.source_kind, body.source_ref))
        if row is not None:
            return note_view(row)
        response.status_code = 200
        mine = _own(c, user, body.id)
        if mine is not None:                                              # a retried create: the note already exists, nothing new is made
            return note_view(mine)
        if body.source_ref is not None:
            dup = one(c, "SELECT * FROM student_notes WHERE student_id = %s AND source_kind = %s AND source_ref = %s",
                      (user.user_id, body.source_kind, body.source_ref))
            if dup is not None:                                           # this Coach reply is already in the student's notes
                return {**note_view(dup), "duplicate": True}
    raise conflict("Please try saving again.", code="id_conflict")       # the id is taken by a note that is not yours (never says whose)


@router.patch("/{note_id}", dependencies=[Depends(notes_write_rate_limit)])
def update_note(note_id: str, body: NotePatchIn, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    if not _ID.match(note_id):
        raise not_found("Note not found.")
    with db.tx() as c:
        row = one(c, """UPDATE student_notes SET title = COALESCE(%s, title), content = COALESCE(%s, content), version = version + 1
                         WHERE note_id = %s AND student_id = %s AND version = %s RETURNING *""",
                  (body.title, body.content, note_id, user.user_id, body.base_version))
        if row is not None:
            return note_view(row)
        cur = _own(c, user, note_id)
    if cur is None:
        raise not_found("Note not found.")
    same = (body.title is None or body.title == cur["title"]) and (body.content is None or body.content == cur["content"])
    if same:                                                              # the same save arriving again (its first response was lost)
        return note_view(cur)
    raise AppError(409, "This note was changed somewhere else.", code="version_conflict")


@router.delete("/{note_id}", status_code=204, dependencies=[Depends(notes_write_rate_limit)])
def delete_note(note_id: str, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    if not _ID.match(note_id):
        raise not_found("Note not found.")
    with db.tx() as c:
        row = one(c, "DELETE FROM student_notes WHERE note_id = %s AND student_id = %s RETURNING note_id", (note_id, user.user_id))
    if row is None:
        raise not_found("Note not found.")
    return Response(status_code=204)
