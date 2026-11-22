"""Student overview and course insights against the real migrated database: definitions, scoping and empty states."""
from __future__ import annotations

from .helpers import API

OV = f"{API}/student/overview"


def ins_url(course="C1"):
    return f"{API}/teacher/courses/{course}/insights"


def graded_world(w):
    """S1 and S2 in C1. S1: A1 graded 80/100. S2: two attempts on A1 graded 45/50 then 30/50 (latest counts), verification needs-retry."""
    w.x("UPDATE assignments SET created_at = now() - interval '60 days', published_at = now() - interval '60 days' WHERE assignment_id = 'A1'")
    w.x("INSERT INTO enrollments (enrollment_id, student_id, course_id, classroom_id, university_id) VALUES ('E9','S2','C1','K1','U1')")
    w.x("UPDATE attempts SET status='SUBMITTED' WHERE attempt_id='T1'")
    w.x("""INSERT INTO attempts (attempt_id, student_id, assignment_id, university_id, attempt_number, status) VALUES
           ('T21','S2','A1','U1',1,'SUBMITTED'),('T22','S2','A1','U1',2,'SUBMITTED')""")
    w.x("""INSERT INTO submissions (submission_id, attempt_id, student_id, assignment_id, university_id, submission_type, submission_text, submitted_at, score, max_score, graded_at, grade_source) VALUES
           ('SB1','T1','S1','A1','U1','text','a', now() - interval '3 days', 80, 100, now() - interval '2 days', 'manual'),
           ('SB21','T21','S2','A1','U1','text','b', now() - interval '40 days', 45, 50, now() - interval '39 days', 'manual'),
           ('SB22','T22','S2','A1','U1','text','c', now() - interval '2 days', 30, 50, now() - interval '1 day', 'manual')""")
    w.x("""INSERT INTO verification_runs (verification_id, student_id, assignment_id, submission_id, attempt_id, university_id, status, overall_outcome, completed_at)
           VALUES ('VR1','S2','A1','SB22','T22','U1','COMPLETED','NEEDS_RETRY', now() - interval '1 day')""")
    w.x("""INSERT INTO verification_questions (question_id, verification_id, challenge_id, display_order, verification_type, concept, question_text)
           VALUES ('Q1','VR1','ch1',0,'EXPLAIN','Recursion','?')""")
    w.x("INSERT INTO verification_results (result_id, question_id, outcome, score, confidence) VALUES ('X1','Q1','NEEDS_RETRY',0.2,0.9)")


def test_student_overview_empty_state_is_null_not_zero(world):
    r = world.client.get(OV, headers=world.h("S1"))
    assert r.status_code == 200
    k = r.json()["kpis"]
    assert k["assignments"] == 1 and k["submitted"] == 0 and k["average_grade"] is None and k["graded"] == 0
    assert len(r.json()["trend"]) == 8 and all(p["average_grade"] is None for p in r.json()["trend"])
    assert r.json()["assignments"][0]["status"] == "in_progress"                      # seeded IN_PROGRESS attempt


def test_student_overview_uses_the_latest_graded_submission_and_own_rows_only(world):
    graded_world(world)
    s2 = world.client.get(OV, params={"weeks": 4}, headers=world.h("S2")).json()
    asg = {a["assignment_id"]: a for a in s2["assignments"]}
    assert asg["A1"]["grade"]["percentage"] == 60.0                                   # 30/50 on attempt 2, not 45/50 on attempt 1
    assert asg["A1"]["status"] == "verified" and asg["A1"]["verification"] == {"passed": 0, "total": 1, "status": "COMPLETED"}
    assert s2["kpis"]["verifications_total"] == 1 and s2["kpis"]["verifications_passed"] == 0
    assert {c["course_id"] for c in s2["courses"]} == {"C1", "C2"} and len(s2["trend"]) == 4
    assert s2["deltas"]["average_grade"] == round(60.0 - 90.0, 1)                     # 30 days ago the latest grade was 45/50
    s1 = world.client.get(OV, headers=world.h("S1")).json()
    assert s1["kpis"]["average_grade"] == 80.0 and {a["assignment_id"] for a in s1["assignments"]} == {"A1"}


def test_overview_validation_and_roles(world):
    assert world.client.get(OV, params={"weeks": 0}, headers=world.h("S1")).status_code == 422
    assert world.client.get(OV, params={"weeks": 27}, headers=world.h("S1")).status_code == 422
    assert world.client.get(OV, headers=world.h("P1")).status_code == 403


def test_course_insights_definitions(world):
    graded_world(world)
    r = world.client.get(ins_url(), headers=world.h("P1"))
    assert r.status_code == 200
    d = r.json()
    assert d["grades"]["graded"] == 2 and d["grades"]["highest"] == 80.0 and d["grades"]["lowest"] == 60.0 and d["grades"]["awaiting"] == 0
    assert {b["bucket"]: b["count"] for b in d["grades"]["distribution"]}["60-69"] == 1
    a1 = next(a for a in d["assignments"] if a["id"] == "A1")
    assert (a1["students"], a1["submitted"], a1["graded"], a1["average_grade"], a1["verification_rate"], a1["max_score"]) == (2, 2, 2, 70.0, 0.0, 50.0)
    draft = next(a for a in d["assignments"] if a["id"] == "A1d")
    assert draft["lifecycle"] == "DRAFT" and draft["submitted"] == 0
    st = {s["id"]: s for s in d["students"]}
    assert st["S2"]["recent_grades"] == [60.0] and st["S2"]["verification_rate"] == 0.0 and st["S1"]["verification_rate"] == 0.0
    sub = {(s["student_id"], s["assignment_id"]): s for s in d["submissions"]}
    assert sub[("S2", "A1")]["attempt_number"] == 2 and sub[("S2", "A1")]["verification"]["outcome"] == "NEEDS_RETRY"
    assert d["concepts"] == [{"name": "Recursion", "mastery": 0.2, "level": "Weak", "assignments": 1}]
    assert d["signals"]["by_level"]["one"] == 1 and d["signals"]["by_type"][0]["students"] == 1   # seeded R1 for S1 (an unknown code gets a generic label)
    assert len(d["trend"]) == 8 and len(d["coach_weekly"]) == 8


def test_course_insights_is_scoped_to_the_instructors_own_course(world):
    assert world.client.get(ins_url("C2"), headers=world.h("P1")).status_code == 404
    assert world.client.get(ins_url("C3"), headers=world.h("P1")).status_code == 404     # other university
    assert world.client.get(ins_url(), headers=world.h("S1")).status_code == 403
    d = world.client.get(ins_url("C2"), headers=world.h("P2")).json()
    assert {s["id"] for s in d["students"]} == {"S2"}                                      # never another course's roster
