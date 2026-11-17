import pytest
from ai.evaluation.socratic_quality import evaluate_socratic_turn, SocraticQualityVerdict


def test_socratic_turn_exemplar():
    student = "I think the friction force is equal to mg because that's what gravity is."
    coach = "Good start on thinking about gravity. What happens if the box is resting on a tilted ramp instead of flat ground? Does all of the weight push directly into the surface?"

    verdict = evaluate_socratic_turn(student, coach, persona_id="socratic_guide")
    assert verdict.is_socratic is True
    assert verdict.socratic_index >= 0.70
    assert verdict.question_presence is True
    assert verdict.directness_score == 0.0
    assert len(verdict.detected_giveaways) == 0


def test_socratic_turn_arabic_exemplar():
    student = "مش عارف احسب العجلة هنا ازاي"
    coach = "بداية جيدة! لاحظ أن القوة المحصلة تؤثر على الكتلة. كيف يرتبط القانون الثاني لنيوتن بين القوة والعجلة؟ ما المعادلة التي يمكنك استخدامها؟"

    verdict = evaluate_socratic_turn(student, coach, persona_id="patient_mentor")
    assert verdict.is_socratic is True
    assert verdict.socratic_index >= 0.75
    assert verdict.question_presence is True
    assert verdict.directness_score == 0.0
    assert verdict.persona_alignment_score == 1.0


def test_direct_answer_giveaway_rejected():
    student = "What is the derivative of x^3?"
    coach = "The answer is 3x^2. You should write 3x^2."

    verdict = evaluate_socratic_turn(student, coach)
    assert verdict.is_socratic is False
    assert verdict.directness_score > 0.50
    assert len(verdict.detected_giveaways) > 0
    assert any("answer is" in g.lower() for g in verdict.detected_giveaways)


def test_direct_answer_arabic_giveaway_rejected():
    student = "كم تساوي القوة؟"
    coach = "الإجابة هي 50 نيوتن. الحل هو ضرب الكتلة في العجلة."

    verdict = evaluate_socratic_turn(student, coach)
    assert verdict.is_socratic is False
    assert verdict.directness_score > 0.50
    assert any("الإجابة هي" in g for g in verdict.detected_giveaways)


def test_persona_alignment_practical_engineer():
    student = "Why do we use capacitors in power supplies?"
    coach = "Think about how real-world electrical systems work when the load spikes. What happens to the voltage without a storage buffer? Can you picture how a water reservoir stabilizes pressure in a plumbing system?"

    verdict = evaluate_socratic_turn(student, coach, persona_id="practical_engineer")
    assert verdict.is_socratic is True
    assert verdict.persona_alignment_score == 1.0


def test_empty_reply_handled():
    verdict = evaluate_socratic_turn("Help", "")
    assert verdict.is_socratic is False
    assert verdict.socratic_index == 0.0
