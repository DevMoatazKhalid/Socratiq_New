"""
Response validation / guardrails for the AI Coach (section 22).

Three layers, cheapest first:
1. Fast, deterministic rule checks (no LLM call) that catch the clearest
   policy violations — applied to ALL policies (GUIDED, ASSISTED, OPEN).
   Includes a lightweight structural code-leak detector for programming tasks.
2. An LLM-based reviewer for the more nuanced checks (relevance, whether the
   answer was effectively given away, unsupported claims about the student,
   confidence-calibration, etc).
3. A deterministic final-answer enforcement pass that runs AFTER validation
   and AFTER any LLM rewrites — the absolute last line of defense.

Keep this focused -- it is not a general content-moderation framework.
"""
from __future__ import annotations

import logging
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ai.agents.coach.schemas import ValidationResult

from ai.models.llm import ModelRole, get_structured_llm
from ai.models.schemas import AssistancePolicy
from ai.prompts.verification.validation_prompt import build_validation_messages
from ai.tools.code_analysis import CodeAnalysisTool

logger = logging.getLogger(__name__)

# ── Structural code-leak detection thresholds ─────────────────────────────
# A high-confidence structural leak requires ALL of these signals together.
# A single threshold (e.g. just line count) would create excessive false
# positives for legitimate pedagogical code examples.
#
# Rationale for each threshold:
#   MIN_LINES       — below this, any code block is almost certainly a snippet.
#   MIN_FUNCTIONS   — at least one named function indicates a complete unit.
#   MIN_LOOPS       — at least one loop indicates algorithmic logic is present.
#   MIN_VARIABLES   — multiple assignments suggest full implementation state.
#
# For OPEN policy a stricter multi-function threshold is applied because Open
# permits broader worked examples but must still block the actual solution.
STRUCTURAL_LEAK_MIN_LINES = 8
STRUCTURAL_LEAK_MIN_FUNCTIONS = 1
STRUCTURAL_LEAK_MIN_LOOPS = 1
STRUCTURAL_LEAK_MIN_VARIABLES = 2
# OPEN requires >= 2 functions OR all other signals must be present at higher
# counts — implemented in structural_code_leak_check().
STRUCTURAL_LEAK_OPEN_MIN_FUNCTIONS = 2

# Reusable singleton — CodeAnalysisTool is stateless.
_CODE_ANALYSIS_TOOL = CodeAnalysisTool()


# ── Universal answer-revealing phrases (apply to ALL policies) ────────────
# The Coach MUST NEVER give the student the final answer, regardless of policy.
#
# Two kinds of signal:
#   * "Hand-over" phrases ("here is the solution") are unambiguous and matched as substrings.
#   * "X is ..." statements ("the answer is 42") are matched by `_ANSWER_REVEAL_PATTERN` below, which
#     deliberately does NOT fire on feedback about the STUDENT'S OWN work ("your answer is correct",
#     "your solution is almost there", "the answer is not quite right yet"). Blocking those replaced
#     every piece of praise with a generic "walk me through your reasoning", which told students who
#     had just got it right to start over -- the opposite of good Socratic coaching.
_UNIVERSAL_RED_FLAG_PHRASES = (
    "here is the solution",
    "here's the solution",
    "here is the complete solution",
    "here's the complete solution",
    "here is the full solution",
    "here's the full solution",
    "here is the answer",
    "here's the answer",
    # Arabic hand-over phrasing ("here is the solution / answer", "this is the final solution")
    "إليك الحل",
    "اليك الحل",
    "إليك الإجابة",
    "اليك الاجابة",
    "هذا هو الحل",
    "هذه هي الإجابة",
)

# Words that, right after "the answer is", make the sentence an EVALUATION of the student's work rather
# than a reveal of the answer itself.
_EVALUATIVE_FOLLOWERS = (
    r"correct|right|wrong|incorrect|close|closer|almost|nearly|partly|partially|mostly|"
    r"not\b|on\s+the\s+right\s+track|in\s+the\s+right\s+direction|a\s+good\s+start|"
    r"looking\s+good|getting\s+there|valid|reasonable|plausible|unclear|incomplete|missing"
)

# Additional phrases only flagged under GUIDED (where even partial answers
# are dangerous).
_GUIDED_EXTRA_PHRASES = (
    "you should write",
    "the code should be",
    "the code is",
    "the formula is",
    "just use",
    "simply use",
)


