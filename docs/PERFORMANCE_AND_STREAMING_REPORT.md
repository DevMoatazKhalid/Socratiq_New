# Performance and Streaming Report

## What "streaming" means here, and why
`/ai/coach/stream` already sent real stage events and one final payload. The Coach's reply is a single structured model output (reply, board actions, visual plan) that the validator judges as a whole, and a
deterministic final enforcement may rewrite or replace it. A prefix of an unvalidated draft cannot be proven safe (a later sentence can reveal the answer; a rewrite can contradict an earlier one), so **no draft text is ever sent**.

New contract (`backend/app/routers/ai.py`, `backend/app/streaming.py`):
`stage` (never carries reply text) -> `content_delta` (segments of the *approved* reply, `index`, `text`) -> `final` (canonical payload + `timings`) | `error`.
Order inside the server: Coach finishes -> validator/enforcement -> turn persisted **once** -> deltas -> final. Concatenated deltas equal `final.message.content` exactly (Arabic combining marks, newlines, code fences preserved; verified by tests).
The client renders deltas progressively and replaces them with the canonical message on `final` (no duplicate).

Reliability: optional `client_turn_id` (idempotency key per message, reused by the client only when retrying the *same text*). A retry of a stored turn returns the stored reply (`replayed: true`), makes no model call and writes nothing.
A disconnect before the first delta stores nothing; after it the turn is stored and the UI shows what the server holds instead of asking to resend. Double submission is still refused (409) while a turn runs.

**Honest limit:** this changes how the answer appears. It does **not** make text appear earlier: measured time-to-first-text equals total time (see below). Real time-to-first-token would need validation-safe incremental generation, which this architecture cannot guarantee.

## Instrumentation
Every stream turn records `total_ms`, `context_ms`, `graph_ms` (= provider-side time: LLM and retrieval calls), `persist_ms`, `first_text_ms`, `local_ms` (= total minus graph), and per-stage `stages[]`. They are returned in `final.timings`, logged once per turn, and aggregated
(p50/p95/mean, ok vs error counts) by an in-process recorder. Failed or client-closed turns count as non-ok.

## Measurements (all on this sandbox; none involve a real model provider)
**Full stack, real Postgres + real routers, FakeAI with 4 stages x 40 ms (=160 ms simulated provider), 25 turns** (`backend/tests/test_latency_instrumentation.py`, `BENCH_OUT`):
| metric | p50 | p95 |
|---|---|---|
| total | 168.1 ms | 173.4 ms |
| first visible text | 167.8 ms | 173.1 ms |
| context loading | 2.9 ms | 7.3 ms |
| graph (simulated provider) | 161.2 ms | 161.4 ms |
| persistence | 3.5 ms | 4.9 ms |
| backend-local (total - graph) | 6.8 ms | 12.4 ms |
Takeaway: with this small seeded database the backend's own work is ~7 ms; the model/retrieval calls are the bottleneck. Real DB size, real memory volume and real providers will differ.

**Optimisation implemented: course and student-history retrieval now run concurrently** when both are needed (they are independent). Micro-benchmark `ai/evaluation/bench_retrieval.py`, same script on the original tree and the current tree, simulated 220 ms + 120 ms lookups, 15 runs:
| tree | p50 | p95 |
|---|---|---|
| original (sequential) | 340 ms | 341 ms |
| current (concurrent) | 221 ms | 221 ms |
That is a 35% reduction **for that node**, with simulated delays. It only applies to turns where both lookups are needed. **No end-to-end median improvement against a real provider was measured, so the "20% median" target is neither claimed nor refuted.**

## Not done
Baseline-vs-final end-to-end comparison with a real provider; model selection by task / smaller models for classification (needs quality evaluation first); prompt-size and history-window tuning; caching of stable context; cancellation measurements.
Other sequential model calls (diagnose -> choose_intervention -> generate -> validate) are data-dependent and were left alone.
