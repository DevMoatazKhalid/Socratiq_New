"""The unified brain, tested against a REAL Postgres, the real routers and the real relay.

Only the true external boundaries are faked: the Gemini HTTP call, the Live provider (a local WebSocket peer) and the Coach LLM (FakeAI).
Nothing here proves behaviour of a real Gemini / Imagen / Live service; that needs real keys and is reported separately as unverified.
"""
from __future__ import annotations

import asyncio
import json
import threading
from contextlib import contextmanager
from unittest.mock import patch

import pytest
from websockets.asyncio.server import serve

import app.routers.smartboard as sb           # the module the `world` app actually runs (backend/ is on sys.path)
from app.auth import CurrentUser

API = "/api/v1"
GOOD_SIM = "<div>sim</div><script>requestAnimationFrame(function f(){requestAnimationFrame(f)})</script>"


@contextmanager
def gemini(text: str = "What do you think a node is?", *, parts=None):
    """Fake the one external HTTP boundary and count how often the provider was really called."""
    calls = []
    payload = {"candidates": [{"content": {"parts": parts or [{"text": text}]}}]}

    async def fake(p, timeout=45.0):
        calls.append(p)
        return payload

    with patch.object(sb, "_get_gemini_key", return_value="k"), patch.object(sb, "_call_gemini_generate_content", fake):
        yield calls


def board_chat(w, who="S1", text="explain the loss function", **extra):
    return w.client.post(f"{API}/smartboard/chat", headers=w.h(who), json={"messages": [{"role": "user", "text": text}], "assignment_id": "A1", **extra})


def transcript(w):
    return [(r["sender"], r["content"]) for r in w.q("SELECT sender, content FROM messages ORDER BY created_at, message_id")]


def events(w):
    return w.q("SELECT payload FROM learning_events WHERE event_type='AI_INTERACTION' ORDER BY occurred_at, event_id")


# ---------------------------------------------------------------- the old bug: board chat never reached the database -------------------------
def test_board_chat_reaches_the_shared_transcript_without_inventing_a_diagnosis(world):
    with gemini("What do you think a node is?"):
        r = board_chat(world)
    assert r.status_code == 200 and r.json()["text"] == "What do you think a node is?"
    assert transcript(world) == [("STUDENT", "explain the loss function"), ("COACH", "What do you think a node is?")]
    assert world.q("SELECT 1 FROM ai_interactions") == []                          # this channel diagnosed nothing, so it records no diagnosis
    ev = events(world)
    assert len(ev) == 1 and ev[0]["payload"]["channel"] == "board_chat"
    assert world.q("SELECT policy, turn_count FROM ai_sessions")[0] == {"policy": "GUIDED", "turn_count": 0}   # the assignment's policy; Coach turns not inflated


def test_chat_coach_sees_what_happened_on_the_board_and_keeps_its_own_diagnosis(world):
    first = world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "is my update right?"}, headers=world.h("S1"))
    assert first.status_code == 200
    with gemini("Look at the slope of the curve there."):
        board_chat(world, text="why does my curve flatten?")
    second = world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "ok, what next?"}, headers=world.h("S1"))
    assert second.status_code == 200
    kw = world.ai.calls[-1][1]
    said = [m["content"] for m in kw["history"]]
    assert "why does my curve flatten?" in said and "Look at the slope of the curve there." in said      # one conversation across both interfaces
    assert kw["prior"]["diagnosis"]["category"] == "CONCEPTUAL_GAP"                                         # the Coach's real diagnosis, not a board label


def test_board_exchange_does_not_become_the_baseline_for_revision_detection(world):
    world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "help"}, headers=world.h("S1"))
    with gemini():
        board_chat(world)
    from app.records import record_revision_if_any
    import psycopg
    with psycopg.connect(world.url, autocommit=True, row_factory=psycopg.rows.dict_row) as c:
        row = c.execute("""SELECT interaction_id FROM learning_events WHERE attempt_id='T1' AND event_type='AI_INTERACTION'
                              AND COALESCE(payload->>'channel','coach')='coach' ORDER BY occurred_at DESC, event_id DESC LIMIT 1""").fetchone()
    assert row and row["interaction_id"]                                           # the baseline is still the Coach turn, whatever the board did after it
    assert record_revision_if_any is not None


