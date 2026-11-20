# SocratiQ V2: Frontend Closure Report (English-only UI, personas, polish)

Scope note: this session had no browser, no Supabase and no provider access. Nothing below claims browser E2E or live-integration testing.

## Verification (run from `frontend/`)
| Check | Command | Baseline | After |
|---|---|---|---|
| Unit/component tests | `npx vitest run` | 53 files / 802 passed | 55 files / 815 passed |
| TypeScript | `npx tsc -b` | exit 0 | exit 0 |
| Lint | `npx oxlint` | 0 errors, 72 warnings | 0 errors, 72 warnings (no new warnings) |
| Production build | `npm run build` | not run at baseline | exit 0 |
| Browser E2E | Playwright | Not available (browser download blocked) | Not executed |

## English-only UI audit
* Files scanned: 216 (frontend, `.ts/.tsx/.css/.html/.json/.mjs/.cjs/.md`).
* Arabic UI strings found: persona selector (Arabic name + description per persona, 10 rendered strings) and 3 Arabic branches in `SmartBoardWorkspace.tsx` (full-screen title/label, "writing on the board" status), plus Excalidraw's `langCode` switching its own chrome to Arabic.
* Corrected: all of the above. The selector renders English only; the board workspace has no Arabic branch; `langCode` is pinned to `en`.
* Remaining Arabic in non-test source (none is displayed): `voiceCommands.ts` (Arabic/Egyptian voice-command regexes and letter normalisation), `smartboard/anchor.ts` (deictic/"new" words for board anchoring), `smartboard/diagramSpec.ts` (Arabic letter normalisation for tokenizing). All are input-matching logic that keeps Arabic support working.
* Remaining Arabic in tests: fixtures proving Arabic text, combining marks, voice commands and board text still work.
* Arabic educational content: unchanged. New: chat paragraphs, the composer, the verification answer box, the grade feedback box and the assignment description box use `dir="auto"`; code blocks are `dir="ltr"`.

## Teaching personas (frontend verified against `ai/brain/personas.py`)
| Persona ID | English name | Teaching approach | Main benefit |
|---|---|---|---|
| socratic_guide (default) | The Socratic Guide | one focused question per turn; explains only the missing piece | owning the reasoning |
| patient_mentor | The Patient Mentor | small steps, one idea per reply, slows down when stuck | confidence under frustration |
| practical_engineer | The Practical Engineer | real situation, then a small experiment to run | applying ideas |
| critical_thinker | The Critical Thinker | justify, counter-example, compare alternatives | rigour |
| visual_explorer | The Visual Explorer | pictures and models, read and change them on the board | seeing relationships |

Canonical English names already existed in the backend, so no frontend rename was needed and no second source of truth was added; ids, versions and stored values are untouched. The selector now shows name, tagline, description, tone and questioning level straight from the API payload.

## Changes
* `PersonaSelector.tsx`: English-only; tagline + "how it teaches"; visible "Selected" badge (not colour alone); roving tabindex with Arrow/Home/End navigation (browsing never fires a save); focus moves to the active style on open and returns to the trigger on close/choose; retry button if the list fails to load; scroll-limited panel and larger touch targets; note that switching keeps conversation, board and progress.
* `queries.ts`: `PersonaInfo` accepts optional `socratic`/`visual`; `ar` made optional and documented as never rendered.
* `SmartBoardWorkspace.tsx`: Arabic UI branches removed, Excalidraw `langCode` pinned to `en`.
* `RichText.tsx`, `AiCoach.tsx`, `Verification.tsx`, `GradePanel.tsx`, `NewAssignment.tsx`: `dir="auto"` for learning content.
* Tests: `PersonaAndSplit.test.tsx` (English-only, badge, tone line, fallback, keyboard/focus, retry), `personas.mutation.test.tsx` (real `useSetPersona`: request body, server-confirmed state, rollback on failure, chat cache untouched), `personas.contract.test.ts` (ids/names/default match the Python source), `RichText.test.tsx` (direction).
* `run_browser_mission_a.mjs` (both copies): suite 5 now asserts English-only; machine-specific path removed; hardcoded key removed (see below).

## Security finding (CRITICAL, action needed)
`frontend/run_browser_mission_a.mjs` and `e2e/run_browser_mission_a.mjs` contained a hardcoded Supabase JWT named `SUPABASE_ANON_KEY` whose role claim is `service_role` (bypasses RLS). It is removed from the source (scripts now read `SUPABASE_ANON_KEY` from the environment and refuse to run without it), but the key is still exposed in anything already shared (this zip, any Git history, copies). **Rotate that project's service-role key** and use the real anon key for the script.

