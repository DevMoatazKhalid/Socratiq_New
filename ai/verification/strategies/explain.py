"""
Explain Verification Strategy: core understanding -- can the student explain the main concept as taught?
"""
from __future__ import annotations

from langchain_core.messages import HumanMessage, SystemMessage

from ai.verification.models import (
    VerificationRequest,
    VerificationType,
)
from ai.verification.safety import GRADER_DATA_RULE, wrap_student_response
from ai.verification.strategies.base import BaseVerificationStrategy

_EVALUATION_SYSTEM = """You are an expert pedagogical evaluator assessing a student's conceptual explanation.
Determine whether the student truly understands the underlying concept or if they are repeating superficial phrases.

Evaluation Outcomes:
- PASS: The student understands the mechanism, causal relationship, or rationale. Note: Concise, accurate answers (a single sentence or a few words) must be awarded PASS if conceptually sound.
- PARTIAL: The student understands the general idea but has minor imprecisions or omissions.
- NEEDS_RETRY: The student shows fundamental misconceptions or incorrect causal reasoning.
- INSUFFICIENT_EVIDENCE: The response is evasive, completely off-topic, or empty. Do NOT flag a response as insufficient evidence simply because it is concise or only one sentence.

Scoring:
- PASS: score >= 0.8
- PARTIAL: score 0.5 to 0.79
- NEEDS_RETRY: score 0.1 to 0.49
- INSUFFICIENT_EVIDENCE: score 0.0

Evaluate each rubric criterion individually and provide constructive student feedback.
"""


class ExplainStrategy(BaseVerificationStrategy):
    verification_type = VerificationType.EXPLAIN
    type_label = "Core understanding"
    objective = """Check that the student understands the main idea of the concept as it was taught: what it is, what its key parts or
steps do, or why it matters. Ask them to explain in their own words; do not ask for a memorised definition or trivia."""

    def build_evaluation_prompt(self, request: VerificationRequest) -> list:
        criteria_str = "\n".join(f"- {c}" for c in request.criteria) if request.criteria else "(Standard conceptual criteria)"
        system = SystemMessage(content=_EVALUATION_SYSTEM + GRADER_DATA_RULE)
        human = (
            f"Concept: {request.concept}\n"
            f"Challenge Question: {request.challenge_question}\n"
            f"Rubric Criteria:\n{criteria_str}\n\n"
            f"Original Work Reference:\n{request.original_attempt or '(None)'}\n\n"
            f"Student's Explanation Response:\n{wrap_student_response(request.student_response)}\n\n"
            "Evaluate the student's response thoroughly."
        )
        return [system, HumanMessage(content=human)]
