"""Typed request bodies. Identity, role, university and policy are NEVER accepted from the client: they come from the
authenticated profile and the database. (Extra fields are rejected so a forged `student_id`/`policy` is a 422, not ignored.)"""
from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal, Optional

from ai.whiteboard.models import BoardElement
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class ProfileIn(Strict):
    first_name: str = Field(min_length=1, max_length=80)
    last_name: str = Field(min_length=1, max_length=80)
    role: Literal["STUDENT", "PROFESSOR"]
    university_id: str = Field(min_length=1, max_length=80)
    signup_code: Optional[str] = Field(default=None, max_length=128)   # instructor access code; see config.teacher_signup_code


COLORS = ("plum", "slate", "teal", "clay")


class CourseIn(Strict):
    code: str = Field(min_length=1, max_length=30)
    title: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    color: Literal["plum", "slate", "teal", "clay"] = "plum"
    section_name: str = Field(default="Main", min_length=1, max_length=80)


class CoursePatch(Strict):
    title: Optional[str] = Field(default=None, min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=2000)
    color: Optional[Literal["plum", "slate", "teal", "clay"]] = None
    status: Optional[Literal["ACTIVE", "ARCHIVED"]] = None


class AssignmentIn(Strict):
    title: str = Field(min_length=1, max_length=200)
    topic: Optional[str] = Field(default=None, max_length=120)
    prompt: str = Field(min_length=1, max_length=50000)
    due_at: Optional[datetime] = None
    is_programming: bool = False
    publish: bool = False
    classroom_id: Optional[str] = None
    material_ids: list[str] = Field(default_factory=list, max_length=50)
    concepts: list[str] = Field(default_factory=list, max_length=20)


class AssignmentPatch(Strict):
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    topic: Optional[str] = Field(default=None, max_length=120)
    prompt: Optional[str] = Field(default=None, min_length=1, max_length=50000)
    due_at: Optional[datetime] = None
    clear_due_at: bool = False
    is_programming: Optional[bool] = None
    material_ids: Optional[list[str]] = Field(default=None, max_length=50)
    concepts: Optional[list[str]] = Field(default=None, max_length=20)


class JoinIn(Strict):
    code: str = Field(min_length=4, max_length=20)

    @field_validator("code")
    @classmethod
    def norm(cls, v: str) -> str:
        v = "".join(ch for ch in v.upper() if ch.isalnum())
        if len(v) != 8:
            raise ValueError("invite codes have 8 letters/digits, e.g. K7M4-9QXA")
        return f"{v[:4]}-{v[4:]}"


class AttemptPatch(Strict):
    draft_text: str = Field(max_length=100000)


class Stroke(Strict):
    """One freehand stroke on the board: `p` pen / `e` eraser, width, and points in board units (0..2000)."""
    t: Literal["p", "e", "h"]            # pen / eraser / highlighter
    w: int = Field(ge=1, le=40)
    pts: list[tuple[int, int]] = Field(min_length=1, max_length=4000)
    color: Optional[str] = Field(default=None, max_length=40)

    @field_validator("pts")
    @classmethod
    def _in_board(cls, v):
        if any(not (0 <= x <= 2000 and 0 <= y <= 2000) for x, y in v):
            raise ValueError("stroke point outside the board")
        return v


class WhiteboardIn(Strict):
    steps: list[Annotated[str, StringConstraints(max_length=1000, strip_whitespace=True)]] = Field(default_factory=list, max_length=60)      # legacy typed steps
    strokes: list[Stroke] = Field(default_factory=list, max_length=600)
    elements: list[BoardElement] = Field(default_factory=list, max_length=200)      # smart-board elements (text, equations, arrows, shapes)
    next_seq: int = Field(default=0, ge=0, le=1_000_000)
    # Native (Excalidraw) scene. When present it is the ONLY thing a save changes: the legacy fields above are kept as stored.
    scene: Optional[dict[str, Any]] = None
    # Optimistic concurrency for scene saves: the scene_rev the client's copy was based on. Omitted = legacy behaviour (last write wins).
    base_rev: Optional[int] = Field(default=None, ge=0, le=1_000_000_000)

    @field_validator("scene")
    @classmethod
    def _scene(cls, v):
        if v is None:
            return v
        from ai.whiteboard.scene import SceneError, sanitize_scene
        try:
            return sanitize_scene(v)
        except SceneError as e:
            raise ValueError(str(e))

    @model_validator(mode="after")
    def _bounded(self):
        if sum(len(s.pts) for s in self.strokes) > 30000:
            raise ValueError("the drawing is too large")
        ids = [e.id for e in self.elements]
        if len(set(ids)) != len(ids):
            raise ValueError("duplicate element ids")
        known = set(ids)
        for e in self.elements:
            if any(ref and ref not in known for ref in (e.from_id, e.to_id, e.around)):
                raise ValueError("an element refers to an element that does not exist")
        self.steps = [x for x in self.steps if x]
        return self


class SubmitTextIn(Strict):
    text: str = Field(min_length=1, max_length=100000)


class GradeIn(Strict):
    score: float = Field(ge=0, le=100000)
    max_score: float = Field(gt=0, le=100000)
    feedback: Optional[str] = Field(default=None, max_length=4000)


