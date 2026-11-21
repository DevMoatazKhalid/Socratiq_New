"""
Student overview (GET /student/overview) and course insights (GET /teacher/courses/{id}/insights) for the approved dashboards.

Everything is computed on read from rows that already exist; nothing here writes, and nothing is estimated or filled in:
  * a grade is the LATEST GRADED submission of a (student, assignment) pair, as a percentage of ITS OWN maximum (scales differ per
    assignment). Ungraded work is never counted as 0 -- it is "awaiting a grade" and simply left out of averages.
  * "submitted" means at least one submission row exists for the pair.
  * a verification "succeeds" when the pair's latest COMPLETED verification run finished PASS or PARTIAL (same rule as
    analytics.verification_rate); `passed`/`total` on a run count its questions whose latest result is PASS.
  * a weekly trend point is the value AS OF the end of that week (cumulative), so a quiet week repeats the previous value instead of
    dropping to zero; the current week ends "now". Weeks start on Monday (UTC).
  * deltas compare "now" with the same value 30 days earlier, in percentage points (students: a head count). null = nothing to compare.
  * every value that has no data is null, never 0.
Scope: a student only ever sees their own rows; an instructor only the course they teach (checked by the router before these run).
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional

from .db import many
from .records import mastery_label
from .risk import spec_for
from .views import iso

WEEKS_MAX = 26
DELTA_DAYS = 30
OK_OUTCOMES = ("PASS", "PARTIAL")
BUCKETS = (("<50", 0, 50), ("50-59", 50, 60), ("60-69", 60, 70), ("70-79", 70, 80), ("80-89", 80, 90), ("90-100", 90, 101))


# ------------------------------------------------------------------ small helpers
def _r1(x: Optional[float]) -> Optional[float]:
    return None if x is None else round(float(x), 1)


def _pct(n: int, d: int) -> Optional[float]:
    return None if not d else round(100 * n / d, 1)


def _mean(xs: Iterable[float]) -> Optional[float]:
    xs = list(xs)
    return round(sum(xs) / len(xs), 1) if xs else None


def _diff(now: Optional[float], before: Optional[float]) -> Optional[float]:
    return None if now is None or before is None else round(now - before, 1)


def _name(r) -> str:
    return (" ".join(p for p in (r.get("first_name"), r.get("last_name")) if p)) or (r.get("email") or "").split("@")[0]


def _week_starts(now: datetime, weeks: int) -> list[datetime]:
    monday = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    return [monday - timedelta(weeks=weeks - 1 - i) for i in range(weeks)]


def _released(a) -> datetime:
    return a["published_at"] or a["created_at"]


class Pairs:
    """Submissions, attempts and verification runs of a set of (student, assignment) pairs, queryable at any point in time."""

    def __init__(self, c, university_id: str, student_ids: list[str], assignment_ids: list[str]):
        self.attempts: dict[str, dict] = {}
        self.subs: dict[tuple[str, str], list[dict]] = defaultdict(list)
        self.runs: dict[tuple[str, str], list[dict]] = defaultdict(list)
        if not student_ids or not assignment_ids:
            return
        p = (university_id, assignment_ids, student_ids)
        for r in many(c, """SELECT attempt_id, student_id, assignment_id, attempt_number, status, started_at FROM attempts
                             WHERE university_id = %s AND assignment_id = ANY(%s) AND student_id = ANY(%s)""", p):
            self.attempts[r["attempt_id"]] = r
        sub_attempt: dict[str, str] = {}
        for r in many(c, """SELECT submission_id, attempt_id, student_id, assignment_id, submitted_at, score, max_score, graded_at, feedback FROM submissions
                             WHERE university_id = %s AND assignment_id = ANY(%s) AND student_id = ANY(%s)""", p):
            att = self.attempts.get(r["attempt_id"])
            r = {**r, "attempt_number": att["attempt_number"] if att else 1,
                 "pct": None if r["score"] is None or not r["max_score"] else float(r["score"]) / float(r["max_score"]) * 100}
            self.subs[(r["student_id"], r["assignment_id"])].append(r)
            sub_attempt[r["submission_id"]] = r["attempt_id"]
        for r in many(c, """
            SELECT v.verification_id, v.student_id, v.assignment_id, v.attempt_id, v.submission_id, v.status, v.overall_outcome, v.created_at, v.completed_at,
                   (SELECT count(*) FROM verification_questions q WHERE q.verification_id = v.verification_id)::int AS total,
                   (SELECT count(*) FROM verification_questions q
                     WHERE q.verification_id = v.verification_id
                       AND (SELECT r.outcome FROM verification_results r WHERE r.question_id = q.question_id ORDER BY r.created_at DESC, r.result_id DESC LIMIT 1) = 'PASS')::int AS passed
              FROM verification_runs v WHERE v.university_id = %s AND v.assignment_id = ANY(%s) AND v.student_id = ANY(%s)""", p):
            r = {**r, "attempt_id": r["attempt_id"] or sub_attempt.get(r["submission_id"])}     # attempt_id was added in 009; older runs link via the submission
            self.runs[(r["student_id"], r["assignment_id"])].append(r)
        for v in self.subs.values():
            v.sort(key=lambda s: (s["attempt_number"], s["submitted_at"]))
        for v in self.runs.values():
            v.sort(key=lambda s: (s["completed_at"] or s["created_at"]))

    # -------------------------------------------------- per pair, optionally "as of" a moment
    def submitted(self, key, at: Optional[datetime] = None) -> bool:
        return any(at is None or s["submitted_at"] <= at for s in self.subs.get(key, ()))

    def latest_submission(self, key) -> Optional[dict]:
        subs = self.subs.get(key)
        return subs[-1] if subs else None

    def grade(self, key, at: Optional[datetime] = None) -> Optional[dict]:
        graded = [s for s in self.subs.get(key, ()) if s["pct"] is not None and (at is None or (s["graded_at"] and s["graded_at"] <= at))]
        return graded[-1] if graded else None

    def verification(self, key, at: Optional[datetime] = None) -> Optional[dict]:
        """Latest COMPLETED run (as of `at`)."""
        done = [r for r in self.runs.get(key, ()) if r["status"] == "COMPLETED" and r["completed_at"] and (at is None or r["completed_at"] <= at)]
        return done[-1] if done else None

    def run_for_attempt(self, key, attempt_id: Optional[str]) -> Optional[dict]:
        runs = [r for r in self.runs.get(key, ()) if attempt_id and r["attempt_id"] == attempt_id]
        return runs[-1] if runs else None

    def latest_attempt(self, student_id: str, assignment_id: str) -> Optional[dict]:
        mine = [a for a in self.attempts.values() if a["student_id"] == student_id and a["assignment_id"] == assignment_id]
        return max(mine, key=lambda a: a["attempt_number"]) if mine else None

    def status(self, student_id: str, assignment_id: str) -> str:
        """Same rule as views.student_status: not_started | in_progress | submitted | verified."""
        att = self.latest_attempt(student_id, assignment_id)
        if att is None or att["status"] == "ABANDONED":
            return "not_started"
        if att["status"] in ("DRAFT", "IN_PROGRESS"):
            return "in_progress"
        run = self.run_for_attempt((student_id, assignment_id), att["attempt_id"])
        return "verified" if run and run["status"] == "COMPLETED" else "submitted"


def _run_view(r: Optional[dict]) -> Optional[dict]:
    return None if r is None else {"status": r["status"], "outcome": r["overall_outcome"], "passed": r["passed"], "total": r["total"]}


def _point(pairs: Pairs, keys: list[tuple[str, str]], at: Optional[datetime]) -> dict[str, Optional[float]]:
    """Completion, average grade and verification success over `keys` as of `at` (None = now)."""
    grades = [g["pct"] for k in keys if (g := pairs.grade(k, at))]
    runs = [r for k in keys if (r := pairs.verification(k, at))]
    return {"completion": _pct(sum(1 for k in keys if pairs.submitted(k, at)), len(keys)), "average_grade": _mean(grades),
            "verification_success": _pct(sum(1 for r in runs if r["overall_outcome"] in OK_OUTCOMES), len(runs))}


# ================================================================== student
def student_overview(c, user, weeks: int) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    rooms = many(c, """SELECT DISTINCT course_id, classroom_id FROM enrollments
                        WHERE student_id = %s AND university_id = %s AND status = 'active' AND classroom_id IS NOT NULL""", (user.user_id, user.university_id))
    room_ids = [r["classroom_id"] for r in rooms]
    asgs = many(c, """SELECT assignment_id, course_id, title, due_at, published_at, created_at FROM assignments
                       WHERE classroom_id = ANY(%s) AND university_id = %s AND status = 'PUBLISHED' ORDER BY due_at NULLS LAST, created_at""",
                (room_ids, user.university_id)) if room_ids else []
    ids = [a["assignment_id"] for a in asgs]
    pairs = Pairs(c, user.university_id, [user.user_id], ids)
    turns = {r["assignment_id"]: r["n"] for r in many(c, """SELECT assignment_id, count(*)::int AS n FROM ai_interactions
                                                             WHERE student_id = %s AND university_id = %s AND assignment_id = ANY(%s) GROUP BY assignment_id""",
                                                       (user.user_id, user.university_id, ids))} if ids else {}

    rows, open_due = [], []
    for a in asgs:
        key = (user.user_id, a["assignment_id"])
        status = pairs.status(*key)
        last = pairs.latest_submission(key)
        g = pairs.grade(key)
        att = pairs.latest_attempt(*key)
        run = pairs.run_for_attempt(key, att["attempt_id"]) if att else None
        rows.append({"assignment_id": a["assignment_id"], "course_id": a["course_id"], "status": status, "coach_turns": turns.get(a["assignment_id"], 0),
                     "submitted_at": iso(last["submitted_at"]) if last else None,
                     "grade": None if g is None else {"percentage": _r1(g["pct"]), "graded_at": iso(g["graded_at"]), "feedback": g["feedback"]},
                     "verification": None if run is None else {"passed": run["passed"], "total": run["total"], "status": run["status"]},
                     "_awaiting": bool(last) and last["pct"] is None, "_ver": pairs.verification(key)})
        if status in ("not_started", "in_progress") and a["due_at"] and a["due_at"] >= now:
            open_due.append(a)

    def summary(sel: list[dict]) -> dict:
        vers = [r["_ver"] for r in sel if r["_ver"]]
        return {"done": sum(1 for r in sel if r["status"] in ("submitted", "verified")), "total": len(sel),
                "average_grade": _mean(r["grade"]["percentage"] for r in sel if r["grade"]),
                "verification_passed": sum(1 for v in vers if v["overall_outcome"] in OK_OUTCOMES), "verification_total": len(vers)}

    nxt = min(open_due, key=lambda a: a["due_at"]) if open_due else None
    all_sum = summary(rows)
    kpis = {"courses": len({r["course_id"] for r in rooms}), "assignments": len(rows), "submitted": all_sum["done"],
            "graded": sum(1 for r in rows if r["grade"]), "awaiting_grade": sum(1 for r in rows if r["_awaiting"]), "average_grade": all_sum["average_grade"],
            "verifications_passed": all_sum["verification_passed"], "verifications_total": all_sum["verification_total"],
            "verifications_ready": sum(1 for r in rows if r["status"] == "submitted"),
            "due_this_week": sum(1 for a in open_due if a["due_at"] <= now + timedelta(days=7)),
            "next": None if nxt is None else {"assignment_id": nxt["assignment_id"], "course_id": nxt["course_id"], "title": nxt["title"], "due_at": iso(nxt["due_at"])}}

    courses = []
    for course_id in dict.fromkeys(r["course_id"] for r in rooms):
        mine = [a for a in open_due if a["course_id"] == course_id]
        n = min(mine, key=lambda a: a["due_at"]) if mine else None
        s = summary([r for r in rows if r["course_id"] == course_id])
        courses.append({"course_id": course_id, **s, "next_due": None if n is None else {"assignment_id": n["assignment_id"], "title": n["title"], "due_at": iso(n["due_at"])}})

    def as_of(at: Optional[datetime]) -> dict:
        keys = [(user.user_id, a["assignment_id"]) for a in asgs if at is None or _released(a) <= at]
        return _point(pairs, keys, at)

    trend = []
    for ws in _week_starts(now, weeks):
        p = as_of(min(ws + timedelta(days=7), now))
        trend.append({"week_start": ws.date().isoformat(), **p})
    cur, before = as_of(None), as_of(now - timedelta(days=DELTA_DAYS))
    return {"kpis": kpis, "deltas": {"completion": _diff(cur["completion"], before["completion"]), "average_grade": _diff(cur["average_grade"], before["average_grade"])},
            "trend": trend, "courses": courses, "assignments": [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]}


# ================================================================== instructor
def course_insights(c, user, course_id: str, weeks: int) -> dict[str, Any]:
    from .analytics import activity_feed           # imported here: analytics pulls in the auth stack, insights itself stays light

    now = datetime.now(timezone.utc)
    since = _week_starts(now, weeks)[0]
    uni = user.university_id
    asgs = many(c, """SELECT assignment_id, classroom_id, title, status, due_at, published_at, created_at FROM assignments
                       WHERE course_id = %s AND university_id = %s ORDER BY due_at NULLS LAST, created_at""", (course_id, uni))
    enrol = many(c, """SELECT e.student_id, e.classroom_id, e.created_at, u.first_name, u.last_name, u.email FROM enrollments e JOIN users u ON u.user_id = e.student_id
                        WHERE e.course_id = %s AND e.university_id = %s AND e.status = 'active'""", (course_id, uni))
    names: dict[str, str] = {}
    rooms: dict[str, set] = defaultdict(set)
    joined: dict[str, datetime] = {}
    for e in enrol:
        names[e["student_id"]] = _name(e)
        rooms[e["student_id"]].add(e["classroom_id"])
        joined[e["student_id"]] = min(joined.get(e["student_id"], e["created_at"]), e["created_at"])
    students = sorted(names, key=lambda s: names[s].lower())
    asg_ids = [a["assignment_id"] for a in asgs]
    live = [a for a in asgs if a["status"] != "DRAFT"]                       # students only ever see published (and later archived) work

    def eligible(sid: str, a) -> bool:
        return a["classroom_id"] is None or a["classroom_id"] in rooms[sid]

    pairs = Pairs(c, uni, students, asg_ids)
    live_keys = [(s, a["assignment_id"]) for a in live for s in students if eligible(s, a)]

    # ---------------------------------------------------------- grades (whole course)
    grades = {k: g for k in live_keys if (g := pairs.grade(k))}
    awaiting = [k for k in live_keys if (last := pairs.latest_submission(k)) and last["pct"] is None]
    pcts = [g["pct"] for g in grades.values()]
    dist = [{"bucket": b, "count": sum(1 for p in pcts if lo <= p < hi)} for b, lo, hi in BUCKETS]
    grade_block = {"graded": len(grades), "awaiting": len(awaiting), "highest": _r1(max(pcts)) if pcts else None, "lowest": _r1(min(pcts)) if pcts else None,
                   "distribution": dist}

    # ---------------------------------------------------------- per assignment
    assignments = []
    for a in asgs:
        keys = [(s, a["assignment_id"]) for s in students if eligible(s, a)]
        sub = [k for k in keys if pairs.submitted(k)]
        gr = [grades[k]["pct"] for k in keys if k in grades]
        ok = [k for k in sub if (v := pairs.verification(k)) and v["overall_outcome"] in OK_OUTCOMES]
        scales = [s for k in keys for s in pairs.subs.get(k, ()) if s["max_score"] is not None]
        latest_scale = max(scales, key=lambda s: s["graded_at"] or s["submitted_at"])["max_score"] if scales else None
        assignments.append({"id": a["assignment_id"], "title": a["title"], "lifecycle": a["status"], "due_at": iso(a["due_at"]),
                            "max_score": None if latest_scale is None else float(latest_scale), "students": len(keys), "submitted": len(sub),
                            "graded": len(gr), "average_grade": _mean(gr), "verification_rate": _pct(len(ok), len(sub))})

    # ---------------------------------------------------------- per student
    per_student = []
    for s in students:
        keys = [k for k in live_keys if k[0] == s]
        sub = [k for k in keys if pairs.submitted(k)]
        mine = sorted((grades[k] for k in keys if k in grades), key=lambda g: g["graded_at"] or g["submitted_at"])
        ok = [k for k in sub if (v := pairs.verification(k)) and v["overall_outcome"] in OK_OUTCOMES]
        per_student.append({"id": s, "average_grade": _mean(g["pct"] for g in mine), "graded": len(mine), "submitted": len(sub),
                            "awaiting": sum(1 for k in awaiting if k[0] == s), "verification_rate": _pct(len(ok), len(sub)),
                            "recent_grades": [_r1(g["pct"]) for g in mine[-5:]]})

    # ---------------------------------------------------------- latest submission per pair
    titles = {a["assignment_id"]: a["title"] for a in asgs}
    submissions = []
    for k in live_keys:
        last = pairs.latest_submission(k)
        if last is None:
            continue
        submissions.append({"student_id": k[0], "student_name": names[k[0]], "assignment_id": k[1], "assignment_title": titles[k[1]],
                            "attempt_number": last["attempt_number"], "submitted_at": iso(last["submitted_at"]),
                            "grade": None if last["pct"] is None else {"percentage": _r1(last["pct"]), "graded_at": iso(last["graded_at"])},
                            "verification": _run_view(pairs.run_for_attempt(k, last["attempt_id"]))})
    submissions.sort(key=lambda x: x["submitted_at"] or "", reverse=True)

    # ---------------------------------------------------------- review indicators in the period (observations, never conclusions)
    sig_rows = many(c, """SELECT student_id, signal FROM risk_signals
                           WHERE university_id = %s AND assignment_id = ANY(%s) AND student_id = ANY(%s) AND created_at >= %s""",
                    (uni, asg_ids, students, since)) if students and asg_ids else []
    by_signal: dict[str, set] = defaultdict(set)
    per_count: dict[str, int] = defaultdict(int)
    for r in sig_rows:
        by_signal[r["signal"]].add(r["student_id"])
        per_count[r["student_id"]] += 1
    by_type = sorted(({"signal": k, "label": spec_for(k).label, "students": len(v)} for k, v in by_signal.items()), key=lambda x: (-x["students"], x["label"]))
    counts = [per_count.get(s, 0) for s in students]
    by_level = {"none": sum(1 for n in counts if n == 0), "one": sum(1 for n in counts if n == 1), "two": sum(1 for n in counts if n == 2),
                "three_plus": sum(1 for n in counts if n >= 3)}

    # ---------------------------------------------------------- Coach use per week in the period
    turns = {r["wk"]: r["n"] for r in many(c, """
        SELECT date_trunc('week', created_at AT TIME ZONE 'UTC')::date AS wk, count(*)::int AS n FROM ai_interactions
         WHERE university_id = %s AND assignment_id = ANY(%s) AND student_id = ANY(%s) AND created_at >= %s GROUP BY 1""",
        (uni, asg_ids, students, since))} if students and asg_ids else {}
    week_starts = _week_starts(now, weeks)
    coach_weekly = [{"week_start": ws.date().isoformat(), "turns": turns.get(ws.date(), 0)} for ws in week_starts]

    # ---------------------------------------------------------- verified mastery per concept (verification results only)
    concepts = []
    if students and asg_ids:
        seen = set()
        for r in many(c, """
            SELECT min(btrim(q.concept)) AS name, avg(res.score)::float AS mastery, count(DISTINCT v.assignment_id)::int AS assignments, count(*)::int AS answers
              FROM verification_questions q JOIN verification_runs v ON v.verification_id = q.verification_id
              JOIN LATERAL (SELECT r.score, r.outcome FROM verification_results r WHERE r.question_id = q.question_id
                             ORDER BY r.created_at DESC, r.result_id DESC LIMIT 1) res ON true
             WHERE v.university_id = %s AND v.assignment_id = ANY(%s) AND v.student_id = ANY(%s)
               AND q.concept IS NOT NULL AND btrim(q.concept) <> '' AND res.outcome <> 'INSUFFICIENT_EVIDENCE'
             GROUP BY lower(btrim(q.concept)) ORDER BY mastery, name""", (uni, asg_ids, students)):
            seen.add(r["name"].lower())
            concepts.append({"name": r["name"], "mastery": round(r["mastery"], 3), "level": mastery_label(r["mastery"], r["answers"]), "assignments": r["assignments"]})
        for r in many(c, """SELECT min(k.name) AS name, count(DISTINCT ac.assignment_id)::int AS assignments FROM assignment_concepts ac
                              JOIN concepts k ON k.concept_id = ac.concept_id WHERE ac.assignment_id = ANY(%s) GROUP BY lower(btrim(k.name)) ORDER BY 1""", (asg_ids,)):
            if r["name"].strip().lower() not in seen:                        # taught but not yet verified: shown as "no evidence yet"
                concepts.append({"name": r["name"], "mastery": None, "level": None, "assignments": r["assignments"]})

    # ---------------------------------------------------------- activity in the period
    roster = set(students)
    activity = []
    for e in activity_feed(c, university_id=uni, course_id=course_id, limit=200):
        at = datetime.fromisoformat(e["date"]) if e["date"] else None
        if at is None or at < since or e["student_id"] not in roster:
            continue
        activity.append({**e, "student_name": names[e["student_id"]]})
        if len(activity) == 60:
            break

    # ---------------------------------------------------------- trend + deltas
    def as_of(at: Optional[datetime]) -> dict:
        keys = [(s, a["assignment_id"]) for a in live for s in students
                if eligible(s, a) and (at is None or (_released(a) <= at and joined[s] <= at))]
        return _point(pairs, keys, at)

    trend = [{"week_start": ws.date().isoformat(), **as_of(min(ws + timedelta(days=7), now))} for ws in week_starts]
    cur, before = as_of(None), as_of(now - timedelta(days=DELTA_DAYS))
    month_ago = now - timedelta(days=DELTA_DAYS)
    deltas = {"students": len(students) - sum(1 for s in students if joined[s] <= month_ago) if students else None,
              "completion": _diff(cur["completion"], before["completion"]), "average_grade": _diff(cur["average_grade"], before["average_grade"]),
              "verification_success": _diff(cur["verification_success"], before["verification_success"])}

    return {"trend": trend, "deltas": deltas, "grades": grade_block, "assignments": assignments, "students": per_student, "submissions": submissions,
            "signals": {"by_type": by_type, "by_level": by_level}, "coach_weekly": coach_weekly, "concepts": concepts, "activity": activity}
