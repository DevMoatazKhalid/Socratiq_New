"""Excel gradebook builder (pure): layout, live formulas, graded-work-only averages, and formula-injection safety."""
from __future__ import annotations

import io
from datetime import datetime, timedelta, timezone

from openpyxl import load_workbook

from app.exports import build_gradebook, export_filename, sheet_name

NOW = datetime(2026, 11, 21, 20, 0, tzinfo=timezone.utc)
A = [{"id": "A1", "title": "Gradient descent", "due_at": NOW - timedelta(days=2), "points": 10,
      "rubric": [{"id": "m", "title": "Method", "points": 6}, {"id": "e", "title": "Explanation", "points": 4}]},
     {"id": "A2", "title": "Essay", "due_at": None, "points": 20, "rubric": []}]
S = [{"id": "S1", "code": "2024001", "first_name": "Mona", "last_name": "Ali", "email": "m@u", "section": "A", "status": "active"},
     {"id": "S2", "code": None, "first_name": "=cmd|' /C calc'!A0", "last_name": "@SUM(1)", "email": "+x", "section": "A", "status": "active"}]
C = {("S1", "A1"): {"status": "graded", "score": 8, "max_score": 10, "source": "ai", "graded_by": "Dr P", "graded_at": NOW, "submitted_at": NOW - timedelta(days=3),
                    "attempt": 1, "feedback": "-good", "criteria": [{"id": "m", "points_awarded": 5}, {"id": "e", "points_awarded": 3}]},
     ("S2", "A1"): {"status": "missing"}, ("S1", "A2"): {"status": "ungraded", "submitted_at": NOW, "attempt": 1}}


def _wb(**kw):
    return load_workbook(io.BytesIO(build_gradebook(course={"code": "CS101", "title": "Intro", "instructors": ["Dr P"], "sections": ["A"]}, assignments=A,
                                                    students=S, cells=C, exported_by="Dr P", tz_name="Africa/Cairo", now=NOW, **kw)))


def test_sheets_and_gradebook_formulas():
    wb = _wb()
    assert wb.sheetnames == ["Summary", "Gradebook", "Details", "Rubric · Gradient descent"]
    gb = wb["Gradebook"]
    assert gb["G6"].value == 10 and gb["G7"].value == 8 and gb["H7"].value == '=IF(ISNUMBER(G7),G7/G$6,"")'
    assert gb["G8"].value == "Missing" and gb["I7"].value == "Ungraded"                       # never a 0 for missing or ungraded work
    assert gb["M7"].value == '=IFERROR(AVERAGE(H7,J7),"")' and gb["L7"].value == 0 and gb["L8"].value == 1   # course average and missing count
    assert gb.freeze_panes == "G7"


def test_untrusted_text_is_never_a_formula():
    wb = _wb()
    for ws, ref in ((wb["Gradebook"], "B8"), (wb["Gradebook"], "C8"), (wb["Gradebook"], "D8"), (wb["Details"], "Q5")):
        assert ws[ref].data_type == "s" and ws[ref].quotePrefix, ref


def test_options_and_names():
    assert "Rubric · Gradient descent" not in _wb(include_rubric=False).sheetnames
    assert _wb(include_feedback=False)["Details"].max_column == 16
    used = set()
    assert sheet_name("Gradient: [descent]/part?", used, "Rubric · ") == "Rubric · Gradient descent part"
    assert len(sheet_name("x" * 60, used)) == 31 and sheet_name("x" * 60, used).endswith("(2)")
    assert export_filename("CS 101", "تمرين", NOW) == ("SocratiQ_CS_101_grades_2026-11-21.xlsx", "SocratiQ_CS_101_تمرين_grades_2026-11-21.xlsx")
