# Remediation — November 2026

This is the follow-up to the engineering audit (finding IDs below match the audit doc). Each entry says what changed, why, and how it was
checked. **Not run yet:** `backend/tests`, `database/tests` and the frontend suite. The environment these changes were made in had no
FastAPI, psycopg or `node_modules`. `ai/tests` ran against a minimal local stand-in for langgraph/langchain_core, not the real
libraries. Run `pytest` and `cd frontend && npm test && npm run build` before deploying.

## Security

| ID | Change | Files |
|---|---|---|
| SEC-01 | Live Voice no longer opens an unauthenticated Gemini session just because `assignment_id == "demo-assignment"`. A token is required. The public demo page can use voice only with `SMARTBOARD_PUBLIC_DEMO_VOICE=true`, never in production (startup validation rejects it), with a browser Origin, and at most 1 concurrent and 6 hourly sessions per client IP. The voice protocol and relay logic are unchanged; only the entry check moved. | `routers/smartboard.py`, `config.py` |
| SEC-02 | SmartBoard element-ID / visual-grant HMAC key is no longer a constant in the source. Key order: `BOARD_SIGNING_SECRET` → `FILE_LINK_SECRET` → a key derived from `SUPABASE_SERVICE_ROLE_KEY`. Production fails with none of these; dev uses a random per-process key. IDs issued under the old key stay valid through the existing DB provenance fallback (`is_registered_coach_element`). | `config.py`, `board_auth.py` |
| SEC-03 | `/smartboard/chat` is hardened. It has its own per-user limit. With a shared session, only the student's latest turn comes from the client and the rest from the server transcript, so forged "model" turns are dropped. Without one, the client sends at most 12 turns, roles are checked, and each message is capped at 4,000 characters. The audio MIME type is validated. DB and RAG work runs off the event loop that also carries Live Voice. Chat without an assignment still works under the strictest policy, as the existing tests specify. | `routers/smartboard.py`, `ratelimit.py` |
| SEC-04 | Removed `ip_limiter`. It keyed on the JWT *header*, which is the same for every user, so the whole project shared one bucket. SmartBoard generation and chat are now limited per user. | `ratelimit.py` |
| SEC-05 | Verification grading resists prompt injection. The answer is sanitised and wrapped in delimiters it cannot close. Every rubric prompt says the answer is data, not instructions. Grader-directed text (English and Arabic) caps the result at PARTIAL with confidence ≤ 0.3. The score can never exceed the share of rubric criteria the model marked as met plus 0.15. These checks only ever lower a result. | `ai/verification/safety.py`, `strategies/*.py`, `service.py` |
| SEC-06 | CORS no longer hard-codes `*.trycloudflare.com` for every deployment. Use `CORS_ORIGIN_REGEX`; `scripts/start_public.sh` sets the tunnel regex for the backend it starts. | `main.py`, `config.py`, `scripts/start_public.sh` |
| SEC-07 | Optional `TEACHER_SIGNUP_CODE`: when set, creating an instructor profile requires it (constant-time comparison). `/universities` reports only *whether* a code is required. The signup and complete-profile forms ask for it when needed. Unset, signup behaves as before. | `routers/auth_users.py`, `schemas.py`, frontend auth pages |
| — | `/smartboard/retrieve` now returns nothing when the student's document whitelist is empty. Before, an empty list meant "no filter", which exposed course-wide chunks. | `routers/smartboard.py` |

## AI behaviour

| ID | Change |
|---|---|
| AI-01/03 | Answer-reveal detection is shared by the rule check and final enforcement. It no longer flags praise ("your answer is correct") and catches Arabic hand-overs, with an Arabic fallback. (This was a pre-existing working-tree change; it was reviewed and kept.) |
| AI-02 | The LLM validator now sees the assignment instructions, the student's work and the retrieved material, each capped and labelled DATA. Before, it judged "reveals the answer / off-topic / ungrounded" without seeing any of them. |
| AI-04 | Student memory now reaches the Coach. `ai_adapter` dropped it before. It is capped at 2,000 characters, sanitised, and excludes board and library content. |
| AI-05 | The `generate_response` path map now includes `generate_response` and `safe_fallback`. The grounding-retry path used to raise inside the graph. |
| AI-06 | A failed generation goes straight to emit. Before, it spent a validator LLM call on the canned "please rephrase" text. |
| AI-07 | One set of verification thresholds (PASS ≥ 0.8, PARTIAL ≥ 0.5) in the AI layer and the backend aggregate. Before, the backend used 0.75 / 0.4. |
| — | The current attempt is no longer repeated in the conversation history. Only the student's message goes there, which removes the largest duplicated input from each Coach call. |

