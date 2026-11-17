"""Streaming helpers for the Coach SSE endpoint: safe text segmentation and latency instrumentation.

Why the reply is released AFTER validation (and after it is stored), not token by token:
the Coach's reply is one structured model output (reply + board actions + visual plan) that the validator judges as a whole, and a deterministic
last-line enforcement may rewrite or replace it. A prefix of an unvalidated draft cannot be proven safe (an answer can be revealed by a later
sentence, or a rewrite can contradict an earlier one), so no draft text is ever sent. What streams is the APPROVED text, segmented so the client
can render it progressively. This improves how the answer appears; it does not shorten the model's own time, and the timings below say so honestly.
"""
from __future__ import annotations

import statistics
import threading
import time
import unicodedata
from collections import deque
from typing import Optional

SEGMENT_CHARS = 48          # target size of one content_delta: a few words, small enough to feel continuous, large enough not to flood the connection
HARD_SPLIT_CHARS = 200      # a single token longer than this (a minified blob, a long URL) is split here


def segment_text(text: str, max_chars: int = SEGMENT_CHARS) -> list[str]:
    """Split `text` into segments whose concatenation is EXACTLY `text` (nothing added, trimmed or normalised). Splits only at whitespace
    boundaries; an over-long unbroken token is split at HARD_SPLIT_CHARS, never between a base character and its combining mark (Arabic
    diacritics) and never inside a surrogate pair (Python strings are code points)."""
    if not text:
        return []
    out: list[str] = []
    buf = ""
    i, n = 0, len(text)
    while i < n:
        j = i
        while j < n and not text[j].isspace():      # one token
            j += 1
        while j < n and text[j].isspace():          # plus its trailing whitespace (newlines survive intact)
            j += 1
        token = text[i:j]
        i = j
        while len(token) > HARD_SPLIT_CHARS:        # pathological token
            cut = HARD_SPLIT_CHARS
            while cut < len(token) and unicodedata.combining(token[cut]):
                cut += 1
            if buf:
                out.append(buf)
                buf = ""
            out.append(token[:cut])
            token = token[cut:]
        if buf and len(buf) + len(token) > max_chars:
            out.append(buf)
            buf = ""
        buf += token
    if buf:
        out.append(buf)
    return out


class StageTimer:
    """Wall-clock marks for one turn, all relative to request arrival. `provider_ms` is the time spent inside the Coach graph (LLM and retrieval
    calls dominate it); `local_ms` is everything this process did itself (context loading, persistence, streaming). The two never overlap."""

    def __init__(self, start: Optional[float] = None) -> None:
        self.t0 = start if start is not None else time.perf_counter()
        self._last = self.t0
        self.stages: list[dict] = []
        self.marks: dict[str, float] = {}

    def _now(self) -> float:
        return time.perf_counter()

    def mark(self, name: str) -> None:
        self.marks[name] = (self._now() - self.t0) * 1000

    def stage(self, name: str) -> float:
        """A graph node finished: its duration is the time since the previous stage event."""
        now = self._now()
        ms = (now - self._last) * 1000
        self._last = now
        self.stages.append({"stage": name, "ms": round(ms, 1)})
        return ms

    def reset_stage_clock(self) -> None:
        self._last = self._now()

    def finish(self) -> dict:
        total = (self._now() - self.t0) * 1000
        ctx = self.marks.get("context_loaded", 0.0)
        graph_ms = sum(s["ms"] for s in self.stages if s["stage"] != "start")
        persist = self.marks.get("persisted", ctx + graph_ms) - (ctx + graph_ms)
        return {"total_ms": round(total, 1), "context_ms": round(ctx, 1), "graph_ms": round(graph_ms, 1), "persist_ms": round(max(persist, 0.0), 1),
                "first_text_ms": round(self.marks["first_text"], 1) if "first_text" in self.marks else None,
                "provider_ms": round(graph_ms, 1), "local_ms": round(max(total - graph_ms, 0.0), 1), "stages": self.stages}


class LatencyRecorder:
    """Process-local ring buffer of recent turn timings; the benchmark and the logs read p50/p95 from it. Not a metrics backend."""

    def __init__(self, size: int = 500) -> None:
        self._rows: deque[dict] = deque(maxlen=size)
        self._lock = threading.Lock()

    def record(self, timings: dict, *, outcome: str = "ok") -> None:
        with self._lock:
            self._rows.append({**{k: v for k, v in timings.items() if k != "stages"}, "outcome": outcome})

    def clear(self) -> None:
        with self._lock:
            self._rows.clear()

    def summary(self) -> dict:
        with self._lock:
            rows = list(self._rows)
        ok = [r for r in rows if r["outcome"] == "ok"]
        out: dict = {"n": len(rows), "ok": len(ok), "errors": len(rows) - len(ok)}
        for key in ("total_ms", "first_text_ms", "context_ms", "graph_ms", "persist_ms", "local_ms"):
            vals = sorted(float(r[key]) for r in ok if r.get(key) is not None)
            if vals:
                p95 = vals[min(len(vals) - 1, max(0, int(round(0.95 * (len(vals) - 1)))))]
                out[key] = {"p50": round(statistics.median(vals), 1), "p95": round(p95, 1), "mean": round(statistics.fmean(vals), 1)}
        return out


LATENCY = LatencyRecorder()