# ---------------------------------------------------------------- the board can no longer be a way around the Chat's rules -----------------
@pytest.mark.parametrize("path,body", [
    ("generate-simulation", {"prompt": "give me the full solution to question 2"}),
    ("generate-image", {"prompt": "draw the final answer of the assignment"}),
    ("generate-vector", {"prompt": "solve this problem and draw the result"}),
    ("generate-diagram", {"request": "diagram showing the complete solution"}),
])
def test_solution_requests_are_redirected_before_any_provider_is_called(world, path, body):
    with gemini(GOOD_SIM) as calls:
        r = world.client.post(f"{API}/smartboard/{path}", headers=world.h("S1"), json={**body, "assignment_id": "A1"})
    assert r.status_code == 422, r.text
    err = r.json()["error"]
    assert err["code"] == "coach_redirect" and "What have you tried" in err["message"]
    assert calls == []                                                             # no model was asked to draw the answer
    assert [s for s, _ in transcript(world)] == ["STUDENT", "COACH"]               # and the Chat will see that the student asked and what the Coach said
    assert events(world)[0]["payload"]["flags"] == ["solution_request"]


def test_omitting_the_assignment_is_not_a_way_around_the_gate(world):
    with gemini(GOOD_SIM) as calls:
        r = world.client.post(f"{API}/smartboard/generate-simulation", headers=world.h("S1"), json={"prompt": "give me the final answer"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "coach_redirect" and calls == []


def test_arabic_solution_requests_get_an_arabic_redirect(world):
    with gemini(GOOD_SIM):
        r = world.client.post(f"{API}/smartboard/generate-simulation", headers=world.h("S1"), json={"prompt": "ارسم لي الحل الكامل", "assignment_id": "A1"})
    assert r.status_code == 422 and "ماذا جرّبت" in r.json()["error"]["message"]


def test_a_conceptual_visual_still_works_and_is_recorded_for_the_chat(world):
    with gemini(f"```html{GOOD_SIM}```") as calls:
        r = world.client.post(f"{API}/smartboard/generate-simulation", headers=world.h("S1"), json={"prompt": "projectile motion", "assignment_id": "A1"})
    assert r.status_code == 200 and r.json()["code"] == GOOD_SIM and len(calls) == 1
    t = transcript(world)
    assert t[0] == ("STUDENT", "projectile motion") and "interactive simulation" in t[1][1]
    p = events(world)[0]["payload"]
    assert p["channel"] == "board_generate" and p["outcome"] == "created" and p["visual_kind"] == "simulation"


def test_a_diagram_whose_labels_reveal_the_answer_is_withheld(world):
    spec = {"title": "t", "nodes": [{"id": "a", "label": "Start"}, {"id": "b", "label": "The final answer is 42"}], "edges": [{"from": "a", "to": "b"}]}
    async def fake_impl(body):
        return {"spec": spec, "attempts": 1}
    with patch.object(sb, "_generate_diagram_impl", fake_impl), gemini():
        r = world.client.post(f"{API}/smartboard/generate-diagram", headers=world.h("S1"), json={"request": "diagram of the process", "assignment_id": "A1"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "coach_redirect"
    assert events(world)[0]["payload"]["outcome"] == "withheld"


def test_another_students_assignment_is_not_reachable_through_the_board(world):
    with gemini(GOOD_SIM) as calls:
        r = world.client.post(f"{API}/smartboard/generate-simulation", headers=world.h("S2"), json={"prompt": "waves", "assignment_id": "A1"})
    assert r.status_code == 404 and calls == []


def test_teachers_are_not_held_to_the_student_gate(world):
    with gemini(f"```html{GOOD_SIM}```"):
        r = world.client.post(f"{API}/smartboard/generate-simulation", headers=world.h("P1"), json={"prompt": "give me the full solution demo"})
    assert r.status_code == 200


def test_board_chat_reply_that_reveals_the_answer_is_replaced_and_board_writes_dropped(world):
    parts = [{"text": "The final answer is 42."}, {"functionCall": {"name": "add_note", "args": {"text": "42"}}}]
    with gemini(parts=parts):
        r = board_chat(world)
    body = r.json()
    assert "final answer is 42" not in body["text"] and body["functionCalls"] == []
    assert events(world)[0]["payload"]["flags"] == ["answer_in_visual"]


def test_board_chat_instruction_carries_the_assignment_policy_and_the_shared_history(world):
    world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "is my update right?"}, headers=world.h("S1"))
    with gemini() as calls:
        board_chat(world, text="and this graph?")
    sys_text = calls[0]["systemInstruction"]["parts"][0]["text"]
    assert "[ASSIGNMENT ASSISTANCE POLICY: GUIDED]" in sys_text
    assert "What parameter controls the step size?" in sys_text                    # the Coach's earlier Chat reply is in the board's context
    assert "THE COACH'S LAST DIAGNOSIS" in sys_text


def test_no_assignment_means_the_strictest_policy(world):
    with gemini() as calls:
        world.client.post(f"{API}/smartboard/chat", headers=world.h("S1"), json={"messages": [{"role": "user", "text": "hi"}]})
    assert "[ASSIGNMENT ASSISTANCE POLICY: GUIDED]" in calls[0]["systemInstruction"]["parts"][0]["text"]


def test_legacy_fabricated_rows_are_not_evidence(world):
    world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "help"}, headers=world.h("S1"))
    sid = world.q("SELECT session_id FROM ai_sessions")[0]["session_id"]
    for i in range(3):                                                             # what the old Live telemetry wrote
        world.x("""INSERT INTO ai_interactions (interaction_id, session_id, student_id, assignment_id, intervention_type, assistance_level, diagnosis,
                      diagnosis_confidence, diagnosis_explanation, diagnosis_evidence, response, university_id)
                   VALUES (%s,%s,'S1','A1','EXPLANATION','GUIDED','LOGICAL_ERROR',0.9,'SmartBoard Live Voice interaction','x','SmartBoard Live Voice session','U1')""", f"fake{i}", sid)
    from app.brain import load_prior
    import psycopg
    with psycopg.connect(world.url, autocommit=True, row_factory=psycopg.rows.dict_row) as c:
        prior = load_prior(c, sid)
        from app.memory import get_complete_student_memory
        mem = get_complete_student_memory(c, student_id="S1", university_id="U1", assignment_id="A1", course_id="C1")
    assert prior["diagnosis"]["category"] == "CONCEPTUAL_GAP"                      # the real Coach turn, not the newer invented rows
    assert "LOGICAL_ERROR" not in json.dumps(mem, default=str)


