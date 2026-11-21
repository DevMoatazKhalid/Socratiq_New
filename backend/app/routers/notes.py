"""Student notes: a personal notes space, independent of any course or conversation.

Ownership is enforced here on every statement (student_id = the authenticated student); a note id that is not yours behaves exactly like one
that does not exist. Writes are safe to retry:
  * create uses a client-chosen id, so a retried create returns the note it already made instead of making a second one;
  * update carries the version the text is based on; a lost-response retry of the same text is recognised and answered as saved, while a
    different edit made meanwhile (another tab or device) is reported as a conflict instead of being silently overwritten.

Notes board (migration 019): every note also has organisation fields -- course_id / assignment_id (where it is filed), importance, pinned -- and
can sit in any number of the student's own groups. They are changed only through PATCH /{id}/meta and the /groups routes and never bump the
text `version`, so organising a note can never conflict with editing it. If 019 has not been applied yet, the list keeps working exactly as
before (no organisation fields, no groups) and the organisation routes answer 503 with a clear message instead of failing obscurely.
"""
from __future__ import annotations

import re
from typing import Optional

from fastapi import APIRouter, Depends, Query, Response

from ..auth import CurrentUser, get_db, require_student
from ..db import Database, many, new_id, one
from ..access import student_assignment, student_course
from ..errors import AppError, conflict, not_found
from ..ratelimit import notes_write_rate_limit
from ..schemas import GROUP_ID, NOTE_ID, NoteCreateIn, NoteGroupIn, NoteGroupPatchIn, NoteMetaIn, NotePatchIn
from ..views import iso

router = APIRouter(prefix="/student/notes", tags=["notes"])
_ID = re.compile(NOTE_ID)
_GID = re.compile(GROUP_ID)
GROUP_LIMIT = 200
PREVIEW_CHARS = 240
LIST_LIMIT = 500


def _org(r, group_ids: Optional[list[str]] = None) -> dict:
    """Organisation fields; absent (an un-migrated database) means "not filed anywhere"."""
    if "pinned" not in r:
        return {}
    out = {"course_id": r["course_id"], "assignment_id": r["assignment_id"], "importance": r["importance"], "pinned": bool(r["pinned"])}
    if group_ids is not None:
        out["group_ids"] = group_ids
    return out


def note_view(r, group_ids: Optional[list[str]] = None) -> dict:
    return {"id": r["note_id"], "title": r["title"], "content": r["content"], "version": r["version"], "source_kind": r["source_kind"],
            "source_ref": r["source_ref"], "created_at": iso(r["created_at"]), "updated_at": iso(r["updated_at"]), **_org(r, group_ids)}


def summary_view(r) -> dict:
    return {"id": r["note_id"], "title": r["title"], "preview": r["preview"], "version": r["version"], "source_kind": r["source_kind"],
            "source_ref": r["source_ref"], "created_at": iso(r["created_at"]), "updated_at": iso(r["updated_at"]),
            **_org(r, list(r["group_ids"] or []) if "group_ids" in r else None)}


def group_view(r) -> dict:
    return {"id": r["group_id"], "name": r["name"], "assignment_id": r["assignment_id"], "created_at": iso(r["created_at"]), "updated_at": iso(r["updated_at"])}


def _board_ready(c) -> bool:
    """True once migration 019 is applied (organisation columns and group tables exist)."""
    return bool(one(c, "SELECT to_regclass('public.student_note_groups') IS NOT NULL AS ok")["ok"])


def _require_board(c) -> None:
    if not _board_ready(c):
        raise AppError(503, "Note organisation is not available yet: the database migration 019_notes_board.sql has not been applied.", code="notes_board_unavailable")


def _group_ids_of(c, note_id: str) -> list[str]:
    return [r["group_id"] for r in many(c, "SELECT group_id FROM student_note_group_members WHERE note_id = %s ORDER BY added_at, group_id", (note_id,))]


def _full(c, r) -> dict:
    """A note with its group ids (once 019 is applied), so every endpoint returns the same shape for the same note."""
    return note_view(r, _group_ids_of(c, r["note_id"]) if "pinned" in r else None)


def _own_group(c, user: CurrentUser, group_id: str, lock: bool = False):
    if not _GID.match(group_id):
        return None
    return one(c, f"SELECT * FROM student_note_groups WHERE group_id = %s AND student_id = %s {'FOR UPDATE' if lock else ''}", (group_id, user.user_id))


