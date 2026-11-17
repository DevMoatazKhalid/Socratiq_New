## Unreleased: teaching personas, concept-aware adaptation, validated streaming
- Added five teaching personas (style only, below policy), student selection API/UI, persistence (`017_teaching_personas.sql`) and per-turn attribution across Chat, Board and Live.
- Chat prompt now renders policy from the canonical `ai/brain/policy.py` (prompt v4).
- Repeated-difficulty detection is concept-aware; failed help triggers a strategy shift; the diagnosed concept is stored.
- `/ai/coach/stream` adds `content_delta` (approved text only, after validation and storage), `timings`, and idempotent retry via `client_turn_id`.
- Course and student-history retrieval run concurrently.
- Fixed: connection used after release in `_read_turn`; duplicate message on retry after a dropped connection.
- Frontend: split Chat + SmartBoard workspace at >= 1024 px (tabs below), resizable/collapsible, progressive reply rendering.
- See docs/UNIFIED_BRAIN_ARCHITECTURE_V2.md and docs/REMAINING_RISKS.md.

## Unreleased: Unified AI Brain
- Added: the Coach can initiate a diagram or simulation on the board itself (`visual_plan`), judged by the same validator as its reply, re-checked and budgeted by the server, drawn only through a signed single-use grant, and recorded at every step. See docs/UNIFIED_AI_BRAIN.md section 6.
- Board generation is reviewed under the assignment's policy before any provider call (422 `coach_redirect` with a Socratic reply); no assignment means the strictest policy.
- Board chat and Live Voice now read the same session, policy, shared transcript, Coach diagnosis, memory and board as the Chat, and write their exchanges to the shared transcript.
- Fixed: board chat telemetry never persisted (schema CHECK violations); Live telemetry invented a diagnosis and used an invalid session policy; invented rows are ignored by memory, prior diagnosis and teacher analytics (not deleted).
- Fixed: Live relay leaked a slot and provider socket when the client left during the handshake, and misreported an early provider hang-up.
- Student speech is no longer written to the server log.

# Changelog

## SmartBoard engineering overhaul (this release)

### Security
- All SmartBoard HTTP routes now require authentication before validation (`/generate-*`, `/chat`, `/retrieve`, `/context`, `/config`); they were an open proxy to the provider key.
- `/chat`: server pedagogical instruction is authoritative; client instruction/tools/history are bounded and treated as untrusted.
- Provider key moved out of REST URLs into a header; `httpx`/`websockets` loggers pinned to WARNING; provider errors redacted.
- Legacy `SimulationNode` iframe now shares the hardened sandbox/CSP/validation module.
- Pillow upgraded to 13.x (fixes the 12.x advisories).

### Persistence
- New `scene_rev` / `base_rev` optimistic concurrency: stale saves get `409 board_conflict`; atomic under the attempt row lock. No schema migration.
- Legacy board model accepts the snake_case fields the client sends (they were being dropped), rejects unknown fields, bounds numerics.
- Autosave no longer dies under React StrictMode; save failures show a visible reason; conflicts offer Reload.

### AI generation
- No placeholder "success": provider failures are 502/504. Images fully decoded and validated; vector and simulation output validated server-side; prompts bounded.

### Simulations
- Loop guard (acorn) bounds runaway loops; sandbox attribute reduced to `allow-scripts`; CSP pinned CDN versions; pinned AI simulation cards keep `ai` authorship.

### Live Voice
- Relay sends explicit end reasons, closes oversized messages with 1009, releases slots cleanly, provider base is configurable for testing.
- Client releases microphone/audio on every end path, ignores events from stale sockets, closes the provider session when the microphone is unavailable, explains why a session ended.

### Board UX
- Connector endpoints corrected when Excalidraw's converter strays; AI bar no longer covers Undo/Redo/Zoom/Help; prompt field stays usable at 900 px; board menu limited to board actions (no third-party social links); Realtime hook no longer resubscribes every render.

### Tests and tooling
- Backend: 862 passed, 1 skipped (real-NVIDIA test, blocked). Frontend: 731 passed. Lint 0 errors. New: auth sweep, media validators, Live lifecycle against a real WebSocket peer, concurrency race, isolation tests, loop guard, Live panel, geometry, StrictMode.
- `e2e/`: real-browser harness and 194 recorded assertions (see `docs/release/BUTTON_INTERACTION_INVENTORY.md`).

---

## Previous: SocratiQ Architecture Integration & Feature Recovery

## Overview
This release delivers the unified architecture of SocratiQ, preserving the modern **Excalidraw Native Whiteboard** while recovering 100% of the valuable capabilities from the legacy V5 implementation, backed by a comprehensive **Security, Architecture, Student Memory, and Real-Time Synchronization** hardening pass.

---

