# Button and interaction inventory

Generated from the recorded browser results in `e2e/evidence/*.json` (real Chromium 131, web security and site isolation ON, real FastAPI backend, real PostgreSQL scratch database).
**Provider caveat:** generation and Live Voice ran against a local stand-in provider, not Google. "PASS" means the app behaved correctly against that stand-in.

Status key: PASS = asserted in a real browser run; every row lists the exact assertion and the measured detail.

## Board controls A: tools, drawing, style, selection, undo/redo, eraser, zoom
`inventoryA-results.json`: **30/30**

| # | Control / behaviour verified | Result | Measured detail |
|---|---|---|---|
| 1 | toolbar: "hand" button activates the hand tool | PASS |  |
| 2 | toolbar: "rectangle" button activates the rectangle tool | PASS |  |
| 3 | toolbar: "diamond" button activates the diamond tool | PASS |  |
| 4 | toolbar: "ellipse" button activates the ellipse tool | PASS |  |
| 5 | toolbar: "arrow" button activates the arrow tool | PASS |  |
| 6 | toolbar: "line" button activates the line tool | PASS |  |
| 7 | toolbar: "freedraw" button activates the freedraw tool | PASS |  |
| 8 | toolbar: "text" button activates the text tool | PASS |  |
| 9 | toolbar: "eraser" button activates the eraser tool | PASS |  |
| 10 | toolbar: "selection" button activates the selection tool | PASS |  |
| 11 | toolbar: "lock" button toggles keep-tool-active mode on and off | PASS | on=true off=true |
| 12 | draw: the rectangle tool creates a rectangle and it is saved to the database | PASS | rectangle |
| 13 | draw: the diamond tool creates a diamond and it is saved to the database | PASS | diamond |
| 14 | draw: the ellipse tool creates a ellipse and it is saved to the database | PASS | ellipse |
| 15 | draw: the arrow tool creates a arrow and it is saved to the database | PASS | arrow |
| 16 | draw: the line tool creates a line and it is saved to the database | PASS | line |
| 17 | draw: the freedraw tool creates a freedraw and it is saved to the database | PASS | freedraw |
| 18 | draw: the text tool creates a text and it is saved to the database | PASS | text |
| 19 | draw: typed text content is stored exactly | PASS |  |
| 20 | draw: nothing drawn by the student is marked as AI or Coach work | PASS |  |
| 21 | style: choosing red in the style panel colours the next rectangle red | PASS | #e03131 |
| 22 | select+drag: moving an element updates its position in the saved scene | PASS | Δ=(50,38) |
| 23 | copy/paste: Ctrl+C then Ctrl+V adds a copy | PASS | 8 -> 9 |
| 24 | delete: the Delete key removes the selection | PASS | now 8 |
| 25 | undo button: restores the deleted element | PASS | now 9 |
| 26 | redo button: re-applies the deletion | PASS | now 8 |
| 27 | Ctrl+Z works as undo too | PASS |  |
| 28 | eraser: dragging across a stroke deletes it | PASS | 1 -> 0 |
| 29 | zoom: + increases, − decreases, reset returns to 100% | PASS | 100% -> 110% -> 90% -> 100% |
| 30 | navigation: "Fit to content" changes the view and "Reset view" returns to 100% | PASS | fit=100% reset=100% |

## Board controls B: tabs, menu, panels, AI bar, simulation panel, layout widths, mobile touch
`inventoryB-results.json`: **29/29**