# Compiled pattern to extract markdown fenced code blocks.
_CODE_FENCE_PATTERN = re.compile(
    r"```(?:[a-zA-Z0-9_\-+#.]*)\s*\n(.*?)```",
    re.DOTALL,
)


def structural_code_leak_check(
    *,
    policy: AssistancePolicy,
    draft_response: str,
    is_programming: bool,
) -> list[str]:
    """Lightweight deterministic structural code-leak detector.

    Applies only to programming tasks (``is_programming=True``).

    Detects high-confidence structural indications that the response contains
    a complete assignment solution, even when no answer-revealing *phrases* are
    present.  The heuristic intentionally requires ALL of the following signals
    simultaneously so that short pedagogical examples, partial snippets, and
    single-concept demonstrations are not blocked:

    * Valid Python syntax
    * Line count >= STRUCTURAL_LEAK_MIN_LINES
    * At least one function definition (>= STRUCTURAL_LEAK_MIN_FUNCTIONS)
    * At least one loop (>= STRUCTURAL_LEAK_MIN_LOOPS)
    * At least two variable assignments (>= STRUCTURAL_LEAK_MIN_VARIABLES)

    For the OPEN policy (which permits broader worked examples), the function
    threshold is raised to STRUCTURAL_LEAK_OPEN_MIN_FUNCTIONS so that a single
    small helper function does not trigger a false alarm, while a full
    multi-function implementation still does.

    Returns a (possibly empty) list of violation strings.
    """
    if not is_programming:
        return []

    # Apply Open policy using stricter function threshold.
    min_functions = (
        STRUCTURAL_LEAK_OPEN_MIN_FUNCTIONS
        if policy == AssistancePolicy.OPEN
        else STRUCTURAL_LEAK_MIN_FUNCTIONS
    )

    violations: list[str] = []
    code_blocks = _CODE_FENCE_PATTERN.findall(draft_response)

    for block in code_blocks:
        block = block.strip()
        if not block:
            continue
        try:
            result = _CODE_ANALYSIS_TOOL.analyze(block)
        except Exception:
            # Analysis failure is non-fatal; skip this block.
            continue

        if not result.is_supported_language:
            # Non-Python code is not analysed by the structural check.
            continue

        if not result.is_valid_syntax:
            # Invalid syntax cannot be a complete runnable solution.
            continue

        # Require ALL four structural signals together.
        has_sufficient_lines = result.line_count >= STRUCTURAL_LEAK_MIN_LINES
        has_function = len(result.defined_functions) >= min_functions
        has_loop = result.loops >= STRUCTURAL_LEAK_MIN_LOOPS
        has_variables = len(result.defined_variables) >= STRUCTURAL_LEAK_MIN_VARIABLES

        if has_sufficient_lines and has_function and has_loop and has_variables:
            logger.warning(
                "structural_code_leak_check: high-confidence structural leak detected "
                "(lines=%d, functions=%d, loops=%d, vars=%d) under %s policy.",
                result.line_count,
                len(result.defined_functions),
                result.loops,
                len(result.defined_variables),
                policy.value,
            )
            violations.append(
                f"{policy.value} policy violation: response contains a code block that "
                f"exhibits high-confidence structural indicators of a complete solution "
                f"(lines={result.line_count}, functions={len(result.defined_functions)}, "
                f"loops={result.loops}, variables={len(result.defined_variables)})."
            )

    return violations


def rule_based_check(
    *,
    policy: AssistancePolicy,
    draft_response: str,
    is_programming: bool = False,
) -> list[str]:
    """Deterministic rule check applied to ALL policies.

    The final-answer prohibition is universal across GUIDED, ASSISTED, and
    OPEN.  GUIDED additionally flags partial-answer phrases.

    ``is_programming=True`` activates the structural code-leak detector, which
    catches complete solutions that contain no answer-revealing phrases.
    """
    violations: list[str] = []
    if not draft_response or not draft_response.strip():
        violations.append("Response is empty.")
        return violations

    lowered = draft_response.lower()

    # Universal: answer-revealing phrases forbidden under every policy.
    for phrase in find_answer_reveals(draft_response):
        violations.append(
            f"{policy.value} policy violation: response contains "
            f"answer-revealing phrase '{phrase}'."
        )

    # GUIDED-only: additional phrases that are too close to giving the answer.
    if policy == AssistancePolicy.GUIDED:
        for phrase in _GUIDED_EXTRA_PHRASES:
            if phrase in lowered:
                violations.append(
                    f"GUIDED policy violation: response contains "
                    f"direct-answer phrase '{phrase}'."
                )

    # Structural code-leak check (programming tasks only).
    violations.extend(
        structural_code_leak_check(
            policy=policy,
            draft_response=draft_response,
            is_programming=is_programming,
        )
    )

    return violations


