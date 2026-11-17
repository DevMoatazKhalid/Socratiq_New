import pytest
import psycopg
from unittest.mock import MagicMock
from datetime import datetime
from backend.app.memory import (
    StudentMemoryProfile,
    get_complete_student_memory,
    format_memory_for_socratic_coach,
    format_memory_for_live_voice,
    record_student_learning_observation,
    delete_student_memory,
)


def test_student_memory_profile_to_dict():
    profile = StudentMemoryProfile(
        student_id="std_1",
        university_id="uni_1",
        strengths=[{"concept": "Derivatives", "mastery": 0.85}],
        weaknesses=[{"concept": "Chain Rule", "mastery": 0.40}],
        misconceptions=[{"concept": "Chain Rule", "observation": "multiplies instead of composing"}],
        recurring_mistakes=[{"diagnosis": "CONCEPTUAL_GAP", "count": 3}],
        recent_progress=[{"intervention": "HINT", "diagnosis": "CONCEPTUAL_GAP"}],
        educational_libraries=[{"title": "Calculus Notes", "indexing_status": "SEARCHABLE_IN_KNOWLEDGE_BASE"}],
        whiteboard_memory={"has_board": True, "student_equations": ["f'(x) = 2x"]},
    )
    d = profile.to_dict()
    assert d["student_id"] == "std_1"
    assert len(d["strengths"]) == 1
    assert d["strengths"][0]["concept"] == "Derivatives"
    assert len(d["weaknesses"]) == 1
    assert len(d["misconceptions"]) == 1
    assert len(d["recurring_mistakes"]) == 1
    assert len(d["educational_libraries"]) == 1
    assert d["whiteboard_memory"]["has_board"] is True


def test_format_memory_for_socratic_coach():
    profile = StudentMemoryProfile(
        student_id="std_1",
        university_id="uni_1",
        strengths=[{"concept": "Newtonian Mechanics", "mastery": 0.9}],
        weaknesses=[{"concept": "Friction Vectors", "mastery": 0.35}],
        misconceptions=[{"concept": "Friction Vectors", "observation": "confuses normal force with weight"}],
        recurring_mistakes=[{"diagnosis": "PROCEDURAL_ERROR", "count": 4}],
        recent_progress=[],
        educational_libraries=[{"title": "Physics 101 Syllabus", "kind": "DOCUMENT", "ownership": "teacher-provided material", "indexing_status": "SEARCHABLE_IN_KNOWLEDGE_BASE"}],
        whiteboard_memory={
            "has_board": True,
            "student_equations": ["F = m * a", "f_k = mu * N"],
            "student_notes": ["Need to resolve components along inclined plane"],
            "coach_annotations": ["Which direction does friction oppose?"],
            "pinned_simulations": [{"title": "Inclined Plane Friction Sim"}],
        },
    )

    coach_text = format_memory_for_socratic_coach(profile)

    assert "Newtonian Mechanics (Estimated Mastery: 90%)" in coach_text
    assert "Friction Vectors (Struggling - Mastery: 35%)" in coach_text
    assert "confuses normal force with weight" in coach_text
    assert "Pattern: PROCEDURAL_ERROR (observed 4 times)" in coach_text
    assert "F = m * a" in coach_text
    assert "Which direction does friction oppose?" in coach_text
    assert "Inclined Plane Friction Sim" in coach_text
    assert "Physics 101 Syllabus" in coach_text
    assert "Personalize questions to address misconceptions without giving answers away" in coach_text


def test_format_memory_for_live_voice():
    profile = StudentMemoryProfile(
        student_id="std_1",
        university_id="uni_1",
        strengths=[{"concept": "Photosynthesis", "mastery": 0.88}],
        weaknesses=[],
        misconceptions=[{"concept": "Light Reactions", "observation": "thinks ATP is created without light"}],
        recurring_mistakes=[{"diagnosis": "CONCEPTUAL_GAP", "count": 2}],
        recent_progress=[],
        educational_libraries=[{"title": "Biology Textbook"}],
        whiteboard_memory={"has_board": True, "student_notes": ["Chlorophyll absorbs blue and red"]},
    )

    voice_text = format_memory_for_live_voice(profile)

    assert "Mastered Concepts: Photosynthesis" in voice_text
    assert "Active Misconception (Light Reactions)" in voice_text
    assert "Recurring Pattern: CONCEPTUAL_GAP" in voice_text
    assert "Chlorophyll absorbs blue and red" in voice_text
    assert "Biology Textbook" in voice_text


