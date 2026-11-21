"""Read-only dashboard endpoints for the approved UI: the student overview and the per-course instructor insights.
All numbers are computed on read by app/insights.py from stored rows (see that module for every definition)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from .. import insights
from ..access import teacher_course
from ..auth import CurrentUser, get_db, require_professor, require_student
from ..db import Database

router = APIRouter(tags=["insights"])


@router.get("/student/overview")
def student_overview(weeks: int = Query(default=8, ge=1, le=insights.WEEKS_MAX), user: CurrentUser = Depends(require_student), db: Database = Depends(get_db)):
    """KPIs, per-course summary, per-assignment status and a weekly trend for the signed-in student (their own work only)."""
    with db.tx() as c:
        return insights.student_overview(c, user, weeks)


@router.get("/teacher/courses/{course_id}/insights")
def course_insights(course_id: str, weeks: int = Query(default=8, ge=1, le=insights.WEEKS_MAX),
                    user: CurrentUser = Depends(require_professor), db: Database = Depends(get_db)):
    """Grades, completion, verification, review indicators, Coach use, concepts and activity for one course the instructor teaches."""
    with db.tx() as c:
        teacher_course(c, user, course_id)                  # 404 for a course that is not yours, exactly like the dashboard
        return insights.course_insights(c, user, course_id, weeks)