| # | Control / behaviour verified | Result | Measured detail |
|---|---|---|---|
| 1 | tab: "Whiteboard" shows the board | PASS |  |
| 2 | tab: "Chat" shows the conversation input and hides the board | PASS |  |
| 3 | tab: switching away and back keeps the drawn work (restored from the server) | PASS | db elements=1 |
| 4 | menu: opens and lists board actions | PASS | Save to... Export image... Ctrl+Shift+E Find on canvas Ctrl+F Help ? Reset the canvas Dark mode Shift+Alt+D Ca |
| 5 | menu: contains no third-party social links (GitHub / Follow us / Discord) | PASS |  |
| 6 | menu: "Export image…" opens the export dialog | PASS |  |
| 7 | menu: "Find on canvas" opens the search panel | PASS |  |
| 8 | menu: "Dark mode" toggles the theme | PASS |  |
| 9 | menu: "Reset the canvas" asks for confirmation before destroying work | PASS |  |
| 10 | menu: cancelling the reset leaves the work untouched | PASS | db elements=1 |
| 11 | help: the "?" button opens the help dialog | PASS |  |
| 12 | library: the Library button opens the library sidebar (panel appears, and it was absent before) | PASS | before=0 |
| 13 | AI bar: "Image" mode switches the prompt for that kind of request | PASS | Describe an image or visual illustration to generate… |
| 14 | AI bar: "Simulate" mode switches the prompt for that kind of request | PASS | Describe a physics, math, or logic simulation to create… |
| 15 | AI bar: "Diagram" mode switches the prompt for that kind of request | PASS | Ask AI to draw a diagram… (uses selected items) |
| 16 | AI bar: submit is disabled while the prompt is empty | PASS |  |
| 17 | AI bar: Enter submits the prompt and reaches a real backend route | PASS | ["200 /smartboard/generate-diagram"] |
| 18 | quick actions: "Explain this" and "Check my work" each send a request to the Coach | PASS | {"menuNames":["Explain this","Check my work"],"posts":["200 /ai/coach/stream","200 /ai/coach/stream"]} |
| 19 | chat bar: sending a message reaches the Coach route | PASS | ["200 /ai/coach/stream"] |
| 20 | simulation panel: "Reload" restarts the simulation from zero | PASS | t 1.27 -> 0.9 |
| 21 | simulation panel: "Expand" enlarges the panel | PASS | 560px -> 1280px |
| 22 | simulation panel: "Close" removes the panel and stops the simulation | PASS |  |
| 23 | layout 1360px: undo/redo/zoom/help are not covered by the AI bar | PASS | [] |
| 24 | layout 1100px: undo/redo/zoom/help are not covered by the AI bar | PASS | [] |
| 25 | layout 900px: undo/redo/zoom/help are not covered by the AI bar | PASS | [] |
| 26 | mobile 390px: the drawing toolbar is present | PASS | tools=12 |
| 27 | mobile touch: a finger-drawn stroke is created and saved to the database | PASS | elements=1 |
| 28 | mobile 390px: the AI bar and chat input are reachable | PASS |  |
| 29 | mobile 390px: no horizontal page overflow | PASS |  |

## Student journey 1 (production build): draw, text, AI diagram, save, DB, reload
`journey1-PRODUCTION-BUILD-results.json`: **15/15**

| # | Control / behaviour verified | Result | Measured detail |
|---|---|---|---|
| 1 | drawn rectangle is persisted in the database | PASS | ["rectangle","freedraw","text"] |
| 2 | drawn freehand stroke is persisted (with real points) | PASS |  |
| 3 | typed text is persisted with the typed content | PASS | ["2x + 4 = 10"] |
| 4 | hand-drawn elements are stamped as student-authored (or unstamped) | PASS |  |
| 5 | the server revision advanced (save confirmed by the database) | PASS | scene_rev=6 |
| 6 | client sent base_rev with its saves | PASS | puts=6 base_revs=0,1,2,3,4,5 |
| 7 | the UI says Saved only after that | PASS |  |
| 8 | diagram request reached the real backend route and succeeded | PASS | ["200 generate-diagram"] |
| 9 | diagram text labels are persisted (Start / Valid? / Home / Retry) | PASS | ["2x + 4 = 10","Start","Valid?","Home","Retry","yes","no"] |
| 10 | diagram is marked AI-generated, distinct from student work | PASS | [null,"ai"] |
| 11 | diagram arrows are bound to nodes (editable connectors) | PASS | arrows=3 |
| 12 | every persisted diagram arrow starts and ends ON the shapes it connects (none ends in empty space) | PASS | [] |
| 13 | after reload the server returns the saved scene (same element count) | PASS | 16 vs 16 |
| 14 | the board re-renders content after reload (screenshot taken) | PASS | canvas=[1072,695] |
| 15 | no uncaught page errors during the journey | PASS |  |

## Student journey 2 (production build): image + simulation lifecycle
`journey2-PRODUCTION-BUILD-results.json`: **24/24**