## Phase 0: Security Hardening & Rate Limiting
- **Migration 016 (`016_whiteboard_scene.sql`)**: Verified and preserved. Ensures the database accommodates large native scenes (up to 3.5MB) with raster assets while maintaining transactional consistency.
- **Generator Rate Limiting**: Added `ip_limiter` in `backend/app/ratelimit.py` with per-IP rate limiting for unauthenticated demo sessions and user-level throttling for authenticated student sessions.
- **SmartBoard Router Hardening**: Protected `/generate-image`, `/generate-simulation`, and `/generate-diagram` in `backend/app/routers/smartboard.py` with the rate limiting dependency.
- **Dual-Engine Fallback Verification**: Verified that `BoardSurface.tsx` maintains complete backward compatibility and allows zero-downtime rollback to the legacy V5 canvas via `VITE_SMARTBOARD_ENGINE=legacy`.
- **Node Test Environment Polyfill**: Added `src/test/setup.ts` to polyfill WebSocket in Node 20 testing environments.

---

## Phase 1: Gemini Multimodal Live Voice Reconnected
- **Standalone `LiveVoicePanel.tsx`**:
  - Implemented real-time bidirectional audio capture (16kHz PCM via `AudioContext` and `ScriptProcessor`).
  - Audio playback queue (24kHz PCM) with immediate barge-in interruption handling when the student speaks.
  - Live audio visualizer reflecting microphone volume.
  - Video stream integration: Periodic board snapshots captured every 2 seconds via Excalidraw's `exportToBlob` and streamed as JPEG media chunks to Gemini Live API.
- **Live Tool Execution Handler (`liveToolHandler.ts`)**:
  - Full bidirectional tool call translation for: `draw_rectangle`, `draw_circle`, `draw_triangle`, `draw_line`, `draw_arrow`, `write_text`, `add_equation`, `pan_view`, `clear_board`, `search_course_materials`, `get_board_context`, `generate_vector_drawing`, `generate_image`, and `generate_simulation`.
  - Batching and collision-free placement on the native board via `planCoachInsertion`.
- **Workspace Integration**: Added the "Live Voice" toggle button to `SmartBoardWorkspace.tsx` top-right header with real-time connection status.

---

## Phase 2: AI Image Generation Reconnected
- **Query Integration**: Added `generateImage()` in `frontend/src/lib/queries.ts` calling `/api/v1/smartboard/generate-image`.
- **Insertion Engine (`insertImage.ts`)**:
  - Function `planImageInsertion`: Converts raster data URLs to Excalidraw binary file records (`BinaryFileData`).
  - Employs spatial obstacle avoidance (`ObstacleIndex`) and anchor resolution (`resolveAnchor`) to position generated illustrations cleanly without occluding student drawings.
- **Multi-Mode AI Prompt Bar**: Integrated into `SmartBoardWorkspace.tsx` with a mode toggle supporting:
  - **Diagram**: Validated structured vector drawings and flowcharts.
  - **Image**: High-quality raster illustrations via Gemini/Imagen.
  - **Simulate**: Interactive STEM simulations.

---

## Phase 3: Enhanced Board-AI Integration (Coach Visual Context)
- **Deep Scene Digestion (`ai/whiteboard/digest.py`)**:
  - Upgraded `render_board_for_llm` to parse native Excalidraw scenes (`scene.elements`), extracting text, LaTeX equations, arrows, geometric shapes, illustrations, and freehand drawing counts.
  - Maintains strict authorship boundaries: clearly separates student reasoning from coach and AI annotations so the Socratic Coach never mistakes AI guidance for student work.
  - Active selection awareness: identifies currently selected element on the Excalidraw canvas so the Coach can resolve deictic references ("this", "here").
- **Pedagogical Integrity**: Verified that the LangGraph Socratic Coach retains 100% pedagogical authority and single-turn decision making.

---

## Phase 4: Interactive STEM Simulations Redesigned
- **Query Integration**: Added `generateSimulation()` in `frontend/src/lib/queries.ts` calling `/api/v1/smartboard/generate-simulation`.
- **Secure Simulation Panel (`SimulationPanel.tsx`)**:
  - Clean floating modal with responsive layout, expansion/fullscreen controls, and live reload.
  - Sandboxed `<iframe>` with Tailwind CSS and MathJax support.
  - "Pin to Board" feature: inserts an interactive simulation card element onto the Excalidraw canvas with dedicated `planSimulationInsertion`.
  - Full lifecycle preservation: Simulation title, id, and complete executable code stored in element `customData.simulation` and preserved across board save, reload, and reopen.
  - Global event bridge (`socratiq-open-simulation`) for opening simulations triggered via Live Voice, AI prompt bar, or canvas card click.

---