def test_whiteboard_attribution_separation():
    conn = MagicMock()

    # Mock attempts table query returning native whiteboard scene with both student and coach elements
    board_scene = {
        "scene": {
            "elements": [
                {
                    "type": "text",
                    "text": "E = mc^2",
                    "customData": {"socratiq": {"author": "student"}},
                },
                {
                    "type": "text",
                    "text": "Check units of c",
                    "customData": {"socratiq": {"author": "coach"}},
                },
                {
                    "type": "rectangle",
                    "customData": {
                        "socratiq": {
                            "role": "simulation",
                            "simulation": {"title": "Relativistic Speed Sim"},
                        }
                    },
                },
                {
                    "type": "freedraw",
                    "customData": {"socratiq": {"author": "student"}},
                },
            ]
        }
    }

    def mock_execute(sql, params):
        cur = MagicMock()
        if "FROM attempts" in sql:
            cur.fetchone.return_value = {
                "whiteboard": board_scene,
                "whiteboard_updated_at": datetime.now(),
            }
        elif "FROM student_concept_state" in sql:
            cur.fetchall.return_value = []
        elif "FROM evidence_candidates" in sql:
            cur.fetchall.return_value = []
        elif "FROM ai_interactions" in sql:
            cur.fetchall.return_value = []
        elif "FROM stored_files" in sql:
            cur.fetchall.return_value = []
        elif "FROM assignments" in sql:
            cur.fetchone.return_value = {"course_id": "c1"}
        return cur

    conn.execute.side_effect = mock_execute

    profile = get_complete_student_memory(
        conn,
        student_id="std_1",
        university_id="uni_1",
        assignment_id="asg_1",
    )

    wb = profile.whiteboard_memory
    assert wb["has_board"] is True
    # Student equation recognized
    assert "E = mc^2" in wb["student_equations"]
    # Coach annotation separated
    assert "Check units of c" in wb["coach_annotations"]
    # Pinned simulation recognized
    assert len(wb["pinned_simulations"]) == 1
    assert wb["pinned_simulations"][0]["title"] == "Relativistic Speed Sim"
    assert wb["student_drawings_count"] == 1


def test_record_and_delete_student_memory():
    conn = MagicMock()
    cur = MagicMock()
    cur.rowcount = 1
    conn.execute.return_value = cur

    # Create
    ev_id = record_student_learning_observation(
        conn,
        student_id="std_1",
        university_id="uni_1",
        assignment_id="asg_1",
        concept="Momentum",
        evidence_type="MISCONCEPTION",
        strength="MODERATE",
        observation="forgot conservation in inelastic collision",
        confidence=0.85,
    )
    assert ev_id.startswith("evd")
    assert conn.execute.called

    # Delete specific concept
    deleted = delete_student_memory(conn, student_id="std_1", university_id="uni_1", concept_id="c_1")
    assert deleted == 1

    # Delete student learning profile
    deleted_all = delete_student_memory(conn, student_id="std_1", university_id="uni_1")
    assert deleted_all == 2

    # Comprehensive GDPR erasure
    cur.fetchone.return_value = (5,)  # 5 shared materials in the university
    report = delete_student_memory(conn, student_id="std_1", university_id="uni_1", scope="gdpr_erasure")
    assert report.concept_states_deleted == 1
    assert report.evidence_candidates_deleted == 1
    assert report.whiteboard_sessions_cleared == 1
    assert report.ai_sessions_deleted == 1
    assert report.student_files_deleted == 1
    assert report.shared_materials_preserved == 5
    assert report.total_deleted() == 5


def test_scoped_deletion_isolation():
    """Verify that scopes only touch their designated data categories."""
    executed_sqls = []
    conn = MagicMock()
    def tracking_execute(sql, params=None):
        executed_sqls.append(sql.strip())
        cur = MagicMock()
        cur.rowcount = 1
        cur.fetchone.return_value = (10,)
        return cur
    conn.execute.side_effect = tracking_execute

    # 1. Scope: whiteboard only
    executed_sqls.clear()
    rep = delete_student_memory(conn, student_id="std_1", university_id="uni_1", scope="whiteboard", assignment_id="asg_1")
    assert rep.whiteboard_sessions_cleared == 1
    assert rep.concept_states_deleted == 0
    assert any("UPDATE attempts SET whiteboard=NULL" in s for s in executed_sqls)
    assert not any("DELETE FROM student_concept_state" in s for s in executed_sqls)
    assert not any("DELETE FROM ai_sessions" in s for s in executed_sqls)

    # 2. Scope: conversations only
    executed_sqls.clear()
    rep = delete_student_memory(conn, student_id="std_1", university_id="uni_1", scope="conversations", assignment_id="asg_1")
    assert rep.ai_sessions_deleted == 1
    assert rep.concept_states_deleted == 0
    assert any("DELETE FROM ai_sessions" in s for s in executed_sqls)
    assert not any("UPDATE attempts" in s for s in executed_sqls)

    # 3. Scope: concept_only
    executed_sqls.clear()
    rep = delete_student_memory(conn, student_id="std_1", university_id="uni_1", scope="concept_only", concept_id="c_1")
    assert rep.concept_states_deleted == 1
    assert rep.evidence_candidates_deleted == 0
    assert any("DELETE FROM student_concept_state" in s for s in executed_sqls)
    assert not any("DELETE FROM evidence_candidates" in s for s in executed_sqls)


