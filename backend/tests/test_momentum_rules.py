"""Study momentum rules (pure): streaks, tiers, and that each moment is offered once and only for real progress."""
from __future__ import annotations

from datetime import date, timedelta

from app.momentum import celebrations, highest_tier, next_tier, streak

TODAY = date(2026, 11, 21)


def days(*ago):
    return {TODAY - timedelta(days=n) for n in ago}


def test_streak_is_alive_until_today_ends_and_tracks_the_longest_run():
    assert streak(days(0, 1, 2), TODAY)["current"] == 3
    s = streak(days(1, 2, 3), TODAY)                       # nothing yet today: yesterday's streak still counts
    assert s["current"] == 3 and not s["active_today"]
    assert streak(days(2, 3), TODAY)["current"] == 0       # a missed day breaks it
    assert streak(days(0, 10, 11, 12, 13), TODAY)["longest"] == 4
    assert [d["active"] for d in streak(days(0, 6), TODAY)["week"]] == [True, False, False, False, False, False, True]


def test_tiers():
    assert highest_tier(12, (1, 5, 10, 25)) == 10 and highest_tier(0, (1, 5)) is None
    assert next_tier(12, (1, 5, 10, 25)) == 25 and next_tier(30, (1, 5, 10, 25)) is None


def test_only_the_highest_unseen_tier_is_offered_and_seeing_a_higher_tier_covers_lower_ones():
    c = celebrations(today=TODAY, days=set(), submissions=30, verified=0, grades=[], seen=set())
    assert [x["key"] for x in c] == ["submissions:25"]
    assert celebrations(today=TODAY, days=set(), submissions=7, verified=0, grades=[], seen={"submissions:25"}) == []


def test_grade_moments_come_first_are_supportive_and_report_real_improvement():
    g = [{"submission_id": "s1", "assignment_id": "a", "course_id": "c", "title": "T", "percentage": 55.0, "previous_average": 40.0}]
    c = celebrations(today=TODAY, days=days(0, 1, 2), submissions=1, verified=0, grades=g, seen=set())
    assert c[0]["kind"] == "grade" and c[0]["band"] == "growing" and c[0]["improved_by"] == 15.0
    assert [x["kind"] for x in c] == ["grade", "streak", "submissions"]
    assert celebrations(today=TODAY, days=set(), submissions=0, verified=0, grades=g, seen={"grade:s1"}) == []


def test_welcome_back_only_after_a_real_gap():
    assert [x["kind"] for x in celebrations(today=TODAY, days=days(0, 6), submissions=0, verified=0, grades=[], seen=set())] == ["comeback"]
    assert celebrations(today=TODAY, days=days(0, 2), submissions=0, verified=0, grades=[], seen=set()) == []
