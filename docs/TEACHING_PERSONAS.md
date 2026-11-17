# Teaching Persona Specification (v1)

## Principle
Three layers, kept apart:
- **Teaching intelligence**: diagnosis, intervention, validator (`ai/agents/coach`). Decides what the student needs.
- **Teaching strategy**: assistance level, hint progression, escalation, strategy shift (`ai/brain/adaptation.py`, `choose_intervention`).
- **Teaching persona**: `ai/brain/personas.py`. Decides only how the decision is *said*.

A persona is data plus one rendering function (`persona_directive`). Its text is appended to the Chat prompt **after** the policy block, to the Board/Live
instruction **after** the policy directive, and states that it ranks below every rule above it. It never changes the diagnosis, the intervention type, the
assignment policy, the answer-leak rules or the validator, which judges the final text identically for every persona. Factual "context answers"
(`prepare_context_response`) are persona-neutral by design: grounding outranks style.

Unknown, missing or malformed ids resolve to the default (`socratic_guide`) when **reading**; **choosing** an unknown id is rejected (422).

## The five personas
| id | Name (EN / AR) | Philosophy | Questions | Explanations | Formality | Socratic | Visuals | Voice |
|---|---|---|---|---|---|---|---|---|
| `socratic_guide` (default) | The Socratic Guide / المرشد السقراطي | Understanding you derive lasts | one focused question tied to the student's last step | question first; explain only the missing piece | balanced | high, but a stuck student gets a stronger hint | sketch structure, leave the key step | measured, warm |
| `patient_mentor` | The Patient Mentor / المعلّم الصبور | Safe pace; reduce load first | easy-entry, widening | one step, 2-3 plain sentences, check, move on | casual | medium; firmer hint after frustration or two failures | one simple picture per step | slow, very warm |
| `practical_engineer` | The Practical Engineer / المهندس العملي | Concepts stick when they solve something | testable "what if" | situation, idea, small experiment | casual | medium | block diagrams, quick plots of a *related* system | brisk, warm |
| `critical_thinker` | The Critical Thinker / المفكّر الناقد | Reasoning must survive a fair challenge | justification, counter-example, alternative | restate claim, probe weakest assumption, compare | formal | high, but never challenges a correct claim just to challenge | comparison tables | measured, reserved |
| `visual_explorer` | The Visual Explorer / المستكشف البصري | Many ideas are relationships | read/predict from a picture | describe, point, ask to interpret or change | balanced | medium | strong (board; diagram/simulation when the server grants one) | measured, warm |

Each persona also carries explicit constraints (e.g. Patient Mentor: no generic praise, one new idea per reply; Visual Explorer: never claim a visual exists when
none was placed; Practical Engineer: examples only of *related* problems). `gemini_voice` is `None` everywhere: the Live transport and model configuration were not touched.

## Versioning and attribution
Every persona has an integer `version`. Each Coach interaction stores `ai_interactions.persona_id/persona_version` and the event payload `persona`; Board and Live
events carry the same `persona`. Attribution uses the registry version in force when the turn ran. Changing a persona's wording means bumping its version.

## Student control and persistence
`GET/PUT /student/teaching-personas`. The server reads the stored choice (`student_preferences`), the client never sends a persona with a Coach request, so one
choice applies to Chat, Board and Live Voice and survives reloads and navigation. Switching changes nothing about the session, transcript or learning memory.
When made inside an assignment with an open attempt, the change is a `AI_INTERACTION` event (`channel: persona`) shown on the teacher timeline.

## Adding a persona
Add one `TeachingPersona` entry to `_PERSONAS` (and its Arabic strings). No graph, prompt or migration change is needed. Tests in
`ai/tests/test_personas_and_adaptation.py` enforce completeness, distinctness, Arabic text and the "ranks below the rules" directive.
