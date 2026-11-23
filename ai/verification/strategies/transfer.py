"""
Transfer Verification Strategy: application -- can the student apply the concept to a new simple case?
"""
from __future__ import annotations

from langchain_core.messages import HumanMessage, SystemMessage

from ai.verification.models import (
    VerificationRequest,
    VerificationType,
)
from ai.verification.safety import GRADER_DATA_RULE, wrap_student_response
from ai.verification.strategies.base import BaseVerificationStrategy

_EVALUATION_SYSTEM = """You are an expert pedagogical evaluator assessing a student's conceptual transfer.
Determine whether the student can abstract the core principles of the concept and apply them correctly to a novel domain.

Evaluation Outcomes:
- PASS: The student successfully transferred the concept to the new case. Note: Concise, accurate answers (a single sentence or a few words) must be awarded PASS if conceptually sound.
- PARTIAL: The student transferred the core intuition but struggled with minor specifics.
- NEEDS_RETRY: The student failed to transfer the concept or misapplied it completely.
- INSUFFICIENT_EVIDENCE: The response is evasive, completely off-topic, or empty. Do NOT flag a response as insufficient evidence simply because it is concise or only one sentence.

Scoring:
- PASS: score >= 0.8
- PARTIAL: score 0.5 to 0.79
- NEEDS_RETRY: score 0.1 to 0.49
- INSUFFICIENT_EVIDENCE: score 0.0

Evaluate each rubric criterion individually and provide constructive student feedback.
"""


class TransferStrategy(BaseVerificationStrategy):
    verification_type = VerificationType.TRANSFER
    type_label = "Application"
    objective = """Check that the student can apply the concept to one concrete, simple case or situation that the lesson did not
work through, at the lesson's level. The situation may be new, but answering it must need only ideas taught in the lesson. Keep the
scenario to one short clause; do not re-ask the explanation or reasoning questions."""

    def build_evaluation_prompt(self, request: VerificationRequest) -> list:
        criteria_str = "\n".join(f"- {c}" for c in request.criteria) if request.criteria else "(Standard transfer criteria)"
        system = SystemMessage(content=_EVALUATION_SYSTEM + GRADER_DATA_RULE)
        human = (
            f"Concept: {request.concept}\n"
            f"Novel Scenario Challenge: {request.challenge_question}\n"
            f"Rubric Criteria:\n{criteria_str}\n\n"
            f"Student's Transfer Response:\n{wrap_student_response(request.student_response)}\n\n"
            "Evaluate the student's conceptual transfer thoroughly."
        )
        return [system, HumanMessage(content=human)]
