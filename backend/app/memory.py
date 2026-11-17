"""
Complete Student Memory Architecture for SocratiQ.

Provides a unified, authoritative memory system spanning:
1. Persistent Student Learning Memory:
   - Progress, strengths, weaknesses, misconceptions, and recurring mistakes.
2. Educational Library Memory:
   - Selected/downloaded libraries, resource metadata, ownership, versions, and indexing status.
3. Whiteboard Memory:
   - Scene context, equations, diagrams, notes, and learning history.
4. Attribution System:
   - Strict separation between student-created, AI-generated, and teacher-provided content.
5. Lifecycle Management:
   - Memory creation, updates, retrieval, authorization, recency/expiration, and deletion.
6. Unified Interface:
   - Consistent memory access across Chat, Live Voice, and Whiteboard through the LangGraph Socratic Coach.
"""
from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional
import psycopg
from .db import many, one, new_id

log = logging.getLogger("socratiq.memory")

# Older board / Live Voice telemetry wrote `ai_interactions` rows with a hard-coded diagnosis (nobody had diagnosed anything). Those rows are not
# evidence, so everything that derives learning memory or Coach context from `ai_interactions` skips them. They are not deleted.
FABRICATED_EXPLANATIONS = ("SmartBoard Live Voice interaction", "SmartBoard AI collaborative interaction")

DEFAULT_HALF_LIFE_DAYS = 30.0


def compute_confidence_decay(
    raw_confidence: Optional[float],
    last_evaluated_at: Optional[datetime | str],
    now: Optional[datetime] = None,
    half_life_days: float = DEFAULT_HALF_LIFE_DAYS,
) -> dict[str, Any]:
    """
    Computes exponential retention decay on concept confidence based on elapsed time:
      decay_factor = 2^(-dt / half_life)
      effective_confidence = raw_confidence * decay_factor

    Categorizes retention into:
      - RECENT (dt <= 7 days)
      - RETAINED (decay_factor >= 0.70)
      - DUE_FOR_REVIEW (decay_factor < 0.70 or dt > 30 days)
      - EXPIRED (decay_factor < 0.35)
    """
    if raw_confidence is None:
        return {
            "raw_confidence": None,
            "effective_confidence": None,
            "decay_factor": 1.0,
            "days_elapsed": 0.0,
            "retention_status": "UNKNOWN",
        }

    if not last_evaluated_at:
        return {
            "raw_confidence": float(raw_confidence),
            "effective_confidence": float(raw_confidence),
            "decay_factor": 1.0,
            "days_elapsed": 0.0,
            "retention_status": "RECENT",
        }

    dt_obj: Optional[datetime] = None
    if isinstance(last_evaluated_at, str):
        try:
            dt_obj = datetime.fromisoformat(last_evaluated_at.replace("Z", "+00:00"))
        except Exception:
            dt_obj = None
    elif isinstance(last_evaluated_at, datetime):
        dt_obj = last_evaluated_at

    if dt_obj is None:
        return {
            "raw_confidence": float(raw_confidence),
            "effective_confidence": float(raw_confidence),
            "decay_factor": 1.0,
            "days_elapsed": 0.0,
            "retention_status": "RECENT",
        }

    now_dt = now or datetime.now(timezone.utc)
    if dt_obj.tzinfo is None:
        dt_obj = dt_obj.replace(tzinfo=timezone.utc)
    if now_dt.tzinfo is None:
        now_dt = now_dt.replace(tzinfo=timezone.utc)

    seconds = max(0.0, (now_dt - dt_obj).total_seconds())
    days_elapsed = seconds / 86400.0

    decay_factor = math.pow(2.0, -days_elapsed / max(1.0, half_life_days))
    effective_confidence = round(float(raw_confidence) * decay_factor, 4)

    if days_elapsed <= 7.0:
        retention_status = "RECENT"
    elif decay_factor >= 0.70:
        retention_status = "RETAINED"
    elif decay_factor >= 0.35:
        retention_status = "DUE_FOR_REVIEW"
    else:
        retention_status = "EXPIRED"

    return {
        "raw_confidence": float(raw_confidence),
        "effective_confidence": effective_confidence,
        "decay_factor": round(decay_factor, 4),
        "days_elapsed": round(days_elapsed, 2),
        "retention_status": retention_status,
    }


