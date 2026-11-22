"""
Assessment: grading settings, the AI grading queue and worker, releasing grades, and the grade audit trail.

Trust model
  * A grade a student can see lives in ONE place: the columns on public.submissions (014 + 020). Teacher review, the student page, the
    dashboard and the Excel export all read it through `views.grade_view`.
  * The AI only ever writes DRAFTS (public.grade_evaluations). A draft becomes a grade when an instructor releases it (as is, or edited), or
    automatically when the instructor opted the assignment into "auto_release" AND the draft is confident, flag-free, and the student has
    no grade yet. A released grade is never overwritten by the AI.
  * Every change to a released grade is appended to public.grade_events (who, what, from what, based on which draft).

Queue
  Submitting work (assignments with ai_grading <> 'off') or an instructor's "Grade with AI" enqueues a QUEUED evaluation. At most one
  QUEUED/RUNNING evaluation exists per submission (partial unique index). `GradingQueue.process()` claims one with FOR UPDATE SKIP LOCKED,
  grades it outside any transaction (the LLM call can take a while), then writes the result. Model outages are retried; work that cannot be
  graded automatically (no readable text) fails with a clear message for the instructor.
"""
from __future__ import annotations

import hashlib
import json
import logging
import threading
import time
from typing import Any, Callable, Iterable, Optional

from .config import get_backend_config
from .db import Database, Row, many, new_id, one
from .errors import AIUnavailable, AppError
from .views import iso

log = logging.getLogger("socratiq.grading")

AI_MODES = ("off", "review", "auto_release")
DEFAULT_POINTS = 100.0
ACTIVE = ("QUEUED", "RUNNING")


# ================================================================== schema readiness
def ready(c) -> bool:
    """True once migration 020 is applied. Before that the old grading behaviour (014) keeps working and the new routes answer 503."""
    return bool(one(c, "SELECT to_regclass('public.grade_evaluations') IS NOT NULL AS ok")["ok"])


def require_ready(c) -> None:
    if not ready(c):
        raise AppError(503, "AI grading is not available yet: the database migration 020_assessment.sql has not been applied.", code="assessment_unavailable")


def level_for(points: float, maximum: float) -> str:
    """Same bands as ai/grading/engine.level_for, so a level never depends on who set the points."""
    r = points / maximum if maximum else 0.0
    return "excellent" if r >= 0.9 else "proficient" if r >= 0.7 else "developing" if r >= 0.4 else "beginning" if r > 0 else "missing"


# ================================================================== settings
def rubric_of(a: Row) -> list[dict]:
    raw = a.get("rubric") or []
    return [r for r in raw if isinstance(r, dict) and r.get("id") and r.get("points")]


def total_points(a: Row) -> float:
    """The assignment's maximum score: the rubric's total when there is a rubric, else points_possible, else 100."""
    rub = rubric_of(a)
    if rub:
        return float(sum(float(r["points"]) for r in rub))
    return float(a.get("points_possible") or DEFAULT_POINTS)