## Retrieval

| ID | Change | Evidence |
|---|---|---|
| RAG-01 | Full-text search ORs the query's lexemes and ranks with `ts_rank_cd(..., 32)`. Before, it ANDed them: `plainto_tsquery` over a multi-sentence Coach query matched almost nothing, so "hybrid" search was effectively dense-only. The query is capped at 1,000 characters. | Checked on a local PostgreSQL 16 against a generated `tsv_content` column: the old query matched 0 of 3 chunks; the new one matched 2, in the right order. Stop-word-only, empty and operator-laden inputs return 0 rows without errors. |
| RAG-05 | The retrieval query bounds its parts: instructions ≤ 600 characters, diagnosis ≤ 300, student text ≤ 600. A multi-page brief no longer drowns the concept in the single embedding. | `ai/tests` |

## Observability

PERF-03: `ai/models/usage.py`. Every structured model, fallbacks included, carries a callback that records calls, input/output tokens
and latency per role into a meter opened for the current Coach turn (`CoachAgent.invoke`). One summary line is logged per turn. The meter
is fail-safe: no meter means nothing is recorded, a provider that reports no usage is counted as `calls_without_usage`, and metering
errors are swallowed. The streaming path is not metered yet, because `stream()` is iterated from a thread pool where the context
variable does not carry across `next()` calls.

## Tooling

- `.github/workflows/ci.yml`: pytest against `pgvector/pgvector:pg16`, plus frontend lint, test and build. **It has not run in Actions yet.**
- Root `package.json` pointed at a non-existent `frontend/socratiq`; it now points at `frontend`.
- `.env.example` documents `CORS_ORIGIN_REGEX`, `BOARD_SIGNING_SECRET`, `TEACHER_SIGNUP_CODE` and `SMARTBOARD_PUBLIC_DEMO_VOICE`.
- New tests: `ai/tests/test_remediation_2026_11.py` (25 tests, passing here) and `backend/tests/test_remediation_2026_11.py` (not run here).

## Deliberately not done

- **FE-01 (lazy-load the legacy board):** three `AiCoach*.test.tsx` files mount the legacy engine synchronously via
  `VITE_SMARTBOARD_ENGINE=legacy`. Changing that without running vitest risks breaking them. Worth doing with the suite available.
- **ANN index on `document_chunks.embedding`:** that is a schema migration, and `vector(2048)` exceeds pgvector's 2,000-dimension HNSW/IVFFlat
  limit for `vector`. It needs either `halfvec` or a smaller embedding dimension, which is a data decision.
- The 15 pre-existing ruff findings (unused imports/locals) in touched files are unchanged; none are undefined names.

## Operator actions

1. Set `BOARD_SIGNING_SECRET` (or rely on `FILE_LINK_SECRET`) in every deployed environment.
2. If the public demo page should have voice in development, set `SMARTBOARD_PUBLIC_DEMO_VOICE=true` locally.
3. If instructor signup should be gated, set `TEACHER_SIGNUP_CODE` and share it with instructors.
4. Grades: verification outcomes between 0.75 and 0.8 now read PARTIAL instead of PASS. This affects new verifications only; stored results are not rewritten.

## Publication preparation (2026-11-20)

- `data/documents/` is now in `.gitignore`. It is `RAG_STORAGE_DIR`'s default, and the 44 tracked
  `smoke_univ/.../doc_<hash>_gradient_descent.pdf` files are smoke-test output (a new one appears on every run). They are untracked
  with `git rm --cached`, so the files stay on disk. Nothing else was removed: the root `question*.wav` files are inputs to
  `scripts/verify_real_gemini_live.cjs`, and `browser_artifacts/` is evidence that the release docs reference.
- Secret scan of every added or modified file (and the already-tracked files available for review): no keys, tokens or real
  credentials. The only URL-with-password matches are the `CHANGE_ME` placeholder in `.env.example` and the throwaway password of the
  CI-only Postgres container.
- `.github/workflows/ci.yml` is placed by `socratiq_prepare.sh`, which sits outside the repo next to the project folder.