def _filing(c, user: CurrentUser, course_id: Optional[str], assignment_id: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """Validates where a note is filed. The course must be one the student is enrolled in; an assignment must be visible to the student
    and implies its course. A course/assignment that is not yours behaves like one that does not exist (404)."""
    if assignment_id is not None:
        a = student_assignment(c, user, assignment_id)
        if course_id is not None and course_id != a["course_id"]:
            raise AppError(422, "That assignment belongs to a different course.", code="course_mismatch")
        return a["course_id"], assignment_id
    if course_id is not None:
        student_course(c, user, course_id)
    return course_id, None


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
    where = "n.student_id = %s"
    if q and q.strip():
        where += " AND (n.title ILIKE %s ESCAPE '\\' OR n.content ILIKE %s ESCAPE '\\')"
        params += [_like(q.strip())] * 2
    with db.tx() as c:
        board = _board_ready(c)
        org = """, n.course_id, n.assignment_id, n.importance, n.pinned,
                   ARRAY(SELECT m.group_id FROM student_note_group_members m WHERE m.note_id = n.note_id ORDER BY m.added_at, m.group_id) AS group_ids""" if board else ""
        rows = many(c, f"""SELECT n.note_id, n.title, left(n.content, %s) AS preview, n.version, n.source_kind, n.source_ref, n.created_at, n.updated_at{org}
                             FROM student_notes n WHERE {where} ORDER BY n.updated_at DESC, n.note_id LIMIT {LIST_LIMIT}""", params)
        groups = many(c, f"SELECT * FROM student_note_groups WHERE student_id = %s ORDER BY created_at, group_id LIMIT {GROUP_LIMIT}", (user.user_id,)) if board else []
    return {"notes": [summary_view(r) for r in rows], "groups": [group_view(g) for g in groups]}


# ------------------------------------------------------------------ groups (registered before /{note_id} so "groups" is never read as a note id)
@router.post("/groups", status_code=201, dependencies=[Depends(notes_write_rate_limit)])
def create_group(body: NoteGroupIn, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    """A new group, optionally attached to one assignment, optionally filled with some of the student's notes (from any course)."""
    with db.tx() as c:
        _require_board(c)
        if body.assignment_id is not None:
            student_assignment(c, user, body.assignment_id)
        count = one(c, "SELECT count(*)::int AS n FROM student_note_groups WHERE student_id = %s", (user.user_id,))["n"]
        if count >= GROUP_LIMIT:
            raise AppError(422, f"You can have up to {GROUP_LIMIT} groups. Delete one you no longer use first.", code="group_limit")
        note_ids = list(dict.fromkeys(body.note_ids))
        if note_ids:
            mine = {r["note_id"] for r in many(c, "SELECT note_id FROM student_notes WHERE student_id = %s AND note_id = ANY(%s)", (user.user_id, note_ids))}
            if len(mine) != len(note_ids):
                raise not_found("Note not found.")
        row = one(c, """INSERT INTO student_note_groups (group_id, student_id, university_id, name, assignment_id)
                        VALUES (%s, %s, %s, %s, %s) RETURNING *""", (new_id("grp"), user.user_id, user.university_id, body.name, body.assignment_id))
        for nid in note_ids:
            c.execute("INSERT INTO student_note_group_members (group_id, note_id) VALUES (%s, %s) ON CONFLICT DO NOTHING", (row["group_id"], nid))
    return {**group_view(row), "note_ids": note_ids}


@router.patch("/groups/{group_id}", dependencies=[Depends(notes_write_rate_limit)])
def update_group(group_id: str, body: NoteGroupPatchIn, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    with db.tx() as c:
        _require_board(c)
        g = _own_group(c, user, group_id, lock=True)
        if g is None:
            raise not_found("Group not found.")
        sets, params = [], []
        if "name" in body.model_fields_set:
            sets.append("name = %s"); params.append(body.name)
        if "assignment_id" in body.model_fields_set:
            if body.assignment_id is not None:
                student_assignment(c, user, body.assignment_id)
            sets.append("assignment_id = %s"); params.append(body.assignment_id)
        row = one(c, f"UPDATE student_note_groups SET {', '.join(sets)} WHERE group_id = %s AND student_id = %s RETURNING *", (*params, group_id, user.user_id))
    return group_view(row)


@router.delete("/groups/{group_id}", status_code=204, dependencies=[Depends(notes_write_rate_limit)])
def delete_group(group_id: str, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    """Deletes the group only. Its notes are kept (they simply leave this group)."""
    with db.tx() as c:
        _require_board(c)
        if not _GID.match(group_id):
            raise not_found("Group not found.")
        row = one(c, "DELETE FROM student_note_groups WHERE group_id = %s AND student_id = %s RETURNING group_id", (group_id, user.user_id))
    if row is None:
        raise not_found("Group not found.")
    return Response(status_code=204)


@router.get("/{note_id}")
def get_note(note_id: str, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    with db.tx() as c:
        row = _own(c, user, note_id)
        if row is None:
            raise not_found("Note not found.")
        return _full(c, row)


@router.post("", status_code=201, dependencies=[Depends(notes_write_rate_limit)])
def create_note(body: NoteCreateIn, response: Response, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    with db.tx() as c:
        row = one(c, """INSERT INTO student_notes (note_id, student_id, university_id, title, content, source_kind, source_ref)
                        VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING RETURNING *""",
                  (body.id, user.user_id, user.university_id, body.title, body.content, body.source_kind, body.source_ref))
        if row is not None:
            return _full(c, row)
        response.status_code = 200
        mine = _own(c, user, body.id)
        if mine is not None:                                              # a retried create: the note already exists, nothing new is made
            return _full(c, mine)
        if body.source_ref is not None:
            dup = one(c, "SELECT * FROM student_notes WHERE student_id = %s AND source_kind = %s AND source_ref = %s",
                      (user.user_id, body.source_kind, body.source_ref))
            if dup is not None:                                           # this Coach reply is already in the student's notes
                return {**_full(c, dup), "duplicate": True}
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
            return _full(c, row)
        cur = _own(c, user, note_id)
        cur_view = _full(c, cur) if cur is not None else None
    if cur is None:
        raise not_found("Note not found.")
    same = (body.title is None or body.title == cur["title"]) and (body.content is None or body.content == cur["content"])
    if same:                                                              # the same save arriving again (its first response was lost)
        return cur_view
    raise AppError(409, "This note was changed somewhere else.", code="version_conflict")


@router.patch("/{note_id}/meta", dependencies=[Depends(notes_write_rate_limit)])
def update_note_meta(note_id: str, body: NoteMetaIn, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    """Importance, pin, course/assignment filing and group membership. Only the fields sent change. `group_ids` REPLACES the note's
    memberships with exactly that set of the student's own groups. The text `version` is not touched."""
    if not _ID.match(note_id):
        raise not_found("Note not found.")
    sent = body.model_fields_set
    with db.tx() as c:
        _require_board(c)
        cur = one(c, "SELECT * FROM student_notes WHERE note_id = %s AND student_id = %s FOR UPDATE", (note_id, user.user_id))
        if cur is None:
            raise not_found("Note not found.")
        sets, params = [], []
        if "importance" in sent:
            sets.append("importance = %s"); params.append(body.importance)
        if "pinned" in sent:
            sets.append("pinned = %s"); params.append(body.pinned)
        if "course_id" in sent or "assignment_id" in sent:
            course = body.course_id if "course_id" in sent else (None if "assignment_id" in sent and body.assignment_id is not None else cur["course_id"])
            asg = body.assignment_id if "assignment_id" in sent else (cur["assignment_id"] if course == cur["course_id"] else None)
            course, asg = _filing(c, user, course, asg)
            sets += ["course_id = %s", "assignment_id = %s"]; params += [course, asg]
        # note: the 018 trigger still refreshes updated_at (left untouched so 019 stays purely additive); `version` is not bumped
        row = one(c, f"UPDATE student_notes SET {', '.join(sets)} WHERE note_id = %s AND student_id = %s RETURNING *",
                  (*params, note_id, user.user_id)) if sets else cur
        if "group_ids" in sent:
            wanted = list(dict.fromkeys(body.group_ids or []))
            if wanted:
                mine = {r["group_id"] for r in many(c, "SELECT group_id FROM student_note_groups WHERE student_id = %s AND group_id = ANY(%s)", (user.user_id, wanted))}
                if len(mine) != len(wanted):
                    raise not_found("Group not found.")
            c.execute("""DELETE FROM student_note_group_members m USING student_note_groups g
                          WHERE m.group_id = g.group_id AND g.student_id = %s AND m.note_id = %s AND NOT (m.group_id = ANY(%s))""", (user.user_id, note_id, wanted))
            for gid in wanted:
                c.execute("INSERT INTO student_note_group_members (group_id, note_id) VALUES (%s, %s) ON CONFLICT DO NOTHING", (gid, note_id))
        return _full(c, row)


@router.delete("/{note_id}", status_code=204, dependencies=[Depends(notes_write_rate_limit)])
def delete_note(note_id: str, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    if not _ID.match(note_id):
        raise not_found("Note not found.")
    with db.tx() as c:
        row = one(c, "DELETE FROM student_notes WHERE note_id = %s AND student_id = %s RETURNING note_id", (note_id, user.user_id))
    if row is None:
        raise not_found("Note not found.")
    return Response(status_code=204)
