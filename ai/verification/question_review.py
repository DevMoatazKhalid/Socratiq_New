"""
Semantic review of a generated comprehension question (second layer of the quality gate) and the validated safe fallbacks.
"""
from __future__ import annotations

import logging
from typing import Literal, Optional

from pydantic import BaseModel, Field

from ai.verification.question_context import LessonContext
from ai.verification.question_quality import check_question

logger = logging.getLogger(__name__)

REVIEW_CHECKS = ("grounded_in_lesson", "single_clear_question", "natural_language", "concepts_coherent", "answerable_from_lesson",
                 "level_appropriate", "distinct_from_previous", "matches_purpose")


class QuestionReviewPayload(BaseModel):
    """Structured output of the semantic reviewer."""

    grounded_in_lesson: bool = Field(description="The question is about content the lesson actually covers.")
    single_clear_question: bool = Field(description="One question with an identifiable objective.")
    natural_language: bool = Field(description="Natural, grammatical and unambiguous wording.")
    concepts_coherent: bool = Field(description="No unrelated ideas combined; no topic treated as a mechanism.")
    answerable_from_lesson: bool = Field(description="Answerable using only what the lesson taught.")
    level_appropriate: bool = Field(description="Depth matches the material.")
    distinct_from_previous: bool = Field(description="Tests a different aspect from earlier questions.")
    matches_purpose: bool = Field(description="Fits the stated purpose of this question type.")
    problems: list[str] = Field(default_factory=list, description="Short, specific problems found.")
    verdict: Literal["ACCEPT", "REJECT"] = Field(description="ACCEPT only if every check is true.")

    def failed_checks(self) -> list[str]:
        return [c for c in REVIEW_CHECKS if not getattr(self, c)]

    @property
    def accepted(self) -> bool:
        return self.verdict == "ACCEPT" and not self.failed_checks()

    def reasons(self) -> list[str]:
        out = [f"reviewer: {c.replace('_', ' ')} failed" for c in self.failed_checks()]
        out += [f"reviewer: {p}" for p in self.problems[:4] if p]
        if not out and self.verdict != "ACCEPT":
            out.append("reviewer rejected the question")
        return out


# ---------------------------------------------------------------------------------------------------------------- safe fallbacks
# Used only when no generated draft passes the gate (model outage, or every retry rejected). Each frame is grammatical for ANY noun phrase
# (the concept is a topic, so it is only ever the object of "about"/"knowing about"/"connect"), never mentions a "solution", and is run
# through the same deterministic gate before use. They are deliberately plain: a plain, answerable question beats a broken specific one.
_FALLBACKS: dict[str, list[tuple[str, list[str]]]] = {
    # The concept is always introduced as a quoted label ('the topic "nephron"'), which is grammatical for any noun phrase: singular,
    # plural, with or without an article ("nephron", "lists", "anatomy of the kidney", "Newton's second law").
    "EXPLAIN": [
        ('In your own words, what are the key ideas of the topic "{c}" as covered in this lesson?',
         ['States the key ideas of "{c}" accurately, as taught in the lesson',
          "Explains them in the student's own words rather than reciting a definition"]),
        ('What is the most important thing to understand about the topic "{c}", and why?',
         ['Identifies a central idea of "{c}" from the lesson', "Explains correctly why it matters"]),
    ],
    "MODIFY": [
        ('Which other idea from this lesson is closely connected to the topic "{c}", and how are the two related?',
         ['Names an idea from the lesson that is genuinely related to "{c}"', "Explains correctly how the two are connected"]),
        ('What is one cause or effect involving the topic "{c}" described in this lesson, and why does it happen?',
         ['Identifies a cause or effect involving "{c}" that the lesson describes', "Explains the reasoning behind it correctly"]),
    ],
    "TRANSFER": [
        ('In what real situation would the topic "{c}" be useful, and how would you apply it there?',
         ['Describes a realistic situation where "{c}" applies', 'Explains correctly how "{c}" would be used in that situation']),
        ('Can you give one new example of the topic "{c}" and explain how it fits what the lesson taught?',
         ['Gives a correct new example of "{c}"', "Links the example to the ideas taught in the lesson"]),
    ],
}
# Same frames for lessons written in Arabic (the app is bilingual; an English fallback in an Arabic lesson would be jarring).
_FALLBACKS_AR: dict[str, list[tuple[str, list[str]]]] = {
    "EXPLAIN": [("بكلماتك الخاصة، ما الأفكار الرئيسية لموضوع «{c}» كما وردت في هذا الدرس؟",
                 ["يذكر الأفكار الرئيسية لموضوع «{c}» بدقة كما وردت في الدرس", "يشرحها بكلماته لا بترديد تعريف"])],
    "MODIFY": [("ما الفكرة الأخرى في هذا الدرس المرتبطة بموضوع «{c}»، وكيف ترتبطان؟",
                ["يذكر فكرة من الدرس مرتبطة فعلاً بموضوع «{c}»", "يشرح العلاقة بينهما بشكل صحيح"])],
    "TRANSFER": [("في أي موقف واقعي يفيد موضوع «{c}»، وكيف تطبقه فيه؟",
                  ["يصف موقفاً واقعياً ينطبق عليه موضوع «{c}»", "يشرح كيفية تطبيقه في ذلك الموقف بشكل صحيح"])],
}
_GENERIC = {
    "EXPLAIN": "In your own words, what is the main idea of this lesson?",
    "MODIFY": "What is one cause and effect described in this lesson, and why does it happen?",
    "TRANSFER": "Where could you use what this lesson taught in a real situation, and how?",
}


def _is_arabic(ctx: LessonContext) -> bool:
    text = ctx.lesson_text + ctx.concept
    return sum(1 for ch in text if "\u0600" <= ch <= "\u06FF") > sum(1 for ch in text if ch.isascii() and ch.isalpha())


def safe_fallback(ctx: LessonContext) -> tuple[str, list[str]]:
    concept = ctx.concept if len(ctx.concept.split()) <= 8 else (ctx.title if 0 < len(ctx.title.split()) <= 8 else "this topic")
    table = _FALLBACKS_AR if _is_arabic(ctx) else _FALLBACKS
    options = table.get(ctx.verification_type, table["EXPLAIN"])
    for template, criteria in options:
        q = template.format(c=concept)
        if check_question(q, ctx).ok:
            return q, [c.format(c=concept) for c in criteria]
    # Last resort: concept-free wording that is always valid and still about this lesson.
    logger.warning("all fallback frames failed the gate for concept %r; using concept-free fallback", concept)
    return _GENERIC[ctx.verification_type], ["Answer is accurate and based on the lesson", "Explains the idea in the student's own words"]


def coerce_target_concept(target: Optional[str], ctx: LessonContext) -> str:
    """The stored concept must be one the assignment knows (it keys the student's concept mastery), in the caller's ORIGINAL spelling.
    A target the model invented, or left empty, becomes the context's chosen concept."""
    from ai.verification.question_context import humanize_concept
    t = humanize_concept(target).lower()
    for c in [ctx.concept, *ctx.candidate_concepts]:
        if t and c.lower() == t:
            return ctx.original(c)
    return ctx.original(ctx.concept)
