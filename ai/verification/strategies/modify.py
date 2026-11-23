"""
Modify Verification Strategy: reasoning -- can the student explain why/how, or what changes under one altered condition?
"""
from __future__ import annotations

from langchain_core.messages import HumanMessage, SystemMessage

from ai.verification.models import (
    VerificationRequest,
    VerificationType,
)
from ai.verification.safety import GRADER_DATA_RULE, wrap_student_response
from ai.verification.strategies.base import BaseVerificationStrategy

_EVALUATION_SYSTEM = """You are an expert pedagogical evaluator assessing a student's reasoning answer.
The question asked the student to reason with a concept: why something happens, how two related ideas connect, or what changes when one
condition is altered. Determine whether the student's reasoning about the cause, connection or change is correct.

Evaluation Outcomes:
- PASS: The student correctly identified the effect, cause or connection and its rationale. Note: Concise, accurate answers (a single sentence or a few words) must be awarded PASS if conceptually sound.
- PARTIAL: The student identified some changes but missed a key detail or side effect.
- NEEDS_RETRY: The student's reasoning is wrong or reveals a fundamental misconception.
- INSUFFICIENT_EVIDENCE: The response is evasive, completely off-topic, or empty. Do NOT flag a response as insufficient evidence simply because it is concise or only one sentence.

Scoring:
- PASS: score >= 0.8
- PARTIAL: score 0.5 to 0.79
- NEEDS_RETRY: score 0.1 to 0.49
- INSUFFICIENT_EVIDENCE: score 0.0

Evaluate each rubric criterion individually and provide constructive student feedback.
"""


class ModifyStrategy(BaseVerificationStrategy):
    verification_type = VerificationType.MODIFY
    type_label = "Reasoning"
    objective = """Check that the student can reason with the concept: why something described in the lesson happens, how two related
ideas from the lesson connect, or what changes when one condition or assumption described in the lesson is altered (change only one
condition, and only one whose effect can be worked out from the lesson). Ask why or what changes; do not re-ask the core definition."""

    def build_evaluation_prompt(self, request: VerificationRequest) -> list:
        criteria_str = "\n".join(f"- {c}" for c in request.criteria) if request.criteria else "(Standard modification criteria)"
        system = SystemMessage(content=_EVALUATION_SYSTEM + GRADER_DATA_RULE)
        human = (
            f"Concept: {request.concept}\n"
            f"Challenge Question: {request.challenge_question}\n"
            f"Rubric Criteria:\n{criteria_str}\n\n"
            f"Original Work:\n{request.original_attempt or '(None)'}\n\n"
            f"Student's Modification Response:\n{wrap_student_response(request.student_response)}\n\n"
            "Evaluate the student's proposed modification thoroughly."
        )
        return [system, HumanMessage(content=human)]
