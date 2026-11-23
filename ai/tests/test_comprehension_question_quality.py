"""
Regression suite for the three comprehension (verification) questions.

Covers, across anatomy, mathematics, programming, physics, chemistry, academic writing and the hard cases (short lesson, long
multi-concept lesson, code + formulas, missing context, Arabic):
  1. the deterministic quality gate: the production kidney question and its whole failure family are rejected; well-formed,
     lesson-grounded questions in every subject pass;
  2. context construction: lesson vs. student work, concept choice, work kind, previous questions, thin-context handling;
  3. the generation loop: deterministic rejection -> stricter regeneration; semantic (reviewer) rejection -> regeneration; bounded
     retries; provider outage -> validated fallback; reviewer outage -> deterministic floor;
  4. a full three-question run per subject: exactly three questions, all valid, all different.
The model is scripted (no network): these tests pin the PIPELINE. scripts/eval_comprehension_questions.py runs the same lessons through
the real model.
"""
from __future__ import annotations

import itertools

import pytest

from ai.evaluation.fixtures.comprehension_lessons import KIDNEY_REGRESSION, LESSONS, LESSONS_BY_KEY, Lesson
from ai.verification import VerificationChallengeRequest, VerificationService, VerificationType
from ai.verification.question_context import WORK_CODE, WORK_MATH, WORK_NONE, WORK_PROSE, build_lesson_context, humanize_concept
from ai.verification.question_quality import blocking, check_question
from ai.verification.question_review import QuestionReviewPayload, safe_fallback
from ai.verification.service import GeneratedChallengePayload

STEPS = (VerificationType.EXPLAIN, VerificationType.MODIFY, VerificationType.TRANSFER)


def _request(lesson: Lesson, vtype: VerificationType, previous=()) -> VerificationChallengeRequest:
    return VerificationChallengeRequest(
        assignment_id=f"asg_{lesson.key}", concept=lesson.concepts[0], verification_type=vtype, student_work=lesson.student_work,
        course_context=lesson.instructions or None, assignment_title=lesson.title or None, subject_area=lesson.subject_area or None,
        is_programming=lesson.is_programming, lesson_material=list(lesson.material), candidate_concepts=list(lesson.concepts),
        previous_questions=list(previous))


def _ctx(lesson: Lesson, vtype=VerificationType.EXPLAIN, previous=()):
    return build_lesson_context(_request(lesson, vtype, previous))


def _accept(**overrides) -> QuestionReviewPayload:
    base = dict(grounded_in_lesson=True, single_clear_question=True, natural_language=True, concepts_coherent=True,
                answerable_from_lesson=True, level_appropriate=True, distinct_from_previous=True, matches_purpose=True,
                problems=[], verdict="ACCEPT")
    base.update(overrides)
    return QuestionReviewPayload(**base)


class ScriptedModel:
    """Stands in for get_structured_llm(role, schema). Generation and review calls are answered from separate scripts and recorded."""

    def __init__(self, drafts, reviews=None, gen_error=None, review_error=None):
        self.drafts, self.reviews = list(drafts), list(reviews or [])
        self.gen_error, self.review_error = gen_error, review_error
        self.gen_calls, self.review_calls = [], []

    def __call__(self, role, schema):
        model = self

        class _Bound:
            def invoke(self, messages):
                if schema is GeneratedChallengePayload:
                    model.gen_calls.append(messages)
                    if model.gen_error:
                        raise model.gen_error
                    d = model.drafts.pop(0) if len(model.drafts) > 1 else model.drafts[0]
                    return d if isinstance(d, GeneratedChallengePayload) else GeneratedChallengePayload(
                        question=d, criteria=["Makes the key point from the lesson", "Explains it correctly"])
                if schema is QuestionReviewPayload:
                    model.review_calls.append(messages)
                    if model.review_error:
                        raise model.review_error
                    return model.reviews.pop(0) if len(model.reviews) > 1 else (model.reviews[0] if model.reviews else _accept())
                raise AssertionError(f"unexpected schema {schema}")
        return _Bound()


