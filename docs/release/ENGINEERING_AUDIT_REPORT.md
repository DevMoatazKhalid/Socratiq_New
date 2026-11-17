# SmartBoard engineering audit report

Scope: the SmartBoard/whiteboard subsystem of SocratiQ. Method: baseline, defect inventory, repair, then real-browser verification against the real backend and a scratch PostgreSQL database.
Provider note: no real Gemini/Imagen/Live/NVIDIA credentials were available. Everything involving a model used a **local stand-in provider** (see `REAL_PROVIDER_AND_BLOCKED.md`).

## 1. Baseline (original upload, before any change)

| Check | Result |
|---|---|
| Frontend tests | 659 passed |
| TypeScript | clean |
| Lint | 1 error, 60 warnings |
| Backend/AI/DB without PostgreSQL | 507 passed, **271 skipped** (all "no Postgres reachable") |
| Backend/AI/DB with local PostgreSQL 16 + pgvector | 757 passed, **6 failed**, 15 skipped |

The 271 skips hid real failures. The original archive SHA-256 is `bd28cf382d20f9529f2686ed3e2875ac4bba3a98135da12acb6ed0812c17adbb`.

## 2. Architecture as found (what is actually connected)

- Native board: `@excalidraw/excalidraw` in `SmartBoardWorkspace.tsx`, reached from the student Coach page (Chat / Whiteboard tabs) and, read-only, from the teacher submission review. A legacy board remains selectable via `VITE_SMARTBOARD_ENGINE=legacy`.
- Persistence: `PUT/GET /student/assignments/{id}/whiteboard` into `attempts.whiteboard` (JSONB), scene sanitised server-side, DB size backstop 3.5 MB (migration 016). Client autosave: debounced 1.5 s, max wait 10 s, single in-flight save, backoff retry.
- AI routes (`backend/app/routers/smartboard.py`): `/generate-image`, `/generate-simulation`, `/generate-vector`, `/generate-diagram`, `/chat`, `/context`, `/retrieve`, `/config`, and the WebSocket relay `/live`.
- Live Voice: browser `LiveVoicePanel` -> backend relay (auth, origin, server-owned setup) -> Gemini Live.
- Realtime: `useRealtimeSubscription` on `attempts`, used only to invalidate queries (it does not merge remote scenes into the open canvas).

## 3. Defects found and repaired

Severity: **C** critical, **H** high, **M** medium, **L** low.

