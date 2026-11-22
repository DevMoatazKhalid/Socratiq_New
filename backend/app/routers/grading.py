"""Instructor assessment routes: grading settings (rubric, reference answer, AI mode), AI grading drafts, and releasing them as grades.
The single-student grade write stays PUT /teacher/assignments/{a}/students/{s}/grade (routers/teacher.py), which these drafts feed."""
from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, Depends, Request

from .. import grading
from ..access import teacher_assignment
from ..auth import CurrentUser, get_db, require_professor
from ..db import Database, many, one
from ..errors import AppError, conflict
from ..ratelimit import grading_rate_limit
from ..schemas import GradingReleaseIn, GradingRunIn, GradingSettingsIn, RubricSuggestIn
from ..views import grade_view, iso

router = APIRouter(prefix="/teacher", tags=["assessment"])


def _kick(request: Request) -> None:
    w = getattr(request.app.state, "grading_worker", None)
    if w is not None:
        w.kick()


def _rows(c, a) -> list[dict]:
    """One row per actively enrolled student: their latest submission, the released grade, and the latest AI draft for that submission."""
    students = many(c, """SELECT u.user_id, u.first_name, u.last_name, u.email FROM enrollments e JOIN users u ON u.user_id = e.student_id
                           WHERE e.classroom_id=%s AND e.status='active' ORDER BY u.last_name NULLS LAST, u.first_name NULLS LAST, u.user_id""", (a["classroom_id"],))
    subs = {s["student_id"]: s for s in many(c, """
        SELECT DISTINCT ON (s.student_id) s.*, t.attempt_number, gu.first_name AS g_first, gu.last_name AS g_last
          FROM submissions s JOIN attempts t ON t.attempt_id = s.attempt_id LEFT JOIN users gu ON gu.user_id = s.graded_by
         WHERE s.assignment_id=%s ORDER BY s.student_id, t.attempt_number DESC""", (a["assignment_id"],))}
    evs = {}
    if subs:
        for e in many(c, """SELECT DISTINCT ON (submission_id) * FROM grade_evaluations WHERE submission_id = ANY(%s)
                             ORDER BY submission_id, created_at DESC""", ([s["submission_id"] for s in subs.values()],)):
            evs[e["submission_id"]] = e
    h = grading.settings_hash(a)
    out = []
    for st in students:
        sub = subs.get(st["user_id"])
        name = " ".join(p for p in (st["first_name"], st["last_name"]) if p) or st["email"].split("@")[0]
        out.append({"student_id": st["user_id"], "student_name": name, "email": st["email"],
                    "submission": None if not sub else {"id": sub["submission_id"], "submitted_at": iso(sub["submitted_at"]), "attempt_number": sub["attempt_number"],
                                                        "type": sub["submission_type"], "has_text": bool((sub.get("submission_text") or "").strip())},
                    "grade": grade_view(sub),
                    "evaluation": grading.evaluation_view(evs.get(sub["submission_id"]) if sub else None, current_hash=h,
                                                          latest_submission_id=sub["submission_id"] if sub else None)})
    return out


def _counts(rows: list[dict]) -> dict:
    def ev(r):
        return r["evaluation"] or {}
    submitted = [r for r in rows if r["submission"]]
    return {"students": len(rows), "submitted": len(submitted), "graded": sum(1 for r in submitted if r["grade"]),
            "drafts_ready": sum(1 for r in submitted if not r["grade"] and ev(r).get("status") == "COMPLETED" and not ev(r).get("stale")),
            "needs_review": sum(1 for r in submitted if not r["grade"] and ev(r).get("status") == "COMPLETED" and ev(r).get("needs_review")),
            "in_progress": sum(1 for r in submitted if ev(r).get("status") in grading.ACTIVE),
            "failed": sum(1 for r in submitted if ev(r).get("status") == "FAILED"),
            "auto_released": sum(1 for r in submitted if r["grade"] and not r["grade"]["reviewed"])}


