"""
Automated Socratic Quality Evaluator for Pedagogical Dialogue.

Evaluates whether an AI Coach turn adheres to core Socratic pedagogical principles:
1. Guiding Inquiry: The coach leads with probing, open questions rather than didactic lecturing.
2. Anti-Giveaway Guard: The coach does not hand over final solutions, formulas, or answers directly.
3. Scaffolding & Decomposition: The coach breaks complex tasks down and provides incremental hints.
4. Persona Alignment: The tone matches the selected pedagogical persona.
5. Bilingual Support: Handles both English and Arabic conversational exchanges.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import List, Optional

# English & Arabic direct answer patterns
DIRECT_ANSWER_PATTERNS = [
    r"\b(?:the\s+)?answer\s+is\s*[:=]?\s*",
    r"\bhere\s+is\s+the\s+(?:solution|answer|code)\b",
    r"\bthe\s+correct\s+result\s+is\b",
    r"\byou\s+should\s+write\s*[:=]\s*",
    r"\bjust\s+copy\s+this\b",
    r"\bالإجابة\s+هي\b",
    r"\bالحل\s+هو\b",
    r"\bالناتج\s+الصحيح\s+هو\b",
    r"\bالحل\s+النهائي\s+هو\b",
    r"\bخذ\s+هذا\s+الكود\b",
]

# Scaffolding and guiding language markers
SCAFFOLDING_MARKERS_EN = [
    r"\blet'?s\s+(?:break|look|think|explore|start|examine)\b",
    r"\bnotice\s+(?:that|how|what)\b",
    r"\bwhat\s+happens\s+if\b",
    r"\bhow\s+would\s+you\b",
    r"\bwhy\s+do\s+you\s+think\b",
    r"\bcan\s+you\s+(?:explain|identify|find|determine)\b",
    r"\bwhat\s+does\s+this\s+mean\b",
    r"\bconsider\s+the\s+case\b",
    r"\brecall\s+(?:that|when|the)\b",
    r"\bstep\s+by\s+step\b",
    r"\bwhich\s+rule\s+applies\b",
    r"\bwhat\s+is\s+the\s+relationship\b",
]

SCAFFOLDING_MARKERS_AR = [
    r"\bدعنا\s+(?:نبدأ|نقسم|نفكر|ننظر|نراجع)\b",
    r"\bلاحظ\s+(?:أن|كيف|ماذا)\b",
    r"\bماذا\s+يحدث\s+(?:إذا|لو)\b",
    r"\bكيف\s+يمكنك\b",
    r"\bلماذا\s+تعتقد\b",
    r"\bهل\s+يمكنك\s+(?:شرح|تحديد|إيجاد)\b",
    r"\bما\s+العلاقة\s+بين\b",
    r"\bخطوة\s+بخطوة\b",
    r"\bتذكر\s+أن\b",
    r"\bأي\s+قاعدة\s+تنطبق\b",
]

# Question marks and question starters
QUESTION_PATTERN_EN = r"\?|\b(?:what|why|how|which|where|when|can\s+you|could\s+you|does\s+this|is\s+it)\b"
QUESTION_PATTERN_AR = r"؟|\b(?:لماذا|كيف|ماذا|ما\s+هو|ما\s+هي|هل|أين|متى|أي)\b"


@dataclass(frozen=True)
class SocraticQualityVerdict:
    socratic_index: float                # 0.0 to 1.0 composite
    is_socratic: bool                   # True if meets standard (index >= 0.70 & directness <= 0.35)
    question_presence: bool
    question_ratio: float               # Questions / total sentences
    directness_score: float             # 0.0 (indirect) to 1.0 (blatant direct answer)
    scaffolding_score: float            # 0.0 to 1.0
    persona_alignment_score: float      # 0.0 to 1.0
    detected_giveaways: List[str] = field(default_factory=list)
    feedback: List[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "socratic_index": self.socratic_index,
            "is_socratic": self.is_socratic,
            "question_presence": self.question_presence,
            "question_ratio": self.question_ratio,
            "directness_score": self.directness_score,
            "scaffolding_score": self.scaffolding_score,
            "persona_alignment_score": self.persona_alignment_score,
            "detected_giveaways": self.detected_giveaways,
            "feedback": self.feedback,
        }


def evaluate_socratic_turn(
    student_message: str,
    coach_reply: str,
    persona_id: Optional[str] = "socratic_guide",
    assignment_policy: Optional[str] = None,
) -> SocraticQualityVerdict:
    """
    Evaluates a single Coach reply to determine its Socratic quality and pedagogical rigor.
    """
    reply = (coach_reply or "").strip()
    if not reply:
        return SocraticQualityVerdict(
            socratic_index=0.0,
            is_socratic=False,
            question_presence=False,
            question_ratio=0.0,
            directness_score=0.0,
            scaffolding_score=0.0,
            persona_alignment_score=0.0,
            feedback=["Coach reply is empty."],
        )

    # 1. Question Detection
    # Split into approximate sentences
    sentences = [s.strip() for s in re.split(r"[.!?؟;\n]+", reply) if len(s.strip()) > 3]
    total_sentences = max(1, len(sentences))

    has_q_mark = "?" in reply or "؟" in reply
    has_q_word = bool(re.search(QUESTION_PATTERN_EN, reply, re.IGNORECASE) or re.search(QUESTION_PATTERN_AR, reply))
    question_presence = has_q_mark or has_q_word

    q_sentence_count = sum(
        1 for s in sentences
        if "?" in s or "؟" in s or re.search(QUESTION_PATTERN_EN, s, re.IGNORECASE) or re.search(QUESTION_PATTERN_AR, s)
    )
    question_ratio = min(1.0, round(q_sentence_count / total_sentences, 3))

    # 2. Direct Answer / Solution Detection
    giveaways = []
    for pat in DIRECT_ANSWER_PATTERNS:
        match = re.search(pat, reply, re.IGNORECASE)
        if match:
            giveaways.append(match.group(0).strip())

    # Raw final solution indicators
    if re.search(r"\b(?:therefore|so|hence)\s+x\s*=\s*\d+", reply, re.IGNORECASE):
        giveaways.append("numeric solution declared directly")

    directness_score = 0.0
    if giveaways:
        directness_score = min(1.0, 0.5 + (len(giveaways) * 0.25))

    # 3. Scaffolding Analysis
    scaffold_hits = 0
    for pat in SCAFFOLDING_MARKERS_EN:
        if re.search(pat, reply, re.IGNORECASE):
            scaffold_hits += 1
    for pat in SCAFFOLDING_MARKERS_AR:
        if re.search(pat, reply):
            scaffold_hits += 1

    scaffolding_score = min(1.0, round(scaffold_hits * 0.35, 3))
    if question_presence and scaffolding_score == 0.0:
        scaffolding_score = 0.40   # A guiding question alone provides baseline scaffolding

    # 4. Persona Alignment
    persona_alignment = 0.85      # default baseline
    p = (persona_id or "socratic_guide").lower()

    if p == "practical_engineer":
        # Check for real-world application, system, or mechanical terminology
        if re.search(r"\b(?:real-world|application|system|practical|build|industry|engine|device|تطبيقي|واقعي|نظام)\b", reply, re.IGNORECASE):
            persona_alignment = 1.0
    elif p == "critical_thinker":
        # Check for assumption testing, edge cases, counterarguments
        if re.search(r"\b(?:assume|assumption|edge\s+case|verify|proof|counter|evidence|افتراض|حالة\s+خاصة|دليل|برهان)\b", reply, re.IGNORECASE):
            persona_alignment = 1.0
    elif p == "visual_explorer":
        # Check for spatial, graphical, or mental model visualization terms
        if re.search(r"\b(?:visualize|picture|diagram|graph|draw|shape|coordinate|تخيل|ارسم|شكل|رسم\s+بياني)\b", reply, re.IGNORECASE):
            persona_alignment = 1.0
    elif p == "patient_mentor":
        # Check for encouragement, warmth, normalization of mistakes
        if re.search(r"\b(?:great|good\s+start|no\s+worries|step\s+by\s+step|keep\s+going|take\s+your\s+time|بداية\s+جيدة|خطوة\s+بخطوة|أحسنت|لا\s+تقلق)\b", reply, re.IGNORECASE):
            persona_alignment = 1.0

    # 5. Composite Socratic Index Computation
    # Weightings: 35% question presence/ratio, 30% low directness, 20% scaffolding, 15% persona
    q_component = 0.6 * (1.0 if question_presence else 0.0) + 0.4 * question_ratio
    directness_penalty = directness_score
    s_index = (
        0.35 * q_component +
        0.30 * (1.0 - directness_penalty) +
        0.20 * scaffolding_score +
        0.15 * persona_alignment
    )
    socratic_index = max(0.0, min(1.0, round(s_index, 3)))
    is_socratic = socratic_index >= 0.65 and directness_score <= 0.35

    # Feedback generation
    feedback = []
    if not question_presence:
        feedback.append("The reply does not pose a guiding question. Socratic coaching requires inviting the student to reason.")
    if giveaways:
        feedback.append(f"Direct answer indicators detected ({', '.join(giveaways)}). Redirect student to discover the principle instead.")
    if scaffolding_score < 0.4:
        feedback.append("Add scaffolding markers or step-by-step breakdown to guide reasoning.")
    if persona_alignment < 0.8:
        feedback.append(f"Tone could reflect persona '{persona_id}' more explicitly.")

    return SocraticQualityVerdict(
        socratic_index=socratic_index,
        is_socratic=is_socratic,
        question_presence=question_presence,
        question_ratio=question_ratio,
        directness_score=directness_score,
        scaffolding_score=scaffolding_score,
        persona_alignment_score=persona_alignment,
        detected_giveaways=giveaways,
        feedback=feedback,
    )
