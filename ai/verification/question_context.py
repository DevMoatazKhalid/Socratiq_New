"""
Lesson context for comprehension-question generation.

Turns a VerificationChallengeRequest into ONE focused, bounded context that the generator, the deterministic quality gate and the
semantic reviewer all share. The point is that every layer judges a question against the same lesson, and that the lesson is clearly
separated from the student's own work (the old prompt handed both to the model under loose labels, and every strategy talked about
"your solution" regardless of subject).

Decisions made here:
  * which concept to target (a grounded one from the assignment's concept list, not simply the alphabetically first);
  * what kind of work the student submitted (code / worked maths / prose / nothing), which decides whether a question may refer to
    "your solution" or "your code" at all;
  * whether the lesson context is substantive enough to hold a question to it, or thin (then the prompt says so and the reviewer is
    told to accept only questions about the concept itself).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

from ai.rag.security import sanitize_untrusted_text
from ai.verification.models import VerificationChallengeRequest

MAX_INSTRUCTIONS_CHARS = 3_000
MAX_MATERIAL_CHARS = 4_500
MAX_MATERIAL_CHUNK_CHARS = 1_500
MAX_WORK_CHARS = 3_000
SUBSTANTIVE_CONTEXT_CHARS = 200   # instructions + material at or above this are enough to hold a question to the lesson's vocabulary

WORK_CODE, WORK_MATH, WORK_PROSE, WORK_NONE = "code", "math", "prose", "none"

_CODE_MARKERS = re.compile(
    r"(```|\bdef \w+\(|\bclass \w+[:(]|\breturn\b|\bimport \w+|#include|\bfunction\s*\w*\(|=>|;\s*$|\bfor\s*\(|\bwhile\s*\(|"
    r"\bpublic\s+(static\s+)?\w+|\bconsole\.log|\bprint\(|\w+\s*=\s*\w+\s*[-+*/]\s*\w+)",
    re.MULTILINE,
)
_MATH_MARKERS = re.compile(r"(\$[^$]+\$|\\frac|\\int|\\sum|\\lambda|=\s*-?\d|\d\s*[x×*/^]\s*\d|\b[a-z]\s*=\s*[-\d(]|√|∫|∑|≤|≥)")

_STOPWORDS = frozenset("""
a an the and or but if then else of to in on at by for with from into onto about as is are was were be been being do does did done
this that these those it its it's their there here what which who whom whose why how when where whether can could would should will
shall may might must you your yours we our us they them he she his her i me my not no yes than so such also very just only each every
any some more most less least many much one two three first second next new other same own between within without through during
after before over under again further once all both few nor out up down off too s t
""".split())

# Words that frame a question rather than carry its subject. They never count as lesson content and never count as "foreign".
GENERIC_QUESTION_WORDS = frozenset("""
explain describe identify compare contrast apply predict justify discuss define give state list show outline summarise summarize
illustrate example examples situation case scenario happen happens happened change changes changed changing affect affects affected
effect effects result results outcome outcomes role roles function functions work works purpose reason reasons important importance
matter matters main key idea ideas concept concepts lesson lessons topic topics part parts step steps relate relates related relation
relationship connect connects connected connection difference differences similar similarity cause causes caused instead rather
use used using apply applied applying solve solved solving problem problems approach method methods way ways mean means meaning
real life world everyday own words help helps knowing know understand understanding learned taught covered student would different
differently happen if why how what which might likely expect expected based contribute contributes contribution form formation produce
produces process processes structure structures system systems kind type types factor factors condition conditions
""".split())

_WORD = re.compile(r"[A-Za-z؀-ۿ][A-Za-z؀-ۿ'\-]*")


def stem(word: str) -> str:
    """Tiny suffix stripper: enough to match filter/filters/filtering/filtration, not a linguistic stemmer."""
    w = word.lower().strip("'-")
    for suf in ("ations", "ation", "ization", "isation", "ments", "ment", "ness", "ities", "ity", "ings", "ing", "ies", "ied",
                "ers", "er", "ed", "es", "ly", "al", "s"):
        if len(w) - len(suf) >= 4 and w.endswith(suf):
            return w[: -len(suf)]
    return w


def content_terms(text: str) -> list[str]:
    """Stemmed content words (no stopwords, no question-framing words), in order."""
    out = []
    for m in _WORD.finditer(text or ""):
        w = m.group(0).lower()
        if len(w) < 3 or w in _STOPWORDS or w in GENERIC_QUESTION_WORDS:
            continue
        out.append(stem(w))
    return out


def humanize_concept(concept: Optional[str]) -> str:
    """'gradient_descent' -> 'gradient descent'; trims, collapses whitespace, caps length. Never returns placeholders like 'N/A'."""
    c = re.sub(r"[_\s]+", " ", (concept or "")).strip(" .:;,-")
    if c.lower() in ("", "n/a", "na", "none", "null", "unknown", "general"):
        return ""
    return c[:80].rstrip()


def classify_work(student_work: str) -> str:
    w = (student_work or "").strip()
    if len(w) < 15:
        return WORK_NONE
    if len(_CODE_MARKERS.findall(w)) >= 1 and (w.count("\n") >= 1 or "=" in w or "(" in w):
        return WORK_CODE
    if len(_MATH_MARKERS.findall(w)) >= 2:
        return WORK_MATH
    return WORK_PROSE


def _cap(text: str, n: int) -> str:
    t = (text or "").strip()
    return t if len(t) <= n else t[:n].rstrip() + " [truncated]"


@dataclass
class LessonContext:
    verification_type: str
    concept: str                      # humanized target concept (may differ from request.concept when a better-grounded one exists)
    candidate_concepts: list[str]
    title: str
    subject_area: str
    instructions: str
    material: list[str]
    student_work: str                 # sanitized, capped; DATA only
    work_kind: str                    # code | math | prose | none
    previous_questions: list[str]
    substantive: bool                 # enough lesson text to hold the question to it
    vocabulary: frozenset = field(default_factory=frozenset)   # stemmed content terms of lesson + concept + work
    # humanized (lower-cased) concept -> the caller's original spelling. The STORED concept must stay the original: it keys the
    # student's concept mastery (concepts.normalized_name), so "gradient_descent" must not silently become "gradient descent".
    original_names: dict = field(default_factory=dict)

    def original(self, humanized: str) -> str:
        return self.original_names.get((humanized or "").lower(), humanized)

    @property
    def work_is_solution(self) -> bool:
        """A question may only talk about 'your solution/code/program/derivation' when the student actually submitted one."""
        return self.work_kind in (WORK_CODE, WORK_MATH)

    @property
    def lesson_text(self) -> str:
        return "\n".join([self.title, self.instructions, *self.material])


def _grounding_score(concept: str, haystack_terms: set[str]) -> float:
    terms = content_terms(concept) or [stem(w) for w in concept.lower().split() if w]
    if not terms:
        return 0.0
    return sum(1 for t in terms if t in haystack_terms) / len(terms)


def choose_concept(primary: str, candidates: list[str], lesson_terms: set[str], used_concepts: list[str]) -> str:
    """Pick the candidate best grounded in the lesson text. Ties keep the caller's order, so the primary wins unless another concept
    is clearly better supported by the material. Concepts already targeted by earlier questions in the run are slightly penalised so
    the three questions can spread across a multi-concept lesson."""
    pool, seen = [], set()
    for c in [primary, *candidates]:
        h = humanize_concept(c)
        if h and h.lower() not in seen:
            seen.add(h.lower())
            pool.append(h)
    if not pool:
        return ""
    used = {u.lower() for u in used_concepts}
    best, best_score = pool[0], -1.0
    for c in pool:
        s = _grounding_score(c, lesson_terms) - (0.25 if c.lower() in used else 0.0)
        if s > best_score + 1e-9:
            best, best_score = c, s
    return best


def build_lesson_context(request: VerificationChallengeRequest, used_concepts: Optional[list[str]] = None) -> LessonContext:
    title = sanitize_untrusted_text(request.assignment_title or "").strip()[:200]
    instructions = _cap(sanitize_untrusted_text(request.course_context or ""), MAX_INSTRUCTIONS_CHARS)
    if instructions.strip().upper() in ("N/A", "NONE"):
        instructions = ""
    material, total = [], 0
    for chunk in request.lesson_material or []:
        t = _cap(sanitize_untrusted_text(chunk or ""), MAX_MATERIAL_CHUNK_CHARS)
        if not t or total + len(t) > MAX_MATERIAL_CHARS:
            continue
        material.append(t)
        total += len(t)
    work = _cap(sanitize_untrusted_text(request.student_work or ""), MAX_WORK_CHARS)
    lesson_terms = set(content_terms("\n".join([title, instructions, *material])))
    candidates = [humanize_concept(c) for c in (request.candidate_concepts or []) if humanize_concept(c)]
    originals = {}
    for raw in [*(request.candidate_concepts or []), request.concept]:
        h = humanize_concept(raw)
        if h:
            originals[h.lower()] = raw
    if used_concepts is None:   # infer which concepts earlier questions in this run already covered
        prev_terms = set(content_terms(" ".join(request.previous_questions or [])))
        used_concepts = [c for c in candidates if content_terms(c) and all(t in prev_terms for t in content_terms(c))]
    concept = choose_concept(request.concept, candidates, lesson_terms, used_concepts)
    if not concept:
        concept = humanize_concept(request.subject_area) or title or "the main topic of this lesson"
    vocab = set(lesson_terms)
    vocab.update(content_terms(concept))
    for c in candidates:
        vocab.update(content_terms(c))
    vocab.update(content_terms(work))
    vocab.update(content_terms(humanize_concept(request.subject_area)))
    return LessonContext(
        verification_type=request.verification_type.value,
        concept=concept,
        candidate_concepts=candidates,
        title=title,
        subject_area=humanize_concept(request.subject_area),
        instructions=instructions,
        material=material,
        student_work=work,
        work_kind=classify_work(work),
        previous_questions=[q.strip() for q in (request.previous_questions or []) if q and q.strip()],
        substantive=len(instructions) + total >= SUBSTANTIVE_CONTEXT_CHARS,
        vocabulary=frozenset(vocab),
        original_names=originals,
    )
