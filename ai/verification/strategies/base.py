"""
Base class for Learning Verification strategies.

Each strategy defines the PURPOSE of its question (EXPLAIN = core understanding, MODIFY = reasoning, TRANSFER = application) and its
evaluation prompt. Question generation shares one prompt (ai/prompts/verification/question_generation_prompt.py) so that every type is
held to the same grounding, clarity and answerability rules; only the objective differs.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Iterable, Optional

from ai.verification.models import (
    VerificationChallengeRequest,
    VerificationRequest,
    VerificationType,
)


class BaseVerificationStrategy(ABC):
    """Abstract strategy for challenge generation and evaluation."""

    verification_type: VerificationType
    type_label: str = ""          # short human name of the question's purpose
    objective: str = ""           # what this question must measure (shown to generator and reviewer)

    def build_challenge_prompt(self, request: VerificationChallengeRequest, ctx=None,
                               rejected: Optional[Iterable[tuple[str, list[str]]]] = None) -> list:
        """Build messages for LLM challenge generation from a grounded LessonContext (built from `request` when not given)."""
        from ai.prompts.verification.question_generation_prompt import build_question_generation_messages
        from ai.verification.question_context import build_lesson_context

        ctx = ctx or build_lesson_context(request)
        return build_question_generation_messages(ctx, type_label=self.type_label, objective=self.objective, rejected=rejected)

    @abstractmethod
    def build_evaluation_prompt(self, request: VerificationRequest) -> list:
        """Build messages for LLM response evaluation."""
        ...
