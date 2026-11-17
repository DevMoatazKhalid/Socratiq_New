# Socratic Teaching Specification (Verified Implementation)

The existing LangGraph Coach pipeline is the single pedagogical authority across SocratiQ V2: `understand_context` ➔ `diagnose` ➔ `choose_intervention` ➔ `retrieve_context` ➔ `generate_response` ➔ `validate` ➔ `final_enforcement`. No persona or communication channel (Chat, Board, Live Voice) has independent pedagogical decision logic.

## Core Pedagogical Capabilities

### 1. Concept-Level Repeated Difficulty & Strategy Shift
- **Concept Identity Tracking (`ai/brain/adaptation.py::is_repeated_difficulty`):** Previously, *same category OR same concept* counted as "repeated difficulty", causing unrelated misconceptions to escalate assistance prematurely. The algorithm now requires concept identity: both concepts must match (with containment support, e.g. "recursion" within "recursion base case"). If only category matches without concept identity, it is not treated as a repeat. `CORRECT_REASONING` and `UNCERTAIN` are never treated as difficulty.
- **Strategy Shift Directive (`strategy_shift_note`):** When repeated difficulty on the same concept is diagnosed, the generation prompt instructs the model to change its pedagogical representation (using analogy, visual representation, or an illustrative example from a *related* problem where the assignment policy permits) rather than repeating the same explanation with different wording. Under `GUIDED` policy, worked solutions remain strictly prohibited.
- **Persistent Diagnosis Concept (`ai_interactions.diagnosis_concept`):** Stored directly in PostgreSQL via migration 017; legacy records fall back to `referenced_concepts[0]`.

### 2. Time-Aware Confidence Decay (`backend/app/memory.py::compute_confidence_decay`)
- **Retention Modeling:** Exponential decay function based on Ebbinghaus forgetting dynamics:
  $$\text{decay\_factor} = 2^{-\frac{\Delta t}{\text{half\_life}}}$$
  with configurable half-life (default 30 days, configurable per concept category).
- **Evidence Preservation:** The student's recorded historical mastery/score is never overwritten or degraded; only the operational *effective confidence* decays over time.
- **Retention Tiers:**
  - `RECENT`: $\le 7$ days since last evaluation ($\text{decay} \approx 1.0$)
  - `RETAINED`: $\text{decay} \ge 0.70$
  - `DUE_FOR_REVIEW`: $0.35 \le \text{decay} < 0.70$
  - `EXPIRED`: $\text{decay} < 0.35$
- **Graceful Handling:** Handled safely when timestamp is unavailable, defaulting cleanly without crashing.

### 3. Concept Transfer & Spaced Review Scheduling (`schedule_concept_transfers`)
- Identifies concepts ready for transfer challenges: concepts with high historical mastery ($\ge 0.70$) that are due for spaced review or need validation in novel application contexts.
- Surfaces structured recommendations in the Coach memory prompt under `--- TRANSFER & SPACED REVIEW RECOMMENDATIONS ---`.
- Limits active recommendations to prevent cognitive overload (maximum 3 interventions per turn).
- Distinguishes direct recall from conceptual transfer evidence.

### 4. Automated Socratic Quality Evaluation (`ai/evaluation/socratic_quality.py`)
- Standardized rubric assessing:
  - **Diagnostic Question Quality:** Diagnostic questions that probe the student's underlying mental model.
  - **Scaffolding Index:** Incremental hints and step-by-step guidance.
  - **Direct Answer Giveaway Detection:** Regex and semantic patterns detecting premature answer leaks in both English ("the answer is", "solution is", "you should write") and Egyptian/Standard Arabic ("الإجابة هي", "الحل هو", "اكتب الكود التالي", "الناتج النهائي").
  - **Persona Alignment Scoring:** Measures fidelity to the 5 distinct teaching styles (Socratic Guide, Patient Mentor, Practical Engineer, Critical Thinker, Visual Explorer).
  - **Composite Socratic Index:** Weighted score ($0.0 - 1.0$) with strict penalties for answer leaks.
- Verified with 6 automated tests in `ai/tests/test_socratic_quality.py`.

## Invariant Safety Rules
- **Absolute No-Final-Answer Rule:** No Coach channel or persona may hand over complete homework solutions.
- **Deterministic Enforcement:** All model text passes through `review_generated_text()` and regex guardrails before being presented to the student.
