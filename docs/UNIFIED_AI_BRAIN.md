# SocratiQ Unified AI Brain: architecture, changes and what remains

Scope: make Chat, SmartBoard and Live Voice one educational system. The LangGraph Coach and its validator stay the single pedagogical
authority; every other channel is a client of the same facts and rules. No migrations, no deleted data, no new dependencies.

## 1. What the audit found (verified in the code, and where noted, against a real Postgres)

| # | Gap | Evidence |
|---|-----|----------|
| 1 | Board visual generation (`/generate-diagram`, `-image`, `-simulation`, `-vector`) had **no assignment, no policy and no pedagogy**. A student could ask the board for "the full solution to question 2" and get it as a diagram or simulation. | Request bodies held only a prompt. |
| 2 | Legacy board chat (`/smartboard/chat`) **never persisted anything**: its telemetry insert used values the schema's CHECK constraints reject (`SMARTBOARD_GUIDANCE`, `SUGGESTION`, `GUIDED_PRACTICE`) and the error was swallowed. | Real-DB probe: `messages`, `ai_interactions`, `ai_sessions` all empty after a successful turn. The old mock-only test asserted the impossible INSERT. |
| 3 | Live Voice telemetry wrote an **invented diagnosis** (`CONCEPTUAL_GAP`, 0.9) that fed the student's learning memory and the teacher's diagnosis breakdown, and tried to open sessions with policy `SOCRATIC` (not a valid value). | `smartboard.py` (old), `memory.py` recurring-mistakes query. |
| 4 | Live had no assignment **policy**, no Chat transcript, no Coach diagnosis, no board; its speech was only logged (student speech at INFO) and never stored. | Relay setup code. |
| 5 | Legacy chat used its own one-line pedagogy rule instead of the assignment policy. | Old `pedagogy_and_language` block. |
| 6 | Live relay leaked a concurrency slot and a provider socket if the client left during the provider handshake; a provider that hung up right after setup was reported as "all keys failed". | 3 baseline failures in `test_live_voice_lifecycle.py`. |

## 2. The design

```
                       +-------------------- ai/brain (pure, no network) ---------------------+
  Chat  --------------> LangGraph Coach + coach_validator   policy.py        visual_gate.py
  Board ask ----------> (same Coach)                        policy_directive  review_visual_request
                                                                              review_generated_text
  Board generate -----> gate (request) -> provider -> gate (shown text) --+   review_visual_with_llm (optional)
  Legacy board chat --> Brain context + enforcement on reply              |
  Live Voice ---------> Brain context (setup) + post-hoc audit            |
                       +---------------- backend/app/brain.py ----------------+
                         load_brain  ->  session (policy from the ASSIGNMENT), shared transcript,
                                         Coach's last real diagnosis, learning memory, stored board
                         brain_context_text  ->  bounded, sanitised instruction block
                         record_channel_exchange -> messages + learning_events (channel tagged)
```

* **One policy source.** `ai/brain/policy.py` renders GUIDED/ASSISTED/OPEN once. Unknown or missing = GUIDED (strictest).
* **One shared transcript.** Board and Live exchanges are written to `messages` for the session the Chat already uses, so the Coach's next turn (`history`) includes them.
* **Honest evidence.** Non-Coach channels never write `ai_interactions` and never invent a diagnosis; they write a `learning_events` `AI_INTERACTION` event tagged `payload.channel` (`board_chat`, `board_generate`, `live`). Coach-only readers (revision baseline, board-change baseline, prior diagnosis) ignore those events. They do not touch `turn_count`.
* **The board cannot bypass the Chat.** Every student generation call is reviewed before a provider is called. A refusal is HTTP 422 `coach_redirect` carrying a Socratic reply (English or Arabic) and is recorded in the transcript. A student who sends no `assignment_id` gets the strictest policy. Generated diagram labels are re-checked with the Coach's own `final_answer_enforcement`.
* **Legacy board chat** now runs on the brain context and its reply goes through the same enforcement; a reply that reveals the answer is replaced by a redirect and its board writes are dropped.
* **Live Voice** starts from the same context and policy; transcripts are accumulated server-side (bounded) and stored when the session ends. Live audio cannot be validated before it plays, so the Coach's words are audited afterwards and a finding is stored as `payload.flags` (not as a student risk signal).
* **Frontend.** Every generation call carries `assignment_id`; the board shows the Coach's redirect text instead of the generic failure; Live tools return the redirect to the model as the tool error.
* **Legacy rows.** Old rows with the invented explanations (`FABRICATED_EXPLANATIONS` in `memory.py`) are skipped by learning memory, the Coach's prior diagnosis and the teacher's diagnosis breakdown. They are NOT deleted.

## 3. Files

New: `ai/brain/{__init__,policy,visual_gate}.py`, `backend/app/brain.py`, `backend/tests/test_unified_brain.py`, `ai/tests/test_brain_policy_and_gate.py`, `frontend/src/lib/unifiedBrain.client.test.ts`, this document.
Changed: `backend/app/routers/smartboard.py` (gate, chat, Live, handshake fixes), `routers/ai.py` (`_read_turn` uses the shared helpers), `memory.py`, `analytics.py`, `records.py`, `frontend/src/lib/{queries,geminiSmartBoardService}.ts`, `lib/smartboard/{glue,liveToolHandler}.ts`, `components/smartboard/SmartBoardWorkspace.tsx`, `components/socratiq/BoardWorkspace.tsx`, two backend tests (see Verification).

