"""The chat's Run button only appears for a closed, language-tagged ``` fence, so the Coach prompt must ask for exactly that (prompt v5).

Regression: from the code-runner release on, nothing told the model how to format code (and v4 added "never put math inside code
blocks"), so replies often carried code as plain text, in single backticks, untagged or with an unclosed fence: no interactive block.
"""
from __future__ import annotations

import pytest

from ai.prompts.coach.response_prompt import RESPONSE_PROMPT_VERSION, build_response_messages


def _system(policy: str, **kw) -> str:
    msgs = build_response_messages(policy=policy, intervention_type="HINT", diagnosis_category="CODE_ERROR", diagnosis_concept="loops", **kw)
    return msgs[0].content


@pytest.mark.parametrize("policy", ["GUIDED", "ASSISTED", "OPEN"])
def test_every_policy_asks_for_language_tagged_closed_fences(policy):
    s = _system(policy)
    assert "```python" in s                                   # the opening fence names the language
    assert "closing ``` on its own" in s                      # ... and the fence is closed
    assert "single backticks" in s                            # multi-line code never goes in inline code
    assert "Run button" in s


def test_code_formatting_never_relaxes_the_policy():
    s = _system("GUIDED")
    assert "never put the assignment's solution in a code block" in s
    # the policy block still comes first and is unchanged
    assert s.index("ABSOLUTE RULE") < s.index("Whenever your reply contains program code")


def test_rule_survives_persona_and_board_turns():
    s = _system("ASSISTED", persona_id="socratic_guide", board_context="(empty board)")
    assert "Whenever your reply contains program code" in s


def test_prompt_version_bumped():
    assert RESPONSE_PROMPT_VERSION == "v5"
