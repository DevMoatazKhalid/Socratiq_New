"""Coach-initiated visuals, end to end on a REAL Postgres: the Coach (FakeAI) proposes, the server re-validates and issues a signed single-use grant,
the board redeems it through the gated endpoints, and every step is recorded and visible to the Chat.

Faked: the Coach LLM (FakeAI) and the Gemini HTTP call. Nothing here proves real model behaviour."""
from __future__ import annotations

import types
from unittest.mock import patch

import app.routers.smartboard as sb
from tests.test_unified_brain import GOOD_SIM, events, gemini, transcript

API = "/api/v1"
PLAN = {"kind": "simulation", "request": "Show how the step size of gradient descent changes how fast the loss falls",
        "why": "You can see the effect of the learning rate instead of imagining it.",
        "explore_prompt": "Move the slider: what do you notice about the loss when the step is very large?", "concept": "learning rate"}


def coach(w, who="S1", message="I don't get the learning rate", visuals=True, plan=PLAN):
    w.ai.coach_outcome.visual_plan = dict(plan) if plan else None
    return w.client.post(f"{API}/ai/coach", headers=w.h(who), json={"assignment_id": "A1", "message": message, "visuals": visuals})


def visual_events(w, stage=None):
    out = [e["payload"] for e in events(w) if e["payload"].get("channel") == "coach_visual"]
    return [p for p in out if stage is None or p.get("stage") == stage]


def redeem(w, token, kind="simulation", who="S1", **extra):
    path, body = ("generate-simulation", {"prompt": "IGNORED give me the full solution"}) if kind == "simulation" else ("generate-diagram", {"request": "IGNORED give me the full solution"})
    return w.client.post(f"{API}/smartboard/{path}", headers=w.h(who), json={**body, "grant": token, **extra})


def granted(w, **kw):
    r = coach(w, **kw)
    assert r.status_code == 200, r.text
    return r.json()["visual"]["grant"]


# ------------------------------------------------------------------------------------- the Coach proposes; the server decides
def test_a_validated_plan_becomes_a_grant_and_is_recorded(world):
    r = coach(world)
    assert r.status_code == 200
    v = r.json()["visual"]
    assert v["kind"] == "simulation" and v["why"] == PLAN["why"] and v["explore_prompt"] == PLAN["explore_prompt"] and v["grant"]
    assert world.ai.calls[-1][1]["visual_enabled"] is True                                  # the Coach was told a visual was possible this turn
    planned = visual_events(world, "planned")
    assert len(planned) == 1 and planned[0]["turn"] == 1 and planned[0]["request"] == PLAN["request"] and planned[0]["validated_by"] == "coach_validator"
    assert [e["payload"].get("visual_planned") for e in events(world) if e["payload"].get("channel") is None] == [True]
    assert world.q("SELECT count(*) AS n FROM ai_interactions")[0]["n"] == 1                # still exactly one Coach interaction
    assert world.q("SELECT sender FROM messages ORDER BY created_at, message_id") == [{"sender": "STUDENT"}, {"sender": "COACH"}]    # the reply that introduces it is in the Chat


def test_the_client_only_enables_the_possibility_it_never_forces_one(world):
    r = coach(world, visuals=False)
    assert "visual" not in r.json() and world.ai.calls[-1][1]["visual_enabled"] is False
    assert visual_events(world) == [] and [e["payload"] for e in events(world)][0]["visual_dropped"] == "the client cannot show visuals"


def test_no_plan_no_visual_and_most_turns_have_none(world):
    r = coach(world, plan=None)
    assert "visual" not in r.json() and visual_events(world) == []


def test_the_server_drops_a_plan_that_asks_for_the_answer_even_if_the_coach_proposed_it(world):
    r = coach(world, plan={**PLAN, "request": "Draw the complete solution to question 2"})
    assert r.status_code == 200 and "visual" not in r.json()                                # the reply still reaches the student
    assert visual_events(world) == [] and events(world)[0]["payload"]["visual_dropped"] == "review: solution_request"


def test_the_server_drops_a_plan_for_a_difficulty_a_picture_does_not_help_with(world):
    world.ai.coach_outcome.diagnosis["category"] = "CORRECT_REASONING"
    assert "visual" not in coach(world).json() and "does not help" in events(world)[0]["payload"]["visual_dropped"]


