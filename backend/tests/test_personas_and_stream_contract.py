"""Persona API + persistence + attribution, and the streaming/idempotency contract. Real Postgres and routers; only the LLM is faked."""
from __future__ import annotations

import json

from app.streaming import segment_text

from .helpers import API
from .test_coach_stream import _events, _post

P = f"{API}/student/teaching-personas"
COACH = f"{API}/ai/coach"
STREAM = f"{API}/ai/coach/stream"


def _put(w, pid, who="S1", **extra):
    return w.client.put(P, json={"persona_id": pid, **extra}, headers=w.h(who))


# ------------------------------------------------------------------ selection and persistence
def test_default_persona_listing(world):
    r = world.client.get(P, headers=world.h("S1"))
    assert r.status_code == 200
    j = r.json()
    assert j["selected"]["id"] == "socratic_guide" and len(j["personas"]) == 5 and j["default"] == "socratic_guide"
    assert all(p["name"]["ar"] and p["name"]["en"] for p in j["personas"])


def test_selection_survives_reload_and_is_per_student(world):
    assert _put(world, "visual_explorer").json()["selected"]["id"] == "visual_explorer"
    assert world.client.get(P, headers=world.h("S1")).json()["selected"]["id"] == "visual_explorer"       # "reload"
    assert world.client.get(P, headers=world.h("S2")).json()["selected"]["id"] == "socratic_guide"         # another student is untouched
    assert world.q("select teaching_persona, persona_version from student_preferences") == [{"teaching_persona": "visual_explorer", "persona_version": 1}]


def test_unknown_or_malformed_persona_is_rejected_and_changes_nothing(world):
    _put(world, "patient_mentor")
    for bad in ("nope", "Bad-Id", "x", "a" * 80, "socratic_guide; drop table"):
        assert _put(world, bad).status_code in (400, 422)
    assert world.client.get(P, headers=world.h("S1")).json()["selected"]["id"] == "patient_mentor"


def test_persona_endpoints_require_a_student_and_a_visible_assignment(world):
    assert world.client.get(P).status_code in (401, 403)
    assert world.client.put(P, json={"persona_id": "patient_mentor"}).status_code in (401, 403)
    assert _put(world, "patient_mentor", assignment_id="NO_SUCH").status_code == 404


# ------------------------------------------------------------------ persona reaches the Coach, and switching mid-session keeps everything
def test_persona_is_passed_to_the_coach_and_recorded_per_turn(world):
    _put(world, "practical_engineer")
    assert _post_plain(world).status_code == 200
    assert world.ai.calls[-1][1]["persona_id"] == "practical_engineer"
    row = world.q("select persona_id, persona_version, diagnosis_concept from ai_interactions")[0]
    assert row == {"persona_id": "practical_engineer", "persona_version": 1, "diagnosis_concept": "learning rate"}
    ev = world.q("select payload from learning_events where interaction_id is not null")[0]["payload"]
    assert ev["persona"] == {"id": "practical_engineer", "version": 1}


def _post_plain(w, msg="is my update right?", who="S1", **extra):
    return w.client.post(COACH, json={"assignment_id": "A1", "message": msg, **extra}, headers=w.h(who))


def test_switching_persona_mid_session_keeps_session_transcript_and_policy(world):
    _put(world, "socratic_guide")
    _post_plain(world, "first question")
    sess_before = world.q("select session_id, turn_count from ai_sessions")
    msgs_before = world.q("select message_id from messages order by created_at")
    _put(world, "critical_thinker", assignment_id="A1")
    r = _post_plain(world, "second question")
    assert r.status_code == 200
    assert world.q("select count(*) n from ai_sessions")[0]["n"] == 1                                       # same session
    assert world.q("select session_id from ai_sessions")[0]["session_id"] == sess_before[0]["session_id"]
    assert [m["message_id"] for m in world.q("select message_id from messages order by created_at")][:len(msgs_before)] == [m["message_id"] for m in msgs_before]
    assert world.q("select persona_id from ai_interactions order by created_at") == [{"persona_id": "socratic_guide"}, {"persona_id": "critical_thinker"}]
    coach_calls = [kw for n, kw in world.ai.calls if n == "coach"]
    assert [c["persona_id"] for c in coach_calls] == ["socratic_guide", "critical_thinker"]
    assert coach_calls[0]["policy"] == coach_calls[1]["policy"]                                             # persona never touches the policy
    changes = world.q("select payload from learning_events where payload->>'channel'='persona'")
    assert len(changes) == 1 and changes[0]["payload"]["persona"]["id"] == "critical_thinker" and changes[0]["payload"]["from"]["id"] == "socratic_guide"


def test_reselecting_the_same_persona_records_nothing(world):
    _post_plain(world)
    _put(world, "patient_mentor", assignment_id="A1")
    _put(world, "patient_mentor", assignment_id="A1")
    assert world.q("select count(*) n from learning_events where payload->>'channel'='persona'")[0]["n"] == 1


