"""Policy-aware review of what the BOARD is asked to draw, simulate or illustrate, and of the text those visuals carry.

Why this exists: the Chat is guarded by the Coach pipeline + validator, but "draw me X" on the board used to go straight to a model with no
assignment, no policy and no pedagogy. A student could ask the board for the finished solution and get it as a diagram or simulation. This
module applies the same universal rule as `coach_validator` (never the final answer or complete solution, under every policy) to visual
requests, and re-checks the words that a generated visual displays with the Coach's own `final_answer_enforcement`.

It is deterministic (no network) and deliberately conservative: a refusal is not a dead end. It carries a Socratic redirect and the student
can rephrase toward the concept. A deterministic phrase gate can be paraphrased around; the optional LLM stage (`review_visual_with_llm`) reuses
the Coach validator's LLM reviewer for that, and the Coach's own turns are always validated by the full pipeline.
"""
from __future__ import annotations

import logging
import re
import unicodedata
from dataclasses import dataclass
from typing import Iterable, Optional, Union

from ai.guardrails.coach_validator import final_answer_enforcement
from ai.models.schemas import AssistancePolicy

from .policy import normalize_policy

log = logging.getLogger(__name__)

_ARABIC_LETTERS = re.compile(r"[\u0600-\u06FF]")
_TASHKEEL = re.compile(r"[\u064B-\u065F\u0670\u0640]")


def _norm(text: str) -> str:
    """Lower-case, NFKC, strip Arabic diacritics/tatweel and unify alef/ya/ta-marbuta so one pattern covers the spelling variants."""
    t = unicodedata.normalize("NFKC", text or "").lower()
    t = _TASHKEEL.sub("", t)
    return t.translate(str.maketrans({"أ": "ا", "إ": "ا", "آ": "ا", "ى": "ي", "ة": "ه"}))


def _rx(*patterns: str) -> re.Pattern:
    return re.compile("|".join(f"(?:{p})" for p in patterns), re.IGNORECASE)


# Asking for the answer itself: refused under EVERY policy (same universal rule as the Coach validator).
_SOLUTION = _rx(
    r"\b(?:the\s+)?(?:final|correct|complete|full|whole|entire)\s+(?:answer|solution)s?\b",
    r"\b(?:give|show|tell|write|draw|display|reveal|plot|visuali[sz]e)\s+(?:me\s+)?(?:the\s+|my\s+)?(?:answer|solution)s?\b",
    r"\bsolve\s+(?:it|this|that|these|those|the|my|our|question|problem|assignment|homework|exercise|for)\b",
    r"\b(?:do|finish|complete)\s+(?:my|the|this)\s+(?:homework|assignment|task|exercise|project)\b",
    r"\banswers?\s+(?:to|for|of)\s+(?:question|problem|exercise|task|q)\s*#?\s*\d*",
    r"\bwhat(?:'s|\s+is)\s+the\s+answer\b",
    r"الاجابه\s+(?:النهائيه|الصحيحه)", r"الحل\s+(?:الكامل|النهائي|الصحيح)",
    r"حل\s+(?:لي\s+|لنا\s+)?(?:المساله|التمرين|الواجب|السؤال|التكليف|المشكله)",
    r"جاوب(?:ني)?\s+(?:علي|عن)", r"اعمل(?:ي)?\s+(?:لي\s+)?الواجب",
)
# Under GUIDED even a worked or partial solution is too much.
_GUIDED_EXTRA = _rx(
    r"\bstep[\s-]*by[\s-]*step\s+(?:solution|answer|working|worked|walk[\s-]*through)\b",
    r"\b(?:worked|detailed|full)\s+solution\b",
    r"\b(?:write|give|show)\s+(?:me\s+)?(?:the\s+|a\s+)?(?:code|program|implementation|script|function)\s+(?:for|that\s+solves)\b",
    r"حل(?:ه)?\s+خطوه\s+بخطوه",
)
# Trying to talk the board out of the rules.
_BYPASS = _rx(
    r"\bignore\s+(?:all\s+|any\s+|the\s+|your\s+|previous\s+|above\s+|prior\s+)*(?:instructions?|rules?|polic(?:y|ies)|guidelines?|restrictions?)\b",
    r"\b(?:disable|bypass|override|turn\s+off|skip)\s+(?:the\s+|your\s+)?(?:rules?|polic(?:y|ies)|safety|restrictions?|guard\w*|socratic)\b",
    r"\byou\s+are\s+now\b", r"\bpretend\s+(?:to\s+be|you)\b", r"\bdeveloper\s+mode\b", r"\bjailbreak\b",
    r"تجاهل\s+(?:كل\s+|جميع\s+)?(?:التعليمات|القواعد|السياسه)",
)


