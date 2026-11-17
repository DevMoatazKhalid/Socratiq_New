"""Concept-aware adaptation rules for the Coach (pure functions, no network, no database).

Two things the Coach used to get wrong:

1. "Repeated difficulty" was `same category OR same concept`: two unrelated MISCONCEPTIONs (loops, then recursion) counted as one unresolved
   difficulty and triggered escalation. Escalation must follow the SAME CONCEPT staying unresolved, not a matching label.
2. When an explanation had already been given and the student still struggled on that concept, nothing told the generator to change approach,
   so it could repeat the same explanation in other words.

Nothing here weakens the assignment policy: the output is advice to the generator (a different angle), never more assistance than the policy allows.
"""
from __future__ import annotations

import re
from typing import Optional

_WORD = re.compile(r"[\w\u0600-\u06FF]+", re.UNICODE)
_STOP = {"the", "a", "an", "of", "in", "on", "and", "or", "to", "for", "with", "basic", "basics", "concept", "concepts", "understanding"}
NOT_A_DIFFICULTY = {"CORRECT_REASONING", "UNCERTAIN"}


def concept_tokens(concept: Optional[str]) -> frozenset[str]:
    return frozenset(t for t in (w.lower() for w in _WORD.findall(concept or "")) if t not in _STOP)


def same_concept(a: Optional[str], b: Optional[str]) -> Optional[bool]:
    """True/False when both concepts are known; None when identity cannot be judged (either side empty).
    Containment counts as the same concept ("recursion" within "recursion base case"); disjoint token sets do not."""
    ta, tb = concept_tokens(a), concept_tokens(b)
    if not ta or not tb:
        return None
    return ta <= tb or tb <= ta


def is_repeated_difficulty(prior_category: Optional[str], prior_concept: Optional[str], new_category: Optional[str], new_concept: Optional[str]) -> bool:
    """Is the student still stuck on the SAME thing?  Both turns must be real difficulties.
    - both concepts known  -> they must be the same concept (a matching category alone is not evidence);
    - neither concept known -> identity is unknowable, the matching category is the only evidence we have;
    - only one known       -> we cannot assert it is the same difficulty, so it is not treated as repeated (no escalation on a guess)."""
    if not prior_category or not new_category or prior_category in NOT_A_DIFFICULTY or new_category in NOT_A_DIFFICULTY:
        return False
    verdict = same_concept(prior_concept, new_concept)
    if verdict is None:
        return (not concept_tokens(prior_concept)) and (not concept_tokens(new_concept)) and prior_category == new_category
    return verdict


_FAILED_HELP = {"EXPLANATION", "GUIDED_DEBUGGING", "HINT"}


def strategy_shift_note(*, repeated: bool, previous_intervention: Optional[str], chosen_intervention: str, policy: str, concept: Optional[str]) -> Optional[str]:
    """Internal instruction for the generator when the previous help on this concept did not work. None when no shift is warranted."""
    if not repeated or not previous_intervention or previous_intervention not in _FAILED_HELP:
        return None
    topic = f" on '{concept}'" if concept else ""
    allowed = {
        "GUIDED": "a different small question, a concrete everyday analogy, or a picture of the structure (still no solution, no partial solution)",
        "ASSISTED": "a different angle: a concrete analogy, a worked example of a RELATED problem, or a picture of the structure",
        "OPEN": "a different angle: a concrete analogy, a fully worked example of a RELATED problem, or a picture of the structure",
    }.get(str(policy).upper(), "a different small question or a concrete analogy")
    return (f"The student is still stuck{topic} after your previous {previous_intervention}. Do NOT repeat that explanation or hint in other words. "
            f"Change the representation: use {allowed}. Keep the assignment policy and the answer-leak rules exactly as above.")