@pytest.fixture
def service():
    return VerificationService(max_attempts=2, review_enabled=True)


# ====================================================================================================== 1. the deterministic gate
def test_kidney_production_question_is_rejected_for_the_right_reasons():
    report = check_question(KIDNEY_REGRESSION, _ctx(LESSONS_BY_KEY["anatomy_kidney"]))
    assert not report.ok
    assert {"legacy_template", "topic_as_mechanism", "mismatched_frame"} <= report.codes()


@pytest.mark.parametrize("lesson,bad", [(l, b) for l in LESSONS for b in l.bad], ids=lambda x: getattr(x, "key", str(x)[:40]))
def test_failure_family_is_rejected_in_every_subject(lesson, bad):
    for vtype in STEPS:
        report = check_question(bad, _ctx(lesson, vtype))
        assert not report.ok, f"{lesson.key}/{vtype.value} accepted a bad question: {bad!r}"


@pytest.mark.parametrize("lesson", LESSONS, ids=lambda l: l.key)
def test_good_questions_pass_in_every_subject(lesson):
    asked = []
    for vtype in STEPS:
        q = lesson.good[vtype.value]
        report = check_question(q, _ctx(lesson, vtype, previous=asked))
        assert report.ok, f"{lesson.key}/{vtype.value}: {q!r} -> {[str(i) for i in report.errors]}"
        asked.append(q)


@pytest.mark.parametrize("question,code", [
    ("What is a nephron? What does the glomerulus do?", "multiple_questions"),
    ("Which of the following filters blood? A) nephron B) ureter C) bladder?", "multiple_choice"),
    ("Explain how the nephron forms urine.", "not_a_question"),
    ("How does {concept} relate to urine formation?", "placeholder"),
    ("How does the nephron_unit contribute to urine formation?", "identifier_as_text"),
    ("why does the glomerulus filter blood under pressure?", "capitalisation"),
    ("How does the the nephron form urine from filtered blood?", "repeated_word"),
    ("Why?", "too_vague"),
    ("Here is a verification question: how does the nephron form urine?", "meta_text"),
    ("How does the nephron " + "and its surrounding blood vessels " * 8 + "form urine?", "too_long"),
    ("Why does nephron work in your solution?", "mismatched_frame"),
])
def test_structural_defects_are_rejected(question, code):
    report = check_question(question, _ctx(LESSONS_BY_KEY["anatomy_kidney"]))
    assert code in report.codes() and not report.ok, [str(i) for i in report.issues]


def test_repeating_an_earlier_question_is_rejected():
    lesson = LESSONS_BY_KEY["anatomy_kidney"]
    first = lesson.good["EXPLAIN"]
    ctx = _ctx(lesson, VerificationType.MODIFY, previous=[first])
    assert "duplicate" in check_question("What are the main structures of the kidney, and what role does each play?", ctx).codes()
    assert check_question(lesson.good["MODIFY"], ctx).ok


def test_solution_language_is_allowed_only_when_a_solution_was_submitted():
    q = "Why does your solution set the characteristic polynomial equal to zero?"
    assert check_question(q, _ctx(LESSONS_BY_KEY["math_eigen"])).ok                       # worked maths submitted
    assert "mismatched_frame" in check_question("Why does your solution say the nephron filters blood?",
                                                _ctx(LESSONS_BY_KEY["anatomy_kidney"])).codes()  # essay submitted


def test_unrelated_concepts_are_flagged_for_the_reviewer_and_block_without_one():
    """'Combine unrelated concepts' is semantic; the gate cannot prove it, so it hands the reviewer a warning. If the reviewer is
    unavailable and the question shares nothing with a substantive lesson, the gate blocks it on its own."""
    ctx = _ctx(LESSONS_BY_KEY["anatomy_kidney"])
    mixed = check_question("How would a Python dictionary speed up the glomerulus during filtration of blood?", ctx)
    assert mixed.ok and "foreign_terms" in mixed.codes()
    off_topic = check_question("How would you sort a Python dictionary by its values efficiently?", ctx)
    assert off_topic.ok and "no_anchor" in off_topic.codes()
    assert blocking(off_topic, ctx, reviewer_available=True) == []
    assert [i.code for i in blocking(off_topic, ctx, reviewer_available=False)] == ["no_anchor"]


