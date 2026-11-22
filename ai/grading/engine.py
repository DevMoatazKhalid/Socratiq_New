"""
Rubric-based grading service.

    service = GradingService()
    result = service.grade(GradingRequest(...))          # -> GradingResult (a DRAFT: the backend decides whether it is released)
    criteria = service.suggest_rubric(title=..., ...)    # -> list[RubricCriterion] for the instructor to edit

Accuracy and trust come from splitting the work:
  * the model reads the work and proposes points per criterion, a rationale, a quote as evidence, and feedback;
  * `reconcile` (pure, deterministic) clamps points to each criterion's range, snaps them to a sensible step, derives the level from the
    points, computes the total from the criteria (never from a model-stated total), checks that quoted evidence really occurs in the
    answer, and raises review flags (low confidence, answer addressed to the grader, truncated or very short work, a criterion the model
    skipped, feedback that leaks the reference answer);
  * with `samples > 1` the answer is graded independently several times, the median per criterion is kept, and a large disagreement
    between runs is itself a reason for an instructor to look.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
import statistics
import unicodedata
from typing import Any, Callable, Iterable, Optional

from ai.grading.models import (
    CriterionResult,
    GradingFlag,
    GradingPayload,
    GradingRequest,
    GradingResult,
    GradingUnavailable,
    Level,
    RubricCriterion,
    RubricDraftPayload,
    UngradableSubmission,
)
from ai.grading.prompts import GRADING_PROMPT_VERSION, build_grading_messages, build_rubric_messages
from ai.verification.safety import manipulation_signals

log = logging.getLogger(__name__)

LOW_CONFIDENCE = 0.6
MANIPULATION_CONFIDENCE_CAP = 0.3
DISAGREEMENT_SHARE = 0.15          # runs whose totals differ by more than 15 % of the maximum disagree
UNVERIFIED_EVIDENCE_PENALTY = 0.1
MIN_ANSWER_CHARS = 25

LlmFactory = Callable[[type], Any]      # schema -> runnable with .invoke(messages)


def _default_factory(schema: type) -> Any:
    from ai.models.llm import ModelRole, get_structured_llm
    return get_structured_llm(ModelRole.REASONING, schema)


# ---------------------------------------------------------------- hashing (staleness detection)
def rubric_hash(rubric: Iterable[RubricCriterion], reference_answer: Optional[str] = None, grading_notes: Optional[str] = None) -> str:
    """Changes whenever anything the grader is told about HOW to grade changes, so an older evaluation can be shown as out of date."""
    canon = {"rubric": [{"id": c.id, "title": c.title, "description": c.description, "points": float(c.points)} for c in rubric],
             "reference": (reference_answer or "").strip(), "notes": (grading_notes or "").strip()}
    return hashlib.sha256(json.dumps(canon, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:32]


def submission_hash(text: Optional[str], whiteboard_text: Optional[str] = None) -> str:
    return hashlib.sha256(f"{text or ''}\x00{whiteboard_text or ''}".encode()).hexdigest()[:32]


# ---------------------------------------------------------------- deterministic helpers
def step_for(points: float) -> float:
    return 0.25 if points <= 2 else 0.5


def snap(value: float, maximum: float) -> float:
    step = step_for(maximum)
    v = round(max(0.0, min(float(maximum), float(value))) / step) * step
    return float(min(maximum, max(0.0, round(v, 4))))


def level_for(points: float, maximum: float) -> Level:
    r = points / maximum if maximum else 0.0
    if r >= 0.9:
        return "excellent"
    if r >= 0.7:
        return "proficient"
    if r >= 0.4:
        return "developing"
    if r > 0:
        return "beginning"
    return "missing"


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "").lower()
    s = re.sub(r"[ً-ْـ]", "", s)                 # Arabic diacritics and tatweel do not change the words
    return " ".join(re.sub(r"[^\w\s]", " ", s).split())


def evidence_found(quote: str, answer: str) -> bool:
    q = _norm(quote)
    if not q:
        return True
    a = _norm(answer)
    if q in a:
        return True
    words = q.split()            # tolerate an ellipsis or a trimmed edge: most of a long quote must still appear in order
    if len(words) >= 6:
        mid = " ".join(words[1:-1])
        return mid in a
    return False


def leaks_reference(feedback: str, reference: Optional[str], window: int = 12) -> bool:
    """True when the feedback reproduces a run of `window` consecutive words of the instructor's reference answer."""
    ref = _norm(reference or "").split()
    if len(ref) < window:
        return False
    fb = " " + _norm(feedback) + " "
    return any(" " + " ".join(ref[i:i + window]) + " " in fb for i in range(len(ref) - window + 1))


