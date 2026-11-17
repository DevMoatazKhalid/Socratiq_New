import pytest
from datetime import datetime, timedelta, timezone
from backend.app.memory import (
    compute_confidence_decay,
    schedule_concept_transfers,
    StudentMemoryProfile,
    format_memory_for_socratic_coach,
)


def test_confidence_decay_recent():
    now = datetime(2026, 11, 18, 12, 0, 0, tzinfo=timezone.utc)
    eval_time = now - timedelta(days=2)  # 2 days ago

    res = compute_confidence_decay(raw_confidence=0.90, last_evaluated_at=eval_time, now=now)
    assert res["raw_confidence"] == 0.90
    assert res["effective_confidence"] >= 0.85
    assert res["retention_status"] == "RECENT"
    assert res["decay_factor"] > 0.95
    assert res["days_elapsed"] == 2.0


def test_confidence_decay_half_life():
    now = datetime(2026, 11, 18, 12, 0, 0, tzinfo=timezone.utc)
    # Exactly 30 days ago (1 half-life)
    eval_time = now - timedelta(days=30)

    res = compute_confidence_decay(raw_confidence=0.80, last_evaluated_at=eval_time, now=now, half_life_days=30.0)
    assert res["raw_confidence"] == 0.80
    # Half-life = 50% retention
    assert abs(res["decay_factor"] - 0.50) < 0.01
    assert abs(res["effective_confidence"] - 0.40) < 0.01
    assert res["retention_status"] == "DUE_FOR_REVIEW"


def test_confidence_decay_expired():
    now = datetime(2026, 11, 18, 12, 0, 0, tzinfo=timezone.utc)
    # 90 days ago (3 half-lives: 12.5% retention)
    eval_time = now - timedelta(days=90)

    res = compute_confidence_decay(raw_confidence=0.80, last_evaluated_at=eval_time, now=now, half_life_days=30.0)
    assert res["decay_factor"] < 0.20
    assert res["effective_confidence"] < 0.20
    assert res["retention_status"] == "EXPIRED"


def test_confidence_decay_none_handled_gracefully():
    res = compute_confidence_decay(raw_confidence=None, last_evaluated_at=None)
    assert res["raw_confidence"] is None
    assert res["effective_confidence"] is None
    assert res["retention_status"] == "UNKNOWN"


def test_transfer_scheduling_logic():
    strengths = [
        {
            "concept": "Newton's First Law",
            "mastery": 0.92,
            "confidence": 0.90,
            "effective_confidence": 0.88,
            "retention_status": "RECENT",
        },
        {
            "concept": "Kinematics in 1D",
            "mastery": 0.85,
            "confidence": 0.85,
            "effective_confidence": 0.40,
            "retention_status": "DUE_FOR_REVIEW",
        },
    ]
    weaknesses = [
        {"concept": "Frictional Forces", "mastery": 0.35}
    ]
    misconceptions = [
        {"concept": "Normal Force", "observation": "thinks normal force equals mg on inclined plane"}
    ]

    schedule = schedule_concept_transfers(strengths, weaknesses, misconceptions, current_concepts=["Newton's First Law"])
    categories = [s["category"] for s in schedule]

    assert "READY_FOR_TRANSFER" in categories
    assert "DUE_FOR_REVIEW" in categories
    assert "ACTIVE_SCAFFOLDING" in categories

    review_item = next(s for s in schedule if s["concept"] == "Kinematics in 1D")
    assert review_item["category"] == "DUE_FOR_REVIEW"
    assert "retrieval or warm-up" in review_item["pedagogical_action"]


def test_profile_with_transfer_schedule_formatting():
    profile = StudentMemoryProfile(
        student_id="s123",
        university_id="u1",
        strengths=[{"concept": "Linear Algebra", "mastery": 0.95}],
        weaknesses=[],
        misconceptions=[],
        recurring_mistakes=[],
        recent_progress=[],
        educational_libraries=[],
        whiteboard_memory={},
        transfer_schedule=[
            {
                "concept": "Linear Algebra",
                "category": "READY_FOR_TRANSFER",
                "priority": "HIGH",
                "pedagogical_action": "Bridge matrix transforms to graphic coordinate geometry",
            }
        ],
    )

    formatted = format_memory_for_socratic_coach(profile)
    assert "Transfer & Spaced Review Recommendations:" in formatted
    assert "READY_FOR_TRANSFER - HIGH" in formatted
    assert "Bridge matrix transforms" in formatted