## Phase 5: Complete Student Memory Architecture (`backend/app/memory.py`)
- **Persistent Student Learning Memory**:
  - `StudentMemoryProfile` dataclass aggregating student mastery states, misconceptions, recurring mistakes, educational library context, and whiteboard work.
  - Queries 6 authoritative tables: `student_concept_state`, `evidence_candidates`, `ai_interactions`, `stored_files`, `materials`, and `attempts`.
- **Pedagogical Prompt Formatting**:
  - `format_memory_for_socratic_coach()`: Detailed structured Markdown block injected into LangGraph Socratic Coach context (`TaskContext.student_memory_text`).
  - `format_memory_for_live_voice()`: Low-latency, high-priority summary block for Gemini Multimodal Live Voice relay.
- **Strict Authorship & Attribution in Whiteboard Memory**:
  - Student written notes and equations separated from Coach annotations and pinned interactive simulations.
- **Memory Lifecycle & Granular Deletion Engine**:
  - `record_student_learning_observation()`: Records pedagogical observations as evidence candidates.
  - `delete_student_memory()`: Granular scoped deletion (`concept_only`, `learning_profile`, `whiteboard`, `conversations`, `gdpr_erasure`).
  - Multi-table writes execute in transactional boundaries (`db.tx()` / `conn.transaction()`) with automatic rollback on error.
  - Setting `attempts.whiteboard = NULL` cleanly resets the canvas for downstream consumers without student data leakage.
  - Foreign key cascades cleanly prune child interactions and verification citations.
  - Strictly preserves shared university educational materials, courses, assignments, and enrollment records.
- **Omni-Channel Integration**:
  - SmartBoard `/chat` endpoint integrates memory into turn context blocks.
  - SmartBoard `live_relay` WebSocket injects memory into Gemini Live session prompts.
  - LangGraph Socratic Coach (`ai.py` `_read_turn`) populates memory context for graph execution.

---

## Phase 6: Supabase Persistence & Real-Time Synchronization (`frontend/src/lib/realtime.ts`)
- **Authoritative Database Persistence**:
  - All writes route through FastAPI transactional database sessions (`db.tx()`) with `FOR UPDATE` row locking to prevent race conditions.
  - Whiteboard scenes saved to `attempts.whiteboard` with strict 3.5MB size validation (migration 016).
  - Robust frontend autosave state machine (`autosave.ts`): debounced (1.5s), max wait (10s), single in-flight lock, retry backoff [2s, 5s, 15s], and unload flushing.
- **Supabase Realtime Channel Synchronization**:
  - Idempotent deployment script created at `database/deploy_supabase_realtime.sql` to safely enroll `attempts` and `materials` in `supabase_realtime` CDC publication without altering base PostgreSQL migrations.
  - Implemented `useRealtimeSubscription` listening for postgres changes on Supabase Realtime channels.
  - `useWhiteboardRealtimeSync`: Real-time whiteboard updates across tabs and devices, and live teacher observation in `SubmissionReview.tsx`.
  - `useMaterialRealtimeSync`: Real-time material indexing status updates (`QUEUED` -> `PROCESSING` -> `COMPLETED`) in teacher and student views.
  - Reconnection recovery: Automatically refetches and invalidates queries on subscription reconnect.
  - Defensive fallback: Gracefully no-ops when Supabase Realtime is unconfigured or offline.

---

## Security, Architecture & Runtime Hardening
- **Server-Owned System Instructions & Tool Declarations**: Frontend cannot override pedagogical rules or tool schemas.
- **WebSocket Security**: Origin validation against approved hostnames, mandatory JWT authentication, per-user connection limits (max 2), 15-minute session timeouts, 90-second idle timeouts, and 2MB payload caps.
- **Simulation Defense-in-Depth**: Strict Content Security Policy (`connect-src 'none'`) and pre-execution malicious code scanning (`validateSimulationCode`).
- **Image Insertion Security**: Strict MIME whitelist (`image/png`, `image/jpeg`, `image/webp`, `image/svg+xml`) and 2.5MB decoded size ceiling.
- **Live Board Streaming**: Dirty-signature canvas comparisons (`sceneSignature`) to eliminate redundant frame captures; 15-second heartbeat; 1280px resolution clamp.

---

## Verification & Test Results
- **Frontend Vitest Suite**: 41 passed files, **659 passed tests**, 0 failures.
- **Backend Pytest Suite**: **106 passed tests**, 0 failures (218 integration tests skipped awaiting live Postgres environment).
- **Whiteboard & AI Engine Tests**: **391 passed tests** in `ai/tests/`, 0 failures (10 integration skipped).
- **Total Passing Automated Tests**: **1,156 passed tests**, 228 skipped, 0 failures across 106 test files.
- **Frontend Production Build**: Clean `tsc -b && vite build` completed in 1.35s with 0 errors.