class CoachIn(Strict):
    assignment_id: str = Field(min_length=1, max_length=200)
    message: str = Field(min_length=1, max_length=4000)
    # Whiteboard context supplied by the UI. These only describe what the student is looking at / pressed; they never grant permissions:
    mode: Literal["chat", "board"] = "chat"
    selected_id: Optional[str] = Field(default=None, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    board_intent: Optional[Literal["explain", "continue", "correct", "summarize", "organize", "highlight_key", "steps"]] = None
    # The UI says it can display a Coach-initiated visual. This only ENABLES the possibility: whether the Coach may propose one, and whether it may
    # be drawn, is decided server-side (diagnosis, validator, budget) and enforced again before anything is generated.
    visuals: bool = False
    # Idempotency key chosen by the client for ONE student message (reused when that same message is retried). If a turn with this key was already
    # stored, the stored reply is returned and nothing is generated or written a second time.
    client_turn_id: Optional[str] = Field(default=None, min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")


class PersonaIn(Strict):
    persona_id: str = Field(min_length=2, max_length=40, pattern=r"^[a-z][a-z0-9_]+$")
    assignment_id: Optional[str] = Field(default=None, max_length=200)      # only to place the change on the right learning timeline


class VerificationAnswerIn(Strict):
    answer: str = Field(min_length=1, max_length=8000)


class EnrollmentPatch(Strict):
    status: Literal["active", "inactive"]


class StrictRaw(BaseModel):
    """Like Strict, but text is kept byte-for-byte (code indentation, trailing newlines and Markdown spacing are meaningful)."""
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=False)


# ---------------------------------------------------------------- student notes
NOTE_ID = r"^note_[0-9a-f]{32}$"
NOTE_TITLE_MAX, NOTE_CONTENT_MAX = 200, 100_000


class NoteCreateIn(StrictRaw):
    # Chosen by the client BEFORE the first save, so a retried create is idempotent: the same id can never become two notes.
    id: str = Field(pattern=NOTE_ID)
    title: str = Field(default="", max_length=NOTE_TITLE_MAX)
    content: str = Field(default="", max_length=NOTE_CONTENT_MAX)
    # "Save to Notes" on a Coach reply: the interaction it came from. Saving the same reply again returns the existing note.
    source_kind: Optional[Literal["coach_message"]] = None
    source_ref: Optional[str] = Field(default=None, min_length=1, max_length=200, pattern=r"^[A-Za-z0-9_:.-]+$")

    @model_validator(mode="after")
    def _source_pair(self):
        if (self.source_kind is None) != (self.source_ref is None):
            raise ValueError("source_kind and source_ref go together")
        return self


GROUP_ID = r"^grp_[0-9a-f]{32}$"
ROW_ID = r"^[A-Za-z0-9_:.-]{1,200}$"          # course / assignment ids as stored (opaque text)


class NoteMetaIn(Strict):
    """Organisation fields of a note (Notes board). Only the fields that are SENT change; an explicit null clears a field.
    These never bump the note's text version, so they cannot conflict with an edit in another tab."""
    importance: Optional[Literal["high", "medium", "low"]] = None
    pinned: Optional[bool] = None
    course_id: Optional[str] = Field(default=None, pattern=ROW_ID)
    assignment_id: Optional[str] = Field(default=None, pattern=ROW_ID)
    group_ids: Optional[list[Annotated[str, StringConstraints(pattern=GROUP_ID)]]] = Field(default=None, max_length=50)

    @model_validator(mode="after")
    def _something(self):
        if not self.model_fields_set:
            raise ValueError("nothing to update")
        if "pinned" in self.model_fields_set and self.pinned is None:
            raise ValueError("pinned must be true or false")
        return self


class NoteGroupIn(Strict):
    name: str = Field(min_length=1, max_length=80)
    assignment_id: Optional[str] = Field(default=None, pattern=ROW_ID)
    note_ids: list[Annotated[str, StringConstraints(pattern=NOTE_ID)]] = Field(default_factory=list, max_length=500)


class NoteGroupPatchIn(Strict):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    assignment_id: Optional[str] = Field(default=None, pattern=ROW_ID)

    @model_validator(mode="after")
    def _something(self):
        if not self.model_fields_set:
            raise ValueError("nothing to update")
        if "name" in self.model_fields_set and self.name is None:
            raise ValueError("name cannot be empty")
        return self


class NotePatchIn(StrictRaw):
    base_version: int = Field(ge=1, le=2_000_000_000)      # the version the client's text is based on (optimistic concurrency)
    title: Optional[str] = Field(default=None, max_length=NOTE_TITLE_MAX)
    content: Optional[str] = Field(default=None, max_length=NOTE_CONTENT_MAX)

    @model_validator(mode="after")
    def _something(self):
        if self.title is None and self.content is None:
            raise ValueError("nothing to update")
        return self


# ---------------------------------------------------------------- in-chat code runner
CODE_SOURCE_MAX, CODE_STDIN_MAX = 20_000, 16_000


class CodeRunIn(StrictRaw):
    # Chosen by the client for this run so it can cancel it while the request is still open. Scoped to the student: never shared.
    run_id: str = Field(pattern=r"^[A-Za-z0-9_-]{8,64}$")
    language: str = Field(min_length=1, max_length=20, pattern=r"^[a-z0-9+#]+$")
    source: str = Field(min_length=1, max_length=CODE_SOURCE_MAX)
    stdin: str = Field(default="", max_length=CODE_STDIN_MAX)