## Not done / not verified
* Browser testing at 1440/1280/1024/768/375 px, streaming in a live app, and RTL rendering in a real browser were not run. Manual checklist: open the selector at 375 px and confirm it fits, tab into it and use arrows/Enter/Escape; switch persona mid-conversation and confirm chat and board stay; send an Arabic message and an English one and confirm paragraph direction and trailing punctuation; stream a reply containing Arabic with diacritics and confirm no jump or duplicate.
* Global visual-system, SmartBoard toolbar and split-workspace restyling were NOT performed: I found the splitter already follows the window-splitter pattern, both panes stay mounted, reduced-motion is handled and the mode tabs are a real tablist, and I made no visual changes there without a browser to judge them. Treat those items as reviewed at source level only.
* Backend untouched.

---

# Addendum: SmartBoard visibility and persistent chat layout fix

## Root causes
1. **Board content "disappearing" on resize.** `SmartBoardWorkspace` had no resize handling. Excalidraw re-measures its canvas when the container changes but intentionally keeps `scrollX/scrollY/zoom`; scroll is the scene coordinate at the canvas's top-left, so a narrower panel just shows less of the scene and content near the right/bottom edge slides out of view. Nothing re-fitted it (the code only dispatched fake `window` resize events). Not CSS, not a coordinate bug: elements were never changed, only unreachable.
2. **Composer pushed below the fold.** `AppShell` was `min-h-[100dvh]` (grows with content) and the Coach faked a fixed height with `calc(100dvh - 3.5rem)` / `calc(100dvh - 8.5rem)`. The header is `flex-wrap` and sticky, so its real height varies (breadcrumbs, search, menu), the constant was wrong, and the whole page scrolled past the composer.
3. **Forced scrolling.** The transcript scrolled to the bottom on every message change, smoothly, regardless of where the student was reading; during streaming that restarts an animation per token.
4. **Composer.** A single-line `<input>` in a non-wrapping row: at 375 px the language select and three icon buttons squeezed the text field to ~150 px; long text could not grow the field.

## Fixes (files)
* `lib/smartboard/resizeFit.ts` (new, pure logic) and `SmartBoardWorkspace.tsx` (ResizeObserver, debounced): on shrink, if everything WAS in view and no longer is, re-fit (min zoom 0.1, no animation; panning still possible). On grow, restore the earlier view if it fits, otherwise re-fit into the larger space. A deliberately zoomed-in view, or one moved since our fit, is never touched. Empty board and hidden (0-size) panel do nothing. Only viewport state changes (applied with `CaptureUpdateAction.NEVER`): elements, persisted data and undo history are untouched.
* `AppShell.tsx`: new `fitViewport` prop: shell is exactly one viewport tall (`h-[100dvh]`, follows `visualViewport` so a phone keyboard shrinks it), `main` is `flex-1 min-h-0 overflow-hidden`. Other pages are unchanged. `index.html`: `interactive-widget=resizes-content`.
* `AiCoach.tsx`: uses `fitViewport`, magic-number heights removed; transcript is the only scroller; stick-to-bottom (within 80 px) instead of unconditional scroll, sending a message returns to the latest, instant scroll while streaming; composer is an auto-growing textarea (max ~6 lines, Enter sends, Shift+Enter newline, no send during IME composition), wraps on mobile (text field gets its own row), `shrink-0`, safe-area bottom padding; status bars `shrink-0`.
* `ResizableSplit.tsx`: panes use `overflow-clip` so one pane cannot bleed into the other.
* Tests: `resizeFit.test.ts` (11), `AppShell.layout.test.tsx` (4), `AiCoach.layout.test.tsx` (7).

## Results (run from `frontend/`)
| Check | Result |
|---|---|
| `npx vitest run` | 58 files, 837 passed |
| `npx tsc -b` | exit 0 |
| `npx oxlint` | exit 0, 0 errors, 72 warnings (same as baseline) |
| `npm run build` | exit 0 |
| Real-browser tests / screenshots at 1440, 1280, 1024, 768, 390, 375 | **Not executed** (no browser available in this session) |

## Limitations
* The board re-fit decision logic is unit-tested, and the wiring type-checks, but it was NOT exercised against real Excalidraw in a browser. Please run the manual checklist: add several elements spread across the board, drag the divider narrow and wide repeatedly, collapse and expand the board, resize the window, and confirm all elements come back into view and the zoom returns when you widen again.
* At 1024 px the 288 px sidebar leaves ~736 px for the workspace: functional but tight; the split threshold is unchanged.
* The legacy board engine (`VITE_SMARTBOARD_ENGINE=legacy`) already had its own ResizeObserver and was not changed.
* iOS keyboard behaviour relies on `visualViewport`; verify on a real device.
