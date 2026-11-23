"""
Learning Verification Service.

Standalone pedagogical assessment service that challenges students via
Explain, Modify, and Transfer tasks to verify authentic understanding.
Emits structured VerificationResult records and observable evidence candidates.
"""
from __future__ import annotations

import logging
import os
import time
from typing import Optional

from pydantic import BaseModel, Field

from ai.models.llm import ModelRole, get_structured_llm
from ai.models.schemas import (
    EvidenceStrength,
    EvidenceType,
    LearningEvidenceCandidate,
)
from ai.verification.models import (
    VerificationChallenge,
    VerificationChallengeRequest,
    VerificationEvaluationPayload,
    VerificationOutcome,
    VerificationRequest,
    VerificationResult,
    VerificationType,
)
from ai.prompts.verification.question_review_prompt import build_question_review_messages
from ai.verification.question_context import build_lesson_context
from ai.verification.question_quality import blocking, check_question, normalize_question
from ai.verification.question_review import QuestionReviewPayload, coerce_target_concept, safe_fallback
from ai.verification.safety import reconcile_evaluation
from ai.verification.strategies import (
    BaseVerificationStrategy,
    ExplainStrategy,
    ModifyStrategy,
    TransferStrategy,
)

logger = logging.getLogger(__name__)


class GeneratedChallengePayload(BaseModel):
    """Schema for challenge generation LLM response."""

    question: str = Field(
        description="One clear, grammatical comprehension question (about 8-30 words) grounded in the lesson, answerable in 1-3 sentences."
    )
    criteria: list[str] = Field(
        default_factory=list, description="2-3 specific rubric criteria for evaluation, checkable against the lesson."
    )
    target_concept: Optional[str] = Field(
        default=None, description="The lesson concept the question targets (one of the listed lesson concepts)."
    )
    lesson_basis: Optional[str] = Field(
        default=None, description="The lesson statement(s) a correct answer relies on, quoted or closely paraphrased."
    )


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(os.environ.get(name, default))))
    except (TypeError, ValueError):
        return default


def _env_flag(name: str, default: bool) -> bool:
    raw = (os.environ.get(name) or "").strip().lower()
    return default if not raw else raw not in ("0", "false", "no", "off")


