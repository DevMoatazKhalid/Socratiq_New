"""
Deterministic quality gate for comprehension questions.

This is the floor every question must clear before a student sees it, whether it came from the model, a retry, or the safe fallback.
It catches the failures that are unambiguous from the text alone (format, leftover template frames, a topic used as if it were a
mechanism, "your solution" when the student submitted no solution, repeats of an earlier question). Semantic relevance — whether the
question is really about this lesson, combines related ideas, and is answerable from the material — is judged by the LLM reviewer
(question_review.py); the vocabulary-overlap signals computed here are only *hints* to that reviewer, plus a last-resort block when the
reviewer is unavailable and the question shares nothing with a substantive lesson.

Issue severities:
  ERROR    -> the question is rejected (regenerate or fall back).
  WARNING  -> passed to the semantic reviewer as something to check; blocks only if the reviewer is unavailable (see `blocking`).
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Iterable, Optional

from ai.verification.question_context import LessonContext, content_terms

ERROR, WARNING = "error", "warning"

MIN_WORDS = 5
MAX_WORDS = 40
MAX_CHARS = 300
DUPLICATE_JACCARD = 0.6
DUPLICATE_RATIO = 0.8


@dataclass(frozen=True)
class QualityIssue:
    code: str
    severity: str
    message: str

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"


@dataclass
class QualityReport:
    question: str
    issues: list[QualityIssue]

    @property
    def errors(self) -> list[QualityIssue]:
        return [i for i in self.issues if i.severity == ERROR]

    @property
    def warnings(self) -> list[QualityIssue]:
        return [i for i in self.issues if i.severity == WARNING]

    @property
    def ok(self) -> bool:
        return not self.errors

    def codes(self) -> set[str]:
        return {i.code for i in self.issues}


# ---------------------------------------------------------------------------------------------------------------- normalisation
def normalize_question(text: Optional[str]) -> str:
    """Trim, collapse whitespace, drop wrapping quotes / 'Question:' labels / list markers. Does NOT rewrite wording."""
    q = (text or "").strip()
    q = re.sub(r"^\s*(?:question\s*\d*\s*[:.)-]|q\d*\s*[:.)-]|\d+\s*[.)]|[-*•])\s*", "", q, flags=re.IGNORECASE)
    q = q.strip().strip('"“”\'`').strip()
    q = re.sub(r"\s+", " ", q)
    return q


# ---------------------------------------------------------------------------------------------------------------- patterns
# The exact frames the old service used as fallbacks. They interpolate a topic name into a sentence that only makes sense for a
# mechanism inside a solution, which is how "Why does anatomy of the kidney work in your solution?" reached students.
_LEGACY_TEMPLATES = [
    # "Why does <anything> work in your <anything>?" -- the old EXPLAIN frame, whatever artefact word fills the slot.
    re.compile(r"^why (?:does|do) .+ work in your [\w\s'-]{1,40}\??$", re.IGNORECASE),
    re.compile(r"^what changes if .+ is modified or reversed\??$", re.IGNORECASE),
    re.compile(r"^where else could you apply .+\?$", re.IGNORECASE),
]

# A subject-area / topic noun treated as an agent that "works" or "functions": "Why does anatomy of the kidney work...",
# "How does the history of Rome function...", "Why does the structure of the cell work...". Subjects of study don't work; things in them do.
_TOPIC_HEADS = (r"anatomy|physiology|history|overview|introduction|basics|fundamentals|principles|theory|topic|subject|study|chapter|"
                r"lesson|unit|module|section|concept|notion|field|area|discipline|structure|definition|properties|classification")
_TOPIC_AS_MECHANISM = re.compile(
    rf"\b(?:why|how)\s+(?:does|do|did|would|will|can|could)\s+(?:the\s+)?(?:{_TOPIC_HEADS})\b(?:\s+of\s+[\w\s'-]{{1,60}}?)?\s+"
    r"(?:work|function|operate)\b",
    re.IGNORECASE,
)

# References to the student's own artefact. Only meaningful when the student submitted code or a worked solution.
_SOLUTION_REF = re.compile(
    r"\byour\s+(?:own\s+)?(?:solution|code|program|implementation|function|algorithm|script|derivation|calculation|proof|formula)\b",
    re.IGNORECASE,
)
# Softer references to whatever the student handed in; fine for any submission, wrong when nothing was submitted.
_WORK_REF = re.compile(r"\byour\s+(?:own\s+)?(?:answer|work|submission|essay|response|approach|attempt)\b", re.IGNORECASE)

_PLACEHOLDER = re.compile(r"(\{[a-z_]+\}|\[[A-Z_ ]{3,}\]|<[A-Z_]{3,}>|\bN/A\b|\bTODO\b|\bXXX\b)")
_SNAKE = re.compile(r"\b[a-z]+(?:_[a-z0-9]+)+\b")
_MCQ = re.compile(r"(?:^|\s)(?:\(?[A-Da-d][).]\s+\S+.*){2,}|\b(?:which of the following|choose (?:one|the correct)|select (?:one|all))\b",
                  re.IGNORECASE)
_REPEATED_WORD = re.compile(r"\b(\w{2,})\s+\1\b", re.IGNORECASE)
_META = re.compile(r"\b(?:as an ai|here is (?:a|the|your) question|verification question|rubric|criteria:|the student)\b", re.IGNORECASE)
_VAGUE_ONLY = re.compile(r"^(?:what do you think|any thoughts|can you explain(?: this| it)?|explain (?:this|it)|why)\??$", re.IGNORECASE)


def _names_topic_as_mechanism(q: str, ctx: LessonContext) -> bool:
    """'Why does linear algebra work...', 'How does Anatomy and Physiology of the Kidney function...': the lesson's own subject area or
    title used as the thing that works. (A concept name is NOT included: "Why does recursion terminate?" is a fine question.)"""
    for topic in (ctx.subject_area, ctx.title):
        t = (topic or "").strip()
        if len(t) < 4:
            continue
        pat = rf"\b(?:why|how)\s+(?:does|do|did|would|can)\s+(?:the\s+)?{re.escape(t)}\s+(?:work|function|operate)\b"
        if re.search(pat, q, re.IGNORECASE):
            return True
    return False


def _tokens(text: str) -> set[str]:
    """Stemmed non-stopwords, framing words INCLUDED: 'what is X' and 'apply X in a real situation' share the subject but are
    different questions, so the framing must count when judging repetition."""
    from ai.verification.question_context import _STOPWORDS, _WORD, stem
    return {stem(m.group(0)) for m in _WORD.finditer(text or "") if len(m.group(0)) >= 3 and m.group(0).lower() not in _STOPWORDS}


def _similar(a: str, b: str) -> bool:
    ta, tb = _tokens(a), _tokens(b)
    jac = len(ta & tb) / len(ta | tb) if ta and tb else 0.0
    ratio = SequenceMatcher(None, a.lower(), b.lower()).ratio()
    return jac >= DUPLICATE_JACCARD or ratio >= DUPLICATE_RATIO


# ---------------------------------------------------------------------------------------------------------------- the gate
def check_question(question: str, ctx: LessonContext, *, previous: Optional[Iterable[str]] = None) -> QualityReport:
    q = normalize_question(question)
    issues: list[QualityIssue] = []

    def add(code: str, severity: str, message: str) -> None:
        issues.append(QualityIssue(code, severity, message))

    words = q.split()
    if not q:
        add("empty", ERROR, "No question text was produced.")
        return QualityReport(q, issues)

    # --- form -------------------------------------------------------------------------------------------------------------
    if len(words) < MIN_WORDS or _VAGUE_ONLY.match(q):
        add("too_vague", ERROR, f"The question is too short or vague to have a clear objective ({len(words)} words).")
    if len(words) > MAX_WORDS or len(q) > MAX_CHARS:
        add("too_long", ERROR, f"The question is too long ({len(words)} words); ask one focused thing.")
    qmarks = q.count("?") + q.count("؟")
    if qmarks == 0:
        add("not_a_question", ERROR, "The text is not phrased as a question (no question mark).")
    elif qmarks > 1:
        add("multiple_questions", ERROR, "Several questions were packed into one; ask exactly one.")
    elif not q.rstrip().endswith(("?", "؟")):
        add("trailing_text", ERROR, "There is text after the question mark.")
    if q[:1].islower():
        add("capitalisation", ERROR, "The question does not start with a capital letter.")
    if _PLACEHOLDER.search(q):
        add("placeholder", ERROR, "The question contains a template placeholder or null value.")
    if _SNAKE.search(q):
        add("identifier_as_text", WARNING if ctx.work_kind == "code" else ERROR,
            "The question contains a raw identifier (snake_case) instead of natural wording.")
    if _REPEATED_WORD.search(q):
        add("repeated_word", ERROR, "The question repeats a word (\"the the\").")
    if _MCQ.search(q):
        add("multiple_choice", ERROR, "The question is multiple choice; it must be open-ended.")
    if _META.search(q):
        add("meta_text", ERROR, "The question talks about the assessment or the student in the third person instead of asking.")

    # --- known incoherent frames (the kidney failure class) --------------------------------------------------------------
    if any(p.match(q) for p in _LEGACY_TEMPLATES):
        add("legacy_template", ERROR, "The question uses a fill-in-the-concept template that produces incoherent questions.")
    if _TOPIC_AS_MECHANISM.search(q) or _names_topic_as_mechanism(q, ctx):
        add("topic_as_mechanism", ERROR,
            "The question treats a subject or topic (e.g. 'anatomy of the kidney') as if it were a mechanism that 'works'; "
            "ask about a specific structure, process or idea within it.")
    if _SOLUTION_REF.search(q) and not ctx.work_is_solution:
        add("mismatched_frame", ERROR,
            "The question refers to the student's solution/code/answer, but the student did not submit one for this lesson; "
            "ask about the lesson content instead.")
    elif _WORK_REF.search(q) and ctx.work_kind == "none":
        add("mismatched_frame", ERROR, "The question refers to the student's work, but no work was submitted.")

    # --- non-redundancy ----------------------------------------------------------------------------------------------------
    for prev in list(previous if previous is not None else ctx.previous_questions):
        if prev and _similar(q, prev):
            add("duplicate", ERROR, f"The question repeats an earlier question: \"{prev[:120]}\".")
            break

    # --- grounding hints (vocabulary only; semantic judgement is the reviewer's) ------------------------------------------
    terms = content_terms(q)
    if terms:
        anchored = [t for t in terms if t in ctx.vocabulary]
        foreign = [t for t in terms if t not in ctx.vocabulary]
        if not anchored:
            add("no_anchor", WARNING, "The question shares no subject terms with the lesson, concept or student work.")
        elif ctx.verification_type != "TRANSFER" and ctx.substantive and len(foreign) >= 2 and len(foreign) >= len(anchored):
            add("foreign_terms", WARNING,
                "Most subject terms in the question do not appear in the lesson: " + ", ".join(sorted(set(foreign))[:6]) + ".")
    return QualityReport(q, issues)


def blocking(report: QualityReport, ctx: LessonContext, *, reviewer_available: bool) -> list[QualityIssue]:
    """Issues that reject the question. With a reviewer, only errors block (warnings are the reviewer's call). Without one, a question
    that shares no vocabulary with a substantive lesson is also rejected, because nothing else would catch an off-topic question."""
    out = list(report.errors)
    if not reviewer_available and ctx.substantive:
        out += [i for i in report.warnings if i.code == "no_anchor"]
    return out