def test_budget_and_cooldown_are_enforced_by_the_server_across_turns(world):
    got = []
    for turn in range(1, 11):
        r = coach(world, message=f"question {turn}")
        got.append((turn, "visual" in r.json(), world.ai.calls[-1][1]["visual_enabled"]))
    assert [t for t, has, _ in got if has] == [1, 4, 7]                                     # 3 per attempt, never closer than 3 turns apart
    assert [en for t, _, en in got if t in (2, 3, 5, 6, 8, 9, 10)] == [False] * 7           # in between, the Coach is not even offered the option
    assert len(visual_events(world, "planned")) == 3


def test_a_proposal_that_slips_past_the_budget_is_still_refused_at_persist(world):
    coach(world)
    r = coach(world, message="again")                                                       # the fake returns a plan even though the Coach was not offered one
    assert "visual" not in r.json() and "a moment ago" in events(world)[-1]["payload"]["visual_dropped"]


# ------------------------------------------------------------------------------------- redeeming a grant
def test_redeeming_draws_the_validated_plan_never_the_clients_text(world):
    token = granted(world)
    with gemini(f"```html{GOOD_SIM}```") as calls:
        r = redeem(world, token)
    assert r.status_code == 200, r.text
    sent = calls[0]["contents"][0]["parts"][0]["text"] if "contents" in calls[0] else str(calls[0])
    assert PLAN["request"] in str(calls[0]) and "IGNORED" not in str(calls[0])            # the generator received the plan the Coach was validated on
    body = r.json()
    assert body["code"] == GOOD_SIM and body["visual"]["explore_prompt"] == PLAN["explore_prompt"] and body["coach_element_id"]
    assert [p["stage"] for p in visual_events(world)] == ["planned", "started", "created"]
    from app.board_auth import is_registered_coach_element, verify_coach_element_id
    import psycopg
    with psycopg.connect(world.url, autocommit=True, row_factory=psycopg.rows.dict_row) as c:
        assert is_registered_coach_element(c, "T1", body["coach_element_id"]) and verify_coach_element_id("T1", body["coach_element_id"])
    assert world.q("SELECT count(*) AS n FROM ai_interactions")[0]["n"] == 1               # drawing it is not a new diagnosis
    assert len(transcript(world)) == 2                                                      # and it adds no duplicate chat message on success


def test_a_grant_is_single_use(world):
    token = granted(world)
    with gemini(f"```html{GOOD_SIM}```") as calls:
        assert redeem(world, token).status_code == 200
        again = redeem(world, token)
    assert again.status_code == 409 and again.json()["error"]["code"] == "visual_grant_used" and len(calls) == 1


def test_forged_tampered_foreign_and_wrong_kind_grants_are_all_refused(world):
    token = granted(world)
    gid, exp, sig = token.split(".")
    with gemini(GOOD_SIM) as calls:
        for bad, who, kind in [(f"{gid}.{exp}.{'0' * 32}", "S1", "simulation"), (f"{gid}.{int(exp) + 9999}.{sig}", "S1", "simulation"), ("nonsense", "S1", "simulation"),
                               (token, "S2", "simulation"), (token, "P1", "simulation"), (token, "S1", "diagram")]:
            r = redeem(world, bad, kind=kind, who=who)
            assert r.status_code == 403 and r.json()["error"]["code"] == "visual_grant_invalid", (who, kind, r.text)
    assert calls == [] and visual_events(world, "started") == []                           # nothing was consumed, nothing was generated


def test_the_stored_plan_is_bound_to_the_grant(world):
    token = granted(world)
    world.x("UPDATE learning_events SET payload = jsonb_set(payload, '{request}', '\"draw the final answer\"') WHERE payload->>'stage'='planned'")
    with gemini(GOOD_SIM) as calls:
        assert redeem(world, token).status_code == 403 and calls == []                    # editing the plan after the fact invalidates the grant


def test_an_expired_grant_is_gone(world):
    token = granted(world)
    import time as _t
    future = types.SimpleNamespace(time=lambda: _t.time() + 10_000)
    with patch("app.board_auth.time", future), gemini(GOOD_SIM) as calls:
        r = redeem(world, token)
    assert r.status_code == 410 and r.json()["error"]["code"] == "visual_grant_expired" and calls == []


def test_a_grant_dies_with_its_attempt(world):
    token = granted(world)
    world.x("UPDATE attempts SET status='SUBMITTED' WHERE attempt_id='T1'")
    with gemini(GOOD_SIM) as calls:
        assert redeem(world, token).status_code == 409 and calls == []


