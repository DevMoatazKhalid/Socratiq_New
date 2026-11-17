"""The shared pedagogical layer used by EVERY SocratiQ AI channel (Chat, Board, Live Voice).

The LangGraph Coach (`ai/agents/coach`) and its validator (`ai/guardrails/coach_validator.py`) remain the single pedagogical authority.
This package holds the pure, network-free pieces that let the other channels apply the SAME rules instead of inventing their own:

* `policy`       - the assignment-policy directive (GUIDED / ASSISTED / OPEN), rendered once, for any channel.
* `personas`     - the Teaching Persona registry: HOW the Coach communicates a decision (style only; ranks below policy and the validator).
* `visual_gate`  - a policy-aware review of "draw / simulate / illustrate this" requests and of the text that generated visuals carry.
"""
from .personas import DEFAULT_PERSONA_ID, TeachingPersona, get_persona, normalize_persona_id, persona_directive, persona_ids, persona_public_view, persona_ref
from .policy import normalize_policy, policy_directive, policy_rules_block
from .visual_gate import GateDecision, review_generated_text, review_visual_request

__all__ = ["DEFAULT_PERSONA_ID", "GateDecision", "TeachingPersona", "get_persona", "normalize_persona_id", "normalize_policy", "persona_directive", "persona_ids",
           "persona_public_view", "persona_ref", "policy_directive", "policy_rules_block", "review_generated_text", "review_visual_request"]