def settings_hash(a: Row) -> str:
    """Changes whenever anything that tells the grader HOW to grade changes (rubric, reference answer, grading notes, instructions).
    A draft made under another hash is shown to the instructor as out of date."""
    canon = {"rubric": [{"id": r["id"], "title": r.get("title"), "description": r.get("description") or "", "points": float(r["points"])} for r in rubric_of(a)],
             "reference": (a.get("reference_answer") or "").strip(), "notes": (a.get("grading_notes") or "").strip(),
             "instructions": a.get("instructions") or "", "points": total_points(a)}
    return hashlib.sha256(json.dumps(canon, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:32]


def work_hash(text: Optional[str], board_text: Optional[str]) -> str:
    return hashlib.sha256(f"{text or ''}\x00{board_text or ''}".encode()).hexdigest()[:32]


def settings_view(a: Row, *, include_private: bool = True) -> dict[str, Any]:
    out = {"assignment_id": a["assignment_id"], "ai_grading": a.get("ai_grading") or "review", "points_possible": total_points(a),
           "rubric": [{"id": r["id"], "title": r.get("title") or "", "description": r.get("description") or "", "points": float(r["points"])} for r in rubric_of(a)],
           "rubric_source": a.get("rubric_source") or "none", "updated_at": iso(a.get("grading_updated_at"))}
    if include_private:
        out["reference_answer"] = a.get("reference_answer") or ""
        out["grading_notes"] = a.get("grading_notes") or ""
    return out


def board_text(whiteboard: Optional[dict]) -> str:
    """The student's OWN typed reasoning on their board (Coach-written content is excluded by the digest)."""
    if not whiteboard:
        return ""
    try:
        from ai.whiteboard.digest import student_work_text
        return student_work_text(whiteboard).strip()
    except Exception:  # noqa: BLE001  (a malformed board must never block grading)
        log.warning("could not read the whiteboard for grading", exc_info=True)
        return ""


# ================================================================== views
def evaluation_view(e: Optional[Row], *, current_hash: Optional[str] = None, latest_submission_id: Optional[str] = None) -> Optional[dict[str, Any]]:
    if e is None:
        return None
    done = e["status"] == "COMPLETED"
    stale_reasons = []
    if done and current_hash and e.get("rubric_hash") and e["rubric_hash"] != current_hash:
        stale_reasons.append("settings_changed")
    if latest_submission_id and e["submission_id"] != latest_submission_id:
        stale_reasons.append("resubmitted")
    score, mx = (float(e["score"]), float(e["max_score"])) if done else (None, None)
    return {"id": e["evaluation_id"], "status": e["status"], "trigger": e["trigger"], "submission_id": e["submission_id"],
            "score": score, "max_score": mx, "percentage": round(score / mx * 100, 1) if done and mx else None,
            "confidence": float(e["confidence"]) if e.get("confidence") is not None else None,
            "criteria": e.get("criteria") or [], "feedback": e.get("feedback"), "rationale": e.get("rationale"),
            "flags": e.get("flags") or [], "needs_review": bool(e.get("needs_review")), "error": e.get("error"),
            "stale": bool(stale_reasons), "stale_reasons": stale_reasons, "created_at": iso(e["created_at"]), "completed_at": iso(e.get("completed_at"))}


def grade_history(c, submission_ids: Iterable[str]) -> list[dict[str, Any]]:
    ids = list(submission_ids)
    if not ids:
        return []
    rows = many(c, """SELECT g.*, u.first_name, u.last_name FROM grade_events g LEFT JOIN users u ON u.user_id = g.actor_id
                       WHERE g.submission_id = ANY(%s) ORDER BY g.created_at DESC LIMIT 50""", (ids,))
    return [{"id": r["event_id"], "action": r["action"], "source": r["source"], "at": iso(r["created_at"]),
             "actor": (" ".join(p for p in (r["first_name"], r["last_name"]) if p) or "Instructor") if r["actor_id"] else "SocratiQ",
             "score": float(r["score"]) if r["score"] is not None else None, "max_score": float(r["max_score"]) if r["max_score"] is not None else None,
             "previous_score": float(r["previous_score"]) if r["previous_score"] is not None else None,
             "previous_max": float(r["previous_max"]) if r["previous_max"] is not None else None, "note": r["note"]} for r in rows]


def latest_evaluation(c, submission_id: str) -> Optional[Row]:
    return one(c, "SELECT * FROM grade_evaluations WHERE submission_id=%s ORDER BY created_at DESC LIMIT 1", (submission_id,))


# ================================================================== queue
def enqueue(c, *, assignment: Row, submission: Row, trigger: str, requested_by: Optional[str]) -> Optional[Row]:
    """Queue an AI grading of this submission. Returns the queued row, or None when one is already queued/running for it."""
    return one(c, """INSERT INTO grade_evaluations (evaluation_id, university_id, course_id, assignment_id, submission_id, student_id, trigger, requested_by)
                     VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                     ON CONFLICT (submission_id) WHERE status IN ('QUEUED','RUNNING') DO NOTHING RETURNING *""",
               (new_id("gev"), assignment["university_id"], assignment["course_id"], assignment["assignment_id"], submission["submission_id"],
                submission["student_id"], trigger, requested_by))


def latest_submissions(c, assignment_id: str, student_ids: Optional[list[str]] = None) -> list[Row]:
    """Each student's latest submission for the assignment (active enrolments only)."""
    return many(c, """
        SELECT DISTINCT ON (s.student_id) s.* FROM submissions s
          JOIN attempts t ON t.attempt_id = s.attempt_id
          JOIN assignments a ON a.assignment_id = s.assignment_id
          JOIN enrollments e ON e.student_id = s.student_id AND e.classroom_id = a.classroom_id AND e.status = 'active'
         WHERE s.assignment_id = %s AND (%s::text[] IS NULL OR s.student_id = ANY(%s::text[]))
         ORDER BY s.student_id, t.attempt_number DESC""", (assignment_id, student_ids, student_ids))


class GradingQueue:
    """The asynchronous half of grading. `ai_provider` returns the AI adapter (resolved lazily so a missing key never blocks startup)."""

    def __init__(self, db: Database, ai_provider: Callable[[], Any], max_attempts: int = 3):
        self.db, self._ai, self.max_attempts = db, ai_provider, max_attempts

    # ---------------------------------------------------------------- claim
    def claim(self, evaluation_id: Optional[str] = None) -> Optional[Row]:
        with self.db.tx() as c:
            if evaluation_id:
                return one(c, """UPDATE grade_evaluations SET status='RUNNING', attempts=attempts+1, started_at=now(), error=NULL
                                  WHERE evaluation_id=(SELECT evaluation_id FROM grade_evaluations WHERE evaluation_id=%s AND status='QUEUED' FOR UPDATE SKIP LOCKED)
                                  RETURNING *""", (evaluation_id,))
            return one(c, """UPDATE grade_evaluations SET status='RUNNING', attempts=attempts+1, started_at=now(), error=NULL
                              WHERE evaluation_id=(SELECT evaluation_id FROM grade_evaluations WHERE status='QUEUED' ORDER BY created_at
                                                   FOR UPDATE SKIP LOCKED LIMIT 1)
                              RETURNING *""")

    def requeue_stale(self, minutes: int) -> int:
        with self.db.tx() as c:
            rows = many(c, "UPDATE grade_evaluations SET status='QUEUED' WHERE status='RUNNING' AND started_at < now() - make_interval(mins => %s) RETURNING evaluation_id", (minutes,))
            return len(rows)

    # ---------------------------------------------------------------- process
    def process(self, evaluation_id: Optional[str] = None) -> Optional[str]:
        """Grade ONE queued evaluation. Returns its id, or None when the queue is empty."""
        ev = self.claim(evaluation_id)
        if ev is None:
            return None
        started = time.monotonic()
        try:
            ctx = self._context(ev)
            if ctx is None:
                return ev["evaluation_id"]
            a, request, s_hash, w_hash = ctx
            out = self._ai().grade_submission(**request)
            if "ungradable" in out:
                self._finish(ev, status="FAILED", error=out["ungradable"]["message"])
                return ev["evaluation_id"]
            self._complete(ev, a, out["result"], s_hash, w_hash, int((time.monotonic() - started) * 1000))
        except AIUnavailable as exc:
            retry = ev["attempts"] < self.max_attempts
            log.warning("grading %s: AI unavailable (attempt %s, retry=%s)", ev["evaluation_id"], ev["attempts"], retry)
            self._finish(ev, status="QUEUED" if retry else "FAILED",
                         error=None if retry else "The AI grader was unavailable. Try “Grade with AI” again later, or grade this submission yourself.")
        except Exception:  # noqa: BLE001
            log.exception("grading %s failed", ev["evaluation_id"])
            retry = ev["attempts"] < self.max_attempts
            self._finish(ev, status="QUEUED" if retry else "FAILED", error=None if retry else "Something went wrong while grading. Try again.")
        return ev["evaluation_id"]

    def _finish(self, ev: Row, *, status: str, error: Optional[str]) -> None:
        with self.db.tx() as c:
            c.execute("UPDATE grade_evaluations SET status=%s, error=%s, completed_at=CASE WHEN %s IN ('FAILED','CANCELLED') THEN now() ELSE NULL END WHERE evaluation_id=%s AND status='RUNNING'",
                      (status, error, status, ev["evaluation_id"]))

    def _context(self, ev: Row):
        """Load what the grader may see (and make sure it is still worth grading). Returns None when the evaluation was cancelled."""
        with self.db.tx() as c:
            a = one(c, "SELECT * FROM assignments WHERE assignment_id=%s", (ev["assignment_id"],))
            sub = one(c, "SELECT s.*, t.whiteboard, t.attempt_number FROM submissions s JOIN attempts t ON t.attempt_id = s.attempt_id WHERE s.submission_id=%s", (ev["submission_id"],))
            latest = one(c, """SELECT s.submission_id FROM submissions s JOIN attempts t ON t.attempt_id = s.attempt_id
                                WHERE s.student_id=%s AND s.assignment_id=%s ORDER BY t.attempt_number DESC LIMIT 1""", (ev["student_id"], ev["assignment_id"]))
            concepts = [r["name"] for r in many(c, "SELECT k.name FROM assignment_concepts ac JOIN concepts k ON k.concept_id = ac.concept_id WHERE ac.assignment_id=%s ORDER BY k.name", (ev["assignment_id"],))]
        if a is None or sub is None:
            self._finish(ev, status="CANCELLED", error="The submission no longer exists.")
            return None
        if latest and latest["submission_id"] != sub["submission_id"]:
            self._finish(ev, status="CANCELLED", error="The student has submitted a newer version.")
            return None
        rubric = rubric_of(a)
        if not rubric:
            rubric = self._ensure_rubric(a, concepts)
            a = {**a, "rubric": rubric}
        btext = board_text(sub.get("whiteboard"))
        request = dict(assignment_id=a["assignment_id"], title=a["title"], instructions=a["instructions"] or "", subject_area=a.get("subject_area"),
                       is_programming=bool(a.get("is_programming")), concepts=concepts, rubric=rubric, reference_answer=a.get("reference_answer"),
                       grading_notes=a.get("grading_notes"), submission_text=sub.get("submission_text") or "", whiteboard_text=btext or None,
                       submission_kind="file" if sub.get("submission_type") == "file" else "text",
                       file_without_text=bool(sub.get("file_id")) and not (sub.get("submission_text") or "").strip())
        return a, request, settings_hash(a), work_hash(sub.get("submission_text"), btext)

    def _ensure_rubric(self, a: Row, concepts: list[str]) -> list[dict]:
        """No rubric yet: draft one ONCE for the assignment and store it (rubric_source='ai'), so every student is graded against the same
        criteria. The instructor sees that it was drafted by the AI and can edit it (drafts made before an edit are then marked out of date)."""
        draft = self._ai().suggest_rubric(title=a["title"], instructions=a["instructions"] or "", subject_area=a.get("subject_area"),
                                          is_programming=bool(a.get("is_programming")), total_points=float(a.get("points_possible") or DEFAULT_POINTS),
                                          reference_answer=a.get("reference_answer"), concepts=concepts)
        with self.db.tx() as c:
            cur = one(c, "SELECT rubric FROM assignments WHERE assignment_id=%s FOR UPDATE", (a["assignment_id"],))
            existing = [r for r in (cur or {}).get("rubric") or [] if isinstance(r, dict) and r.get("id")]
            if existing:                                              # another worker drafted one first: use it
                return existing
            c.execute("UPDATE assignments SET rubric=%s::jsonb, rubric_source='ai', grading_updated_at=now() WHERE assignment_id=%s",
                      (json.dumps(draft), a["assignment_id"]))
            return draft

    def _complete(self, ev: Row, a: Row, result: dict, s_hash: str, w_hash: str, duration_ms: int) -> None:
        cfg = get_backend_config()
        snapshot = [{"id": r["id"], "title": r.get("title"), "description": r.get("description") or "", "points": float(r["points"])} for r in rubric_of(a)]
        with self.db.tx() as c:
            row = one(c, """UPDATE grade_evaluations SET status='COMPLETED', score=%s, max_score=%s, confidence=%s, criteria=%s::jsonb, feedback=%s, rationale=%s,
                                   flags=%s::jsonb, needs_review=%s, rubric_snapshot=%s::jsonb, rubric_hash=%s, submission_hash=%s, prompt_version=%s,
                                   duration_ms=%s, completed_at=now(), error=NULL
                             WHERE evaluation_id=%s AND status='RUNNING' RETURNING *""",
                      (result["score"], result["max_score"], result["confidence"], json.dumps(result["criteria"]), (result.get("feedback") or "")[:4000] or None,
                       (result.get("rationale") or "")[:4000] or None, json.dumps(result.get("flags") or []), bool(result.get("needs_review")),
                       json.dumps(snapshot), s_hash, w_hash, result.get("prompt_version"), duration_ms, ev["evaluation_id"]))
            if row is None:                                           # requeued as stale meanwhile: another run owns it now
                return
            if (a.get("ai_grading") == "auto_release" and not row["needs_review"] and float(row["confidence"]) >= cfg.grading_auto_release_min_confidence):
                sub = one(c, "SELECT * FROM submissions WHERE submission_id=%s FOR UPDATE", (row["submission_id"],))
                if sub is not None and sub["score"] is None:          # never overwrite a grade that already exists
                    release(c, sub=sub, actor_id=None, score=float(row["score"]), max_score=float(row["max_score"]), feedback=row["feedback"],
                            criteria=student_criteria(row["criteria"], None), source="ai", evaluation_id=row["evaluation_id"], action="auto_released")


# ================================================================== releasing grades
def student_criteria(criteria: list[dict], comments: Optional[dict[str, str]]) -> list[dict]:
    """The per-criterion breakdown a student sees: title, points and level, plus an instructor comment if one was written.
    The AI's rationale and evidence are instructor-facing and are not copied here."""
    out = []
    for c in criteria or []:
        item = {"id": c["id"], "title": c.get("title") or c["id"], "points_awarded": float(c["points_awarded"]), "points_possible": float(c["points_possible"]),
                "level": c.get("level")}
        note = (comments or {}).get(c["id"])
        if note and note.strip():
            item["comment"] = note.strip()[:1000]
        out.append(item)
    return out


def release(c, *, sub: Row, actor_id: Optional[str], score: float, max_score: float, feedback: Optional[str], criteria: Optional[list[dict]],
            source: str, evaluation_id: Optional[str], action: Optional[str] = None, note: Optional[str] = None) -> None:
    """Write the grade the student sees and append it to the audit trail (inside the caller's transaction)."""
    if max_score <= 0 or score < 0 or score > max_score:
        raise AppError(422, "The score must be between 0 and the maximum score.", "invalid_grade")
    prev_score, prev_max = sub.get("score"), sub.get("max_score")
    if not ready(c):                                                   # pre-020 database: the original 014 behaviour
        c.execute("UPDATE submissions SET score=%s, max_score=%s, feedback=%s, graded_at=now(), graded_by=%s WHERE submission_id=%s",
                  (score, max_score, (feedback or "").strip() or None, actor_id, sub["submission_id"]))
        return
    c.execute("""UPDATE submissions SET score=%s, max_score=%s, feedback=%s, graded_at=now(), graded_by=%s, grade_source=%s, grade_evaluation_id=%s,
                        grade_criteria=%s::jsonb WHERE submission_id=%s""",
              (score, max_score, (feedback or "").strip() or None, actor_id, source, evaluation_id, json.dumps(criteria) if criteria else None, sub["submission_id"]))
    c.execute("""INSERT INTO grade_events (event_id, university_id, submission_id, student_id, assignment_id, actor_id, action, source, score, max_score,
                                           previous_score, previous_max, evaluation_id, note) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
              (new_id("gre"), sub["university_id"], sub["submission_id"], sub["student_id"], sub["assignment_id"], actor_id,
               action or ("released" if prev_score is None else "edited"), source, score, max_score, prev_score, prev_max, evaluation_id, note))


def clear(c, *, sub: Row, actor_id: str) -> None:
    if sub.get("score") is None:
        return
    if not ready(c):
        c.execute("UPDATE submissions SET score=NULL, max_score=NULL, feedback=NULL, graded_at=NULL, graded_by=NULL WHERE submission_id=%s", (sub["submission_id"],))
        return
    c.execute("""UPDATE submissions SET score=NULL, max_score=NULL, feedback=NULL, graded_at=NULL, graded_by=NULL, grade_source=NULL,
                        grade_evaluation_id=NULL, grade_criteria=NULL WHERE submission_id=%s""", (sub["submission_id"],))
    c.execute("""INSERT INTO grade_events (event_id, university_id, submission_id, student_id, assignment_id, actor_id, action, previous_score, previous_max)
                 VALUES (%s,%s,%s,%s,%s,%s,'cleared',%s,%s)""",
              (new_id("gre"), sub["university_id"], sub["submission_id"], sub["student_id"], sub["assignment_id"], actor_id, sub["score"], sub["max_score"]))


def same_as_draft(ev: Row, *, score: float, feedback: Optional[str], points: Optional[dict[str, float]]) -> bool:
    if abs(float(ev["score"]) - score) > 1e-6 or (" ".join((ev.get("feedback") or "").split()) != " ".join((feedback or "").split())):
        return False
    if points is None:
        return True
    return all(abs(float(c["points_awarded"]) - float(points.get(c["id"], -1))) < 1e-6 for c in ev.get("criteria") or [])


# ================================================================== worker
class GradingWorker:
    """A daemon thread draining the grading queue. State lives in Postgres, so a restart loses nothing (stale RUNNING rows are re-queued)."""

    def __init__(self, queue: GradingQueue, workers: int = 1, poll_seconds: int = 5, stale_minutes: int = 10):
        self.queue, self.n, self.poll, self.stale = queue, workers, poll_seconds, stale_minutes
        self._wake, self._stop = threading.Event(), threading.Event()
        self._threads: list[threading.Thread] = []

    def start(self) -> None:
        try:
            n = self.queue.requeue_stale(0)
            if n:
                log.info("re-queued %s interrupted grading(s)", n)
        except Exception:  # noqa: BLE001  (before migration 020 the table does not exist; grading simply stays idle)
            log.warning("grading queue not available", exc_info=True)
        for i in range(self.n):
            t = threading.Thread(target=self._loop, name=f"grading-{i}", daemon=True)
            t.start()
            self._threads.append(t)

    def kick(self) -> None:
        self._wake.set()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        for t in self._threads:
            t.join(timeout=5)

    def _loop(self) -> None:
        ticks = 0
        while not self._stop.is_set():
            try:
                result = self.queue.process()
            except Exception:  # noqa: BLE001
                log.exception("grading loop error")
                result = None
            if result is None:
                self._wake.wait(self.poll)
                self._wake.clear()
                ticks += 1
                if ticks % max(1, 60 // max(1, self.poll)) == 0:
                    try:
                        self.queue.requeue_stale(self.stale)
                    except Exception:  # noqa: BLE001
                        log.exception("stale grading requeue failed")