def _flag(flags: list[GradingFlag], code: str, message: str, severity: str = "review") -> None:
    if not any(f.code == code for f in flags):
        flags.append(GradingFlag(code=code, message=message, severity=severity))  # type: ignore[arg-type]


def reconcile(req: GradingRequest, payloads: list[GradingPayload], *, truncated: bool = False) -> GradingResult:
    """Turn one or more model judgements into ONE consistent result. Pure: no I/O, no randomness."""
    if not payloads:
        raise GradingUnavailable("no usable grading output")
    answer = "\n".join(x for x in (req.submission_text, req.whiteboard_text or "") if x)
    flags: list[GradingFlag] = []
    per_run_totals: list[float] = []
    criteria: list[CriterionResult] = []
    penalty = 0.0

    by_run = [{a.criterion_id.strip(): a for a in p.criteria} for p in payloads]
    for run in by_run:
        per_run_totals.append(sum(snap(run[c.id].points_awarded, c.points) for c in req.rubric if c.id in run))
    for c in req.rubric:
        seen = [run[c.id] for run in by_run if c.id in run]
        if len(seen) < len(by_run):
            _flag(flags, "criterion_skipped", f"The AI did not assess “{c.title}” in every run; it is scored from the runs that did, or 0.")
        if not seen:
            pts, rationale, evidence = 0.0, "Not assessed by the AI grader.", ""
        else:
            pts = snap(statistics.median(a.points_awarded for a in seen), c.points)
            best = min(seen, key=lambda a: abs(snap(a.points_awarded, c.points) - pts))         # the run closest to the consensus explains it
            rationale = " ".join(best.rationale.split())[:600]
            evidence = " ".join(best.evidence.split())[:300]
            if evidence and not evidence_found(evidence, answer):
                evidence = ""
                penalty += UNVERIFIED_EVIDENCE_PENALTY
                _flag(flags, "evidence_unverified", "A quote the AI cited was not found in the submission and was removed.", "info")
        criteria.append(CriterionResult(id=c.id, title=c.title, points_awarded=pts, points_possible=float(c.points),
                                        level=level_for(pts, c.points), rationale=rationale, evidence=evidence))

    max_score = float(sum(c.points for c in req.rubric))
    score = float(round(sum(c.points_awarded for c in criteria), 4))
    confidence = statistics.mean(max(0.0, min(1.0, p.confidence)) for p in payloads)

    if len(payloads) > 1 and max(per_run_totals) - min(per_run_totals) > DISAGREEMENT_SHARE * max_score:
        _flag(flags, "runs_disagree", f"Independent AI gradings disagreed ({min(per_run_totals):g}–{max(per_run_totals):g} of {max_score:g}).")
        confidence = min(confidence, 0.5)
    signals = manipulation_signals(answer)
    if signals:
        _flag(flags, "addresses_grader", "The submission contains text aimed at the grader (for example asking for full marks). It was ignored; please check the grade.", "block")
        confidence = min(confidence, MANIPULATION_CONFIDENCE_CAP)
    if truncated:
        _flag(flags, "truncated", "The submission is very long; the AI graded only its first part.")
    if len(re.sub(r"\s", "", answer)) < MIN_ANSWER_CHARS:
        _flag(flags, "very_short", "The submission is very short.")
    concerns = [" ".join(x.split())[:200] for p in payloads for x in p.concerns if x and x.strip()]
    if concerns:
        _flag(flags, "grader_concerns", "The AI noted: " + "; ".join(dict.fromkeys(concerns))[:480], "info")

    feedback = tidy_text(payloads[0].feedback) if len(payloads) == 1 else _closest_feedback(payloads, per_run_totals, score)
    if leaks_reference(feedback, req.reference_answer):
        _flag(flags, "feedback_reveals_reference", "The draft feedback repeats part of your reference answer. Edit it before releasing.", "block")
    confidence = max(0.0, min(1.0, confidence - penalty))
    if confidence < LOW_CONFIDENCE:
        _flag(flags, "low_confidence", f"The AI is not confident about this grade ({round(confidence * 100)}%).")

    rationale = " ".join(payloads[0].teacher_summary.split())[:1500]
    return GradingResult(
        score=score, max_score=max_score, percentage=round(score / max_score * 100, 1) if max_score else 0.0, confidence=round(confidence, 3),
        criteria=criteria, feedback=feedback[:4000], rationale=rationale, flags=flags,
        needs_review=any(f.severity in ("review", "block") for f in flags), samples=len(payloads),
        rubric_hash=rubric_hash(req.rubric, req.reference_answer, req.grading_notes),
        submission_hash=submission_hash(req.submission_text, req.whiteboard_text), prompt_version=GRADING_PROMPT_VERSION)