class VerificationService:
    """Service orchestrating Learning Verification challenge generation and evaluation.

    Question generation pipeline (per question):
        lesson context  ->  generate (strict prompt on retries)  ->  deterministic gate  ->  semantic review  ->  accept
                                         ^------------------- rejected, attempts left -------------------'
        no attempt accepted / model unavailable  ->  validated safe fallback (never an unchecked template)
    Cost is bounded: at most `max_attempts` generations and `max_attempts` reviews per question, and no retry after a provider error
    or once the time budget is spent.
    """

    def __init__(self, *, max_attempts: Optional[int] = None, review_enabled: Optional[bool] = None,
                 time_budget_s: Optional[float] = None):
        self._strategies: dict[VerificationType, BaseVerificationStrategy] = {
            VerificationType.EXPLAIN: ExplainStrategy(),
            VerificationType.MODIFY: ModifyStrategy(),
            VerificationType.TRANSFER: TransferStrategy(),
        }
        self.max_attempts = max_attempts or _env_int("AI_VERIFICATION_QUESTION_MAX_ATTEMPTS", 2, 1, 3)
        self.review_enabled = _env_flag("AI_VERIFICATION_QUESTION_REVIEW", True) if review_enabled is None else review_enabled
        self.time_budget_s = time_budget_s or float(_env_int("AI_VERIFICATION_QUESTION_TIME_BUDGET_S", 50, 5, 85))

    # ------------------------------------------------------------------------------------------------------------ generation
    def generate_challenge(self, request: VerificationChallengeRequest) -> VerificationChallenge:
        """Generate one verification question that is grounded in the lesson, clear, and distinct from earlier questions."""
        strategy = self._strategies.get(request.verification_type)
        if not strategy:
            raise ValueError(f"Unsupported verification type: {request.verification_type}")

        ctx = build_lesson_context(request)
        started = time.monotonic()
        rejected: list[tuple[str, list[str]]] = []
        notes: list[str] = []

        for attempt in range(1, self.max_attempts + 1):
            if attempt > 1 and time.monotonic() - started > self.time_budget_s:
                notes.append("time budget spent; no further retries")
                break
            messages = strategy.build_challenge_prompt(request, ctx=ctx, rejected=rejected)
            try:
                llm = get_structured_llm(ModelRole.VERIFICATION, GeneratedChallengePayload)
                payload = llm.invoke(messages)
                if not isinstance(payload, GeneratedChallengePayload):
                    payload = GeneratedChallengePayload.model_validate(payload)
            except Exception:
                # A provider/parse failure is not a quality problem: retrying the same call mostly burns time and quota.
                logger.exception("Question generation failed (%s, attempt %d); using the safe fallback.", ctx.verification_type, attempt)
                notes.append(f"attempt {attempt}: generation failed")
                break

            question = normalize_question(payload.question)
            report = check_question(question, ctx)
            review_ok, review_reasons, reviewer_available = True, [], False
            hard = blocking(report, ctx, reviewer_available=self.review_enabled)
            if not hard and self.review_enabled:
                review_ok, review_reasons, reviewer_available = self._review(
                    strategy, ctx, question, hints=[str(w) for w in report.warnings])
                if not reviewer_available:
                    hard = blocking(report, ctx, reviewer_available=False)
            reasons = [i.message for i in hard] + ([] if review_ok else review_reasons)
            if not reasons:
                criteria = [c.strip() for c in (payload.criteria or []) if c and c.strip()][:3]
                if not criteria:
                    criteria = [f"Answers the question accurately using ideas taught about {ctx.concept}"]
                if report.warnings:
                    notes.append("accepted with warnings: " + "; ".join(i.code for i in report.warnings))
                if self.review_enabled and not reviewer_available:
                    notes.append("semantic review unavailable; deterministic gate only")
                return VerificationChallenge(
                    verification_type=request.verification_type,
                    concept=coerce_target_concept(payload.target_concept, ctx),
                    question=question,
                    criteria=criteria,
                    source="generated" if attempt == 1 else "regenerated",
                    quality_notes=notes,
                )
            logger.warning("Rejected %s question (attempt %d/%d): %r -- %s", ctx.verification_type, attempt, self.max_attempts,
                           question, " | ".join(reasons))
            notes.append(f"attempt {attempt} rejected: " + "; ".join(reasons[:4]))
            rejected.append((question or "(empty)", reasons))

        question, criteria = safe_fallback(ctx)
        logger.warning("Using safe fallback %s question for concept %r (%s).", ctx.verification_type, ctx.concept, " | ".join(notes))
        return VerificationChallenge(
            verification_type=request.verification_type,
            concept=ctx.original(ctx.concept),
            question=question,
            criteria=criteria,
            source="fallback",
            quality_notes=notes,
        )

    def _review(self, strategy: BaseVerificationStrategy, ctx, question: str, hints: list[str]) -> tuple[bool, list[str], bool]:
        """(accepted, reasons, reviewer_available)."""
        try:
            llm = get_structured_llm(ModelRole.VERIFICATION, QuestionReviewPayload)
            review = llm.invoke(build_question_review_messages(
                ctx, question=question, type_label=strategy.type_label, objective=strategy.objective, hints=hints))
            if not isinstance(review, QuestionReviewPayload):
                review = QuestionReviewPayload.model_validate(review)
        except Exception as exc:  # noqa: BLE001 - review is a quality layer; its outage must not block the student
            logger.warning("Question review unavailable (%s): %s", ctx.verification_type, exc)
            return True, [], False
        return review.accepted, review.reasons(), True

    def verify(self, request: VerificationRequest) -> VerificationResult:
        """Evaluate a student's response to a verification challenge."""
        strategy = self._strategies.get(request.verification_type)
        if not strategy:
            raise ValueError(f"Unsupported verification type: {request.verification_type}")

        prompt_messages = strategy.build_evaluation_prompt(request)

        try:
            llm = get_structured_llm(ModelRole.VERIFICATION, VerificationEvaluationPayload)
            evaluation: VerificationEvaluationPayload = llm.invoke(prompt_messages)

            # Make the result agree with the rubric the model filled in and refuse to be steered by the answer itself (only ever lowers).
            outcome, score, confidence, notes = reconcile_evaluation(
                outcome=evaluation.outcome.value, score=evaluation.score, confidence=evaluation.confidence,
                criteria_passed=[c.passed for c in evaluation.criteria_evaluations], student_response=request.student_response,
            )
            if notes:
                logger.warning("verification result adjusted (%s): %s", request.verification_type.value, " | ".join(notes))
            evaluation = evaluation.model_copy(update={"outcome": VerificationOutcome(outcome), "score": score, "confidence": confidence})

            # Build result
            result = VerificationResult(
                student_id=request.student_id,
                assignment_id=request.assignment_id,
                concept=request.concept,
                verification_type=request.verification_type,
                outcome=evaluation.outcome,
                score=evaluation.score,
                confidence=evaluation.confidence,
                feedback=evaluation.feedback,
                criteria_evaluations=evaluation.criteria_evaluations,
            )

            # Generate evidence candidate if student passed or showed partial understanding
            if evaluation.outcome in (VerificationOutcome.PASS, VerificationOutcome.PARTIAL):
                ev_type = (
                    EvidenceType.TRANSFER
                    if request.verification_type == VerificationType.TRANSFER
                    else (
                        EvidenceType.EXPLANATION
                        if request.verification_type == VerificationType.EXPLAIN
                        else EvidenceType.UNDERSTANDING
                    )
                )
                ev_strength = (
                    EvidenceStrength.STRONG
                    if evaluation.outcome == VerificationOutcome.PASS and evaluation.confidence >= 0.8
                    else EvidenceStrength.MODERATE
                )
                result.evidence_candidate = LearningEvidenceCandidate(
                    student_id=request.student_id,
                    assignment_id=request.assignment_id,
                    concept=request.concept,
                    evidence_type=ev_type,
                    strength=ev_strength,
                    observation=(
                        f"Student successfully completed {request.verification_type.value.lower()} verification "
                        f"for concept '{request.concept}' with score {evaluation.score:.2f}."
                    ),
                    source_event_ids=[result.verification_id],
                )

            return result

        except Exception as exc:
            logger.exception("Learning verification evaluation failed.")
            return VerificationResult(
                student_id=request.student_id,
                assignment_id=request.assignment_id,
                concept=request.concept,
                verification_type=request.verification_type,
                outcome=VerificationOutcome.INSUFFICIENT_EVIDENCE,
                score=0.0,
                confidence=0.0,
                feedback="We encountered an issue evaluating your verification response. Please try again in a moment.",
                criteria_evaluations=[],
                evidence_candidate=None,
            )


_default_verification_service: Optional[VerificationService] = None


def get_default_verification_service() -> VerificationService:
    """Lazily-instantiated default service singleton."""
    global _default_verification_service
    if _default_verification_service is None:
        _default_verification_service = VerificationService()
    return _default_verification_service