| # | Control / behaviour verified | Result | Measured detail |
|---|---|---|---|
| 1 | image generation hit the real route and succeeded | PASS | ["200 GET whiteboard","200 POST generate-image","200 PUT whiteboard"] |
| 2 | the image element is persisted with its binary data in the database | PASS | image/png 2KB |
| 3 | the image is a real decodable PNG (magic bytes) not a placeholder | PASS |  |
| 4 | image has sane size on the board | PASS | 380x380 |
| 5 | image is marked as AI-generated | PASS | "ai" |
| 6 | simulation runs in the sandboxed frame and its clock advances | PASS | t 1.38 -> 2.31 |
| 7 | iframe sandbox is exactly allow-scripts | PASS | allow-scripts |
| 8 | the moving object really moves (position changes) | PASS | x 23.7 -> -41 |
| 9 | Pause stops the simulation | PASS | t 2.81 -> 2.81 |
| 10 | Play resumes it | PASS |  |
| 11 | Reset restarts it | PASS |  |
| 12 | the slider changes the dynamics (stiffer spring oscillates faster) | PASS | 49,57,55,46,30,6,-15,-38,-53,-57,-50,-36 |
| 13 | pinning creates a persistent simulation card in the database | PASS | rectangle 320x180 |
| 14 | the card stores the runnable source code | PASS | 908 chars |
| 15 | the card has a title and a persistent identifier | PASS | {"title":"spring mass oscillator","id":"600c21f1-0457-4ee0-8493-d548a2f37ae9"} |
| 16 | the card is not an empty rectangle (it carries a visible label/preview) | PASS | ["image","rectangle","text"] |
| 17 | the card is associated with the AI author (not student) | PASS | {"v":1,"opId":"e3d14e50-4e2c-4e59-8abb-eb6a21257186","role":"simulation","author":"ai","legacyId":"sim-600c21f |
| 18 | after reload the server returns every element (image + simulation card + labels) | PASS | 3 vs 3 |
| 19 | selecting the persisted card and choosing "Open and run" reopens the simulation | PASS |  |
| 20 | the reopened simulation animates again | PASS | t 2.24 -> 3.08 |
| 21 | and responds to controls after reload (Pause) | PASS |  |
| 22 | a second authorized session opens the same persisted simulation | PASS |  |
| 23 | and it animates in that session too | PASS | t 1.84 -> 2.68 |
| 24 | no uncaught page errors | PASS |  |

## Failure and security journey
`journey3-results.json`: **25/25**

| # | Control / behaviour verified | Result | Measured detail |
|---|---|---|---|
| 1 | image provider failure: the user sees an error (not a success) | PASS | Something went wrong on our side. Please try again. |
| 2 | image provider failure: the server answered with an error status, not 200 | PASS | [502] |
| 3 | image provider failure: nothing was inserted or saved | PASS | elements=0 |
| 4 | malicious (SVG with script) provider payload is rejected | PASS | [502] |
| 5 | malicious payload: nothing inserted or saved | PASS |  |
| 6 | empty/whitespace prompt makes no request | PASS | disabled=true requests=0 |
| 7 | rapid repeated clicks cause exactly one generation request | PASS | requests=1 |
| 8 | and exactly one diagram on the board (no duplicates) | PASS | arrows=3 |
| 9 | backend unreachable: the UI says the work is NOT saved (never "Saved") | PASS | Save failed: retrying |
| 10 | and the database really has nothing yet | PASS |  |
| 11 | after the backend returns, the pending work is saved automatically/with Retry | PASS | elements=1 |
| 12 | and the UI now says Saved | PASS |  |
| 13 | tab B (stale) is told, in visible text, that the board changed elsewhere, offered Reload, and is NOT shown as saved | PASS | This board was changed in another window or tab. Reload the page to see the latest version; saving from here w |
| 14 | tab A's work survived: tab B did not overwrite it | PASS | A saved 1, now 1 |
| 15 | no token: board read is 401 | PASS |  |
| 16 | malformed/forged token: board read is 401 | PASS |  |
| 17 | a student of ANOTHER course cannot read this board | PASS | status 404 |
| 18 | a student of ANOTHER course cannot write this board | PASS | status 404 |
| 19 | a teacher cannot write through the student endpoint | PASS | status 403 |
| 20 | unauthenticated generate-image is 401 (no open proxy to the provider key) | PASS |  |
| 21 | unauthenticated generate-simulation is 401 (no open proxy to the provider key) | PASS |  |
| 22 | unauthenticated generate-vector is 401 (no open proxy to the provider key) | PASS |  |
| 23 | unauthenticated chat is 401 (no open proxy to the provider key) | PASS |  |
| 24 | no session in the browser: the board is not shown, the user is sent to sign in | PASS | http://localhost:5173/login |
| 25 | an expired/revoked token never exposes the board (API 401 -> sign-in or error, no editable board) | PASS | http://localhost:5173/student/courses/C1/assignments/A1/coach |

## Leaving the page with unsaved work
`journey3b-results.json`: **3/3**

| # | Control / behaviour verified | Result | Measured detail |
|---|---|---|---|
| 1 | with unsaved work the page vetoes leaving (the browser will ask the user) | PASS | badge="Unsaved changes" vetoed=true |
| 2 | once everything is saved the page does NOT nag | PASS | badge="Saved 06:23 AM" vetoed=false |
| 3 | the saved stroke is in the database | PASS | elements=1 |

## Teacher journey
`journey4-results.json`: **10/10**

| # | Control / behaviour verified | Result | Measured detail |
|---|---|---|---|
| 1 | setup: the student saved a board (student rectangle + AI ellipse) | PASS |  |
| 2 | the teacher opens the student's submission page and the board renders | PASS |  |
| 3 | the board shows the student's dark strokes AND the AI's teal-edged ellipse (authorship is visible) | PASS | {"teal":241,"dark":145} |
| 4 | the teacher's attempts to draw or delete change nothing in the database | PASS |  |
| 5 | and the teacher page sent no write requests at all | PASS | [] |
| 6 | API: the teacher cannot PUT to the student board endpoint | PASS | status 403 |
| 7 | API: the board is unchanged after that attempt | PASS |  |
| 8 | API: the teacher cannot read a student's board in a course they don't teach | PASS | status 404 |
| 9 | API: the teacher's view of their own student includes the scene and the AI authorship metadata | PASS | status 200, elements=2 |
| 10 | after the student's later save, the teacher's reload shows the new content | PASS | elements=3 |

## Live Voice (real relay, fake provider, fake microphone)
`journey5-results.json`: **13/13**

| # | Control / behaviour verified | Result | Measured detail |
|---|---|---|---|
| 1 | the UI shows a connecting state first, then Listening only after the provider connection exists | PASS | (no connecting text seen) |
| 2 | the browser opened the relay WebSocket on the app origin (not directly to the provider) | PASS | ["ws://localhost:8000/api/v1/smartboard/live","ws://localhost:8000/api/v1/smartboard/live"] |
| 3 | the relay connected to the (fake) provider exactly once, with the key in its handshake | PASS | {"connected":1} |
| 4 | the provider received the SERVER's setup (pedagogical rules present, client-supplied text absent) | PASS |  |
| 5 | microphone audio chunks really flowed browser -> relay -> provider | PASS | chunks=20 |
| 6 | provider audio came back and the UI reflects a live conversation (no error state) | PASS | Listening to you… |
| 7 | ending the call closes the provider connection | PASS | {"connected":1,"closed":1} |
| 8 | and microphone audio stops flowing (the capture is really released) | PASS | chunks 25 -> 25 -> 25 |
| 9 | the provider dropping mid-session is reported to the user (not left looking connected) | PASS | Session ended |
| 10 | after the drop the browser has stopped capturing/sending audio | PASS | chunks 3 |
| 11 | a forged token never reaches the provider (relay or API refuses first) | PASS | {"mode":"ok","connected":0,"closed":0,"audio_chunks":0,"paths":[],"setup_has_server_rules":false,"setup_has_cl |
| 12 | microphone denied: the user is told so | PASS | No microphone was found. |
| 13 | microphone denied: the provider session is closed, not left running | PASS | {"connected":1,"closed":1} |

## Performance and stability
`perf-results.json`: **12/12**

| # | Control / behaviour verified | Result | Measured detail |
|---|---|---|---|
| 1 | server accepts a large board (1,800 elements) | PASS | HTTP 200, request 767 KB, 144 ms |
| 2 | server returns it quickly | PASS | 108 ms, 1800 elements |
| 3 | drawing on a 1,800-element board is not disproportionately slower than on an empty board (same 30-move stroke) | PASS | large 4879 ms vs empty 4601 ms (+6%); absolute numbers are inflated by software-rendered headless Chromium |
| 4 | autosave of the large board completes and is confirmed | PASS | ~1940 ms after the stroke |
| 5 | the new stroke is in the database next to the 1,800 existing elements | PASS |  |
| 6 | only a bounded number of saves were sent for one stroke (no save storm) | PASS | scene_rev=2 |
| 7 | reload cycle 1: the large board renders | PASS | 4160 ms |
| 8 | reload cycle 2: the large board renders | PASS | 3174 ms |
| 9 | reload cycle 3: the large board renders | PASS | 3489 ms |
| 10 | reload cycle 4: the large board renders | PASS | 3123 ms |
| 11 | JS heap does not grow without bound across 4 reload cycles | PASS | heap MB per cycle: 87 -> 87 -> 87 -> 87 |
| 12 | no uncaught page errors on the large board | PASS |  |

## Simulation sandbox (real Chromium, production sandbox/CSP/loop-guard modules)
`sim-e2e-results.json`: **33/33**

| # | Behaviour verified | Result | Measured detail |
|---|---|---|---|
| 1 | animation advances over real time | PASS | t 0.03 -> 0.76 |
| 2 | the bob is really drawn and MOVES on the canvas | PASS | bob x 147.7 -> 119.9 |
| 3 | slider changes the model (period recomputed) | PASS | period 2.18 -> 2.81 |
| 4 | pause stops time | PASS | t 1.63 -> 1.63 |
| 5 | resume continues time | PASS |  |
| 6 | reset restarts the simulation | PASS | t after reset 0.08 |
| 7 | escape attempt blocked: parentDoc | PASS | parentDoc=blocked:SecurityError |
| 8 | escape attempt blocked: topDoc | PASS | topDoc=blocked:SecurityError |
| 9 | escape attempt blocked: localStorage | PASS | localStorage=blocked:SecurityError |
| 10 | escape attempt blocked: cookie | PASS | cookie=blocked:SecurityError |
| 11 | escape attempt blocked: indexedDB | PASS | indexedDB=blocked:SecurityError |
| 12 | escape attempt blocked: topNavigate | PASS | topNavigate=blocked:SecurityError |
| 13 | escape attempt blocked: popup | PASS | popup=blocked |
| 14 | escape attempt blocked: fetch | PASS | fetch=blocked:TypeError |
| 15 | escape attempt blocked: img | PASS | img=blocked |
| 16 | escape attempt blocked: script | PASS | script=blocked |
| 17 | escape attempt blocked: ws | PASS | ws=blocked |
| 18 | parent page was not navigated by the sandboxed frame | PASS | about:blank |
| 19 | no popup window was opened | PASS | open pages: 1 |
| 20 | NOTHING reached the network listener (fetch/img/script/ws/form/nav/popup) | PASS | [] |
| 21 | CONTROL (CSP stripped): the same attack DOES reach the network, so the CSP is what blocks it | PASS | reached: ["/fetch","/img.png","/x.js","/ws"] |
| 22 | CONTROL (CSP stripped): the sandbox attribute alone still blocks parent/storage/cookie access | PASS | parentDoc=blocked:SecurityError / topDoc=blocked:SecurityError / localStorage=blocked:SecurityError / cookie=b |
| 23 | control: an UN-sandboxed page can reach the listener (so the zero above is meaningful) | PASS | ["GET /control"] |
| 24 | validator blocks: <script>window.parent.x</script> | PASS |  |
| 25 | validator blocks: <script>localStorage.a=1</script> | PASS |  |
| 26 | validator blocks: <meta http-equiv=refresh content="0;url= | PASS |  |
| 27 | validator blocks: <iframe src=x></iframe> | PASS |  |
| 28 | validator blocks: <script>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | PASS |  |
| 29 | CONTROL: parent ticks normally with a well-behaved simulation | PASS | ticks 9 -> 25 |
| 30 | runaway while(true) in a script no longer freezes the tab (loop guard) | PASS | parent ticks 4 -> 19  (-1 = tab stopped responding) |
| 31 | runaway for(;;) no longer freezes the tab | PASS | parent ticks 4 -> 19 |
| 32 | runaway loop inside an inline onclick handler no longer freezes the tab | PASS | parent ticks 4 -> 19 |
| 33 | a legitimate per-frame loop keeps running past the guard limit (no false positive) | PASS | frames 81 -> 214 over ~2.2s, longer than the 1500ms limit |

**Total recorded assertions: 194/194 passed.**

## Controls NOT covered by an assertion above
- **Dedicated highlighter tool:** the native board has none (tools are select, hand, rectangle, diamond, ellipse, arrow, line, pencil, text, image, eraser, lock, "more tools"). The legacy board is not exercised by these journeys.
- **"More tools" dropdown contents and the image-insert tool dialog** (upload from disk) were not driven.
- **Opacity slider, fill/stroke-style/sloppiness/edges/layer-order buttons** in the style panel were not individually asserted; only stroke colour and drawing were.
- **Student submit/verification flow, Live Voice board tools executed from a real provider tool call** (unit-tested only), and **Realtime-driven live sync** (no Realtime server locally).
- **Right-to-left/Arabic UI and screen-reader behaviour** were not tested.
