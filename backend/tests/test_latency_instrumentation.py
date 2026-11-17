"""Latency instrumentation on the real stack (real Postgres + routers; the provider is a FakeAI with a configurable delay per stage).

What this measures: everything the BACKEND does itself (context loading, persistence, streaming) versus time inside the Coach graph. It does NOT measure a
real model provider. Set BENCH_OUT=<file> to write the summary as JSON (used for the performance report)."""
from __future__ import annotations

import json
import os
import time

from app.ratelimit import reset_limits
from app.streaming import LATENCY

from .test_coach_stream import _events, _post

STAGE_DELAY = 0.04


def _slow(world):
    orig = world.ai.coach_turn_stream

    def slow(**kw):
        for item in orig(**kw):
            if item[0] == "stage":
                time.sleep(STAGE_DELAY)
            yield item
    world.ai.coach_turn_stream = slow


def test_timings_separate_provider_time_from_local_time_and_aggregate(world):
    _slow(world)
    LATENCY.clear()
    n = 25
    finals = []
    for i in range(n):
        reset_limits()                                                                    # this measures latency, not the per-student rate limit
        ev = _events(_post(world, msg=f"question {i}"))
        assert ev[-1][0] == "final"
        finals.append(ev[-1][1]["timings"])
    t = finals[-1]
    assert t["graph_ms"] >= 4 * STAGE_DELAY * 1000 * 0.9                                  # the four fake stages' delay is inside the graph time
    assert t["local_ms"] < t["total_ms"] and t["context_ms"] > 0 and t["persist_ms"] >= 0
    assert 0 < t["first_text_ms"] <= t["total_ms"]
    s = LATENCY.summary()
    assert s["n"] == n and s["ok"] == n and s["errors"] == 0
    for k in ("total_ms", "first_text_ms", "context_ms", "graph_ms", "persist_ms", "local_ms"):
        assert s[k]["p50"] <= s[k]["p95"] and s[k]["mean"] > 0
    assert s["local_ms"]["p50"] < s["graph_ms"]["p50"]                                   # with a 160 ms provider the backend's own share is the smaller part
    if os.environ.get("BENCH_OUT"):
        with open(os.environ["BENCH_OUT"], "w") as f:
            json.dump({"turns": n, "simulated_provider_ms_per_turn": 4 * STAGE_DELAY * 1000, "summary": s}, f, indent=2)


def test_failed_turns_are_counted_as_errors_not_successes(world):
    LATENCY.clear()
    world.ai.fail = True
    _events(_post(world))
    world.ai.fail = False
    _events(_post(world))
    s = LATENCY.summary()
    assert s["n"] == 2 and s["ok"] == 1 and s["errors"] == 1