# ====================================================================================================== 2. context construction
def test_work_kind_is_classified_per_subject():
    kinds = {l.key: _ctx(l).work_kind for l in LESSONS}
    assert kinds["anatomy_kidney"] == WORK_PROSE
    assert kinds["chemistry_equilibrium"] == WORK_PROSE
    assert kinds["theory_writing"] == WORK_PROSE
    assert kinds["programming_ds"] == WORK_CODE
    assert kinds["long_multi_concept"] == WORK_CODE
    assert kinds["math_eigen"] in (WORK_MATH, WORK_CODE)
    assert kinds["physics_newton"] in (WORK_MATH, WORK_CODE)
    assert kinds["short_lesson"] == WORK_NONE and kinds["missing_context"] == WORK_NONE


def test_concepts_are_humanized_but_stored_in_original_spelling():
    ctx = _ctx(LESSONS_BY_KEY["long_multi_concept"])
    assert ctx.concept == "gradient descent"
    assert ctx.original(ctx.concept) == "gradient_descent"
    assert humanize_concept("N/A") == "" and humanize_concept("  learning_rate ") == "learning rate"


def test_concept_choice_prefers_the_concept_the_lesson_actually_teaches():
    lesson = LESSONS_BY_KEY["anatomy_kidney"]
    req = _request(lesson, VerificationType.EXPLAIN)
    req.concept = "renal anatomy history"       # primary not grounded in the material
    assert build_lesson_context(req).concept in ("nephron", "urine formation", "anatomy of the kidney")


def test_later_questions_move_to_concepts_not_yet_covered():
    lesson = LESSONS_BY_KEY["long_multi_concept"]
    ctx = _ctx(lesson, VerificationType.TRANSFER, previous=[
        "Why does the update subtract the gradient in gradient descent?", "Why does gradient descent diverge?"])
    assert ctx.concept != "gradient descent"


def test_prompt_separates_lesson_from_student_work_and_carries_everything_needed():
    from ai.verification.strategies import ExplainStrategy
    lesson = LESSONS_BY_KEY["anatomy_kidney"]
    req = _request(lesson, VerificationType.EXPLAIN, previous=["What is the renal cortex?"])
    system, human = (m.content for m in ExplainStrategy().build_challenge_prompt(req))
    assert "=== LESSON (DATA) ===" in human and "Bowman's capsule" in human               # retrieved material reaches the model
    assert "<<<STUDENT_WORK>>>" in human                                                   # student work is delimited data
    assert "What is the renal cortex?" in human                                            # earlier questions are listed
    assert "a written answer (prose, not code or a worked solution)" in system
    assert 'Do NOT refer to "your solution"' in system
    assert KIDNEY_REGRESSION in system                                                     # explicit negative example


def test_thin_context_is_declared_to_the_model():
    from ai.verification.strategies import ExplainStrategy
    system = ExplainStrategy().build_challenge_prompt(_request(LESSONS_BY_KEY["missing_context"], VerificationType.EXPLAIN))[0].content
    assert "The lesson context provided is thin" in system


# ====================================================================================================== 3. generation loop
def test_kidney_draft_is_regenerated_with_stricter_instructions(monkeypatch, service):
    lesson = LESSONS_BY_KEY["anatomy_kidney"]
    model = ScriptedModel(drafts=[KIDNEY_REGRESSION, lesson.good["EXPLAIN"]])
    monkeypatch.setattr("ai.verification.service.get_structured_llm", model)

    ch = service.generate_challenge(_request(lesson, VerificationType.EXPLAIN))

    assert ch.question == lesson.good["EXPLAIN"] and ch.source == "regenerated"
    assert len(model.gen_calls) == 2 and len(model.review_calls) == 1     # the bad draft never reached the reviewer
    retry_system, retry_human = (m.content for m in model.gen_calls[1])
    assert "STRICT MODE" in retry_system
    assert f'REJECTED DRAFT: "{KIDNEY_REGRESSION}"' in retry_human and "topic" in retry_human