def _closest_feedback(payloads: list[GradingPayload], totals: list[float], score: float) -> str:
    i = min(range(len(payloads)), key=lambda k: abs(totals[k] - score))
    return tidy_text(payloads[i].feedback)


def tidy_text(s: str) -> str:
    """Tidy model prose for students: spaces collapsed within lines, but line and paragraph breaks kept (feedback is rendered with
    paragraphs and may hold multi-line formulas)."""
    lines = [" ".join(line.split()) for line in s.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def normalize_rubric(drafts: list[dict], total: float) -> list[RubricCriterion]:
    """Instructor-ready rubric from a model draft: unique ids, tidy text, points rescaled to add up to `total` exactly."""
    rows = [d for d in drafts if str(d.get("title", "")).strip() and float(d.get("points") or 0) > 0][:8]
    if not rows:
        raise GradingUnavailable("the rubric draft was empty")
    raw = [float(d["points"]) for d in rows]
    scale = total / sum(raw)
    step = 0.5 if total >= 10 else 0.25
    pts = [max(step, round(p * scale / step) * step) for p in raw]
    pts[pts.index(max(pts))] += round(total - sum(pts), 4)                 # absorb rounding in the largest criterion
    out, used = [], set()
    for d, p in zip(rows, pts):
        base = re.sub(r"[^a-z0-9]+", "-", unicodedata.normalize("NFKD", str(d["title"])).encode("ascii", "ignore").decode().lower()).strip("-")[:30] or "criterion"
        cid, n = base, 2
        while cid in used:
            cid, n = f"{base[:27]}-{n}", n + 1
        used.add(cid)
        out.append(RubricCriterion(id=cid, title=str(d["title"])[:120], description=str(d.get("description") or "")[:1000], points=round(p, 4)))
    return out


class GradingService:
    def __init__(self, llm_factory: Optional[LlmFactory] = None, samples: int = 1):
        self._factory = llm_factory or _default_factory
        self.samples = max(1, min(3, int(samples)))

    def grade(self, req: GradingRequest) -> GradingResult:
        readable = (req.submission_text or "").strip() or (req.whiteboard_text or "").strip()
        if not readable:
            if req.file_without_text:
                raise UngradableSubmission("no_text", "No text could be read from the submitted file, so it can't be graded automatically. Open the file and grade it yourself.")
            raise UngradableSubmission("empty", "The submission is empty, so there is nothing for the AI to grade.")
        messages, truncated = build_grading_messages(req)
        try:
            llm = self._factory(GradingPayload)
        except Exception as exc:  # noqa: BLE001  (missing key / bad provider config)
            raise GradingUnavailable(f"grading model unavailable: {type(exc).__name__}") from exc
        payloads: list[GradingPayload] = []
        last: Optional[Exception] = None
        for _ in range(self.samples):
            try:
                out = llm.invoke(messages)
                payloads.append(out if isinstance(out, GradingPayload) else GradingPayload.model_validate(out))
            except Exception as exc:  # noqa: BLE001
                last = exc
                log.warning("grading run failed: %s", type(exc).__name__)
        if not payloads:
            raise GradingUnavailable("every grading run failed") from last
        return reconcile(req, payloads, truncated=truncated)

    def suggest_rubric(self, *, title: str, instructions: str, subject_area: Optional[str] = None, is_programming: bool = False,
                       total_points: float = 100.0, reference_answer: Optional[str] = None, concepts: Optional[list[str]] = None) -> list[RubricCriterion]:
        messages = build_rubric_messages(title=title, instructions=instructions, subject_area=subject_area, is_programming=is_programming,
                                         total_points=total_points, reference_answer=reference_answer, concepts=concepts)
        try:
            out = self._factory(RubricDraftPayload).invoke(messages)
            draft = out if isinstance(out, RubricDraftPayload) else RubricDraftPayload.model_validate(out)
        except Exception as exc:  # noqa: BLE001
            raise GradingUnavailable(f"rubric draft failed: {type(exc).__name__}") from exc
        return normalize_rubric([c.model_dump() for c in draft.criteria], float(total_points))