## 4. Verification (what was actually run)

Baseline before changes: backend/AI/DB 870 passed, 15 skipped, **3 failed** (Live lifecycle). After:

* Backend + AI + database suites: **967 passed, 0 failed, 15 skipped**, three consecutive full runs (real local Postgres 16 + pgvector).
* New real-DB tests: 21 (board chat persistence, Chat sees board exchanges, no invented diagnosis, gate on all four generators, no-assignment bypass, Arabic redirect, withheld diagnosis labels, cross-student 404, teacher unaffected, policy in the board prompt, legacy rows ignored, Live setup carries policy/history, Live transcript persisted, Live audit flag, Live never logs speech).
* New unit tests: 74 (policy normalisation, 17 refusal phrases x 3 policies, allowed conceptual visuals, GUIDED vs OPEN, language of the redirect, generated-text recheck, optional LLM stage with a stub).
* Frontend: `tsc -b` clean; vitest 770 passed, 1 failed. The failure (`BoardToolFixes.test.tsx` image generation) is **pre-existing**: jsdom has no `canvas.toDataURL`; it fails identically on the untouched upload.
* Two old tests were changed on purpose: the grounding test now supplies a brain; `test_smartboard_chat_telemetry_recording` was removed because it asserted an INSERT the schema rejects (replaced by the real-DB tests).

NOT verified (no keys/browser here): real Gemini text, Imagen/image generation, Gemini Live audio, the LLM review stage, any real-browser/Excalidraw behaviour of the new redirect UI. The Live model id in the relay (`models/gemini-3.8-live`) was left untouched and is unverified.

## 5. Known limits and what remains

1. The request gate is phrase-based (English + Arabic). A determined student can paraphrase around it. The optional LLM stage (`review_visual_with_llm`, reusing the Coach validator) is wired into the gate behind `BRAIN_VISUAL_LLM_REVIEW=1` (off by default) and tested only with a stub reviewer, never a real provider.
2. Image, simulation and vector outputs are gated on the *request* only; only diagram labels are re-checked after generation (an image or simulation body is not inspected).
3. Live audio is audited after the fact; it cannot be stopped mid-sentence. Tool calls from Live go through the gated endpoints.
4. The Coach does not yet *propose* visuals (a `visual_offer` in its reply with a server-signed grant). Today the Coach can write on the board via `board_actions`; diagram/simulation/image generation is still student- or Live-initiated. This is the main remaining piece of "know when to draw".
5. Prompt wording is still duplicated: `response_prompt.py` (Chat) and `ai/brain/policy.py` (other channels) state the same rules separately. A test pins the universal rule in the shared directive, but the Chat prompt does not yet import it.
6. Chat history rows are not tagged by channel in the Coach prompt (a spoken or board turn looks like any turn); the channel is in the event payload for teachers.
7. Teacher dashboards count Coach turns from `ai_interactions`, so board/Live-only usage is not in "coach turns" (it is in the learning timeline).
8. Optional cleanup for old invented rows (NOT executed): `SELECT count(*) FROM ai_interactions WHERE diagnosis_explanation IN ('SmartBoard Live Voice interaction','SmartBoard AI collaborative interaction');`
9. Class-wide and teacher-facing unification (teacher authorship of board guidance, classroom mode) is out of scope here.


## 6. Coach-initiated visuals (autonomous teaching, still under the Coach's authority)

Decision (the owner chose "Option B"): the Coach may place a diagram or simulation on the board WITHOUT waiting for the student to ask. It is a controlled
extension of the existing Coach path (the same pattern as `board_actions`), not a side door.

### 6.1 Flow

```
 student message --> Coach graph (diagnose -> choose intervention -> generate_response -> validate)
   generate_response: the Coach may return `visual_plan` {kind, request, why, explore_prompt, concept} in the SAME structured output as its reply,
                      only when the server enabled visuals this turn (client can show one AND budget allows). Kept only if eligible + reviewed.
   validate:          the SAME validator judges reply + plan text together; deterministic last-line enforcement; the plan is cleared whenever the
                      reply is rewritten, blocked, or replaced by the safe fallback.
 backend _persist_turn (inside the turn's transaction, under the session lock): the server decides AGAIN (opt-in, budget, eligibility, review),
                      records a `coach_visual/planned` event, issues a signed single-use GRANT and returns `visual` next to the reply.
 board: redeems the grant at /smartboard/generate-simulation | -diagram. The server draws the STORED, reviewed plan, ignores any text the client
        sends, re-reviews it under the current policy, re-checks the labels of what was generated, records started -> created | failed | withheld.
 next Coach turn: receives a short follow-up note about the visual it placed, so it asks what the student noticed instead of repeating or forgetting it.
```

### 6.2 What enforces each requirement

