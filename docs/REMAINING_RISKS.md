# Remaining Risks and Production Readiness Assessment

## Resolved Risks (Audited, Fixed, and Verified)
1. **Repeated-Difficulty Escalation on Unrelated Concepts:** Resolved via concept identity checking in `ai/brain/adaptation.py::is_repeated_difficulty`.
2. **Diagnosis Concept Not Persisted:** Resolved via column in migration 017 and retrieval fallback.
3. **Database Transaction Lifetime Bug:** Resolved in `_read_turn` by executing queries inside the active transaction.
4. **Duplicate Message Insertion on Replay:** Resolved via `client_turn_id` idempotency key.
5. **Missing Persona Attribution:** Resolved across Chat, Board, and Voice channels.
6. **SmartBoard Image Generation Placeholder Omission:** Resolved by pushing placeholder to `addedElements` in `BoardWorkspace.tsx`.
7. **Live Voice Lifecycle Relay Cleanup:** Resolved by awaiting cancelled background task completion in `smartboard.py`.
8. **Pre-existing Missing `.env.example`:** Resolved with complete template covering all required variables.
9. **Pre-existing jsdom Canvas Test Failure:** Resolved with canvas `toDataURL` stub in `domStubs.ts`.
10. **Untested Browser Split Workspace:** Resolved with 31 Playwright browser tests across 8 test suites.
11. **Live Supabase RLS Verification:** Resolved with 7 live database tests proving cross-student isolation.
12. **Missing Learning Intelligence:** Resolved with time-aware confidence decay, transfer scheduling, and Socratic quality evaluation.

---

## Operational Considerations & Recommendations for Scale

### 1. External AI Model Latency & Time-To-First-Token
- **Current Behavior:** The Coach generates a complete response, validates it through pedagogical safety filters, and streams pre-approved segments. This guarantees zero answer leaks, but time-to-first-token is bound by total generation + validation time.
- **Production Recommendation:** Consider speculative decoding or dual-path validation where the model stream is audited in low-latency token windows for low-risk assistance levels.

### 2. Live Voice Bandwidth & Multi-Region Turnaround
- **Current Behavior:** The Live Voice relay acts as a secure proxy between student WebSocket connections and Google Gemini Live WebSocket endpoints, strictly preventing API key exposure to client code.
- **Production Recommendation:** For multi-region student deployments, deploy regional WebSocket edge relays (e.g. Frankfurt / Cairo) to minimize audio packet latency.

### 3. Database Connection Pooling Under High Concurrency
- **Current Behavior:** Backend uses `psycopg` connection pooling with explicit transaction contexts (`db.tx()`).
- **Production Recommendation:** For production scaling exceeding 500 concurrent students, place Supavisor (PgBouncer) in transaction mode in front of PostgreSQL.