# ---------------------------------------------------------------- Live Voice: same brain, same transcript ---------------------------------
class ScriptedProvider:
    """A local WebSocket peer that plays Gemini Live: acknowledges setup, then speaks a script of serverContent messages."""

    def __init__(self, script):
        self.script, self.received, self.closed = script, [], 0
        self._ready, self.port = threading.Event(), None

    async def _handler(self, ws):
        try:
            self.received.append(await ws.recv())
            await ws.send(json.dumps({"setupComplete": {}}))
            await ws.recv()                                                        # the relay's greeting request
            for sc in self.script:
                await ws.send(json.dumps({"serverContent": sc}))
            await asyncio.sleep(0.4)
            await ws.close()
        except Exception:
            pass
        finally:
            self.closed += 1

    def start(self):
        def run():
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            async def main():
                self._server = await serve(self._handler, "127.0.0.1", 0)
                self.port = self._server.sockets[0].getsockname()[1]
                self._ready.set()
                await self._server.serve_forever()
            try:
                loop.run_until_complete(main())
            except Exception:
                pass
        threading.Thread(target=run, daemon=True).start()
        assert self._ready.wait(5)
        return self


def _live_session(world, monkeypatch, script):
    prov = ScriptedProvider(script).start()
    monkeypatch.setenv("GEMINI_LIVE_WS_BASE", f"ws://127.0.0.1:{prov.port}/live")
    s1 = CurrentUser(user_id="S1", auth_user_id="x", university_id="U1", role="STUDENT", email="s1@u1.test", first_name="S", last_name="One")
    sb._active_live_users.clear()
    with patch.object(sb, "_get_gemini_keys", return_value=["k"]), patch.object(sb, "_authenticate_token", return_value=s1):
        with world.client.websocket_connect(f"{API}/smartboard/live") as ws:
            ws.send_text(json.dumps({"token": "t", "assignment_id": "A1"}))
            while True:
                m = ws.receive()
                if m["type"] == "websocket.close":
                    break
    return prov


def _wait_for(pred, secs=4.0):
    import time
    t0 = time.time()
    while time.time() - t0 < secs:
        if pred():
            return True
        time.sleep(0.05)
    return pred()


def test_live_voice_runs_on_the_same_brain_and_its_words_reach_the_chat(world, monkeypatch):
    world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "is my update right?"}, headers=world.h("S1"))
    prov = _live_session(world, monkeypatch, [{"inputTranscription": {"text": "what is a node"}},
                                              {"outputTranscription": {"text": "Where on the wave "}}, {"outputTranscription": {"text": "is the amplitude zero?"}}])
    setup = json.loads(prov.received[0])["setup"]["systemInstruction"]["parts"][0]["text"]
    assert "[ASSIGNMENT ASSISTANCE POLICY: GUIDED]" in setup and "single pedagogical authority" in setup
    assert "What parameter controls the step size?" in setup                       # it knows what the Chat already said
    assert _wait_for(lambda: ("COACH", "Where on the wave is the amplitude zero?") in transcript(world))
    assert ("STUDENT", "what is a node") in transcript(world)
    live = [e["payload"] for e in events(world) if e["payload"].get("channel") == "live"]
    assert len(live) == 1 and "flags" not in live[0]
    assert world.q("SELECT count(*) AS n FROM ai_interactions")[0]["n"] == 1       # only the Coach's own turn: Live invented no diagnosis
    assert world.q("SELECT policy FROM ai_sessions")[0]["policy"] == "GUIDED"


