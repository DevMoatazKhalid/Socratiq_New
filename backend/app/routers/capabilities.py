"""What this server can do, so the app can tell people plainly when a feature needs a server update or a database migration,
instead of showing empty tables or numbers that cannot be right. Booleans only: no versions of dependencies, no configuration values."""
from __future__ import annotations

from fastapi import APIRouter, Depends

from ..auth import CurrentUser, get_current_user, get_db
from ..db import Database, one

router = APIRouter(tags=["meta"])
API_LEVEL = 3          # 1: original API · 2: notes board, overview and insights · 3: capabilities, roster grades, course icons


@router.get("/capabilities")
def capabilities(user: CurrentUser = Depends(get_current_user), db: Database = Depends(get_db)):
    with db.tx() as c:
        row = one(c, """SELECT to_regclass('public.student_note_groups') IS NOT NULL AS notes_board,
                               to_regclass('public.grade_evaluations') IS NOT NULL AS assessment,
                               EXISTS (SELECT 1 FROM information_schema.columns
                                        WHERE table_schema = 'public' AND table_name = 'courses' AND column_name = 'icon') AS course_icons""")
    return {"api_level": API_LEVEL,
            "features": {"insights": True, "notes_board": bool(row["notes_board"]), "assessment": bool(row["assessment"]),
                         "course_icons": bool(row["course_icons"])},
            # which migration enables each feature, so an administrator knows exactly what to run
            "migrations": {"notes_board": "019_notes_board.sql", "assessment": "020_assessment.sql", "course_icons": "021_course_icon.sql"}}
