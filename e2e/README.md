# SmartBoard browser end-to-end harness

**Test harness, not production code.** `serve_stack.py` runs the real FastAPI backend against a disposable PostgreSQL database seeded with the backend's test data, with two test doubles: tokens `tok:<auth-uuid>` are accepted as identity (the seam the backend's own tests use), and a local HTTP/WebSocket server stands in for Gemini (Imagen, generateContent, Live). Nothing here verifies real Google services.

## Prerequisites (outside the repository)
- PostgreSQL 16 + pgvector, `TEST_ADMIN_URL=postgresql://postgres:<pw>@127.0.0.1:5432/postgres`
- Python venv with `requirements.txt` + `requirements-dev.txt`
- Node 22, `cd frontend && npm ci`
- A Chromium and `playwright-core`, in `/home/claude/browser` (see `lib.mjs`). The harness used `@sparticuz/chromium`; its default flags disable web security, site isolation and multi-process, so `lib.mjs` removes them. Do not reuse those defaults for isolation tests.

## Run
```bash
bash e2e/start_stack.sh                     # Postgres + backend (:8000) + Vite dev server (:5173); SKIP_WEB=1 to skip the dev server
node e2e/journey1.mjs                       # student: draw, text, diagram, save, DB, reload
node e2e/journey2.mjs                       # image + simulation lifecycle
node e2e/journey3.mjs                       # failure/security; journey3b.mjs = leave-page veto
node e2e/journey4.mjs                       # teacher
node e2e/journey5.mjs                       # Live Voice (fake mic + stand-in provider)
node e2e/sim.e2e.mjs                        # simulation sandbox, real Chromium
node e2e/perf.mjs; node e2e/inventoryA.mjs; node e2e/inventoryB.mjs
```
For the production-bundle runs, build with `VITE_API_URL=http://localhost:8000 VITE_SUPABASE_URL=http://localhost:54321 VITE_SUPABASE_ANON_KEY=anon-e2e npx vite build --outDir /tmp/dist-e2e` and serve it with `npx vite preview --outDir /tmp/dist-e2e --port 5173`.
Each script resets its own board and writes results to `evidence/*.json`; screenshots are in `evidence/`.

Known quirks: the scripts avoid the style panel (x<505) and AI bar when pointing at the canvas; keyboard shortcuts need canvas focus because the board does not capture keys globally.