| Requirement | Enforcement (all server-side) |
|---|---|
| Decision comes from the Coach's pedagogical reasoning | `visual_plan` is part of the Coach's own structured output; the frontend never triggers generation, it only carries a server grant. |
| Relevant to lesson, assignment, level, conversation | Generated in the same call that sees the assignment, diagnosis, memory, history and board; only for diagnoses a picture helps (MISCONCEPTION, CONCEPTUAL_GAP, INCOMPLETE_REASONING, PROCEDURAL_ERROR) and moves (QUESTION, HINT, EXPLANATION, CLARIFICATION); never for assignment-understanding requests; `ai/brain/visual_plan.py::eligibility`. |
| Policies, safety, Socratic principles | Same validator + `final_answer_enforcement` judge the plan with the reply; the same visual gate a student's request meets (`review_plan`); GUIDED is the default; nothing is drawn if the plan asks for or displays the answer; checked at plan time, at persist, at redemption, and on generated diagram labels. |
| Explains why and guides exploration | Plan requires `why` and `explore_prompt`; the prompt instructs the Coach to introduce the visual in its reply, not pre-announce the conclusion, and ask the student to notice something. The next turn gets a follow-up note. |
| Chat and Board stay synchronized | The introducing reply is a normal Chat message; the board shows the visual; failures/withholds are written to the shared transcript; a status chip on the message says pending / placed / failed. |
| No unnecessary visuals | Rare by prompt; hard budget of 3 per attempt and at least 3 Coach turns between visuals, computed from recorded events (not the client); not offered to the model outside the budget. |
| Student stays in control | The visual is ordinary board content: movable, editable, deletable, undo removes it in one step. |
| Validated, permission-checked, recorded | Grant = HMAC over student + attempt + kind + plan hash + expiry (10 min); single use; student-only; dies with its attempt; editing the stored plan invalidates it; every stage is an append-only `learning_events` row (`channel=coach_visual`, stages planned/started/created/failed/withheld); coach element ids are signed and registered. |
| Coach authority not weakened | There is no path that skips the validator: no plan is ever drawn from a model output alone, and a rewritten/blocked reply removes its visual. |

### 6.3 Files

New: `ai/brain/visual_plan.py`, `ai/tests/test_coach_visuals.py`, `backend/tests/test_coach_visuals.py`, `frontend/src/lib/coachVisuals.client.test.ts`, `frontend/src/pages/student/AiCoach.visuals.test.tsx`.
Changed: `ai/agents/coach/{schemas,state,nodes,graph}.py`, `ai/prompts/coach/response_prompt.py`, `ai/models/schemas.py`, `backend/app/{ai_adapter,brain,board_auth,schemas,analytics}.py`, `backend/app/routers/{ai,smartboard}.py`, `frontend/src/lib/{queries.ts,smartboard/glue.ts}`, `frontend/src/components/smartboard/SmartBoardWorkspace.tsx`, `frontend/src/pages/student/AiCoach.tsx`.
No migrations: the stages are new `payload` shapes of existing `AI_INTERACTION` events. Coach-only readers already ignore `channel != coach`.

### 6.4 Verification

Backend + AI + database: 1015 passed, 0 failed, 15 skipped (28 + 20 new). Frontend: `tsc -b` clean; 778 passed, 1 pre-existing jsdom failure (BoardToolFixes image test, identical on the untouched upload); 8 new.
New tests cover: plan parsing/clipping, eligibility table, budget, review, prompt only mentions visuals when allowed, plan survives/dropped in the graph, validator sees the plan, rewrite/block/fallback clear it, server drops answer-revealing plans even if the Coach proposed them, client opt-in, 3-per-attempt and cooldown across real turns, grant redemption draws the stored plan not the client's text, single use, forged/tampered/foreign/teacher/wrong-kind grants, plan bound to grant, expiry, closed attempt, failure and withheld paths reach the Chat, follow-up note, no disturbance of Coach baselines, teacher timeline wording, and the page-level hand-off (board open / Chat view / failure / no visual / engine without support).

### 6.5 Limits and what remains

1. Whether the Coach DECIDES well (good moments, good plans) depends on the real model and the new prompt section. Only the rules around that decision are tested; no real model was run. Expect to tune the prompt wording with real transcripts.
2. In Chat view a visual is drawn when the student opens the board (a hidden board has no viewport). It is not drawn into a closed page.
3. A grant is single use: if the network fails mid-redemption the visual is not retried automatically (the failure is recorded and said in the Chat; the student can still ask for a visual, or the Coach can propose another once the cooldown passes).
4. Image and drawing generation are never Coach-initiated. Only diagrams and simulations (a graph is a simulation).
5. The legacy board engine cannot show Coach visuals; there the Coach is never offered the option.
6. Only diagram labels are re-checked after generation; a simulation's body is not inspected (same limit as section 5.2).
7. Coach-drawn visuals reuse the board's existing AI-drawing path for placement; their provenance is the signed element id plus the recorded event. Verifying that id when the board is saved uses the existing registered-id check, but its end-to-end behaviour in a real browser was not run.
8. The cooldown and cap are constants in `ai/brain/visual_plan.py` (3 per attempt, 3 turns apart), not teacher settings.