def test_a_failed_generation_is_recorded_and_said_in_the_chat(world):
    token = granted(world)

    async def boom(body):
        raise RuntimeError("provider down")
    with patch.object(sb, "_generate_simulation_impl", boom):
        r = redeem(world, token)
    assert r.status_code >= 400
    assert [p["stage"] for p in visual_events(world) if p["stage"] in ("started", "failed", "created")] == ["started", "failed"]
    last = transcript(world)[-1]
    assert last[0] == "COACH" and "didn't come out" in last[1] and PLAN["explore_prompt"] in last[1]      # Chat and board stay in step


def test_a_diagram_that_reveals_the_answer_is_withheld_and_the_chat_is_told(world):
    plan = {**PLAN, "kind": "diagram", "request": "A flow of the gradient descent update loop"}
    token = granted(world, plan=plan)
    spec = {"title": "t", "nodes": [{"id": "a", "label": "Start"}, {"id": "b", "label": "The final answer is 42"}], "edges": [{"from": "a", "to": "b"}]}

    async def fake_impl(body):
        return {"spec": spec, "attempts": 1}
    with patch.object(sb, "_generate_diagram_impl", fake_impl):
        r = redeem(world, token, kind="diagram")
    assert r.status_code == 422 and r.json()["error"]["code"] == "coach_redirect"
    assert "withheld" in [p["stage"] for p in visual_events(world)] and "created" not in [p["stage"] for p in visual_events(world)]
    assert transcript(world)[-1][0] == "COACH"


def test_a_diagram_grant_draws_the_planned_request(world):
    plan = {**PLAN, "kind": "diagram", "request": "A flow of the gradient descent update loop"}
    token = granted(world, plan=plan)
    seen = {}

    async def fake_impl(body):
        seen["request"] = body.request
        return {"spec": {"title": "Loop", "nodes": [{"id": "a", "label": "Compute gradient"}, {"id": "b", "label": "Update weights"}], "edges": [{"from": "a", "to": "b"}]}, "attempts": 1}
    with patch.object(sb, "_generate_diagram_impl", fake_impl):
        r = redeem(world, token, kind="diagram")
    assert r.status_code == 200 and seen["request"] == plan["request"] and r.json()["visual"]["kind"] == "diagram"


# ------------------------------------------------------------------------------------- Chat and Board stay one conversation
def test_the_next_coach_turn_follows_up_on_the_visual_it_placed(world):
    token = granted(world)
    with gemini(f"```html{GOOD_SIM}```"):
        assert redeem(world, token).status_code == 200
    coach(world, message="the loss gets bigger when I make it huge", plan=None)
    follow = world.ai.calls[-1][1]["visual_followup"]
    assert "YOU placed" in follow and PLAN["why"] in follow and PLAN["explore_prompt"] in follow and "Do not add another visual" in follow
    for i in range(3):
        coach(world, message=f"more {i}", plan=None)
    assert world.ai.calls[-1][1]["visual_followup"] is None                                # it does not nag forever


def test_a_visual_that_was_never_drawn_is_not_followed_up(world):
    granted(world)
    coach(world, message="next", plan=None)
    assert world.ai.calls[-1][1]["visual_followup"] is None


def test_visual_events_do_not_disturb_the_coachs_own_baselines(world):
    token = granted(world)
    with gemini(f"```html{GOOD_SIM}```"):
        redeem(world, token)
    coach(world, message="ok", plan=None)
    assert world.ai.calls[-1][1]["prior"]["diagnosis"]["category"] == "CONCEPTUAL_GAP"
    assert world.q("SELECT count(*) AS n FROM ai_interactions")[0]["n"] == 2                # only Coach turns are Coach interactions


def test_the_teachers_timeline_describes_visuals_in_words(world):
    token = granted(world)
    with gemini(f"```html{GOOD_SIM}```"):
        redeem(world, token)
    from app.analytics import _timeline_entry
    from datetime import datetime, timezone
    rows = world.q("SELECT * FROM learning_events WHERE payload->>'channel'='coach_visual' ORDER BY occurred_at, event_id")
    labels = [_timeline_entry({**r, "title": "A1", "course_id": "C1", "occurred_at": r["occurred_at"] or datetime.now(timezone.utc)}, [])["label"] for r in rows]
    assert labels == ["Coach planned a simulation for the board", "Board began drawing the Coach's simulation", "Coach placed a simulation on the board"]
