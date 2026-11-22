"""
Assignment grading: domain models and the structured-output contracts of the grading model.

The grader judges a student's submission against the instructor's rubric. The model only ever proposes points per criterion and the
wording of the feedback; everything that makes a grade a grade (totals, the scale, levels, which criteria exist, whether a person must
look at it) is computed deterministically in `ai.grading.engine`, so two runs on the same work cannot disagree about arithmetic and an
answer cannot talk its way into a higher score.
"""
from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator

CRITERION_ID = r"^[a-z0-9][a-z0-9_-]{0,39}$"
MAX_CRITERIA = 25

Level = Literal["excellent", "proficient", "developing", "beginning", "missing"]
Severity = Literal["info", "review", "block"]


class RubricCriterion(BaseModel):
    """One row of an instructor's rubric."""

    id: str = Field(pattern=CRITERION_ID)
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=1000)
    points: float = Field(gt=0, le=10000)

    @field_validator("title", "description")
    @classmethod
    def _strip(cls, v: str) -> str:
        return " ".join(v.split())


class GradingRequest(BaseModel):
    """Everything the grader may see. Built by the backend from database rows; nothing here comes from the client."""

    assignment_id: str
    title: str
    instructions: str
    subject_area: Optional[str] = None
    is_programming: bool = False
    concepts: list[str] = Field(default_factory=list)
    rubric: list[RubricCriterion] = Field(min_length=1, max_length=MAX_CRITERIA)
    reference_answer: Optional[str] = None
    grading_notes: Optional[str] = None
    submission_text: str = ""
    whiteboard_text: Optional[str] = None
    submission_kind: str = "text"                 # text | file
    file_without_text: bool = False               # a file was submitted but no text could be extracted from it


# ---------------------------------------------------------------- what the model returns (structured output)
# Ranges are deliberately NOT enforced here: an out-of-range number must be clamped by the engine, not make the whole run unparseable.
class CriterionAssessmentPayload(BaseModel):
    criterion_id: str = Field(description="The id of the rubric criterion, exactly as given.")
    points_awarded: float = Field(description="Points for this criterion, between 0 and the criterion's maximum.")
    rationale: str = Field(description="One or two sentences for the instructor: why these points, referring to the answer.")
    evidence: str = Field(default="", description="A short verbatim quote (at most 25 words) from the student's answer that supports the judgement, or empty if the answer has nothing relevant.")


class GradingPayload(BaseModel):
    criteria: list[CriterionAssessmentPayload] = Field(description="Exactly one entry per rubric criterion.")
    feedback: str = Field(description="Feedback addressed to the student (3-6 sentences): what they did well, what is missing or wrong, and one concrete next step. In the student's language.")
    teacher_summary: str = Field(description="Two or three sentences for the instructor summarising the judgement and anything uncertain.")
    confidence: float = Field(description="How confident you are that an expert instructor would give the same points (0-1).")
    concerns: list[str] = Field(default_factory=list, description="Anything that made grading hard: unreadable parts, ambiguous requirements, an answer that seems incomplete or off-topic.")


class RubricDraftCriterionPayload(BaseModel):
    title: str = Field(description="Short criterion name (2-6 words).")
    description: str = Field(description="What a full-credit answer demonstrates for this criterion, in one or two sentences.")
    points: float = Field(gt=0, description="Points for this criterion.")


class RubricDraftPayload(BaseModel):
    criteria: list[RubricDraftCriterionPayload] = Field(description="3-6 criteria that together cover the assignment's requirements.")


# ---------------------------------------------------------------- what the engine returns
class GradingFlag(BaseModel):
    code: str
    message: str
    severity: Severity = "review"


class CriterionResult(BaseModel):
    id: str
    title: str
    points_awarded: float
    points_possible: float
    level: Level
    rationale: str = ""
    evidence: str = ""


class GradingResult(BaseModel):
    score: float
    max_score: float
    percentage: float
    confidence: float
    criteria: list[CriterionResult]
    feedback: str
    rationale: str
    flags: list[GradingFlag] = Field(default_factory=list)
    needs_review: bool = False
    samples: int = 1
    rubric_hash: str
    submission_hash: str
    prompt_version: str


class UngradableSubmission(Exception):
    """The work cannot be graded automatically (nothing readable). Not retryable: an instructor has to grade it."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


class GradingUnavailable(Exception):
    """The grading model could not be reached or returned nothing usable. Retryable."""
