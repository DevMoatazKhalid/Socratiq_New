# Data Collection and Integrity Report (Complete Production Audit)

## Scope and Audit Status
This report documents the completed end-to-end data integrity audit of the entire SocratiQ V2 learning platform. All 12 pedagogical and operational data pathways have been mapped and verified across frontend origins, backend routing, policy validation, PostgreSQL/Supabase persistence, and teacher dashboard consumption.

The accompanying full event trace is documented in [`docs/DATA_TRACEABILITY_MATRIX.md`](./DATA_TRACEABILITY_MATRIX.md).

## Completed Traceability Matrix Summary
| Information | Source | Destination | Consumer | Verified by |
|---|---|---|---|---|
| **Student + Coach message** | Chat UI (`AiCoach.tsx`) | `messages` (shared transcript, one STUDENT + one COACH per turn) | Coach history, Board, Live | `test_personas_and_stream_contract`, Playwright E2E |
| **Coach diagnosis** | Validated Coach | `ai_interactions.diagnosis*` | Learning memory, next-turn prior | Evidence tests, learning intelligence suite |
| **Diagnosed concept** | Coach | `ai_interactions.diagnosis_concept` (017) | Repeated-difficulty detection | Live Supabase schema tests, `test_personas_and_adaptation` |
| **Intervention type** | Coach | `ai_interactions.intervention_type`, event payload | Adaptive engine, Socratic coach | Contract tests, `test_socratic_quality` |
| **Persona + version** | Student choice | `student_preferences` (017); per turn `ai_interactions.persona_*` | All channels, teacher timeline | Persona API tests, live RLS test suite |
| **Persona change event** | Student UI | `learning_events` (`channel: persona`) when inside open attempt | Teacher timeline label | Switch test (1 event emitted; 0 on idempotent re-select) |
| **Board / Live exchanges** | SmartBoard, Voice | Shared transcript + `learning_events` (`channel`, `persona`) | Coach context, teacher timeline | `test_unified_brain`, live voice lifecycle tests |
| **Idempotency key** | Chat client | Event payload `client_turn_id` | Replay engine | Replay tests (no second model call, 1 interaction row) |
| **Confidence decay** | Memory engine | `student_concept_state` (effective confidence) | Socratic Coach prompt, transfer scheduler | `test_learning_intelligence.py` (6/6 tests passing) |
| **Transfer schedule** | Memory engine | `StudentMemoryProfile.transfer_schedule` | Coach recommendations block | `test_learning_intelligence.py` |
| **Turn timings & latency** | Backend streaming | Application logs + in-process `StageTimer` | Operational engineering (deliberately **not** in `learning_events`) | Latency benchmark tests |
| **Teacher dashboard metrics** | Teacher UI | Read-only SQL aggregations of `attempts`, `ai_interactions`, `verification_results` | Instructor Course Dashboard & Review Queue | `analytics.py`, `test_risk_and_dashboard` |

Failed AI requests store nothing (verified: no `ai_interactions`/`messages` rows; error event only). Non-Coach channels create zero fabricated diagnoses.

## Verified Architectural Defects & Fixes
1. **Diagnosed Concept Storage:** Diagnosed concept was previously not stored; `load_prior` used `referenced_concepts[0]`, which could differ and caused repeated-difficulty escalation on unrelated concepts. Fixed via column in migration 017 with concept identity matching.
2. **Database Transaction Lifetime:** `_read_turn` ran two queries (`load_visual_budget`, `visual_followup_text`) after the transaction block had released the connection to the pool. Moved cleanly inside the active transaction.
3. **Idempotent Replay on Connection Drops:** Retrying after a dropped network connection could store duplicate student messages. Fixed via `client_turn_id` idempotency key.
4. **Persona Attribution Across All Channels:** AI interactions now persistently attribute `persona_id` and `persona_version` on every turn.
5. **SmartBoard Image Generation Placeholder Bug:** The tool handler for `generate_image` in `BoardWorkspace.tsx` created a placeholder but omitted pushing it to `addedElements`, causing image generation replacements to silently fail. Fixed by pushing the placeholder to `addedElements`.
6. **Live Voice Lifecycle Task Cancellation:** Live relay background tasks were cancelled without awaiting their completion, triggering unhandled pending task warnings and delayed connection cleanup. Fixed by awaiting `asyncio.gather(*pending, return_exceptions=True)`.
7. **HTML Canvas `toDataURL` Test Stub:** jsdom lacked canvas `toDataURL` implementation, causing false-positive image generation timeouts in Vitest. Fixed via `installDomStubs()` stub.

## Supabase Schema & Security (Migration 017)
- `student_preferences`: RLS enabled, authenticated users can read and update only their own preference row (`student_id = app.current_user_id()`). Anonymous users have zero grants.
- `ai_interactions`: Added `persona_id`, `persona_version`, and `diagnosis_concept` columns with CHECK constraints.
- **Verified against live Supabase project `ydivejlvcrkotwlmffmi`**: All 7 live tests in `database/tests/test_rls_live.py` pass cleanly, verifying migration tracking, RLS policies, zero anon grants, and cross-student isolation.

## Telemetry vs. Educational Evidence Guarantee
Operational metrics (`total_ms`, `context_ms`, `graph_ms`, `first_text_ms`) remain strictly isolated to application logging and memory timers. No operational telemetry is ever recorded into `learning_events` or `evidence_candidates`.