def test_semantic_rejection_by_reviewer_triggers_regeneration(monkeypatch, service):
    lesson = LESSONS_BY_KEY["anatomy_kidney"]
    mixed = "How would a Python dictionary speed up the glomerulus during filtration of blood?"
    model = ScriptedModel(drafts=[mixed, lesson.good["MODIFY"]],
                          reviews=[_accept(concepts_coherent=False, grounded_in_lesson=False, verdict="REJECT",
                                           problems=["combines Python dictionaries with kidney filtration"]), _accept()])
    monkeypatch.setattr("ai.verification.service.get_structured_llm", model)

    ch = service.generate_challenge(_request(lesson, VerificationType.MODIFY))

    assert ch.question == lesson.good["MODIFY"]
    first_review = model.review_calls[0][1].content
    assert "foreign_terms" in first_review                     # the gate's hint reached the reviewer
    assert "combines Python dictionaries" in model.gen_calls[1][1].content


def test_retries_are_bounded_and_end_in_a_validated_fallback(monkeypatch, service):
    for lesson in LESSONS:
        bad = lesson.bad[0] if lesson.bad else "Why?"
        model = ScriptedModel(drafts=[bad])
        monkeypatch.setattr("ai.verification.service.get_structured_llm", model)
        for vtype in STEPS:
            model.gen_calls.clear()
            req = _request(lesson, vtype)
            ch = service.generate_challenge(req)
            assert ch.source == "fallback", (lesson.key, vtype, ch.question)
            assert len(model.gen_calls) == service.max_attempts
            assert check_question(ch.question, build_lesson_context(req)).ok, (lesson.key, vtype, ch.question)
            assert "your solution" not in ch.question.lower()


def test_provider_outage_is_not_retried(monkeypatch, service):
    model = ScriptedModel(drafts=["unused"], gen_error=RuntimeError("429 quota"))
    monkeypatch.setattr("ai.verification.service.get_structured_llm", model)
    ch = service.generate_challenge(_request(LESSONS_BY_KEY["physics_newton"], VerificationType.EXPLAIN))
    assert ch.source == "fallback" and len(model.gen_calls) == 1
    assert "Newton's second law" in ch.question


def test_reviewer_outage_falls_back_to_the_deterministic_floor(monkeypatch, service):
    lesson = LESSONS_BY_KEY["anatomy_kidney"]
    off_topic = "How would you sort a Python dictionary by its values efficiently?"
    model = ScriptedModel(drafts=[off_topic, lesson.good["EXPLAIN"]], review_error=RuntimeError("timeout"))
    monkeypatch.setattr("ai.verification.service.get_structured_llm", model)
    ch = service.generate_challenge(_request(lesson, VerificationType.EXPLAIN))
    assert ch.question == lesson.good["EXPLAIN"]
    assert any("deterministic gate only" in n for n in ch.quality_notes)


def test_invented_target_concept_is_replaced_by_a_real_one(monkeypatch, service):
    lesson = LESSONS_BY_KEY["long_multi_concept"]
    draft = GeneratedChallengePayload(question=lesson.good["MODIFY"], criteria=["c1"], target_concept="neural networks")
    monkeypatch.setattr("ai.verification.service.get_structured_llm", ScriptedModel(drafts=[draft]))
    ch = service.generate_challenge(_request(lesson, VerificationType.MODIFY))
    assert ch.concept in lesson.concepts

    draft = GeneratedChallengePayload(question=lesson.good["MODIFY"], criteria=["c1"], target_concept="learning rate")
    monkeypatch.setattr("ai.verification.service.get_structured_llm", ScriptedModel(drafts=[draft]))
    assert service.generate_challenge(_request(lesson, VerificationType.MODIFY)).concept == "learning_rate"


