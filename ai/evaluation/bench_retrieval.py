"""Reproducible micro-benchmark: the Coach's retrieve_context node with simulated provider latency.

Run it against any checkout:  PYTHONPATH=<repo root> python ai/evaluation/bench_retrieval.py [runs]
It uses the node from THAT checkout, so running it on the original and the current tree gives a like-for-like comparison. The delays are
SIMULATED (course retrieval 220 ms, student history 120 ms): this measures how the node combines two lookups, not any real provider.
"""
from __future__ import annotations

import statistics
import sys
import time
from types import SimpleNamespace

from ai.agents.coach.nodes import make_retrieve_context_node
from ai.agents.coach.state import TaskContext
from ai.agents.coach.schemas import DiagnosisResult
from ai.models.schemas import DiagnosisCategory

COURSE_MS, HISTORY_MS = 220, 120


class Course:
    name = "course_retriever"

    def retrieve_scoped(self, *a, **k):
        time.sleep(COURSE_MS / 1000)
        return ["c"]

    retrieve = retrieve_scoped


class History:
    name = "student_history"

    def retrieve(self, *a, **k):
        time.sleep(HISTORY_MS / 1000)
        return ["h"]


def main(runs: int = 15) -> None:
    node = make_retrieve_context_node(Course(), History())
    task = TaskContext(assignment_id="asg_1", course_id="c1", university_id="u1", title="t", instructions="i", subject_area="ml", is_programming=True)
    state = {"task_context": task, "metadata": SimpleNamespace(student_id="s", assignment_id="a"),
             "diagnosis": DiagnosisResult(category=DiagnosisCategory.MISCONCEPTION, concept="x", explanation="e", evidence="ev", confidence=0.8),
             "needs_course_material": True, "needs_student_history": True, "message": "m", "attempt": "t"}
    times = []
    for _ in range(runs):
        t0 = time.perf_counter()
        out = node(state)
        times.append((time.perf_counter() - t0) * 1000)
        assert out["tools_used"] == ["course_retriever", "student_history"]
    times.sort()
    print(f"runs={runs} simulated course={COURSE_MS}ms history={HISTORY_MS}ms  p50={statistics.median(times):.0f}ms  "
          f"p95={times[min(len(times)-1, int(round(0.95*(len(times)-1))))]:.0f}ms  mean={statistics.fmean(times):.0f}ms")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 15)
