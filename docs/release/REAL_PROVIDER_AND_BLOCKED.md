# Real-provider tests, blocked integrations, and what is unverified

## Real-provider tests executed

**None.** No Gemini, Imagen, Gemini Live, or NVIDIA embedding/reranker credentials were available in the working environment, so no request was ever sent to a real model provider. Nothing below may be read as "verified against Google".

## What WAS exercised, and how (be precise when citing)

| Capability | How it was exercised | What that does and does not prove |
|---|---|---|
| Image generation | Real FastAPI route + real validators; a **local HTTP stand-in** returned a real PNG (and failure / malicious-SVG modes) | Proves our auth, validation, error mapping, insertion, persistence and reload. Does **not** prove Imagen's real response shape/quota/latency behaviour. |
| Simulation generation | Same (stand-in returns interactive HTML) | Proves validation, sandboxing, animation, interaction, pinning, persistence. Not real model output quality or safety. |
| Diagram / vector generation | Same | Proves spec validation, layout, connectors, persistence. |
| Live Voice | Real relay + real browser with a **fake microphone device**; a local WebSocket stand-in played Gemini Live | Proves auth/origin/limits/cleanup, setup ownership, audio flow browser->relay->provider, close reasons, client lifecycle. Does **not** prove real Gemini Live protocol compatibility, audio quality, barge-in with real speech, or provider timeouts/rate limits. |
| Coach (`/ai/coach/stream`) | Existing test double for the AI adapter | Not a real LLM; pedagogy quality and prompt-injection resistance are unverified. |

Stand-in code: `e2e/serve_stack.py` (clearly labelled as a test harness). Provider base URLs are overridable only through server-owned env vars `GEMINI_API_BASE` and `GEMINI_LIVE_WS_BASE`.

## Blocked / externally unverified (exact requirement to unblock)

| Item | Status | Needed to verify |
|---|---|---|
| Real image generation (Imagen / Gemini image) | **Unverified** | A `GEMINI_API_KEY` with image-generation access and quota; then run one prompt through the UI and confirm a persisted, reloadable image. |
| Real simulation / diagram / vector generation | **Unverified** | Same key. |
| Real Gemini Live voice session | **Unverified** | Same key with Live access, a real microphone, and speakers. Confirm: setup accepted, audio both ways, barge-in, stop, cleanup. The key is passed in the provider WebSocket URL; check whether the header form is accepted. |
| Real NVIDIA embedding / reranker (`database/tests/test_live_db.py::test_real_embedding_dense_retrieval`) | **BLOCKED (skipped, reported as skipped)** | `RAG_EMBEDDING_API_KEY` / `NVIDIA_API_KEY` / `AI_API_KEY`. |
| Supabase Realtime (cross-session push) | **Unverified** | A Supabase project with Realtime enabled on `attempts` and the RLS from migrations 007/013 applied. Locally the client reports a channel error and degrades silently; only the client hook is unit-tested. |
| Supabase Auth (real JWT verification) | **Unverified** | The E2E harness replaces only the token verifier (the same seam the backend's own tests use). Real JWT validation, expiry and refresh were not exercised. |
| Remote/production database | **Not touched** | By design. All DB work used disposable local PostgreSQL 16 + pgvector. |

## Environment limitations that affected verification

- The Tailwind and MathJax CDNs are unreachable from the sandbox network, so the browser tests ran simulations **without** those two scripts loaded.
- Headless Chromium has no audio output: provider audio *arrival* and a healthy UI were verified, audible playback was not.
- The microphone-denied run hit Chromium's "no microphone" branch; the literal "permission denied" branch is covered by a unit test only.
- Chromium came from the `@sparticuz/chromium` npm package (Playwright's own download was blocked). Its default flags disable web security and site isolation; those flags were **removed** for every isolation test (`--no-sandbox` was kept, as required when running as root).
- Browser: Chromium 131 only. Firefox/WebKit/Safari and real touch hardware were not tested (touch was emulated through CDP).