| ID | Sev | Area | Finding | Fix | Evidence |
|---|---|---|---|---|---|
| D1 | C | Security | `/generate-image`, `/generate-simulation`, `/generate-vector`, `/generate-diagram`, `/chat` accepted unauthenticated callers (IP rate-limit only): an open proxy to the paid provider key. `/chat` authenticated only if an assignment/course id was supplied. `/retrieve` validated before authenticating; `/config` was open. | Every smartboard HTTP route depends on `get_current_user` and authenticates before validation. | `test_smartboard_auth.py` (failed before, passes after); journey 3 API checks |
| D2 | H | Security | `/chat` let the client replace the system instruction and supply unbounded tools/history. | Server instruction is authoritative; client text is appended as labelled untrusted context; tools shape-checked and bounded; history <= 200. | `test_smartboard_auth.py` |
| D3 | H | Security | Provider key sent in URL query strings; provider error text logged unredacted; `websockets` logs the handshake line (with `?key=`) at DEBUG. | Header auth on REST; `httpx`/`websockets` loggers pinned to WARNING; `_redact()` on provider errors. The Live WebSocket URL still carries the key (not verifiable without credentials). | `test_smartboard_media.py`, `test_live_voice_lifecycle.py::test_the_provider_key_is_never_logged` |
| D4 | H | Data | Legacy saves silently dropped `stroke_width`, `path_data`, `font_size`, `is_loading` (client sends snake_case; model accepted only camelCase aliases and ignored unknown fields). | Model accepts both spellings, forbids unknown fields, bounds numerics, rejects NaN/inf. | `test_smart_board.py` (reproduced, then fixed) |
| D5 | H | Persistence | Last-write-wins on scene saves: a stale tab overwrote newer work. | `scene_rev` + `base_rev`; stale save -> `409 board_conflict`; atomic under the attempt row lock; legacy clients unaffected. UI shows the reason as text and offers Reload. | backend tests incl. a 6-way concurrent race (exactly one winner, repeated 3x); journey 3 two-tab check; autosave/workspace unit tests |
| D6 | H | Persistence | Autosave permanently dead under React StrictMode (cleanup disposed a reused autosaver). Development builds only, but silent data loss for anyone testing locally. | Dispose only if still unmounted when the flush completes. | `SmartBoardWorkspace.test.tsx` (failed before, passes after); production build also verified |
| D7 | H | Images | Provider failure returned **HTTP 200 with a placeholder SVG** embedding the prompt unescaped. Returned bytes were not validated. | Honest 502/504; strict decode (PNG/JPEG/WEBP only, <= 4 MB, <= 4096 px, magic bytes + full Pillow decode); SVG refused. | `test_smartboard_media.py`; journey 3 provider-failure and SVG-payload checks |
| D8 | M | Vector | Failures returned `{"elements": []}` as success; arbitrary model JSON passed through. | `validate_vector`: allow-listed types, bounded numbers, path/colour sanitising; empty/invalid -> 502. Client helpers no longer map errors to "success with no shapes". | `test_smartboard_media.py`, `geminiSmartBoardService.generation.test.ts` |
| D9 | H | Simulations | Legacy `SimulationNode` iframe had **no CSP and no code validation**. | One shared hardened module (`simulationDoc.ts`) for both renderers: sandbox `allow-scripts` only, CSP, size cap, deny-list (fixed unquoted `meta refresh` bypass), pinned CDN versions. | real-Chromium sandbox suite (33/33) incl. a no-CSP control |
| D10 | H | Simulations | An infinite loop in a sandboxed simulation **freezes the whole tab** (verified in Chromium). | `loopGuard.ts` (acorn): time check in every loop of inline scripts and `on*` handlers; freeze bounded to ~1.5 s. | `loopGuard.test.ts` (21), browser runaway tests |
| D11 | M | Simulations | Server returned simulation code unvalidated. | Server-side extraction + validation (script required, deny-list, <= 120 KB); prompts bounded and delimited. | `test_smartboard_media.py` |
| D12 | M | Provenance | Pinned AI simulation card stamped `student` (the server demotes unsigned `coach` claims), so its caption was fed to the Coach as the student's own words. | Author `ai`, like diagrams/images. | backend provenance tests; journey 2 |
| D13 | M | Diagrams | Bound connector endpoints sometimes landed in empty space (e.g. Start -> Valid? ended ~100 px beside the diamond; also flowchart `e5`, tree `e4`). | Use the layout's boundary point wherever Excalidraw's converter strays > 24 px. | `toNative.connectors.test.ts` (7 diagram kinds); persisted-geometry check in journey 1 |
| D14 | M | Live Voice | Client: mic leak if closed during permission prompt; late close of an old socket put a new session in "error"; mic denial left the provider session open; server end-reasons ignored; mic/audio not released when the server ended the session. | Session guard, detached handlers, cleanup on every end path, `describeLiveClose()`. | `LiveVoicePanel.test.tsx` (20; 13 fail on the original) |
| D15 | M | Live Voice | Relay: no end reason sent; oversized message silently dropped; `g_ws` referenced before assignment; empty entry left in slot registry; no way to test against a local peer. | `end_reason` close frames, 1009 on oversize, safe cleanup, `_release_live_slot`, configurable provider base (`GEMINI_LIVE_WS_BASE`). | `test_live_voice_lifecycle.py` (11, real WebSocket peer) |
| D16 | M | Realtime | Subscription torn down and recreated on every render (inline callbacks/keys in deps); conditional hook in `try/catch` (the baseline lint error). | Refs for callbacks/keys; unconditional context read. | `realtime.test.ts` |
| D17 | M | UI | AI bar **covered Redo, Undo, Zoom-in and Help** at 900-1360 px (unclickable). Prompt field squeezed to ~30 px at 900 px. | Reserved the corners on md+; bar wraps with a minimum prompt width. | measured at 4 widths; journey/inventory B layout checks |
| D18 | L | UI | Stock Excalidraw menu showed GitHub / "Follow us" / Discord links. | Explicit board-only `<MainMenu>`. | workspace test; inventory B |
| D19 | L | UI | Permanent save failure showed only "Not saved" (reason in a hover tooltip). | Visible reason text; code carried through autosaver. | autosave + workspace tests |
| D20 | L | Tests | Stale tests encoding old behaviour (DB cap 400 KB vs migration 016's 3.5 MB; fallback-question wording; "Changes since" matched static rules text; anonymous-access fixtures; key-in-URL assertion). Process-global rate limiter polluted later tests (and the code is imported under two module names, i.e. two limiter states). | Updated to the documented contracts; autouse reset of both limiter instances. `test_live_db` real-NVIDIA test now an explicit BLOCKED skip. | full suite |

## 4. Findings NOT fixed (open)

| ID | Sev | Finding |
|---|---|---|
| O1 | **H** | **71 known advisories in 8 Python packages** (pip-audit): langgraph 0.2.76, langchain-core / -openai / -anthropic, Starlette 0.46.2 (via FastAPI 0.115), and others. Fixes need major-version upgrades of the AI stack and FastAPI; not attempted, they need a dedicated regression pass. (Pillow was upgraded to 13.0.0: no known vulnerabilities, full suite still green.) |
| O2 | M | 13 npm advisories (10 high), all transitive through `@excalidraw/excalidraw` (mermaid, lodash-es, nanoid, chevrotain). Fixing means moving the core board library. |
| O3 | M | `/chat` still accepts client-declared tool names (bounded and shape-checked, not allow-listed). |
| O4 | M | The Live provider URL carries the key in its query string. |
| O5 | M | Realtime delivers whole `attempts` rows (including large board JSON) as an invalidation signal; Realtime does not merge remote scenes into an open canvas (a second tab learns of changes via the 409). |
| O6 | L | A runaway simulation still freezes the tab for up to ~1.5 s; catastrophic regex backtracking and huge single allocations are not guarded. |
| O7 | L | An AI-inserted diagram can sit partly under the toolbar until "Show" is clicked. |
| O8 | L | The test suite writes generated PDFs into `data/documents/smoke_univ/` inside the source tree. |
| O9 | M | **Not audited:** mathematical graphs / function plots / charts, LaTeX/MathJax on the native board, the legacy board, the Coach LangGraph internals beyond context isolation, and long-session memory lifecycle (deletion/update). |

## 5. Checks that found nothing wrong

- Text tool typing, rectangle/diamond/ellipse/arrow/line/pencil creation, move, copy/paste, delete, undo/redo, eraser, zoom: all work (inventory A, 30/30). The "text tool typing failure" risk was **not reproduced**.
- Teacher read-only access, cross-course isolation (404/403), forged/expired token handling.
- Large board (1,800 elements): loads in ~2.4-3.6 s, heap flat at 87 MB across reloads, stroke latency +6% vs an empty board.
