"""November 2026 alignment: server capabilities, course icons (migration 021) and grades on the assignment roster. Real database (conftest.world)."""
from __future__ import annotations

from .helpers import API


def test_capabilities_need_sign_in_and_report_the_migrations(world):
    assert world.client.get(f"{API}/capabilities").status_code == 401
    r = world.client.get(f"{API}/capabilities", headers=world.h("S1"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["api_level"] >= 3
    assert body["features"] == {"insights": True, "notes_board": True, "assessment": True, "course_icons": True}   # every migration applied
    assert body["migrations"]["course_icons"] == "021_course_icon.sql"


def test_course_icon_is_stored_returned_and_validated(world):
    h = world.h("P1")
    r = world.client.post(f"{API}/teacher/courses", json={"code": "ICN1", "title": "Icons", "icon": "flask"}, headers=h)
    assert r.status_code == 201, r.text
    cid = r.json()["id"]
    assert r.json()["icon"] == "flask"
    assert world.client.get(f"{API}/teacher/courses/{cid}", headers=h).json()["course"]["icon"] == "flask"
    assert world.client.patch(f"{API}/teacher/courses/{cid}", json={"icon": "leaf"}, headers=h).json()["icon"] == "leaf"
    assert world.client.post(f"{API}/teacher/courses", json={"code": "ICN2", "title": "Bad", "icon": "rocket"}, headers=h).status_code == 422
    plain = world.client.post(f"{API}/teacher/courses", json={"code": "ICN3", "title": "No icon"}, headers=h).json()
    assert plain["icon"] is None                                                       # the app then derives an icon from the title


def test_assignment_roster_carries_the_latest_grade(world):
    T = f"{API}/teacher/assignments/A1"
    row = lambda: next(s for s in world.client.get(T, headers=world.h("P1")).json()["submissions"] if s["student_id"] == "S1")
    assert row()["grade"] is None
    assert world.client.post(f"{API}/student/attempts/T1/submit", json={"text": "theta = theta - lr * grad"}, headers=world.h("S1")).status_code == 200
    assert row()["status"] == "submitted" and row()["grade"] is None                  # handed in, not graded: "To grade"
    assert world.client.put(f"{T}/students/S1/grade", json={"score": 8, "max_score": 10}, headers=world.h("P1")).status_code == 200
    g = row()["grade"]
    assert g["score"] == 8 and g["max_score"] == 10 and g["percentage"] == 80.0 and g["graded_at"]   # shown as graded at once
    assert world.client.get(T, headers=world.h("P1")).json()["counts"]["graded"] == 1
