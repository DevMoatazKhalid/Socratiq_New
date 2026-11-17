# Release verification report

## Verdict

**Not release-ready as a whole. Ready for further review/staging with the blockers below.** The SmartBoard code paths that could be exercised locally behave correctly and are tested. Four things stand between this archive and a production release: unresolved dependency advisories, no real-provider verification, unverified Realtime/real-JWT, and areas that were never audited (graphs/function plots, LaTeX).

## Acceptance criteria

Status: **VERIFIED** (real browser/real DB evidence) - **VERIFIED (stand-in)** (real code against a local fake provider) - **PARTIAL** - **UNVERIFIED** - **NOT AUDITED**.

| Capability | Status | Evidence and limits |
|---|---|---|
| Board UI controls | **VERIFIED (partial coverage)** | 59 control assertions (inventory A+B) incl. all toolbar tools, undo/redo, zoom, menu, dialogs, panels, AI bar, mobile touch. Not driven: "More tools" contents, image-upload dialog, opacity/fill/sloppiness/edge/layer buttons, RTL, screen readers. See the inventory's gap list. |
| Drawing | **VERIFIED** | Rectangle, diamond, ellipse, arrow, line, pencil, text; select/move, copy/paste, delete, eraser, undo/redo, zoom; persisted and reloaded from the DB. Mobile touch stroke saved. No dedicated highlighter tool exists on the native board. |
| Text | **PARTIAL** | Typing, content persisted exactly, edit path used by the toolbar. The reported "typing failure" was **not reproduced**. LaTeX/MathJax on the native board **not audited**. |
| Diagrams | **VERIFIED (stand-in) / PARTIAL** | Flowchart rendered, labels readable, arrows bound and now ending on shapes, AI vs student authorship distinct, persisted and reloaded. Geometry unit-tested for 7 diagram kinds; only the flowchart was inspected visually/in the DB. Overlap/clipping across kinds not systematically reviewed. |
| Graphs / function plots / charts | **NOT AUDITED** | Not exercised. |
| Images | **VERIFIED (stand-in)** | Validation, insertion, persistence (binary in DB), reload, honest failure, malicious-payload rejection. **No real provider call.** |
| Simulations | **VERIFIED (stand-in for generation)** | Animate, sliders/buttons/pause/resume/reset, sandbox escape attempts blocked, runaway loops bounded (<= ~1.5 s freeze), pin to board with persistent card, reload, reopen, second session, production build. Real model output untested; Tailwind/MathJax CDNs not loaded in tests. |
| Live Voice | **VERIFIED (stand-in)** | Real relay + browser + fake microphone: auth, origin, server-owned setup, audio flow, end reasons, cleanup, drop handling, mic unavailable. **No real Gemini Live session**; audible playback and real barge-in untested. |
| Coach as single authority | **PARTIAL** | Server instruction is authoritative on `/chat` and Live; cross-student isolation of the Coach prompt tested end to end. Coach graph internals, memory update/delete lifecycle, and real-model behaviour not audited. |
| Persistence | **VERIFIED** | Confirmed-before-"Saved", ordered saves, revision conflicts, 6-way race (one winner), outage and recovery, leave-page veto, 1,800-element board. |
| Realtime | **UNVERIFIED** | No Realtime server locally; client hook fixed and unit-tested only. Sync across sessions works through reload/409, not push. |
| Security | **PARTIAL - blockers open** | Critical open-proxy hole fixed; key handling, sandbox, validators, isolation verified. **71 Python advisories and 13 npm advisories remain** (audit report O1/O2). No SAST. Real JWT verification not exercised. |
| Performance | **VERIFIED (limits stated)** | 1,800 elements load in ~2.4-3.6 s; heap flat across 4 reloads; stroke +6% vs empty board (headless software rendering inflates absolute times). |
| Browser E2E (student and teacher) | **VERIFIED (Chromium only)** | 194/194 recorded assertions; student, teacher, failure journeys; dev and production builds. |

## Release blockers

1. **B1: Known vulnerabilities in the AI stack and FastAPI/Starlette** (71 advisories / 8 packages). Needs a planned major upgrade and a full AI regression pass.
2. **B2: Real-provider verification** of image generation, simulation generation and Gemini Live (see `REAL_PROVIDER_AND_BLOCKED.md`).
3. **B3: Supabase Realtime and real JWT verification** unverified.
4. **B4: Graphs/function plots and LaTeX rendering** were not audited, but your acceptance list includes graphs.

Non-blocking but recommended: O3-O7 in the audit report (allow-list client tool names, move the Live key out of the URL if the provider supports a header, slim Realtime payloads, document the ~1.5 s runaway freeze).

## Packaging

The archive contains source, tests, the `e2e/` harness with its evidence, and `docs/release/`. It excludes `.env*`, API keys/tokens, `node_modules`, virtualenvs, caches, `frontend/dist`, test-generated documents, and local databases. The archive was extracted into a clean directory and the backend suite (862 passed, 1 skipped) and frontend (`npm ci` from the shipped lockfile, `tsc`, tests, lint, build) were re-run from that copy. SHA-256 and integrity-check results are recorded in `ARCHIVE_CHECKSUM.txt` next to the archive (not inside it, because the archive cannot contain its own hash).