# ── Deterministic final-answer enforcement (absolute last line) ───────────

# Compiled pattern that catches "the answer/solution is X" and similar. A possessive determiner ("your
# answer is", "my solution is", "this answer is") marks talk ABOUT the student's work, and an evaluative
# follower ("... is correct", "... is almost there") marks feedback; neither reveals anything.
_ANSWER_REVEAL_PATTERN = re.compile(
    r"(?<![\w'’])(?:(?P<det>the|your|my|this|that|his|her|their|our|its)\s+)?"
    r"(?:correct\s+|final\s+|complete\s+|full\s+|right\s+)?"
    r"(?:answer|solution)\s+(?:is|would\s+be|equals?|=)\s+"
    r"(?!(?:" + _EVALUATIVE_FOLLOWERS + r"))",
    re.IGNORECASE,
)
_POSSESSIVE_DETERMINERS = frozenset({"your", "my", "this", "that", "his", "her", "their", "our", "its"})

# Arabic "the (correct/final) answer/solution is ..." (الإجابة / الاجابة / الجواب / الحل ... هي / هو / = / :).
# The student's own answer is a different word form (إجابتك / حلك), so it never matches.
_ARABIC_ANSWER_REVEAL_PATTERN = re.compile(
    r"(?:ال)(?:إجابة|اجابة|أجابة|جواب|حل)\s*(?:ال(?:صحيح[ةه]?|نهائي[ةه]?|كامل[ةه]?))?\s*(?:هي|هو|=|:)\s*"
    r"(?!(?:صحيح|صح|خطأ|خاطئ|قريب|غير|ليس|ليست))"
)


def find_answer_reveals(text: str) -> list[str]:
    """Every answer-revealing span in `text` (English or Arabic). Empty when the text only gives
    feedback on the student's own work. Shared by the rule check, the final enforcement pass and the
    board/live review so the three layers can never disagree."""
    if not text:
        return []
    lowered = text.lower()
    hits: list[str] = [p for p in _UNIVERSAL_RED_FLAG_PHRASES if p in lowered]
    for m in _ANSWER_REVEAL_PATTERN.finditer(text):
        det = (m.group("det") or "").lower()
        if det in _POSSESSIVE_DETERMINERS:
            continue
        hits.append(m.group(0).strip())
    hits += [m.group(0).strip() for m in _ARABIC_ANSWER_REVEAL_PATTERN.finditer(text)]
    return hits


def final_answer_enforcement(
    response: str,
    *,
    policy: AssistancePolicy = AssistancePolicy.GUIDED,
    is_programming: bool = False,
) -> tuple[bool, str]:
    """Deterministic last-line-of-defense check.

    Returns (is_safe, cleaned_response).  If the response is unsafe,
    ``cleaned_response`` is a safe Socratic fallback.

    This function MUST run after every path that produces a student-facing
    response — after generation, after LLM validation, and after any
    revised_response substitution.

    ``policy`` and ``is_programming`` are used to run the structural code-leak
    check (shared with rule_based_check) so the final enforcement path remains
    consistent with the earlier deterministic layer.
    """
    if not response or not response.strip():
        return False, _SAFE_SOCRATIC_FALLBACK

    # Check universal hand-over phrases and "the answer is X" statements (English + Arabic)
    reveals = find_answer_reveals(response)
    if reveals:
        logger.warning(
            "final_answer_enforcement blocked response containing '%s'",
            reveals[0][:80],
        )
        return False, _fallback_for(response)

    # Structural code-leak check (programming tasks only) — shared logic,
    # not a second inconsistent implementation.
    if is_programming:
        structural_violations = structural_code_leak_check(
            policy=policy,
            draft_response=response,
            is_programming=is_programming,
        )
        if structural_violations:
            logger.warning(
                "final_answer_enforcement blocked response due to structural code-leak signal."
            )
            return False, _fallback_for(response)

    return True, response


