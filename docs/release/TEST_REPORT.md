# Test report

Environment: Ubuntu 24.04 container, Python 3.12, Node 22.23.4, PostgreSQL 16.15 + pgvector 0.6.0 (disposable, local), Chromium 131.0.6778.0 headless (npm package `@sparticuz/chromium`, with web security / site isolation / multi-process ON), Pillow 13.0.0, FastAPI 0.115.14, Starlette 0.46.2.

Legend: **PASSED** executed and passed - **FAILED** - **SKIPPED** - **BLOCKED** needs unavailable infrastructure/credentials - **MOCK** test double inside the process - **STAND-IN** real code against a local fake provider - **REAL** real external provider (none in this report).

## 1. Automated suites (final run, after all changes)

| Suite | Command | Result | Kind |
|---|---|---|---|
| Backend + AI + database | `export TEST_ADMIN_URL=postgresql://postgres:***@127.0.0.1:5432/postgres DATABASE_URL=postgresql://postgres:***@127.0.0.1:5432/socratiq_scratch TEST_DATABASE_URL=$DATABASE_URL; python -m pytest -q -rs` | **862 passed, 1 skipped, 0 failed** (110 s) | real PostgreSQL; AI adapter is a MOCK; Live relay tested against a real local WebSocket (STAND-IN) |
| - the one skip | `database/tests/test_live_db.py::test_real_embedding_dense_retrieval` | **SKIPPED - BLOCKED** (needs a real NVIDIA embedding key) | would be REAL |
| Frontend | `cd frontend && npx vitest run` | **731 passed (45 files), 0 failed** | jsdom + MOCKed network |
| TypeScript | `npx tsc -b` | clean | |
| Lint | `npx oxlint` | **0 errors**, 58 warnings (baseline: 1 error, 60 warnings) | |
| Production build | `npm run build` | succeeds (6 s; known large Excalidraw chunk warning) | |
| Migrations | `python database/run_migrations.py --local-supabase-stub` on a fresh DB | 17/17 applied | scratch DB |

Progress against the original upload: backend 507 passed + 271 skipped (no Postgres) -> 862 passed + 1 skipped; frontend 659 -> 731.

Runs without PostgreSQL silently skip ~270 tests. The skip count must be checked (`-rs`); this report's numbers are with PostgreSQL.

### Test reliability findings (found by re-running from the extracted archive and under load)

- **Fixed:** my own `loopGuard` test "a loop re-entered many times is not penalised" used a 5 ms wall-clock limit and failed once under CPU contention (and reproducibly under load). It now uses a deterministic clock, models re-entry as separate calls (as a per-frame loop behaves), and adds two companion tests (one run crossing the limit is stopped; a nested loop whose outer run exceeds the limit is stopped). It passed 3/3 under artificial load.
- **Not changed (original test, noted):** under *artificial* heavy CPU starvation (4 busy-loop processes on a small container) the original legacy-board test `SmartBoardGestures.test.tsx > a whole resize drag is undone by ONE Ctrl+Z` exceeded vitest's default 5 s timeout (5.5 s). Run normally the file passes 66/66 repeatedly; the file is unchanged from the upload. Treat that test as load-sensitive on slow CI.
- A runaway-loop test and the Live lifecycle tests use short real timeouts (0.3-0.4 s) and passed in every run, including under load, but they are wall-clock based.

## 2. Real-browser end-to-end (Chromium 131; real backend; scratch DB; STAND-IN provider)

All assertions are recorded in `e2e/evidence/*.json` and itemised in `BUTTON_INTERACTION_INVENTORY.md`.

| Script | Scope | Result |
|---|---|---|
| `sim.e2e.mjs` | simulation animation/interaction; sandbox escape attempts; CSP-stripped control; loop guard; per-frame loop false-positive check | 33/33 |
| `journey1.mjs` (dev server, then **production build**) | draw/text, AI diagram, save, DB contents, authorship, connector geometry, reload | 15/15 both |
| `journey2.mjs` (dev, then **production build**) | image + simulation: generate, animate, interact, pin, persist, reload, reopen, second session | 24/24 both |
| `journey3.mjs` | provider failure, malicious SVG, empty/rapid requests, backend outage and recovery, two-tab conflict, unauthorized/forged/expired | 25/25 |
| `journey3b.mjs` | leave-page veto when unsaved / no nag when saved | 3/3 |
| `journey4.mjs` | teacher read-only, authorship visible, cross-course isolation, sync-after-reload | 10/10 |
| `journey5.mjs` | Live Voice with fake microphone + stand-in provider | 13/13 |
| `perf.mjs` | 1,800-element board, 4 reload cycles, save payload, stroke latency | 12/12 |
| `inventoryA.mjs` | every toolbar tool, drawing, style, selection, copy/paste/delete, undo/redo, eraser, zoom | 30/30 |
| `inventoryB.mjs` | tabs, menu, dialogs, AI bar, quick actions, sim panel, layout widths, mobile touch | 29/29 |
| **Total** | | **194/194** |

Reproducibility caveat: the scripts were debugged iteratively; several failures during development were defects in the *scripts* (selectors, click targets, state left by earlier runs) and are described in the audit report where they led to real findings. Three of my own checks were wrong at first (a vacuous `|| true`, a vacuous "Library" text match, a mis-aimed attack URL) and were replaced; the final scripts are the ones in `e2e/`.

## 3. Tests added in this work (selection)

`test_smartboard_auth.py` (auth sweep for every route; `/chat` server-instruction authority and bounds; cross-course isolation; the Coach prompt never contains another student's board, with a non-vacuity guard), `test_smartboard_media.py` (image/simulation/vector validators and routes), `test_live_voice_lifecycle.py` (11, real WebSocket peer), scene revision + 6-way concurrency race and provenance tests in `test_smart_board.py`; frontend: `loopGuard.test.ts`, `LiveVoicePanel.test.tsx` (20; 13 fail on the original component), `toNative.connectors.test.ts`, `geminiSmartBoardService.generation.test.ts`, StrictMode / conflict / menu tests in `SmartBoardWorkspace.test.tsx`, `realtime.test.ts`, autosave code test.

Existing tests changed (not weakened): fixtures that assumed anonymous access now sign in through the real dependency seam; the DB-cap test uses migration 016's 3.5 MB limit; the delta test keys on the digest header; the fallback-question test asserts the AI module's documented fallback; the key-rotation test asserts the header instead of the URL. Each is explained in `ENGINEERING_AUDIT_REPORT.md` (D20).

## 4. Security checks run

| Check | Result |
|---|---|
| `pip-audit -r requirements.txt` | **71 advisories in 8 packages (OPEN)**, see audit report O1. Pillow 13.0.0 alone: none. |
| `npm audit --omit=dev` | **13 advisories (10 high), transitive via Excalidraw (OPEN)**, see O2. |
| Auth sweep, forged/expired token, cross-course access, open-proxy check | PASSED |
| Sandbox escape attempts (parent/top/storage/cookie/IndexedDB/fetch/img/script/WebSocket/popup/navigation), with a CSP-stripped control proving the CSP is what blocks network | PASSED (Chromium 131) |
| Static analysis / SAST, dependency pinning review beyond the audits above | **Not run** |

## 5. Not covered by any test above

Real provider behaviour; Supabase Realtime and real JWT verification; Firefox/WebKit/Safari; real touch hardware; audible audio playback; accessibility/screen readers; Arabic/RTL; graphs/function plots and LaTeX on the native board; long-running memory growth beyond 4 reload cycles; load/concurrency beyond the 6-way save race.
