# Unified Brain Architecture, v2 (delta on `UNIFIED_AI_BRAIN.md`)

The v1 design stands: one LangGraph Coach as the only pedagogical authority; Chat, Board and Live Voice are interfaces to it over one shared transcript, one policy and one student memory. This iteration adds:

```
Student UI ──(choose style)──► PUT /student/teaching-personas ──► student_preferences (RLS)
                                                                        │ read server-side on every turn, never from the client
Chat  /ai/coach[/stream] ─┐                                             ▼
Board /smartboard/chat   ─┼─► Brain context ─► policy directive (canonical, ai/brain/policy.py)
Live  /smartboard/live   ─┘                    persona directive (style only, ranks BELOW policy)
                                               Coach graph: diagnose ► choose_intervention ► retrieve (course ∥ history) ► generate ► validate ► enforce
                                               (concept-aware repeat detection, strategy shift)
                              validated reply ─► persist once (+persona, +diagnosis_concept, +client_turn_id) ─► content_delta* ─► final(+timings)
```

## Components added
| Component | Role |
|---|---|
| `ai/brain/personas.py` | typed persona registry, `persona_directive`, `persona_ref` (id + version) |
| `ai/brain/adaptation.py` | `is_repeated_difficulty`, `strategy_shift_note` (pure) |
| `ai/brain/policy.py::policy_rules_block` | the Chat prompt's policy text, rendered from the same constants Board/Live use (response prompt v4) |
| `backend/app/personas.py` | load/save the choice, record changes on the timeline |
| `backend/app/streaming.py` | `segment_text`, `StageTimer`, `LATENCY` |
| `database/migrations/017_teaching_personas.sql` | `student_preferences`; `ai_interactions.persona_id/persona_version/diagnosis_concept` |
| `PersonaSelector`, `ResizableSplit`, `useMediaQuery` | frontend |

## Contracts
- **Persona**: `{id, version}`; unknown read -> default; unknown write -> 422; never part of a Coach request body.
- **Stream**: `stage* -> content_delta* -> final | error` (see PERFORMANCE_AND_STREAMING_REPORT.md). `client_turn_id` is optional and per message.
- **Events**: Coach events carry `persona`; Board/Live events carry `persona` in their payload; a persona change is `AI_INTERACTION` with `channel: persona`, `stage: changed`, `from`, `persona`. Existing readers filter by channel and are unaffected; the teacher timeline labels it.

## Invariants (each covered by a test)
Persona never alters policy, diagnosis or intervention; same policy block under every persona; persona switch keeps the session, transcript and memory; failed turns store nothing; a retried turn stores nothing twice; Live/Board invent no diagnosis.

## Not changed
Live Voice transport/protocol/model; the validator and answer-leak rules; existing migrations; RLS of existing tables; branding.
See DATA_COLLECTION_AND_INTEGRITY_REPORT.md, TEST_AND_VERIFICATION_REPORT.md and REMAINING_RISKS.md for what is and is not verified.