def test_persona_switch_never_resets_learning_memory(world):
    _post_plain(world)
    ev_before = world.q("select count(*) n from evidence_candidates")[0]["n"]
    _put(world, "visual_explorer")
    assert world.q("select count(*) n from evidence_candidates")[0]["n"] == ev_before >= 1


# ------------------------------------------------------------------ streaming contract
def test_stream_timings_and_provider_local_split(world):
    final = _events(_post(world))[-1][1]
    t = final["timings"]
    assert t["total_ms"] >= t["context_ms"] >= 0 and t["first_text_ms"] is not None and t["first_text_ms"] <= t["total_ms"]
    assert round(t["provider_ms"] + t["local_ms"], 0) >= round(t["total_ms"] - 1, 0) and [s["stage"] for s in t["stages"]][:2] == ["understand_context", "diagnose"]


def test_stream_preserves_arabic_markdown_and_code_exactly(world):
    text = "اشرح **معدل التعلّم** أولاً.\n\n```python\nfor i in range(3):\n    print(i)\n```\n\nثم جرّب: $\\theta = \\theta - \\alpha g$"
    world.ai.coach_outcome.response = text
    ev = _events(_post(world))
    assert "".join(d["text"] for n, d in ev if n == "content_delta") == text == ev[-1][1]["message"]["content"]
    assert world.q("select response from ai_interactions")[0]["response"] == text


def test_failed_ai_stores_nothing_and_streams_an_error(world):
    world.ai.fail = True
    ev = _events(_post(world))
    assert [n for n, _ in ev][-1] == "error" and "content_delta" not in [n for n, _ in ev] and "final" not in [n for n, _ in ev]
    assert world.q("select count(*) n from ai_interactions")[0]["n"] == 0 and world.q("select count(*) n from messages")[0]["n"] == 0


# ------------------------------------------------------------------ idempotent retry
def test_retry_with_the_same_client_turn_id_returns_the_stored_reply_once(world):
    key = "turn-0001-abcdef"
    first = _post_plain(world, client_turn_id=key).json()
    n_calls = len(world.ai.calls)
    again = _post_plain(world, client_turn_id=key).json()
    assert again["replayed"] is True and again["message"]["content"] == first["message"]["content"] and again["message"]["id"] == first["message"]["id"]
    assert len(world.ai.calls) == n_calls                                                                    # no second model call
    assert world.q("select count(*) n from ai_interactions")[0]["n"] == 1
    assert world.q("select count(*) n from messages")[0]["n"] == 2                                           # one student message, one coach message
    assert world.q("select turn_count from ai_sessions")[0]["turn_count"] == 1


def test_stream_retry_replays_as_deltas_without_a_second_write(world):
    key = "turn-0002-abcdef"
    r1 = world.client.post(STREAM, json={"assignment_id": "A1", "message": "hi there", "client_turn_id": key}, headers=world.h("S1"))
    r2 = world.client.post(STREAM, json={"assignment_id": "A1", "message": "hi there", "client_turn_id": key}, headers=world.h("S1"))
    e1, e2 = _events(r1), _events(r2)
    assert e2[-1][1]["replayed"] is True and "".join(d["text"] for n, d in e2 if n == "content_delta") == e1[-1][1]["message"]["content"]
    assert world.q("select count(*) n from ai_interactions")[0]["n"] == 1


def test_same_key_from_another_student_never_replays_or_leaks(world):
    key = "turn-0003-abcdef"
    first = _post_plain(world, client_turn_id=key).json()
    r = _post_plain(world, who="S2", client_turn_id=key)                       # S2 is not enrolled in this classroom
    assert r.status_code == 404 and first["message"]["content"] not in r.text
    assert world.q("select count(*) n from ai_interactions")[0]["n"] == 1


def test_bad_client_turn_id_is_rejected(world):
    assert _post_plain(world, client_turn_id="has spaces!").status_code == 422


# ------------------------------------------------------------------ segmentation (pure)
def test_segments_concatenate_exactly_and_respect_boundaries():
    for text in ["", "a", "hello  world\n\nnext", "مرحبا بالعالم " * 40, "x" * 1000, "```py\n" + "y = 1\n" * 50 + "```", "عَرَبِيّ" * 80, "😀 " * 100]:
        segs = segment_text(text)
        assert "".join(segs) == text and all(segs)
    assert all(len(s) <= 200 for s in segment_text("x" * 1000)) and len(segment_text("word " * 100)) > 5


def test_segments_never_split_a_combining_mark_from_its_base():
    import unicodedata
    text = "ب" + "ً" * 3 + "ا" * 600
    for s in segment_text(text):
        assert not unicodedata.combining(s[0]) or s is segment_text(text)[0]
