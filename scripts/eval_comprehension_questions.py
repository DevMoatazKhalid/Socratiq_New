"""
Live evaluation of the three comprehension questions against the REAL configured model.

Runs every lesson in ai/evaluation/fixtures/comprehension_lessons.py through VerificationService.generate_challenge for the three steps
(EXPLAIN -> MODIFY -> TRANSFER, each seeing the earlier questions, exactly like the backend), then reports for every question:
the source (generated / regenerated / fallback), the deterministic gate result, and an independent semantic judgement by the reviewer.
It also re-checks each lesson's known-bad questions (including the production kidney question) against the gate.

Usage (from the project root, with the usual AI_* variables in .env):
    python scripts/eval_comprehension_questions.py                 # all lessons
    python scripts/eval_comprehension_questions.py anatomy_kidney  # one lesson
    python scripts/eval_comprehension_questions.py --json out.json

Cost: per question at most AI_VERIFICATION_QUESTION_MAX_ATTEMPTS generations + as many reviews, plus one extra review for the report.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ai.evaluation.fixtures.comprehension_lessons import LESSONS, LESSONS_BY_KEY  # noqa: E402
from ai.models.llm import ModelRole, get_structured_llm  # noqa: E402
from ai.prompts.verification.question_review_prompt import build_question_review_messages  # noqa: E402
from ai.verification import VerificationChallengeRequest, VerificationService, VerificationType  # noqa: E402
from ai.verification.question_context import build_lesson_context  # noqa: E402
from ai.verification.question_quality import check_question  # noqa: E402
from ai.verification.question_review import QuestionReviewPayload  # noqa: E402

STEPS = (VerificationType.EXPLAIN, VerificationType.MODIFY, VerificationType.TRANSFER)


def _request(lesson, vtype, previous):
    return VerificationChallengeRequest(
        assignment_id=f"eval_{lesson.key}", concept=lesson.concepts[0], verification_type=vtype, student_work=lesson.student_work,
        course_context=lesson.instructions or None, assignment_title=lesson.title or None, subject_area=lesson.subject_area or None,
        is_programming=lesson.is_programming, lesson_material=list(lesson.material), candidate_concepts=list(lesson.concepts),
        previous_questions=list(previous))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("lessons", nargs="*", help="lesson keys (default: all)")
    ap.add_argument("--json", help="write the full report here")
    args = ap.parse_args()
    lessons = [LESSONS_BY_KEY[k] for k in args.lessons] if args.lessons else list(LESSONS)
    svc = VerificationService()
    strategies = svc._strategies
    report, failures = [], 0

    for lesson in lessons:
        print(f"\n=== {lesson.key}: {lesson.title or '(no title)'} ===")
        asked = []
        for vtype in STEPS:
            req = _request(lesson, vtype, asked)
            t0 = time.monotonic()
            ch = svc.generate_challenge(req)
            dt = time.monotonic() - t0
            ctx = build_lesson_context(_request(lesson, vtype, asked))
            gate = check_question(ch.question, ctx)
            judge = None
            try:
                strat = strategies[vtype]
                judge = get_structured_llm(ModelRole.VERIFICATION, QuestionReviewPayload).invoke(build_question_review_messages(
                    ctx, question=ch.question, type_label=strat.type_label, objective=strat.objective))
            except Exception as exc:  # noqa: BLE001
                print(f"  (independent review failed: {exc})")
            ok = gate.ok and (judge is None or judge.accepted)
            failures += 0 if ok else 1
            print(f"  [{vtype.value:8}] {'PASS' if ok else 'FAIL'} source={ch.source:11} {dt:5.1f}s  concept={ch.concept!r}")
            print(f"             Q: {ch.question}")
            if gate.issues:
                print("             gate: " + "; ".join(str(i) for i in gate.issues))
            if judge is not None and not judge.accepted:
                print("             review: " + "; ".join(judge.reasons()))
            if ch.quality_notes:
                print("             notes: " + " | ".join(ch.quality_notes))
            report.append({"lesson": lesson.key, "type": vtype.value, "question": ch.question, "concept": ch.concept,
                           "criteria": ch.criteria, "source": ch.source, "seconds": round(dt, 2), "gate_ok": gate.ok,
                           "gate_issues": [str(i) for i in gate.issues], "review": judge.model_dump() if judge else None,
                           "notes": ch.quality_notes})
            asked.append(ch.question)
        if len(set(asked)) != 3:
            failures += 1
            print("  FAIL: the three questions are not all different")
        for bad in lesson.bad:
            if check_question(bad, build_lesson_context(_request(lesson, VerificationType.EXPLAIN, []))).ok:
                failures += 1
                print(f"  FAIL: known-bad question accepted by the gate: {bad!r}")

    total = len(lessons) * 3
    fallbacks = sum(1 for r in report if r["source"] == "fallback")
    print(f"\n{total} questions, {failures} failure(s), {fallbacks} fallback(s).")
    if args.json:
        Path(args.json).write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"report written to {args.json}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