@dataclass(frozen=True)
class GateDecision:
    allowed: bool
    code: str = "ok"                       # ok | solution_request | policy_bypass | answer_in_visual
    redirect: Optional[str] = None         # the Socratic reply to show instead (set only when not allowed)
    reasons: tuple[str, ...] = ()


_OK = GateDecision(True)

_REDIRECT_EN = {
    "solution_request": ("I won't draw or simulate the finished solution, because the point is for you to get there. "
                         "What have you tried so far, and where does it get stuck? I can sketch the ideas involved (not the final result) on the board to help you see them."),
    "policy_bypass": ("I can't change how I help with your assignment. I'm glad to help you understand it, though: tell me what you're working on and "
                      "what you've tried, and I'll draw the concept behind it."),
    "answer_in_visual": ("That visual would have shown the answer itself, so I held it back. Tell me your current thinking and I'll draw something that helps you take the next step yourself."),
}
_REDIRECT_AR = {
    "solution_request": ("لن أرسم أو أحاكي الحل النهائي، لأن الهدف أن تصل إليه بنفسك. ماذا جرّبت حتى الآن وأين تتعثر؟ "
                         "يمكنني أن أرسم الأفكار المتعلقة بالمسألة (وليس النتيجة النهائية) على السبورة لتساعدك."),
    "policy_bypass": "لا يمكنني تغيير طريقة مساعدتي في واجبك. لكن يسعدني أن أساعدك على فهمه: أخبرني ماذا تعمل عليه وماذا جرّبت، وسأرسم لك الفكرة وراءه.",
    "answer_in_visual": "كان هذا الرسم سيعرض الإجابة نفسها فحجبته. أخبرني بتفكيرك الحالي وسأرسم لك شيئًا يساعدك على الخطوة التالية بنفسك.",
}


def _redirect(code: str, like_text: str) -> str:
    return (_REDIRECT_AR if _ARABIC_LETTERS.search(like_text or "") else _REDIRECT_EN)[code]


def review_visual_request(text: str, *, policy: Union[str, AssistancePolicy, None], kind: str = "visual", is_programming: bool = False) -> GateDecision:
    """Judge a student's request to the board. `policy=None`/unknown means GUIDED."""
    p = normalize_policy(policy)
    t = _norm(text)
    if _BYPASS.search(t):
        return GateDecision(False, "policy_bypass", _redirect("policy_bypass", text), (f"{kind} request tries to override the rules",))
    if _SOLUTION.search(t):
        return GateDecision(False, "solution_request", _redirect("solution_request", text), (f"{kind} request asks for the answer or complete solution",))
    if p == AssistancePolicy.GUIDED and _GUIDED_EXTRA.search(t):
        return GateDecision(False, "solution_request", _redirect("solution_request", text), (f"GUIDED policy: {kind} request asks for a worked solution or code",))
    return _OK


def review_generated_text(texts: Iterable[Optional[str]], *, policy: Union[str, AssistancePolicy, None], is_programming: bool = False, like_text: str = "") -> GateDecision:
    """Re-check the words a generated visual shows (diagram labels, captions, notes) with the Coach's own last-line enforcement."""
    joined = "\n".join(t.strip() for t in texts if t and t.strip())
    if not joined:
        return _OK
    safe, _ = final_answer_enforcement(joined, policy=normalize_policy(policy), is_programming=is_programming)
    if safe:
        return _OK
    return GateDecision(False, "answer_in_visual", _redirect("answer_in_visual", like_text or joined), ("the generated visual's text reveals the answer",))


def review_visual_with_llm(request: str, proposal: str, *, policy: Union[str, AssistancePolicy, None], course_material: str = "", kind: str = "visual") -> GateDecision:
    """OPTIONAL second stage: the Coach validator's own LLM reviewer judges the request together with what the visual would contain.
    Any failure of the reviewer (no key, timeout) returns `allowed` because the deterministic stage has already run; it never makes a refusal up."""
    from ai.guardrails.coach_validator import llm_check
    p = normalize_policy(policy)
    draft = f"[A student asked the whiteboard for a {kind}: {request.strip()[:600]}]\n[The {kind} would contain: {proposal.strip()[:1500]}]"
    try:
        res = llm_check(policy=p, diagnosis_category="UNCERTAIN", diagnosis_confidence=0.5, intervention_type="EXPLANATION", course_material=course_material, draft_response=draft)
    except Exception as exc:       # pragma: no cover - exercised with a stub in tests; real provider unverified
        log.warning("visual LLM review unavailable (%s); deterministic review stands", type(exc).__name__)
        return _OK
    if res.passes:
        return _OK
    return GateDecision(False, "solution_request", _redirect("solution_request", request), tuple(res.violations[:3]) or ("the reviewer rejected the visual",))
