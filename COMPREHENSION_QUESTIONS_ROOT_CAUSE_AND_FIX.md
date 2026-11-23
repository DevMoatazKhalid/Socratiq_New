# Comprehension Questions — Root Cause and Fix

**Date:** 2026-11-23 · **Scope:** the three post-submission verification questions (Explain → Modify → Transfer) · **Status:** fixed in the AI layer, wired through the adapter and router; AI-layer regression suite green (96 tests); backend suite to be run on the dev machine (see §7).

---

## 1. Root cause

The production question **"Why does anatomy of the kidney work in your solution?"** was not written by the model. It is, character for character, the output of a hard-coded fallback template in `ai/verification/service.py`:

```python
except Exception as exc:
    logger.exception("Challenge generation failed, returning fallback challenge.")
    ...
    else:
        fallback_question = f"Why does {request.concept} work in your solution?"
```

`request.concept` was `"anatomy of the kidney"` (the assignment's first linked concept), so whenever the model call failed (timeout, quota, a structured-output parse error) the student got a sentence that treats a *subject of study* as a *mechanism* and refers to a *solution* that an anatomy essay does not have. The other two fallbacks had the same flaw ("What changes if anatomy of the kidney is modified or reversed?", "Where else could you apply anatomy of the kidney?").

The template was one symptom of a pipeline with five compounding defects:

| # | Where | Defect | Effect |
|---|---|---|---|
| 1 | `service.py` fallback | Interpolates a topic name into frames that only make sense for a mechanism in code. Errors were logged and swallowed, so outages were invisible. | Exact source of the kidney question; reproducible for **every** subject (see §8). |
| 2 | Context (`ai_adapter.generate_challenge`) | The model received only the assignment *instructions* (≤4,000 chars) and the raw student submission. **No course material was retrieved**, although the Coach already has a scoped RAG retriever. | The model had little more than a concept *name* to ground on, so it tended to bolt that name onto the student's text. |
| 3 | Prompts (`strategies/*.py`) | Every strategy framed every subject as programming: "explain *why* something works or why a choice was made in their work", "what changes in their solution". Lesson and student work were passed under loose labels, the student work was unwrapped, and a **5–12 word** cap forced the model to compress ideas into telegraphic questions. | Even successful generations drifted toward "…in your solution" phrasing for anatomy, chemistry or writing, and toward awkward compressed grammar. |
| 4 | Generation / validation (`service.py`) | `payload.question` was shown as-is: no check for grammar, a single question, relevance, answerability or duplicates. No retry. The three questions were generated independently, so none knew what had already been asked. VERIFICATION ran at temperature 0.5. | Nothing stood between a bad draft and the student; questions could repeat each other. |
| 5 | Concept selection (`routers/verification.py`) | `ORDER BY k.name LIMIT 1` — the alphabetically first concept, not the one the lesson teaches. | Arbitrary targets (e.g. "arguable claim" instead of "thesis statement"). |

**The test suite enforced the defect.** `ai/tests/test_verification.py::test_generate_challenge_fallbacks_are_concise_and_distinct` asserted that fallbacks contain the raw concept, are 5–12 words and that the Explain one contains "why"; `backend/tests/test_ai_contract.py::test_challenge_generation_failure_falls_back_to_a_valid_question` asserted `"work in your solution" in q`. Both are rewritten to assert the new standard (§6).

## 2. Existing generation architecture (as found)

```
POST /student/assignments/{id}/verification            backend/app/routers/verification.py
  _concept(): first concept by name  ->  submission_text
  -> AIAdapter.generate_challenge(assignment, concept, type, student_work)   backend/app/ai_adapter.py
       course_context = instructions[:4000]  (no RAG)
       -> VerificationService.generate_challenge()        ai/verification/service.py
            strategy.build_challenge_prompt()              ai/verification/strategies/{explain,modify,transfer}.py
            get_structured_llm(VERIFICATION, GeneratedChallengePayload).invoke()   (temp 0.5, no retry)
            on ANY exception -> f-string template fallback
  -> INSERT verification_questions (one row per step; the next step is generated after each answer)
frontend shows `current.question`
```

## 3. Prompt improvements

New shared prompt: `ai/prompts/verification/question_generation_prompt.py` (v2). Each strategy now contributes only its **purpose**:

| Step (DB value kept) | Purpose | Asks the student to… |
|---|---|---|
| EXPLAIN | Core understanding | explain the main idea of the concept as taught, in their own words (no rote definition) |
| MODIFY | Reasoning | explain why something in the lesson happens, how two related lesson ideas connect, or what changes when **one** condition the lesson describes is altered |
| TRANSFER | Application | apply the concept to one concrete, simple new case that needs only what was taught |

Rules every question must follow (excerpt): ground in the LESSON section; target one listed concept; *a topic name is not a mechanism — never ask why a topic "works"*; refer to "your solution/code" **only** if the student submitted code or a worked solution (the prompt states what was submitted: code / worked maths / prose / nothing); one direct, grammatical question of about 8–30 words, answerable in 1–3 sentences; no multiple choice; match the material's depth; differ from the earlier questions (listed); 2–3 criteria checkable against the lesson; return `target_concept` and `lesson_basis` (the statement a correct answer relies on). The kidney question is included as an explicit rejected example. Lesson and student work are delimited **DATA** blocks. A thin-context note is added when the lesson text is under 200 characters. On a retry the prompt switches to STRICT MODE and lists each rejected draft with its reasons. Arabic lessons are asked for in Arabic.

## 4. Context-handling improvements

* **Lesson material is retrieved** (`AIAdapter._lesson_material`) with the same trusted `RetrievalScope` as the Coach (university, course, classroom, assignment, document whitelist from `allowed_document_ids`); up to 4 excerpts. Failure degrades to instructions-only, never blocks.
* **One bounded `LessonContext`** (`ai/verification/question_context.py`) shared by generator, gate and reviewer: sanitized, capped title / instructions / material / student work; classified work kind; previous questions; whether the context is substantive.
* **Concept choice**: all assignment concepts are passed; the context picks the one best grounded in the lesson text, and later steps prefer concepts earlier questions have not covered. The model may pick another *listed* concept; anything else is coerced back. The **stored** concept keeps its original spelling (`gradient_descent`), because it keys `student_concept_state`; the student only ever sees the humanized form.
* **Earlier questions of the run** are loaded from `verification_questions` and passed to every step.
* VERIFICATION default temperature lowered to **0.2** (`ai/config.py`; still overridable with `AI_TEMPERATURE_VERIFICATION`).

## 5. Validation and retry strategy

```
LessonContext ─► generate ─► deterministic gate ─► semantic review ─► ACCEPT
                    ▲              │ error            │ reject
                    └── strict retry with reasons ◄───┘   (max AI_VERIFICATION_QUESTION_MAX_ATTEMPTS, default 2)
provider error, attempts exhausted, or time budget spent ─► validated safe fallback
```

**Layer 1 — deterministic gate** (`ai/verification/question_quality.py`), errors reject:
empty / too vague / too long; not a question, several questions, text after the "?"; lowercase start; placeholders; raw `snake_case` (warning only in code lessons); repeated words; multiple choice; meta text; **legacy templates** (any "Why does … work in your …?"); **topic-as-mechanism** ("Why/How does *the anatomy/history/theory of X* or *the lesson's own subject/title* work/function?"); **mismatched frame** ("your solution/code/derivation…" without a submitted solution, "your answer/work" with no submission); **duplicate** of an earlier question (token Jaccard ≥ 0.6 including framing words, or sequence ratio ≥ 0.8).

Vocabulary overlap is **not** used as the relevance decision. It produces *hints* (`no_anchor`, `foreign_terms`) that are handed to the reviewer. Only if the reviewer is unavailable does `no_anchor` block, and only for a substantive lesson.

**Layer 2 — semantic review** (`ai/verification/question_review.py`, prompt `ai/prompts/verification/question_review_prompt.py`): the reviewer sees the same lesson and returns eight booleans — grounded, single clear question, natural language, **concepts coherent**, answerable from lesson, level appropriate, distinct from previous, matches purpose — plus problems and a verdict. ACCEPT requires every check. This is where "combines unrelated concepts" is decided.

**Cost and latency bounds:** at most 2 generations + 2 reviews per question by default; a draft rejected by the gate never reaches the reviewer; a provider error is **not** retried; no new attempt after 50 s (adapter timeout is 90 s). A reviewer outage never blocks the student (gate-only, logged).

**Safe fallback:** plain frames that are grammatical for any noun phrase because the concept appears as a quoted label (`the topic "nephron"`), never mention a solution, exist in English and Arabic, and are themselves run through the gate (a second variant, then a concept-free variant, if needed). Every fallback is logged with the reasons, and `VerificationChallenge.source` / `quality_notes` record `generated` / `regenerated` / `fallback` (not persisted; no migration).

## 6. Files modified

| File | Change |
|---|---|
| `ai/verification/service.py` | New generation loop (gate → review → bounded strict retry → validated fallback); payload gains `target_concept`, `lesson_basis`; env settings. Evaluation (`verify`) unchanged. |
| `ai/verification/models.py` | `VerificationChallengeRequest`: optional `assignment_title`, `subject_area`, `is_programming`, `lesson_material`, `candidate_concepts`, `previous_questions`. `VerificationChallenge`: `source`, `quality_notes`. All optional → backward compatible. |
| `ai/verification/question_context.py` | **New.** Lesson context, concept choice, work-kind classification. |
| `ai/verification/question_quality.py` | **New.** Deterministic gate. |
| `ai/verification/question_review.py` | **New.** Reviewer schema, safe fallbacks, concept coercion. |
| `ai/prompts/verification/question_generation_prompt.py` | **New.** Generation prompt v2. |
| `ai/prompts/verification/question_review_prompt.py` | **New.** Reviewer prompt. |
| `ai/verification/strategies/base.py`, `explain.py`, `modify.py`, `transfer.py` | Strategies declare purpose; shared prompt builder; MODIFY evaluation wording aligned with reasoning questions (outcomes and score bands unchanged). |
| `ai/config.py` | VERIFICATION default temperature 0.2. |
| `backend/app/ai_adapter.py` | `generate_challenge` accepts optional `candidate_concepts`, `previous_questions`, `allowed_document_ids`; retrieves lesson material; `AIAdapter(course_retriever=…)`; `build_ai_adapter` passes the existing retriever. |
| `backend/app/routers/verification.py` | Passes all assignment concepts, earlier questions of the run and the allowed document ids. Response shape and DB writes unchanged. |
| `ai/evaluation/fixtures/comprehension_lessons.py` | **New.** 10 lessons across subjects + hard cases, good and bad questions. |
| `ai/tests/test_comprehension_question_quality.py` | **New.** Regression suite. |
| `ai/tests/test_verification.py` | Three tests that encoded the defect rewritten to the new standard. |
| `backend/tests/test_ai_contract.py` | Fallback test no longer requires "work in your solution"; real flow now asserts three distinct stored questions. |
| `scripts/eval_comprehension_questions.py` | **New.** Live-model evaluation over the same lessons. |
| `.env.example` | New settings documented. |

No database migration. The three-step UX, the `/verification` endpoints, answer submission, evaluation, evidence and mastery updates are unchanged.

## 7. Test cases and actual results

**AI layer — run in this session: 96 passed, 0 failed** (`test_comprehension_question_quality.py` 85 incl. parametrized cases, `test_verification.py` 11). The model is scripted in these tests: they pin the pipeline's behaviour, not a model's wording.

| Group | What is verified |
|---|---|
| Kidney regression | the exact production question is rejected with `legacy_template`, `topic_as_mechanism`, `mismatched_frame`; as a model draft it is never shown — the retry prompt carries it as a rejected draft and the second draft is used |
| Failure family (22 cases, 9 subjects × 3 steps) | paraphrases and cross-subject variants, e.g. "How does the anatomy of the kidney function in your answer?", "Why does linear algebra work in your derivation?", "Why does net force work in your essay about Rome?" — all rejected |
| Good questions (10 lessons × 3 steps) | subject-appropriate questions pass, in sequence, without being flagged as duplicates |
| Over-rejection guard (13) | legitimate questions pass: "Why does binary search work only on sorted lists?", formulas with θ/α/∇, code identifiers in a programming lesson, "your answer" after a submission, Arabic |
| Structural defects (11) | multiple questions, MCQ, no "?", placeholder, snake_case, lowercase, repeated word, vague, meta text, too long, solution frame |
| Mixed concepts | "How would a Python dictionary speed up the glomerulus…?" → `foreign_terms` hint → reviewer rejects → regenerated |
| Context | work kind per subject; lesson material, earlier questions, delimited student work and "no solution" rule reach the prompt; thin-context note; concept humanized for display but stored in original spelling; grounded concept chosen; later steps move to uncovered concepts |
| Loop bounds | 2 generations max then validated fallback, for every lesson and step; provider outage → 1 call, no retry; reviewer outage → gate-only floor; invented `target_concept` replaced |
| Full runs (10 lessons) | exactly three questions, correct step order, all valid, all distinct; a model that repeats itself still ends with three distinct questions |

Adapter path exercised directly (stubbed DB): material retrieved with scope `university/course/assignment/allowed docs`, reaches the prompt with the earlier questions; old call signature still works.

**Not run here:** the backend suite (`backend/tests`, needs FastAPI, psycopg and Postgres) and live-model generation (no network in this environment). Run on the dev machine:

```bash
pytest ai/tests/test_comprehension_question_quality.py ai/tests/test_verification.py backend/tests/test_ai_contract.py backend/tests/test_e2e_learning_loop.py backend/tests/test_api_core.py backend/tests/test_assessment.py
python scripts/eval_comprehension_questions.py --json comprehension_eval.json    # real model, all subjects
```

## 8. Before and after

**Model-outage path — actual outputs** (before: the previous code; after: the new pipeline with the model unavailable). "Rejected" is the new gate's verdict on the old output.

| Lesson | Step | Before (shown to students) | Gate | After |
|---|---|---|---|---|
| Kidney anatomy | Explain | Why does anatomy of the kidney work in your solution? | rejected: legacy_template, topic_as_mechanism, mismatched_frame | In your own words, what are the key ideas of the topic "anatomy of the kidney" as covered in this lesson? |
| | Modify | What changes if anatomy of the kidney is modified or reversed? | rejected | Which other idea from this lesson is closely connected to the topic "nephron", and how are the two related? |
| | Transfer | Where else could you apply anatomy of the kidney? | rejected | In what real situation would the topic "urine formation" be useful, and how would you apply it there? |
| Eigenvalues | Explain | Why does characteristic equation work in your solution? | rejected | In your own words, what are the key ideas of the topic "characteristic equation" as covered in this lesson? |
| Python data structures | Modify | What changes if dictionaries is modified or reversed? | rejected | Which other idea from this lesson is closely connected to the topic "lists", and how are the two related? |
| Newton's second law | Explain | Why does Newton's second law work in your solution? | rejected | In your own words, what are the key ideas of the topic "Newton's second law" as covered in this lesson? |
| Chemical equilibrium | Explain | Why does Le Chatelier's principle work in your solution? | rejected | In your own words, what are the key ideas of the topic "Le Chatelier's principle" as covered in this lesson? |
| Thesis statements | Explain | Why does arguable claim work in your solution? | rejected | In your own words, what are the key ideas of the topic "arguable claim" as covered in this lesson? |
| Gradient descent (long) | Transfer | Where else could you apply feature scaling? | rejected | In what real situation would the topic "learning rate" be useful, and how would you apply it there? |

The fallback is deliberately plain. It is the floor for outages, not the target.

**Model path — target questions** (the illustrative fixtures the scripted model returns; these pass the gate in sequence. Real model output will differ in wording — use `scripts/eval_comprehension_questions.py` to record it):

| Lesson | Core understanding | Reasoning | Application |
|---|---|---|---|
| Kidney | What are the main structures of the kidney, and what is the role of each? | How does the nephron contribute to the formation of urine? | What would happen to urine formation if the glomerulus could no longer filter blood effectively? |
| Eigenvalues | What does it mean for a vector v to be an eigenvector of a matrix A? | Why must det(A − λI) equal zero for λ to be an eigenvalue of A? | What are the eigenvalues of a diagonal matrix with entries 4 and 7, and why? |
| Python | Why does your function use counts.get(w, 0) instead of counts[w] when adding a new word? | Why is looking up a key in a dictionary faster on average than searching a list for a value? | How would you use a dictionary to find the first repeated character in a string? |
| Physics | What does Newton's second law say about how net force, mass and acceleration are related? | What would happen to the cart's acceleration if the same net force pushed a 4 kg cart instead, and why? | Why does a fully loaded shopping trolley speed up more slowly than an empty one when pushed equally hard? |
| Chemistry | What is true about the forward and reverse reaction rates when a reaction is at equilibrium? | Why does increasing the pressure shift this equilibrium toward the side with fewer moles of gas? | In the reaction H2 + I2 ⇌ 2HI, what effect would increasing the pressure have on the equilibrium, and why? |
| Writing | What makes a thesis statement different from a simple statement of fact? | Why does a thesis need to be arguable for an essay to be persuasive? | How would you turn the fact "many students use phones in class" into an arguable thesis statement? |

## 9. Remaining limitations

1. **Live results not yet recorded.** Everything above is verified with a scripted model; run the eval script against the configured provider to capture real outputs and fallback rates.
2. **Backend tests not run in this session.** The router/adapter changes are small and were exercised directly, but run the backend commands in §7 before merging.
3. **Semantic quality depends on the reviewer model.** The same VERIFICATION model judges its own output, which catches incoherence well but can share its blind spots. A different (e.g. REASONING) model for review is a one-line change if needed.
4. **Cost:** a typical accepted question costs 2 model calls (was 1); worst case 4. Set `AI_VERIFICATION_QUESTION_REVIEW=0` to trade semantic review for cost (the deterministic floor remains).
5. **Level** is inferred from the material; there is no course-level field in the schema. If one is added, pass it in `VerificationChallengeRequest`.
6. **Thin lessons** (no material, short instructions) can only be held to the concept itself; questions there are necessarily more general.
7. **Assignments without materials** get no RAG excerpts; adding materials to assignments improves grounding directly.
8. The gate's grammar checks are heuristic: they catch structural problems, not every awkward phrasing; that is the reviewer's job.
9. Already-stored questions in existing runs are not rewritten; the fix applies to newly generated questions.
