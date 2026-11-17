"""Board data model shared by the API, the Coach and the tests. The frontend mirrors it in `frontend/src/lib/whiteboard.ts`.

`BoardElement` is what is STORED (strict). `BoardAction` is what the model PROPOSES (lenient parse, then validated by the engine):
the model never supplies coordinates, only semantic positions ("below_previous", "near_id"), so it cannot place raw pixels.
"""
from __future__ import annotations

from typing import Annotated, Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .latex import check_latex

BOARD_W, BOARD_H = 2000, 1200
MAX_ELEMENTS = 200
MAX_ACTIONS_PER_TURN = 12
MAX_TEXT_CHARS = 1000

Kind = Literal["text", "equation", "shape", "arrow", "line", "circle", "triangle", "image", "simulation", "path"]
Author = Literal["student", "coach"]
TextStyle = Literal["plain", "title", "definition", "note", "step"]
Color = Literal["yellow", "green", "red", "blue", "black", "white", "slate", "purple", "pink"]
Position = Literal["auto", "below_previous", "right_of_previous", "top", "center", "bottom", "left", "right"]
ActionName = Literal["add_text", "add_equation", "highlight", "unhighlight", "erase", "clear", "update", "add_arrow", "add_shape", "organize"]


# Generous but finite: the logical stage is 2000x1200 and the client clamps to it, so anything beyond this is not a real board element.
COORD_LIMIT = 50_000.0
_Num = Annotated[float, Field(ge=-COORD_LIMIT, le=COORD_LIMIT, allow_inf_nan=False)]


class BoardElement(BaseModel):
    # `forbid`: an unknown field is a client bug and must surface as a 422 instead of being dropped silently.
    # `populate_by_name`: the wire format is snake_case (stroke_width, path_data, ...) while older clients used the camelCase aliases; both are accepted.
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    id: str = Field(min_length=1, max_length=64)
    kind: Kind
    author: Author = "student"
    seq: int = Field(default=0, ge=0, le=1_000_000)
    x: _Num = 0
    y: _Num = 0
    w: _Num = 0
    h: _Num = 0
    text: Optional[str] = Field(default=None, max_length=MAX_TEXT_CHARS)
    latex: Optional[str] = Field(default=None, max_length=400)
    style: Optional[TextStyle] = None
    color: Optional[str] = Field(default=None, max_length=32)
    highlight: Optional[str] = Field(default=None, max_length=32)
    from_id: Optional[str] = Field(default=None, max_length=64)
    to_id: Optional[str] = Field(default=None, max_length=64)
    shape: Optional[str] = Field(default=None, max_length=32)
    around: Optional[str] = Field(default=None, max_length=64)
    # SmartBoard properties
    rotation: Optional[float] = Field(default=0, ge=-3600, le=3600, allow_inf_nan=False)
    filled: Optional[bool] = False
    stroke_width: Optional[float] = Field(default=None, alias="strokeWidth", ge=0, le=200, allow_inf_nan=False)
    x2: Optional[_Num] = None
    y2: Optional[_Num] = None
    points: Optional[list[Any]] = Field(default=None, max_length=4000)
    path_data: Optional[str] = Field(default=None, alias="pathData", max_length=50_000)
    src: Optional[str] = None
    code: Optional[str] = Field(default=None, max_length=200_000)
    title: Optional[str] = Field(default=None, max_length=300)
    font_size: Optional[float] = Field(default=None, alias="fontSize", ge=1, le=1000, allow_inf_nan=False)
    is_loading: Optional[bool] = Field(default=False, alias="isLoading")
    original_author: Optional[str] = Field(default=None, alias="originalAuthor", max_length=16)
    student_modified: Optional[bool] = Field(default=None, alias="studentModified")

    @model_validator(mode="after")
    def _by_kind(self):
        if self.kind == "text" and not (self.text or "").strip():
            raise ValueError("text element needs text")
        if self.kind == "equation":
            why = check_latex(self.latex)
            if why:
                raise ValueError(f"equation rejected: {why}")
        if self.kind == "shape" and not self.shape:
            raise ValueError("shape element needs a shape")
        if self.kind == "arrow" and not ((self.from_id and self.to_id) or self.w or self.h):
            raise ValueError("arrow needs endpoints")
        return self


class BoardAction(BaseModel):
    """One proposed change. Unknown fields are ignored; everything is re-validated by the engine against the real board."""
    model_config = ConfigDict(extra="ignore")
    action: ActionName
    text: Optional[str] = Field(default=None, max_length=MAX_TEXT_CHARS)
    latex: Optional[str] = Field(default=None, max_length=400)
    style: Optional[TextStyle] = None
    position: Position = "auto"
    near_id: Optional[str] = Field(default=None, max_length=40)
    side: Literal["below", "right", "above", "left"] = "below"
    target_id: Optional[str] = Field(default=None, max_length=40)
    target: Optional[Literal["last"]] = None
    color: Optional[Color] = None
    ref: Optional[str] = Field(default=None, max_length=24)
    from_id: Optional[str] = Field(default=None, max_length=40)
    to_id: Optional[str] = Field(default=None, max_length=40)
    shape: Optional[Literal["rect", "ellipse"]] = None
    around_id: Optional[str] = Field(default=None, max_length=40)
    reveals_solution: bool = False                 # the model's own flag: "this writes the final answer"; GUIDED policy refuses those


def parse_actions(raw: Any) -> tuple[list[BoardAction], list[dict[str, str]]]:
    """Lenient parsing of model output. Never raises: malformed items are reported as rejected, the rest are kept."""
    if raw is None:
        return [], []
    if not isinstance(raw, list):
        return [], [{"action": "?", "reason": "board_actions was not a list"}]
    ok: list[BoardAction] = []
    bad: list[dict[str, str]] = []
    for i, item in enumerate(raw):
        if len(ok) >= MAX_ACTIONS_PER_TURN:
            bad.append({"action": str(item.get("action", "?")) if isinstance(item, dict) else "?", "reason": f"more than {MAX_ACTIONS_PER_TURN} actions in one turn"})
            continue
        try:
            ok.append(BoardAction.model_validate(item))
        except (ValidationError, TypeError, ValueError):
            bad.append({"action": str(item.get("action", "?")) if isinstance(item, dict) else "?", "reason": "malformed action"})
    return ok, bad
