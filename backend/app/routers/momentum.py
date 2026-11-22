"""Student study momentum: streak, progress toward the next milestone, and celebrations not yet seen (see app/momentum.py)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, Query

from .. import grading, momentum
from ..auth import CurrentUser, get_db, require_student
from ..db import Database, many, one
from ..errors import AppError
from ..schemas import MomentumSeenIn
from ..views import iso

router = APIRouter(prefix="/student", tags=["momentum"])

_DAYS = """
SELECT DISTINCT (ts AT TIME ZONE %(tz)s)::date AS d FROM (
  SELECT created_at AS ts FROM ai_interactions WHERE student_id = %(s)s AND created_at > now() - interval '400 days'
  UNION ALL SELECT submitted_at FROM submissions WHERE student_id = %(s)s AND submitted_at > now() - interval '400 days'
  UNION ALL SELECT completed_at FROM verification_runs WHERE student_id = %(s)s AND completed_at > now() - interval '400 days'
  UNION ALL SELECT updated_at FROM student_notes WHERE student_id = %(s)s AND updated_at > now() - interval '400 days'
) x"""


def _tz(tz: Optional[str]) -> str:
    name = (tz or "UTC").strip() or "UTC"
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        raise AppError(422, "Unknown time zone.", "bad_timezone") from None
    return name


@router.get("/momentum")
def get_momentum(tz: Optional[str] = Query(default=None, max_length=64), user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    tz_name = _tz(tz)
    with db.tx() as c:
        today = one(c, "SELECT (now() AT TIME ZONE %s)::date AS d", (tz_name,))["d"]
        days = {r["d"] for r in many(c, _DAYS, {"tz": tz_name, "s": user.user_id})}
        submitted = one(c, "SELECT count(DISTINCT assignment_id)::int AS n FROM submissions WHERE student_id=%s", (user.user_id,))["n"]
        verified = one(c, "SELECT count(*)::int AS n FROM verification_runs WHERE student_id=%s AND status='COMPLETED' AND overall_outcome='PASS'", (user.user_id,))["n"]
        graded = many(c, """
            SELECT DISTINCT ON (s.assignment_id) s.submission_id, s.assignment_id, s.score, s.max_score, s.graded_at, a.title, a.course_id
              FROM submissions s JOIN attempts t ON t.attempt_id = s.attempt_id JOIN assignments a ON a.assignment_id = s.assignment_id
              JOIN enrollments e ON e.student_id = s.student_id AND e.classroom_id = a.classroom_id AND e.status = 'active'
             WHERE s.student_id = %s ORDER BY s.assignment_id, t.attempt_number DESC""", (user.user_id,))
        ready = grading.ready(c)
        seen = {r["key"] for r in many(c, "SELECT key FROM student_celebrations WHERE student_id=%s", (user.user_id,))} if ready else set()
    recent = datetime.now(timezone.utc) - timedelta(days=momentum.GRADE_WINDOW_DAYS)
    done = sorted((g for g in graded if g["score"] is not None and g["graded_at"]), key=lambda g: g["graded_at"])
    pct = {g["submission_id"]: round(float(g["score"]) / float(g["max_score"]) * 100, 1) for g in done}
    releases = []
    for i, g in enumerate(done):
        if g["graded_at"] < recent:
            continue
        before = [pct[x["submission_id"]] for x in done[:i]]
        releases.append({"submission_id": g["submission_id"], "assignment_id": g["assignment_id"], "course_id": g["course_id"], "title": g["title"],
                         "percentage": pct[g["submission_id"]], "previous_average": round(sum(before) / len(before), 1) if before else None})
    releases.reverse()                                                    # newest first
    st = momentum.streak(days, today)
    return {"today": today.isoformat(), "streak": st,
            "totals": {"submissions": submitted, "verified": verified, "graded": len(done), "active_days_30": sum(1 for d in days if (today - d).days < 30)},
            "next": {"streak": momentum.next_tier(st["current"], momentum.STREAK_TIERS), "submissions": momentum.next_tier(submitted, momentum.SUBMISSION_TIERS),
                     "verified": momentum.next_tier(verified, momentum.VERIFIED_TIERS)},
            "last_active": iso(max(days)) if days else None,
            # without migration 020 nothing could be marked as seen, so nothing is offered (it would repeat on every visit)
            "celebrations": momentum.celebrations(today=today, days=days, submissions=submitted, verified=verified, grades=releases, seen=seen) if ready else []}


@router.post("/momentum/seen", status_code=204)
def mark_seen(body: MomentumSeenIn, user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    with db.tx() as c:
        if not grading.ready(c):
            return None
        for key in dict.fromkeys(body.keys):
            c.execute("INSERT INTO student_celebrations (student_id, university_id, key) VALUES (%s,%s,%s) ON CONFLICT DO NOTHING",
                      (user.user_id, user.university_id, key))
    return None