def schedule_concept_transfers(
    strengths: List[Dict[str, Any]],
    weaknesses: List[Dict[str, Any]],
    misconceptions: List[Dict[str, Any]],
    current_concepts: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    """
    Schedules spaced repetition, conceptual transfer, and scaffolding interventions:
    - DUE_FOR_REVIEW: Mastered concepts whose retention has decayed.
    - ACTIVE_SCAFFOLDING: Current struggles or misconceptions needing immediate intervention.
    - READY_FOR_TRANSFER: Mastered concepts that can be bridged to the current assignment.
    """
    schedule = []
    current_set = {c.lower().strip() for c in (current_concepts or []) if c}

    for s in strengths:
        retention = s.get("retention_status")
        eff_conf = s.get("effective_confidence", s.get("confidence", 1.0))
        concept = s["concept"]
        is_current = concept.lower().strip() in current_set

        if retention in ("DUE_FOR_REVIEW", "EXPIRED") or (eff_conf is not None and eff_conf < 0.60):
            schedule.append({
                "concept": concept,
                "category": "DUE_FOR_REVIEW",
                "priority": "HIGH" if is_current else "MEDIUM",
                "rationale": f"Concept mastery was established ({int(s.get('mastery', 0)*100)}%), but confidence decayed due to elapsed practice time.",
                "pedagogical_action": f"Re-activate understanding of {concept} with a brief retrieval or warm-up question before building on it.",
            })
        elif s.get("mastery", 0) >= 0.80 and (eff_conf is None or eff_conf >= 0.70):
            schedule.append({
                "concept": concept,
                "category": "READY_FOR_TRANSFER",
                "priority": "HIGH" if not is_current else "LOW",
                "rationale": f"High mastery ({int(s.get('mastery', 0)*100)}%) and strong retention make this an ideal foundation for analogical transfer.",
                "pedagogical_action": f"Bridge {concept} to novel problem contexts or use it as an anchor analogy for unfamiliar material.",
            })

    for w in weaknesses:
        concept = w["concept"]
        schedule.append({
            "concept": concept,
            "category": "ACTIVE_SCAFFOLDING",
            "priority": "HIGH",
            "rationale": f"Current gap detected (estimated mastery: {int(w.get('mastery', 0)*100)}%).",
            "pedagogical_action": f"Deconstruct {concept} into foundational micro-steps; prompt the student to explain intermediate reasoning.",
        })

    for m in misconceptions:
        concept = m.get("concept") or "General reasoning"
        schedule.append({
            "concept": concept,
            "category": "ACTIVE_SCAFFOLDING",
            "priority": "CRITICAL",
            "rationale": f"Active misconception logged: {m.get('observation')}",
            "pedagogical_action": f"Challenge the misconception in {concept} via a counter-example or Socratic reductio ad absurdum.",
        })

    return schedule


# ── 1. Learning Memory Types & Structures ─────────────────────────────────────

class StudentMemoryProfile:
    """Consolidated student learning profile across assignments, courses, and sessions."""

    def __init__(
        self,
        student_id: str,
        university_id: str,
        strengths: List[Dict[str, Any]],
        weaknesses: List[Dict[str, Any]],
        misconceptions: List[Dict[str, Any]],
        recurring_mistakes: List[Dict[str, Any]],
        recent_progress: List[Dict[str, Any]],
        educational_libraries: List[Dict[str, Any]],
        whiteboard_memory: Dict[str, Any],
        transfer_schedule: Optional[List[Dict[str, Any]]] = None,
    ):
        self.student_id = student_id
        self.university_id = university_id
        self.strengths = strengths
        self.weaknesses = weaknesses
        self.misconceptions = misconceptions
        self.recurring_mistakes = recurring_mistakes
        self.recent_progress = recent_progress
        self.educational_libraries = educational_libraries
        self.whiteboard_memory = whiteboard_memory
        self.transfer_schedule = transfer_schedule or []

    def to_dict(self) -> Dict[str, Any]:
        d = {
            "student_id": self.student_id,
            "university_id": self.university_id,
            "strengths": self.strengths,
            "weaknesses": self.weaknesses,
            "misconceptions": self.misconceptions,
            "recurring_mistakes": self.recurring_mistakes,
            "recent_progress": self.recent_progress,
            "educational_libraries": self.educational_libraries,
            "whiteboard_memory": self.whiteboard_memory,
        }
        if self.transfer_schedule:
            d["transfer_schedule"] = self.transfer_schedule
        return d


# ── 2. Retrieval: Complete Memory Profile ─────────────────────────────────────

def get_complete_student_memory(
    conn: psycopg.Connection,
    *,
    student_id: str,
    university_id: str,
    assignment_id: Optional[str] = None,
    course_id: Optional[str] = None,
    max_history_days: int = 45,
) -> StudentMemoryProfile:
    """
    Authoritative query pulling the student's full persistent learning profile:
    - Mastered concepts (strengths)
    - Challenged concepts (weaknesses)
    - Active misconceptions (from evidence_candidates)
    - Recurring diagnostic patterns (from ai_interactions)
    - Accessible educational materials with indexing status
    - Whiteboard scene memory with strict attribution
    """
    # A. Strengths & Weaknesses from student_concept_state
    concept_rows = many(
        conn,
        """
        SELECT c.name, s.mastery_estimate, s.confidence, s.evidence_count, s.last_evaluated_at
          FROM student_concept_state s
          JOIN concepts c ON c.concept_id = s.concept_id
         WHERE s.student_id = %s AND s.university_id = %s
         ORDER BY s.mastery_estimate DESC
        """,
        (student_id, university_id),
    )

    strengths = []
    weaknesses = []
    for r in concept_rows:
        decay_info = compute_confidence_decay(
            float(r["confidence"]) if r["confidence"] is not None else None,
            r["last_evaluated_at"],
        )
        entry = {
            "concept": r["name"],
            "mastery": float(r["mastery_estimate"]) if r["mastery_estimate"] is not None else None,
            "confidence": float(r["confidence"]) if r["confidence"] is not None else None,
            "effective_confidence": decay_info["effective_confidence"],
            "decay_factor": decay_info["decay_factor"],
            "days_since_evaluation": decay_info["days_elapsed"],
            "retention_status": decay_info["retention_status"],
            "evidence_count": r["evidence_count"],
            "last_evaluated_at": r["last_evaluated_at"].isoformat() if r["last_evaluated_at"] else None,
        }
        if entry["mastery"] is not None and entry["mastery"] >= 0.70:
            strengths.append(entry)
        elif entry["mastery"] is not None and entry["mastery"] < 0.50:
            weaknesses.append(entry)

    # B. Active Misconceptions from evidence_candidates
    misconception_rows = many(
        conn,
        """
        SELECT concept, observation, strength, created_at, assignment_id
          FROM evidence_candidates
         WHERE student_id = %s AND university_id = %s
           AND evidence_type = 'MISCONCEPTION'
           AND created_at >= now() - (%s || ' days')::interval
         ORDER BY created_at DESC LIMIT 8
        """,
        (student_id, university_id, max_history_days),
    )
    misconceptions = [
        {
            "concept": r["concept"] or "General reasoning",
            "observation": r["observation"],
            "strength": r["strength"],
            "recorded_at": r["created_at"].isoformat() if r["created_at"] else None,
            "assignment_id": r["assignment_id"],
        }
        for r in misconception_rows
    ]

    # C. Recurring Mistakes / Diagnoses from ai_interactions
    mistake_rows = many(
        conn,
        """
        SELECT diagnosis, count(*)::int AS occurrences, max(created_at) AS last_seen
          FROM ai_interactions
         WHERE student_id = %s AND university_id = %s
           AND diagnosis IS NOT NULL
           AND diagnosis IN ('MISCONCEPTION', 'CONCEPTUAL_GAP', 'PROCEDURAL_ERROR', 'LOGICAL_ERROR', 'CODE_ERROR')
           AND COALESCE(diagnosis_explanation, '') <> ALL(%s)
           AND created_at >= now() - (%s || ' days')::interval
         GROUP BY diagnosis
        HAVING count(*) >= 2
         ORDER BY count(*) DESC
        """,
        (student_id, university_id, list(FABRICATED_EXPLANATIONS), max_history_days),
    )
    recurring_mistakes = [
        {
            "diagnosis": r["diagnosis"],
            "count": r["occurrences"],
            "last_seen": r["last_seen"].isoformat() if r["last_seen"] else None,
        }
        for r in mistake_rows
    ]

    # D. Recent Progress / Interventions
    progress_rows = many(
        conn,
        """
        SELECT i.intervention_type, i.diagnosis, i.referenced_concepts, i.created_at, a.title AS assignment_title
          FROM ai_interactions i
          LEFT JOIN assignments a ON a.assignment_id = i.assignment_id
         WHERE i.student_id = %s AND i.university_id = %s AND COALESCE(i.diagnosis_explanation, '') <> ALL(%s)
         ORDER BY i.created_at DESC LIMIT 5
        """,
        (student_id, university_id, list(FABRICATED_EXPLANATIONS)),
    )
    recent_progress = [
        {
            "intervention": r["intervention_type"],
            "diagnosis": r["diagnosis"],
            "concepts": r["referenced_concepts"] if isinstance(r["referenced_concepts"], list) else [],
            "date": r["created_at"].isoformat() if r["created_at"] else None,
            "assignment": r["assignment_title"],
        }
        for r in progress_rows
    ]

    # E. Educational Library Memory
    # Files and materials available to this student in the current context
    target_course_id = course_id
    if not target_course_id and assignment_id:
        asg = one(conn, "SELECT course_id FROM assignments WHERE assignment_id=%s AND university_id=%s", (assignment_id, university_id))
        if asg:
            target_course_id = asg["course_id"]

    lib_sql = """
        SELECT f.file_id, f.original_filename, f.purpose, f.kind, f.extension, f.size_bytes,
               f.index_mode, f.status, f.created_at, m.title AS material_title
          FROM stored_files f
          LEFT JOIN materials m ON m.file_id = f.file_id
         WHERE f.university_id = %s
           AND f.status IN ('READY', 'STORED_ONLY')
    """
    params: list[Any] = [university_id]
    if target_course_id:
        lib_sql += " AND f.course_id = %s"
        params.append(target_course_id)

    lib_sql += " ORDER BY f.created_at DESC LIMIT 30"
    library_rows = many(conn, lib_sql, tuple(params))
    educational_libraries = [
        {
            "file_id": r.get("file_id"),
            "title": r.get("material_title") or r.get("original_filename") or r.get("title") or "Educational Document",
            "filename": r.get("original_filename") or r.get("filename") or "document",
            "kind": r.get("kind", "DOCUMENT"),
            "extension": r.get("extension", ""),
            "size_kb": round((r.get("size_bytes") or 0) / 1024, 1),
            "ownership": (
                "teacher-provided material"
                if r.get("purpose") == "MATERIAL"
                else "assignment attachment"
                if r.get("purpose") == "ASSIGNMENT_ATTACHMENT"
                else "student submission"
            ),
            "indexing_status": "SEARCHABLE_IN_KNOWLEDGE_BASE" if (r.get("index_mode") == "RAG" and r.get("status") == "READY") else "DOWNLOAD_ONLY",
            "created_at": r["created_at"].isoformat() if r.get("created_at") else None,
        }
        for r in library_rows
    ]

    # F. Whiteboard Memory & Content Attribution
    whiteboard_memory: Dict[str, Any] = {
        "has_board": False,
        "total_elements": 0,
        "student_equations": [],
        "student_notes": [],
        "student_drawings_count": 0,
        "coach_annotations": [],
        "pinned_simulations": [],
    }

    if assignment_id:
        att = one(
            conn,
            "SELECT whiteboard, whiteboard_updated_at FROM attempts WHERE student_id=%s AND assignment_id=%s ORDER BY attempt_number DESC LIMIT 1",
            (student_id, assignment_id),
        )
        if att and att.get("whiteboard"):
            wb = att["whiteboard"]
            scene = wb.get("scene") or {}
            elements = scene.get("elements") if isinstance(scene, dict) else None
            legacy_elements = wb.get("elements") or []

            student_eqs = []
            student_notes = []
            coach_notes = []
            simulations = []
            freehand_count = 0

            # Inspect native scene elements
            if isinstance(elements, list):
                for el in elements:
                    if el.get("isDeleted"):
                        continue
                    el_type = el.get("type")
                    custom = el.get("customData") or {}
                    soc = custom.get("socratiq") or {}
                    author = soc.get("author", "student")

                    # Simulations
                    if soc.get("role") == "simulation" or "simulation" in soc:
                        sim_data = soc.get("simulation") or {}
                        simulations.append({
                            "title": sim_data.get("title") or "Simulation Card",
                            "pinned": True,
                        })

                    # Text / Equations
                    if el_type == "text":
                        text_val = el.get("text", "").strip()
                        if not text_val:
                            continue
                        if author == "coach":
                            coach_notes.append(text_val[:120])
                        else:
                            is_eq = any(c in text_val for c in ("$", "\\", "=", "^", "√", "∫", "∑"))
                            if is_eq:
                                student_eqs.append(text_val[:120])
                            else:
                                student_notes.append(text_val[:120])
                    elif el_type == "freedraw":
                        if author != "coach":
                            freehand_count += 1

            # Fallback to legacy elements if no native elements found
            if not student_notes and not student_eqs and isinstance(legacy_elements, list):
                for le in legacy_elements:
                    kind = le.get("kind")
                    author = le.get("author", "student")
                    txt = le.get("text") or le.get("latex") or ""
                    if not txt:
                        continue
                    if author == "coach":
                        coach_notes.append(txt[:120])
                    else:
                        if kind == "equation":
                            student_eqs.append(txt[:120])
                        else:
                            student_notes.append(txt[:120])

            whiteboard_memory = {
                "has_board": True,
                "updated_at": att["whiteboard_updated_at"].isoformat() if att.get("whiteboard_updated_at") else None,
                "student_equations": student_eqs[:10],
                "student_notes": student_notes[:15],
                "student_drawings_count": freehand_count,
                "coach_annotations": coach_notes[:8],
                "pinned_simulations": simulations[:5],
            }

    transfer_schedule = schedule_concept_transfers(
        strengths=strengths,
        weaknesses=weaknesses,
        misconceptions=misconceptions,
    )

    return StudentMemoryProfile(
        student_id=student_id,
        university_id=university_id,
        strengths=strengths,
        weaknesses=weaknesses,
        misconceptions=misconceptions,
        recurring_mistakes=recurring_mistakes,
        recent_progress=recent_progress,
        educational_libraries=educational_libraries,
        whiteboard_memory=whiteboard_memory,
        transfer_schedule=transfer_schedule,
    )


# ── 3. Prompt Renderers for Socratic Coach & Live Voice ────────────────────────

def format_memory_for_socratic_coach(profile: StudentMemoryProfile) -> str:
    """Formats the unified student memory into pedagogical context for the LangGraph Socratic Coach."""
    blocks: list[str] = ["=== STUDENT LEARNING MEMORY & ACADEMIC CONTINUITY ==="]

    # Strengths
    if profile.strengths:
        str_lines = [f"  - {s['concept']} (Estimated Mastery: {int(s['mastery']*100)}%)" for s in profile.strengths[:6]]
        blocks.append("Demonstrated Strengths (Build upon these concepts):\n" + "\n".join(str_lines))

    # Weaknesses & Misconceptions
    if profile.weaknesses or profile.misconceptions:
        weak_lines = []
        for w in profile.weaknesses[:5]:
            weak_lines.append(f"  - {w['concept']} (Struggling - Mastery: {int(w['mastery']*100)}%)")
        for m in profile.misconceptions[:5]:
            weak_lines.append(f"  - [Active Misconception in {m['concept']}]: {m['observation']}")
        blocks.append("Learning Gaps & Active Misconceptions (Probe socratically):\n" + "\n".join(weak_lines))

    # Recurring mistakes
    if profile.recurring_mistakes:
        m_lines = [f"  - Pattern: {rm['diagnosis']} (observed {rm['count']} times)" for rm in profile.recurring_mistakes[:4]]
        blocks.append("Recurring Reasoning Obstacles:\n" + "\n".join(m_lines))

    # Whiteboard Memory & Attribution
    wb = profile.whiteboard_memory
    if wb.get("has_board"):
        wb_lines = []
        if wb.get("student_equations"):
            wb_lines.append("  Student Equations on Board: " + " | ".join(wb["student_equations"][:4]))
        if wb.get("student_notes"):
            wb_lines.append("  Student Written Notes: " + " | ".join(wb["student_notes"][:4]))
        if wb.get("coach_annotations"):
            wb_lines.append("  Previous Coach Stamped Annotations: " + " | ".join(wb["coach_annotations"][:3]))
        if wb.get("pinned_simulations"):
            wb_lines.append("  Pinned Interactive Simulations: " + ", ".join(s["title"] for s in wb["pinned_simulations"]))
        if wb_lines:
            blocks.append("Whiteboard Context & Content Attribution:\n" + "\n".join(wb_lines))

    # Educational Library memory
    if profile.educational_libraries:
        lib_lines = [
            f"  - {doc['title']} [{doc['kind']}] ({doc['ownership']}, {doc['indexing_status']})"
            for doc in profile.educational_libraries[:8]
        ]
        blocks.append("Educational Library Resources in Scope:\n" + "\n".join(lib_lines))

    # Conceptual Transfer & Spaced Repetition Scheduling
    if profile.transfer_schedule:
        sched_lines = []
        for s in profile.transfer_schedule[:5]:
            sched_lines.append(f"  - [{s['category']} - {s['priority']}] {s['concept']}: {s['pedagogical_action']}")
        blocks.append("Transfer & Spaced Review Recommendations:\n" + "\n".join(sched_lines))

    blocks.append("Pedagogical Rule: Personalize questions to address misconceptions without giving answers away.")
    return "\n\n".join(blocks)


def format_memory_for_live_voice(profile: StudentMemoryProfile) -> str:
    """Concise pedagogical memory block specifically calibrated for low-latency Gemini Live Voice."""
    lines: list[str] = ["=== STUDENT MEMORY FOR REAL-TIME VOICE ==="]

    if profile.strengths:
        concepts = ", ".join(s["concept"] for s in profile.strengths[:4])
        lines.append(f"- Mastered Concepts: {concepts}")

    if profile.misconceptions:
        for m in profile.misconceptions[:3]:
            lines.append(f"- Active Misconception ({m['concept']}): {m['observation']}")

    if profile.recurring_mistakes:
        for rm in profile.recurring_mistakes[:2]:
            lines.append(f"- Watch for Recurring Pattern: {rm['diagnosis']}")

    wb = profile.whiteboard_memory
    if wb.get("has_board") and (wb.get("student_equations") or wb.get("student_notes")):
        items = (wb.get("student_equations", []) + wb.get("student_notes", []))[:3]
        lines.append(f"- Active Student Content on Board: {' | '.join(items)}")

    if profile.educational_libraries:
        titles = ", ".join(doc["title"] for doc in profile.educational_libraries[:4])
        lines.append(f"- Course Materials: {titles}")

    lines.append("Guidance: Address student misconceptions warmly; never give away assignment solutions.")
    return "\n".join(lines)


# ── 4. Lifecycle: Creation, Expiration & Deletion ─────────────────────────────

def record_student_learning_observation(
    conn: psycopg.Connection,
    *,
    student_id: str,
    university_id: str,
    assignment_id: str,
    concept: str,
    evidence_type: str,
    strength: str,
    observation: str,
    confidence: Optional[float] = None,
) -> str:
    """Creates a new validated learning evidence record in evidence_candidates."""
    evidence_id = new_id("evd")
    conn.execute(
        """
        INSERT INTO evidence_candidates (evidence_id, student_id, assignment_id, concept, evidence_type, strength, observation, confidence, university_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (evidence_id, student_id, assignment_id, concept.strip()[:200], evidence_type, strength, observation[:2000], confidence, university_id),
    )
    return evidence_id


@dataclass
class MemoryDeletionReport:
    """Structured audit report for student memory deletion and GDPR compliance."""
    student_id: str
    concept_states_deleted: int = 0
    evidence_candidates_deleted: int = 0
    ai_sessions_deleted: int = 0
    whiteboard_sessions_cleared: int = 0
    student_files_deleted: int = 0
    shared_materials_preserved: int = 0

    def total_deleted(self) -> int:
        return (
            self.concept_states_deleted
            + self.evidence_candidates_deleted
            + self.ai_sessions_deleted
            + self.whiteboard_sessions_cleared
            + self.student_files_deleted
        )

    def __int__(self) -> int:
        return self.total_deleted()

    def __eq__(self, other: Any) -> bool:
        if isinstance(other, int):
            return self.total_deleted() == other
        return super().__eq__(other)


def delete_student_memory(
    conn: psycopg.Connection,
    *,
    student_id: str,
    university_id: str,
    concept_id: Optional[str] = None,
    scope: Literal["concept_only", "learning_profile", "whiteboard", "conversations", "gdpr_erasure"] = "learning_profile",
    assignment_id: Optional[str] = None,
) -> MemoryDeletionReport:
    """
    Deletes or resets student memory respecting strict data ownership and legal retention rules.

    Data Category Retention & Deletion Lifecycle:
    1. student_concept_state & evidence_candidates:
       - Personal student learning evaluations, misconceptions, and struggle observations.
       - Purged on 'learning_profile' or 'gdpr_erasure'.
    2. ai_sessions / ai_interactions / messages:
       - Personal Socratic dialogue transcripts between student and AI.
       - Purged on 'conversations' or 'gdpr_erasure' (cascades to ai_interactions and messages).
    3. attempts.whiteboard:
       - Student's personal scratchpad.
       - Scrubbed (SET whiteboard = NULL) on 'whiteboard' or 'gdpr_erasure'.
    4. stored_files:
       - Student submission files (uploader_id = student_id AND purpose = 'SUBMISSION').
       - Purged on 'gdpr_erasure'.
    5. materials & course documents:
       - SHARED EDUCATIONAL RESOURCES owned by university/course instructors.
       - STRICTLY PRESERVED: Never deleted when a student exercises right to erasure.
       - We count and report shared_materials_preserved for compliance auditing.
    """
    report = MemoryDeletionReport(student_id=student_id)

    # 1. Concept-specific deletion
    if concept_id or scope == "concept_only":
        cid = concept_id or ""
        cur1 = conn.execute(
            "DELETE FROM student_concept_state WHERE student_id=%s AND university_id=%s AND concept_id=%s",
            (student_id, university_id, cid),
        )
        report.concept_states_deleted = cur1.rowcount or 0
        return report

    # 2. Learning profile (concept states + evidence candidates)
    if scope in ("learning_profile", "gdpr_erasure"):
        cur1 = conn.execute(
            "DELETE FROM student_concept_state WHERE student_id=%s AND university_id=%s",
            (student_id, university_id),
        )
        report.concept_states_deleted = cur1.rowcount or 0

        cur2 = conn.execute(
            "DELETE FROM evidence_candidates WHERE student_id=%s AND university_id=%s",
            (student_id, university_id),
        )
        report.evidence_candidates_deleted = cur2.rowcount or 0

    # 3. Whiteboard personal scratchpad
    if scope in ("whiteboard", "gdpr_erasure"):
        if assignment_id:
            cur_wb = conn.execute(
                "UPDATE attempts SET whiteboard=NULL WHERE student_id=%s AND assignment_id=%s AND whiteboard IS NOT NULL",
                (student_id, assignment_id),
            )
        else:
            cur_wb = conn.execute(
                "UPDATE attempts SET whiteboard=NULL WHERE student_id=%s AND whiteboard IS NOT NULL",
                (student_id,),
            )
        report.whiteboard_sessions_cleared = cur_wb.rowcount or 0

    # 4. AI conversations & transcripts (cascades to messages and ai_interactions)
    if scope in ("conversations", "gdpr_erasure"):
        if assignment_id:
            cur_ai = conn.execute(
                "DELETE FROM ai_sessions WHERE student_id=%s AND assignment_id=%s",
                (student_id, assignment_id),
            )
        else:
            cur_ai = conn.execute(
                "DELETE FROM ai_sessions WHERE student_id=%s",
                (student_id,),
            )
        report.ai_sessions_deleted = cur_ai.rowcount or 0

    # 5. Student-owned uploaded submission files (only student personal files)
    if scope == "gdpr_erasure":
        cur_files = conn.execute(
            "DELETE FROM stored_files WHERE uploader_id=%s AND purpose='SUBMISSION'",
            (student_id,),
        )
        report.student_files_deleted = cur_files.rowcount or 0

    # 6. Auditing shared materials preserved (ensure course resources are never touched)
    try:
        cur_mat = conn.execute(
            "SELECT COUNT(*) FROM materials WHERE university_id=%s",
            (university_id,),
        )
        row = cur_mat.fetchone()
        if row is not None:
            report.shared_materials_preserved = row[0] if isinstance(row, (tuple, list)) else (row.get("count", 0) if isinstance(row, dict) else 0)
    except Exception:
        report.shared_materials_preserved = 0

    return report
