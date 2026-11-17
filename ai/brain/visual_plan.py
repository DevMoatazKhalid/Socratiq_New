"""A COACH-INITIATED visual: the Coach decides, from its own diagnosis and reasoning, that a diagram or a simulation would genuinely help.

Autonomy here is a controlled extension of the Coach, not a side door:

* The decision is the Coach's: it is a field of the Coach's own structured output (`visual_plan`), produced in the same call as its reply, so the reply
  can say WHY the visual matters and invite the student to explore it.
* It goes through the SAME validator as the reply and the board writing (the plan's words are part of the draft the validator judges), through the
  deterministic last-line enforcement, and through the same visual gate the student's own requests meet. If the reply is rewritten or blocked, the
  plan is dropped with it, exactly like `board_actions`.
* It is rare by construction: only for the kinds of difficulty a picture or an experiment actually helps with, with a hard budget per attempt and a
  cool-down between visuals. The server enforces all of this; the model is only told about it.
* Nothing here draws anything. The plan becomes a server-signed, single-use grant; the board redeems it through the same gated generation endpoints.

Pure Python, no network: everything here is unit-tested without a model.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional, Union

from ai.models.schemas import AssistancePolicy

from .policy import normalize_policy
from .visual_gate import GateDecision, review_generated_text, review_visual_request

ALLOWED_KINDS = ("diagram", "simulation")          # a "graph" is a simulation; static images are never initiated by the Coach
MAX_REQUEST_CHARS, MAX_WHY_CHARS, MAX_EXPLORE_CHARS, MAX_CONCEPT_CHARS = 400, 300, 300, 80

# A picture or an experiment helps with understanding, not with every turn. These are the only difficulties and moves it may accompany.
ELIGIBLE_DIAGNOSES = frozenset({"MISCONCEPTION", "CONCEPTUAL_GAP", "INCOMPLETE_REASONING", "PROCEDURAL_ERROR"})
ELIGIBLE_INTERVENTIONS = frozenset({"QUESTION", "HINT", "EXPLANATION", "CLARIFICATION"})
# Never while the student asked something about the assignment itself (it is answered from the assignment text), and never as encouragement.
INELIGIBLE_INTENTS = frozenset({"assignment_about", "assignment_topics"})

MAX_VISUALS_PER_ATTEMPT = 3
MIN_TURNS_BETWEEN_VISUALS = 3


@dataclass(frozen=True)
class VisualPlan:
    kind: str
    request: str               # WHAT to draw, at the level of the concept: the only text the generator will ever receive for a Coach visual
    why: str                   # why it helps this student now
    explore_prompt: str        # the question that sends the student into the visual
    concept: Optional[str] = None

    def as_dict(self) -> dict:
        return {"kind": self.kind, "request": self.request, "why": self.why, "explore_prompt": self.explore_prompt, "concept": self.concept}


@dataclass(frozen=True)
class VisualBudget:
    """What the server knows about earlier Coach visuals in this attempt. Computed from recorded events, never from the client."""
    created_in_attempt: int = 0
    turns_since_last: Optional[int] = None         # None = no earlier Coach visual in this attempt

    def allows(self) -> bool:
        if self.created_in_attempt >= MAX_VISUALS_PER_ATTEMPT:
            return False
        return self.turns_since_last is None or self.turns_since_last >= MIN_TURNS_BETWEEN_VISUALS

    def reason_denied(self) -> Optional[str]:
        if self.created_in_attempt >= MAX_VISUALS_PER_ATTEMPT:
            return "the visual budget for this attempt is used up"
        if self.turns_since_last is not None and self.turns_since_last < MIN_TURNS_BETWEEN_VISUALS:
            return "a visual was placed a moment ago; let the student work with it first"
        return None


def _clip(v: Any, n: int) -> str:
    return " ".join(str(v or "").split())[:n].strip()


def parse_visual_plan(raw: Any) -> Optional[VisualPlan]:
    """Lenient on shape (a malformed optional field must never fail the turn), strict on content: anything incomplete or unknown becomes None."""
    if not isinstance(raw, dict):
        return None
    kind = str(raw.get("kind") or "").strip().lower()
    if kind == "graph":
        kind = "simulation"
    request, why, explore = _clip(raw.get("request"), MAX_REQUEST_CHARS), _clip(raw.get("why"), MAX_WHY_CHARS), _clip(raw.get("explore_prompt"), MAX_EXPLORE_CHARS)
    if kind not in ALLOWED_KINDS or not request or not why or not explore:
        return None
    return VisualPlan(kind=kind, request=request, why=why, explore_prompt=explore, concept=_clip(raw.get("concept"), MAX_CONCEPT_CHARS) or None)


def plan_text_for_judge(plan: VisualPlan) -> str:
    """Everything the plan will put in front of the student or the generator: the validator judges it together with the reply."""
    return f"{plan.kind}: {plan.request}\nWhy it helps: {plan.why}\nQuestion for the student: {plan.explore_prompt}"


def eligibility(*, diagnosis_category: Optional[str], intervention_type: Optional[str], request_intent: Optional[str] = None,
                visual_enabled: bool = True) -> tuple[bool, Optional[str]]:
    """The deterministic pedagogical gate. The Coach may only PROPOSE when this says yes."""
    if not visual_enabled:
        return False, "visuals are not available for this turn"
    if request_intent in INELIGIBLE_INTENTS:
        return False, "assignment-understanding requests are answered from the assignment text"
    if (diagnosis_category or "") not in ELIGIBLE_DIAGNOSES:
        return False, f"a visual does not help with a {diagnosis_category or 'missing'} diagnosis"
    if (intervention_type or "") not in ELIGIBLE_INTERVENTIONS:
        return False, f"a visual does not accompany a {intervention_type or 'missing'} move"
    return True, None


def review_plan(plan: VisualPlan, *, policy: Union[str, AssistancePolicy, None], is_programming: bool = False) -> GateDecision:
    """The same two checks every other channel applies: the request must not be a request for the answer, and nothing the plan displays may reveal it."""
    p = normalize_policy(policy)
    gate = review_visual_request(plan.request, policy=p, kind=plan.kind, is_programming=is_programming)
    if not gate.allowed:
        return gate
    return review_generated_text([plan.request, plan.why, plan.explore_prompt], policy=p, is_programming=is_programming, like_text=plan.request)


def visual_guidance(*, budget_note: Optional[str] = None) -> str:
    """The text the Coach's prompt gets ONLY on turns where a visual is allowed. Kept here so it is tested and cannot drift from the rules above."""
    return (
        "\n\nVisual explanations (optional, RARE; you decide):\n"
        "You may add `visual_plan` to your structured output: an object {\"kind\": \"diagram\"|\"simulation\", \"request\": ..., \"why\": ..., "
        "\"explore_prompt\": ..., \"concept\": ...}. The board will then draw it for the student right after your reply.\n"
        "Use it ONLY when a picture or an interactive experiment would clearly help THIS student understand THIS concept better than words, for example\n"
        "a process, a structure, a relationship between quantities, or a behaviour that changes with a parameter. Most turns need no visual: leave `visual_plan` null.\n"
        "- `request`: what to draw, about the CONCEPT (never the student's answer, a worked solution, or the assignment's result). A simulation lets the student change a parameter and watch.\n"
        "- `why`: one sentence on how it helps this student now. `explore_prompt`: one question that sends the student INTO the visual to notice something themselves.\n"
        "- Your reply must introduce the visual naturally: say what you put on the board, why it matters for what they are stuck on, and ask them to look and tell you what they notice.\n"
        "  Do not pre-announce the conclusion. The student stays in charge: they can move, change or delete anything on the board.\n"
        "- The same rules apply to the visual as to your words: it never reveals the final answer or a complete solution under any policy.\n"
        + (f"- Note: {budget_note}\n" if budget_note else "")
    )