def test_deletion_preserves_shared_materials_and_submissions():
    """Verify that shared course materials, courses, assignments, and submissions are NEVER deleted."""
    executed_sqls = []
    conn = MagicMock()
    def tracking_execute(sql, params=None):
        executed_sqls.append(sql.strip().upper())
        cur = MagicMock()
        cur.rowcount = 1
        cur.fetchone.return_value = (8,)
        return cur
    conn.execute.side_effect = tracking_execute

    # Run full GDPR erasure
    report = delete_student_memory(conn, student_id="std_1", university_id="uni_1", scope="gdpr_erasure")

    # Assert NO delete statement ever targets materials, assignments, courses, or submissions
    for sql in executed_sqls:
        if "DELETE" in sql:
            assert "FROM MATERIALS" not in sql
            assert "FROM COURSES" not in sql
            assert "FROM ASSIGNMENTS" not in sql
            assert "FROM SUBMISSIONS" not in sql
            assert "FROM ENROLLMENTS" not in sql
    # Stored files deletion must only target SUBMISSION purpose
    file_deletions = [s for s in executed_sqls if "DELETE FROM STORED_FILES" in s]
    assert len(file_deletions) == 1
    assert "PURPOSE='SUBMISSION'" in file_deletions[0]
    assert report.shared_materials_preserved == 8


def test_deletion_idempotency():
    """Calling delete_student_memory repeatedly handles 0 rows deleted gracefully."""
    conn = MagicMock()
    cur = MagicMock()
    cur.rowcount = 0
    cur.fetchone.return_value = (0,)
    conn.execute.return_value = cur

    report1 = delete_student_memory(conn, student_id="std_1", university_id="uni_1", scope="gdpr_erasure")
    report2 = delete_student_memory(conn, student_id="std_1", university_id="uni_1", scope="gdpr_erasure")

    assert report1.total_deleted() == 0
    assert report2.total_deleted() == 0


def test_post_deletion_retrieval_returns_clean_profile():
    """Verify that retrieval after deletion exposes no deleted student information."""
    conn = MagicMock()

    def mock_empty_execute(sql, params=None):
        cur = MagicMock()
        if "FROM attempts" in sql:
            # Whiteboard is NULL after erasure
            cur.fetchone.return_value = {"whiteboard": None, "whiteboard_updated_at": None}
        elif "FROM assignments" in sql:
            cur.fetchone.return_value = {"course_id": "c1"}
        elif "FROM stored_files" in sql:
            # Course materials remain
            cur.fetchall.return_value = [
                {
                    "title": "Calculus Syllabus",
                    "file_id": "f_1",
                    "kind": "DOCUMENT",
                    "purpose": "MATERIAL",
                    "index_mode": "SEARCHABLE",
                    "status": "READY",
                    "uploader_id": "prof_1",
                }
            ]
        else:
            # Concepts, evidence, AI interactions are empty
            cur.fetchall.return_value = []
        return cur

    conn.execute.side_effect = mock_empty_execute

    profile = get_complete_student_memory(
        conn,
        student_id="std_erased",
        university_id="uni_1",
        assignment_id="asg_1",
    )

    assert profile.strengths == []
    assert profile.weaknesses == []
    assert profile.misconceptions == []
    assert profile.recurring_mistakes == []
    assert profile.recent_progress == []
    assert profile.whiteboard_memory["has_board"] is False
    assert profile.whiteboard_memory["student_equations"] == []
    assert profile.whiteboard_memory["student_notes"] == []
    assert profile.whiteboard_memory["student_drawings_count"] == 0
    # Course material is still preserved
    assert len(profile.educational_libraries) == 1
    assert profile.educational_libraries[0]["title"] == "Calculus Syllabus"

    # Socratic prompt formatted on post-deletion profile contains no student data
    coach_prompt = format_memory_for_socratic_coach(profile)
    assert "Demonstrated Strengths" not in coach_prompt
    assert "Active Areas for Growth" not in coach_prompt
    assert "Calculus Syllabus" in coach_prompt


def test_deletion_rollback_on_error():
    """Verify transaction boundary behavior: if an error occurs midway, transaction rollback is triggered."""
    conn = MagicMock()
    tx_mock = MagicMock()
    conn.transaction.return_value = tx_mock
    tx_mock.__enter__.return_value = tx_mock
    tx_mock.__exit__.return_value = False  # re-raise exception

    call_count = 0
    def failing_execute(sql, params=None):
        nonlocal call_count
        call_count += 1
        if "evidence_candidates" in sql:
            raise psycopg.OperationalError("Simulated write conflict / dead lock")
        cur = MagicMock()
        cur.rowcount = 1
        return cur

    conn.execute.side_effect = failing_execute

    with pytest.raises(psycopg.OperationalError, match="Simulated write conflict"):
        with conn.transaction():
            delete_student_memory(conn, student_id="std_1", university_id="uni_1", scope="gdpr_erasure")

    assert tx_mock.__exit__.called
    exc_type = tx_mock.__exit__.call_args[0][0]
    assert exc_type is psycopg.OperationalError

