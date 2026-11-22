"""Grade exports for instructors: the whole course gradebook, or one assignment, as a formatted Excel workbook (see app/exports.py)."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response

from .. import grading
from ..access import teacher_assignment, teacher_course
from ..auth import CurrentUser, get_db, require_professor
from ..db import Database, many
from ..errors import AppError
from ..exports import build_gradebook, export_filename

router = APIRouter(prefix="/teacher", tags=["exports"])
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _tz(tz: Optional[str]) -> str:
    name = (tz or "UTC").strip() or "UTC"
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise AppError(422, f"Unknown time zone “{name[:60]}”.", "bad_timezone") from None
    return name


def _name(first, last, fallback="") -> str:
    return " ".join(p for p in (first, last) if p) or fallback


def _gather(c, user: CurrentUser, course: dict, assignment_ids: Optional[list[str]], include_inactive: bool):
    rooms = many(c, """SELECT k.classroom_id, k.name, p.first_name, p.last_name FROM classrooms k LEFT JOIN users p ON p.user_id = k.professor_id
                        WHERE k.course_id=%s ORDER BY k.created_at""", (course["course_id"],))
    owner = many(c, "SELECT first_name, last_name, email FROM users WHERE user_id=%s", (course.get("instructor_id"),)) if course.get("instructor_id") else []
    instructors = list(dict.fromkeys([_name(o["first_name"], o["last_name"], o["email"]) for o in owner] +
                                     [_name(r["first_name"], r["last_name"]) for r in rooms if r["first_name"] or r["last_name"]]))
    room_name = {r["classroom_id"]: r["name"] for r in rooms}
    asgs = many(c, """SELECT * FROM assignments WHERE course_id=%s AND status <> 'DRAFT' AND (%s::text[] IS NULL OR assignment_id = ANY(%s::text[]))
                       ORDER BY due_at NULLS LAST, created_at""", (course["course_id"], assignment_ids, assignment_ids))
    studs = many(c, """SELECT DISTINCT ON (u.user_id) u.user_id, u.first_name, u.last_name, u.email, st.student_code, e.classroom_id, e.status
                         FROM enrollments e JOIN users u ON u.user_id = e.student_id LEFT JOIN students st ON st.student_id = u.user_id
                        WHERE e.course_id=%s AND e.university_id=%s AND (%s OR e.status='active')
                        ORDER BY u.user_id, (e.status='active') DESC, e.created_at""", (course["course_id"], user.university_id, include_inactive))
    studs.sort(key=lambda s: ((s["last_name"] or "").lower(), (s["first_name"] or "").lower(), s["email"]))
    member = {(r["student_id"], r["classroom_id"]) for r in many(c, "SELECT student_id, classroom_id FROM enrollments WHERE course_id=%s", (course["course_id"],))}
    subs = many(c, """SELECT DISTINCT ON (s.student_id, s.assignment_id) s.*, t.attempt_number, gu.first_name AS g_first, gu.last_name AS g_last
                        FROM submissions s JOIN attempts t ON t.attempt_id = s.attempt_id LEFT JOIN users gu ON gu.user_id = s.graded_by
                       WHERE s.assignment_id = ANY(%s) ORDER BY s.student_id, s.assignment_id, t.attempt_number DESC""", ([a["assignment_id"] for a in asgs],)) if asgs else []
    by = {(s["student_id"], s["assignment_id"]): s for s in subs}
    now = datetime.now(timezone.utc)
    cells = {}
    for st in studs:
        for a in asgs:
            sub = by.get((st["user_id"], a["assignment_id"]))
            if sub is None:
                if a["classroom_id"] and (st["user_id"], a["classroom_id"]) not in member:
                    status = "not_assigned"
                else:
                    status = "missing" if a.get("due_at") and a["due_at"] < now else "not_submitted"
                cells[(st["user_id"], a["assignment_id"])] = {"status": status}
                continue
            src = sub.get("grade_source") or "manual"
            if src == "ai" and not sub.get("graded_by"):
                src = "ai_auto"
            cells[(st["user_id"], a["assignment_id"])] = {
                "status": "graded" if sub["score"] is not None else "ungraded", "score": sub["score"], "max_score": sub["max_score"],
                "submitted_at": sub["submitted_at"], "late": bool(a.get("due_at") and sub["submitted_at"] > a["due_at"]),
                "attempt": sub["attempt_number"], "source": src, "graded_by": _name(sub["g_first"], sub["g_last"]) or None,
                "graded_at": sub.get("graded_at"), "feedback": sub.get("feedback"), "criteria": sub.get("grade_criteria") or []}
    assignments = [{"id": a["assignment_id"], "title": a["title"], "due_at": a.get("due_at"), "points": _points(_assignment_max(a, subs)),
                    "rubric": grading.rubric_of(a)} for a in asgs]
    scale = {a["id"]: a["points"] for a in assignments}
    for (_, aid), cell in cells.items():               # a grade given on another scale (e.g. /10 on a 100-point assignment) is shown on the assignment's
        if cell["status"] == "graded" and float(cell["max_score"]) != scale[aid]:     # scale in the Gradebook; Details keeps the original score/max
            cell["points"] = round(float(cell["score"]) / float(cell["max_score"]) * scale[aid], 4)
    students = [{"id": s["user_id"], "code": s["student_code"], "first_name": s["first_name"], "last_name": s["last_name"], "email": s["email"],
                 "section": room_name.get(s["classroom_id"], ""), "status": s["status"]} for s in studs]
    return {"code": course["code"], "title": course["title"], "instructors": instructors, "sections": [r["name"] for r in rooms]}, assignments, students, cells


def _assignment_max(a: dict, subs: list[dict]) -> float:
    """The assignment's maximum: its rubric / points setting (020), else the scale its grades were given on, else 100."""
    if a.get("rubric") or a.get("points_possible"):
        return grading.total_points(a)
    scales = [float(s["max_score"]) for s in subs if s["assignment_id"] == a["assignment_id"] and s.get("max_score")]
    return max(scales) if scales else grading.DEFAULT_POINTS