def test_fallbacks_are_valid_for_every_lesson_and_distinct_from_each_other():
    for lesson in LESSONS:
        asked = []
        for vtype in STEPS:
            ctx = _ctx(lesson, vtype, previous=asked)
            q, criteria = safe_fallback(ctx)
            assert check_question(q, ctx).ok, (lesson.key, vtype, q)
            assert criteria
            asked.append(q)
        assert len(set(asked)) == 3


# ====================================================================================================== 4. full three-question runs
@pytest.mark.parametrize("lesson", LESSONS, ids=lambda l: l.key)
def test_full_run_yields_three_valid_distinct_questions(monkeypatch, service, lesson):
    asked, results = [], []
    for vtype in STEPS:
        monkeypatch.setattr("ai.verification.service.get_structured_llm", ScriptedModel(drafts=[lesson.good[vtype.value]]))
        ch = service.generate_challenge(_request(lesson, vtype, previous=asked))
        results.append(ch)
        asked.append(ch.question)
    assert len(results) == 3
    assert [c.verification_type for c in results] == list(STEPS)
    assert all(c.source == "generated" for c in results)
    assert len(set(asked)) == 3
    for a, b in itertools.combinations(asked, 2):
        assert "duplicate" not in check_question(b, _ctx(lesson), previous=[a]).codes()


def test_model_repeating_itself_still_yields_three_distinct_questions(monkeypatch, service):
    lesson = LESSONS_BY_KEY["chemistry_equilibrium"]
    same = lesson.good["EXPLAIN"]
    asked = []
    for vtype in STEPS:
        monkeypatch.setattr("ai.verification.service.get_structured_llm", ScriptedModel(drafts=[same]))
        asked.append(service.generate_challenge(_request(lesson, vtype, previous=asked)).question)
    assert asked[0] == same and len(set(asked)) == 3


@pytest.mark.parametrize("key,question", [
    ("anatomy_kidney", "How does the structure of the nephron help it filter blood?"),
    ("anatomy_kidney", "How does the kidney function to remove waste from the blood?"),
    ("anatomy_kidney", "Based on your answer, why is reabsorption in the tubule important?"),
    ("programming_ds", "Why does binary search work only on sorted lists?"),
    ("programming_ds", "What would your count_words function return for an empty string, and why?"),
    ("missing_context", "Why does recursion work for computing factorials?"),
    ("theory_writing", "Why does the theory of evolution apply to bacteria that become resistant to antibiotics?"),
    ("theory_writing", "How would you make your thesis statement more specific?"),
    ("chemistry_equilibrium", "How do the properties of the reactants affect where the equilibrium lies?"),
    ("physics_newton", "If the net force on the cart doubled, what would happen to its acceleration?"),
    ("math_eigen", "How can you check that v = (1, 1) is an eigenvector of A?"),
    ("long_multi_concept", "What does the learning rate α control in the update θ := θ − α∇J(θ)?"),
    ("arabic_kidney", "ما هي الوحدة الوظيفية للكلية؟"),
])
def test_legitimate_questions_are_not_over_rejected(key, question):
    """The gate must not push good questions into fallbacks: mechanisms that 'work', 'your answer' after a submission, code
    identifiers in a programming lesson, formulas, and Arabic are all fine."""
    report = check_question(question, _ctx(LESSONS_BY_KEY[key]))
    assert report.ok, [str(i) for i in report.errors]


def test_fallbacks_name_the_concept_grammatically_and_match_the_lesson_language():
    from ai.verification.question_review import _GENERIC
    for lesson in LESSONS:
        asked = []
        for vtype in STEPS:
            q, _ = safe_fallback(_ctx(lesson, vtype, previous=asked))
            assert q not in _GENERIC.values(), (lesson.key, vtype, q)      # a concept-specific frame was usable
            asked.append(q)
    q, _ = safe_fallback(_ctx(LESSONS_BY_KEY["arabic_kidney"]))
    assert "النفرون" in q and q.endswith("؟")
    q, _ = safe_fallback(_ctx(LESSONS_BY_KEY["programming_ds"], VerificationType.MODIFY))
    assert 'the topic "' in q                                               # never "How does lists connect ..."