_SAFE_SOCRATIC_FALLBACK = (
    "Let me ask you a different way — can you walk me through your "
    "reasoning step by step? That will help me understand where to guide you."
)
_SAFE_SOCRATIC_FALLBACK_AR = (
    "دعني أسألك بطريقة مختلفة — هل يمكنك أن تشرح لي خطوات تفكيرك خطوة بخطوة؟ "
    "سيساعدني ذلك على معرفة أين أوجّهك."
)
_ARABIC_LETTER = re.compile(r"[\u0600-\u06FF]")


def _fallback_for(response: str) -> str:
    """The safe redirect in the language the reply was written in (Arabic-dominant -> Arabic)."""
    letters = [c for c in (response or "") if c.isalpha()]
    if letters and sum(1 for c in letters if _ARABIC_LETTER.match(c)) / len(letters) > 0.5:
        return _SAFE_SOCRATIC_FALLBACK_AR
    return _SAFE_SOCRATIC_FALLBACK


def llm_check(
    *,
    policy: AssistancePolicy,
    diagnosis_category: str,
    diagnosis_confidence: float,
    intervention_type: str,
    course_material: str,
    draft_response: str,
    assignment_title: str | None = None,
    assignment_instructions: str | None = None,
    student_work: str | None = None,
) -> ValidationResult:
    from ai.agents.coach.schemas import ValidationResult

    messages = build_validation_messages(
        policy=policy.value,
        diagnosis_category=diagnosis_category,
        diagnosis_confidence=diagnosis_confidence,
        intervention_type=intervention_type,
        course_material=course_material,
        draft_response=draft_response,
        assignment_title=assignment_title,
        assignment_instructions=assignment_instructions,
        student_work=student_work,
    )
    llm = get_structured_llm(ModelRole.LIGHTWEIGHT, ValidationResult)
    return llm.invoke(messages)


def validate_response(
    *,
    policy: AssistancePolicy,
    diagnosis_category: str,
    diagnosis_confidence: float,
    intervention_type: str,
    course_material: str,
    draft_response: str,
    use_llm: bool = True,
    is_programming: bool = False,
    assignment_title: str | None = None,
    assignment_instructions: str | None = None,
    student_work: str | None = None,
) -> ValidationResult:
    """Full validation pass.

    1. Deterministic rule check (all policies), including structural code-leak
       detection when ``is_programming=True``.
    2. LLM check (unless disabled).
    3. Re-check of any LLM-proposed revised_response with the same rules.
    """
    from ai.agents.coach.schemas import ValidationResult

    violations = rule_based_check(
        policy=policy, draft_response=draft_response, is_programming=is_programming
    )

    if not use_llm:
        return ValidationResult(passes=not violations, violations=violations)

    try:
        llm_result = llm_check(
            policy=policy,
            diagnosis_category=diagnosis_category,
            diagnosis_confidence=diagnosis_confidence,
            intervention_type=intervention_type,
            course_material=course_material,
            draft_response=draft_response,
            assignment_title=assignment_title,
            assignment_instructions=assignment_instructions,
            student_work=student_work,
        )

        if llm_result is None:
            logger.warning(
                "LLM validation returned None; falling back to deterministic "
                "rule-based validation only."
            )
            return ValidationResult(
                passes=not violations,
                violations=violations,
            )

    except Exception:
        logger.exception(
            "LLM validation call failed; falling back to rule-based result only."
        )
        return ValidationResult(
            passes=not violations,
            violations=violations,
        )

    all_violations = violations + list(llm_result.violations)

    passes = not all_violations
    revised = llm_result.revised_response if not passes else None

    # If the LLM proposed a revised response, enforce rules on it too.
    if revised:
        revised_violations = rule_based_check(
            policy=policy, draft_response=revised, is_programming=is_programming
        )
        if revised_violations:
            # The LLM's rewrite itself violates rules — reject it.
            logger.warning(
                "LLM revised_response also violates rules; discarding rewrite."
            )
            all_violations.extend(revised_violations)
            revised = None

    return ValidationResult(
        passes=passes, violations=all_violations, revised_response=revised
    )