@router.get("/assignments/{assignment_id}/grading")
def grading_overview(assignment_id: str, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    with db.tx() as c:
        a = teacher_assignment(c, user, assignment_id)
        grading.require_ready(c)
        rows = _rows(c, a)
        return {"settings": grading.settings_view(a), "students": rows, "counts": _counts(rows)}


@router.put("/assignments/{assignment_id}/grading")
def update_settings(assignment_id: str, body: GradingSettingsIn, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    """Saving a rubric marks it as the instructor's (rubric_source='teacher'). Drafts made under the old settings are then shown as out of
    date; they are not deleted, and released grades are never changed by a settings edit."""
    sent = body.model_fields_set
    with db.tx() as c:
        teacher_assignment(c, user, assignment_id, lock=True)
        grading.require_ready(c)
        cols: dict = {}
        if "ai_grading" in sent and body.ai_grading:
            cols["ai_grading"] = body.ai_grading
        if "rubric" in sent and body.rubric is not None:
            cols["rubric"] = json.dumps([r.model_dump() for r in body.rubric])
            cols["rubric_source"] = "teacher" if body.rubric else "none"
            if body.rubric:
                cols["points_possible"] = round(sum(r.points for r in body.rubric), 4)
        if "points_possible" in sent and body.points_possible and "points_possible" not in cols:
            cur = one(c, "SELECT rubric FROM assignments WHERE assignment_id=%s", (assignment_id,))
            if cur and cur["rubric"] and "rubric" not in cols:
                raise AppError(422, "With a rubric, the maximum score is the sum of its criteria. Change the criterion points instead.", "points_from_rubric")
            cols["points_possible"] = body.points_possible
        for k in ("reference_answer", "grading_notes"):
            if k in sent:
                cols[k] = (getattr(body, k) or "").strip() or None
        if cols:
            sets = ", ".join(f"{k} = %({k})s" + ("::jsonb" if k == "rubric" else "") for k in cols)
            c.execute(f"UPDATE assignments SET {sets}, grading_updated_at = now() WHERE assignment_id = %(aid)s", {**cols, "aid": assignment_id})
        a = one(c, "SELECT * FROM assignments WHERE assignment_id=%s", (assignment_id,))
        return {"settings": grading.settings_view(a)}


@router.post("/assignments/{assignment_id}/grading/rubric-suggestion", dependencies=[Depends(grading_rate_limit)])
def suggest_rubric(assignment_id: str, body: RubricSuggestIn, request: Request, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    """A rubric drafted by the AI from the assignment's instructions. NOT saved: the instructor edits it and saves it with PUT .../grading."""
    with db.tx() as c:
        a = teacher_assignment(c, user, assignment_id)
        grading.require_ready(c)
        concepts = [r["name"] for r in many(c, "SELECT k.name FROM assignment_concepts ac JOIN concepts k ON k.concept_id = ac.concept_id WHERE ac.assignment_id=%s", (assignment_id,))]
    total = float(body.points_possible or a.get("points_possible") or grading.DEFAULT_POINTS)
    criteria = request.app.state.ai.suggest_rubric(title=a["title"], instructions=a["instructions"] or "", subject_area=a.get("subject_area"),
                                                   is_programming=bool(a.get("is_programming")), total_points=total,
                                                   reference_answer=a.get("reference_answer"), concepts=concepts)
    return {"criteria": criteria, "points_possible": total}


@router.post("/assignments/{assignment_id}/grading/run", status_code=202, dependencies=[Depends(grading_rate_limit)])
def run_grading(assignment_id: str, body: GradingRunIn, request: Request, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    """Queue AI drafts for the latest submissions (all, or `student_ids`). Skips work already queued, work with an up-to-date draft
    (unless `regrade`), and students who already have a released grade (unless `include_graded`)."""
    queued, skipped = 0, {"in_progress": 0, "up_to_date": 0, "graded": 0}
    with db.tx() as c:
        a = teacher_assignment(c, user, assignment_id)
        grading.require_ready(c)
        h = grading.settings_hash(a)
        subs = grading.latest_submissions(c, assignment_id, body.student_ids)
        trigger = "teacher" if body.student_ids and len(body.student_ids) == 1 else "bulk"
        for s in subs:
            if s["score"] is not None and not body.include_graded:
                skipped["graded"] += 1
                continue
            last = grading.latest_evaluation(c, s["submission_id"])
            if last and last["status"] in grading.ACTIVE:
                skipped["in_progress"] += 1
                continue
            if last and last["status"] == "COMPLETED" and last.get("rubric_hash") == h and not body.regrade:
                skipped["up_to_date"] += 1
                continue
            if grading.enqueue(c, assignment=a, submission=s, trigger=trigger, requested_by=user.user_id):
                queued += 1
            else:
                skipped["in_progress"] += 1
    if queued:
        _kick(request)
    return {"queued": queued, "skipped": skipped}


@router.post("/assignments/{assignment_id}/grading/release")
def release_drafts(assignment_id: str, body: GradingReleaseIn, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    """Release up-to-date AI drafts of UNGRADED submissions as grades (as drafted, source "ai"). Drafts flagged for review are released only
    for students named in `student_ids`; drafts with a blocking flag (text aimed at the grader, feedback quoting the reference answer) never
    are: those need the instructor to open the submission and save the grade themselves."""
    released, skipped = 0, {"needs_review": 0, "blocked": 0, "low_confidence": 0, "not_ready": 0}
    explicit = set(body.student_ids or [])
    with db.tx() as c:
        a = teacher_assignment(c, user, assignment_id)
        grading.require_ready(c)
        h = grading.settings_hash(a)
        for s in grading.latest_submissions(c, assignment_id, body.student_ids):
            if s["score"] is not None:
                continue
            ev = grading.latest_evaluation(c, s["submission_id"])
            if not ev or ev["status"] != "COMPLETED" or ev.get("rubric_hash") != h:
                skipped["not_ready"] += 1
                continue
            if any(f.get("severity") == "block" for f in ev.get("flags") or []):
                skipped["blocked"] += 1
                continue
            if ev["needs_review"] and s["student_id"] not in explicit:
                skipped["needs_review"] += 1
                continue
            if float(ev["confidence"]) < body.min_confidence:
                skipped["low_confidence"] += 1
                continue
            sub = one(c, "SELECT * FROM submissions WHERE submission_id=%s FOR UPDATE", (s["submission_id"],))
            if sub["score"] is not None:
                continue
            grading.release(c, sub=sub, actor_id=user.user_id, score=float(ev["score"]), max_score=float(ev["max_score"]), feedback=ev["feedback"],
                            criteria=grading.student_criteria(ev["criteria"], None), source="ai", evaluation_id=ev["evaluation_id"],
                            note="released in bulk")
            released += 1
    return {"released": released, "skipped": skipped}


def _latest_submission(c, a, student_id: str):
    if not one(c, "SELECT 1 AS x FROM enrollments WHERE student_id=%s AND classroom_id=%s", (student_id, a["classroom_id"])):
        raise AppError(404, "Student not found", "not_found")
    subs = grading.latest_submissions(c, a["assignment_id"], [student_id])
    if not subs:
        raise conflict("This student has not submitted work for this assignment yet.", "not_submitted")
    return subs[0]


@router.post("/assignments/{assignment_id}/students/{student_id}/evaluation", status_code=202, dependencies=[Depends(grading_rate_limit)])
def grade_one(assignment_id: str, student_id: str, request: Request, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    """“Grade with AI” for one student: queue a fresh draft (or return the one already running). The released grade is not touched."""
    with db.tx() as c:
        a = teacher_assignment(c, user, assignment_id)
        grading.require_ready(c)
        sub = _latest_submission(c, a, student_id)
        row = grading.enqueue(c, assignment=a, submission=sub, trigger="teacher", requested_by=user.user_id) or grading.latest_evaluation(c, sub["submission_id"])
        view = grading.evaluation_view(row, current_hash=grading.settings_hash(a), latest_submission_id=sub["submission_id"])
    _kick(request)
    return {"evaluation": view}


@router.get("/assignments/{assignment_id}/students/{student_id}/evaluation")
def get_evaluation(assignment_id: str, student_id: str, user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    with db.tx() as c:
        a = teacher_assignment(c, user, assignment_id)
        grading.require_ready(c)
        sub: Optional[dict] = _latest_submission(c, a, student_id)
        return {"evaluation": grading.evaluation_view(grading.latest_evaluation(c, sub["submission_id"]), current_hash=grading.settings_hash(a),
                                                      latest_submission_id=sub["submission_id"])}