def _points(v: float) -> float:
    return round(float(v), 4)


def _xlsx(data: bytes, course_code: str, scope: Optional[str]) -> Response:
    ascii_name, utf8_name = export_filename(course_code, scope, datetime.now(timezone.utc))
    return Response(content=data, media_type=XLSX, headers={
        "Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(utf8_name)}"})


@router.get("/courses/{course_id}/grades.xlsx")
def export_course(course_id: str, tz: Optional[str] = Query(default=None, max_length=64), include_feedback: bool = True, include_inactive: bool = False,
                  include_rubric: bool = True, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    """The course gradebook: Summary, Gradebook (formulas), Details, and one sheet per rubric-graded assignment."""
    tz_name = _tz(tz)
    with db.tx() as c:
        course = teacher_course(c, user, course_id)
        info, assignments, students, cells = _gather(c, user, course, None, include_inactive)
    data = build_gradebook(course=info, assignments=assignments, students=students, cells=cells, exported_by=user.name, tz_name=tz_name,
                           include_feedback=include_feedback, include_rubric=include_rubric)
    return _xlsx(data, course["code"], None)


@router.get("/assignments/{assignment_id}/grades.xlsx")
def export_assignment(assignment_id: str, tz: Optional[str] = Query(default=None, max_length=64), include_feedback: bool = True,
                      include_inactive: bool = False, include_rubric: bool = True, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    """One assignment, same workbook layout (Summary, Gradebook, Details, Rubric)."""
    tz_name = _tz(tz)
    with db.tx() as c:
        a = teacher_assignment(c, user, assignment_id)
        course = teacher_course(c, user, a["course_id"])
        info, assignments, students, cells = _gather(c, user, course, [assignment_id], include_inactive)
        if not assignments:
            raise AppError(409, "Draft assignments have no grades to export yet. Publish it first.", "assignment_draft")
    data = build_gradebook(course=info, assignments=assignments, students=students, cells=cells, exported_by=user.name, tz_name=tz_name,
                           include_feedback=include_feedback, include_rubric=include_rubric, scope_title=a["title"])
    return _xlsx(data, course["code"], a["title"])