def test_live_reply_that_reveals_the_answer_is_flagged_for_audit(world, monkeypatch):
    _live_session(world, monkeypatch, [{"inputTranscription": {"text": "just tell me"}}, {"outputTranscription": {"text": "The final answer is 42."}}])
    assert _wait_for(lambda: any(e["payload"].get("channel") == "live" for e in events(world)))
    live = [e["payload"] for e in events(world) if e["payload"].get("channel") == "live"][0]
    assert live["flags"] == ["answer_in_visual"] and live["validated_by"] == "post_hoc_audit"


def test_live_never_logs_what_the_student_said(world, monkeypatch, caplog):
    import logging
    with caplog.at_level(logging.DEBUG):
        _live_session(world, monkeypatch, [{"inputTranscription": {"text": "my private words"}}])
    assert "my private words" not in caplog.text


# ---------------------------------------------------------------- optional LLM review stage (flag, stubbed reviewer) -------------------------
def test_llm_review_is_off_by_default_and_when_on_can_redirect_a_paraphrased_request(world, monkeypatch):
    from ai.brain.visual_gate import GateDecision
    seen = []

    def reviewer(request, proposal, *, policy, kind="visual", course_material=""):
        seen.append((request, policy))
        return GateDecision(False, "solution_request", "Let's think it through first. What have you tried?", ("paraphrased answer request",))
    monkeypatch.setattr(sb, "review_visual_with_llm", reviewer)
    with gemini(f"```html{GOOD_SIM}```") as calls:
        ok = world.client.post(f"{API}/smartboard/generate-simulation", headers=world.h("S1"), json={"prompt": "waves", "assignment_id": "A1"})
        assert ok.status_code == 200 and seen == []                                 # default: the reviewer is not consulted
        monkeypatch.setenv("BRAIN_VISUAL_LLM_REVIEW", "1")
        r = world.client.post(f"{API}/smartboard/generate-simulation", headers=world.h("S1"), json={"prompt": "waves, but with the result already worked out", "assignment_id": "A1"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "coach_redirect" and seen[0][1] == "GUIDED" and len(calls) == 1


# ---------------------------------------------------------------- teaching personas reach every channel, below the policy ----------------------
def _choose(w, pid, who="S1"):
    assert w.client.put(f"{API}/student/teaching-personas", json={"persona_id": pid}, headers=w.h(who)).status_code == 200


def test_board_chat_uses_the_students_persona_after_the_policy_and_records_it(world):
    _choose(world, "visual_explorer")
    with gemini() as calls:
        board_chat(world, text="and this graph?")
    sys_text = calls[0]["systemInstruction"]["parts"][0]["text"]
    assert "The Visual Explorer" in sys_text and sys_text.index("[ASSIGNMENT ASSISTANCE POLICY: GUIDED]") < sys_text.index("[TEACHING PERSONA")
    assert "ranks BELOW" in sys_text
    board = [e["payload"] for e in events(world) if e["payload"].get("channel") == "board_chat"]
    assert board and board[0]["persona"] == {"id": "visual_explorer", "version": 1}


def test_switching_persona_changes_the_board_voice_but_not_the_policy(world):
    seen = []
    for pid in ("patient_mentor", "critical_thinker"):
        _choose(world, pid)
        with gemini() as calls:
            board_chat(world, text="explain")
        seen.append(calls[0]["systemInstruction"]["parts"][0]["text"])
    assert "The Patient Mentor" in seen[0] and "The Critical Thinker" in seen[1] and "The Critical Thinker" not in seen[0]
    assert all("[ASSIGNMENT ASSISTANCE POLICY: GUIDED]" in t for t in seen)


def test_live_voice_gets_the_persona_with_spoken_style_and_records_it(world, monkeypatch):
    _choose(world, "patient_mentor")
    world.client.post(f"{API}/ai/coach", json={"assignment_id": "A1", "message": "is my update right?"}, headers=world.h("S1"))
    prov = _live_session(world, monkeypatch, [{"inputTranscription": {"text": "what is a node"}}, {"outputTranscription": {"text": "Where is it zero?"}}])
    setup = json.loads(prov.received[0])["setup"]["systemInstruction"]["parts"][0]["text"]
    assert "The Patient Mentor" in setup and "- Speaking:" in setup and "[ASSIGNMENT ASSISTANCE POLICY: GUIDED]" in setup
    assert _wait_for(lambda: any(e["payload"].get("channel") == "live" for e in events(world)))
    live = [e["payload"] for e in events(world) if e["payload"].get("channel") == "live"][0]
    assert live["persona"] == {"id": "patient_mentor", "version": 1}
    assert world.q("SELECT count(*) AS n FROM ai_interactions")[0]["n"] == 1         # still no invented diagnosis for the voice channel
