"""
Excel gradebook export (pure: plain data in, .xlsx bytes out; the router gathers and authorises the data).

Workbook
  Summary    course facts, an overview per assignment (submitted / graded / missing, average, median, highest, lowest) and the
             distribution of course averages. Statistics are live formulas over the Gradebook sheet, so they follow any edit.
  Gradebook  one row per student; per assignment the points (or why there are none: Ungraded / Missing / Not submitted) and the
             percentage (formula); then the number of graded assignments, missing work and the course average (formulas). The
             "Max points" row is what every percentage divides by.
  Details    one row per student x assignment: status, submission time, lateness, attempt, score, grade source, grader, time, feedback.
             Filterable; meant for pivot tables and the registrar.
  Rubric · … one sheet per rubric-graded assignment: points per criterion, total and percentage.

Rules
  * Graded work only: an ungraded or missing assignment is blank in every average, never a 0 (same rule as the app).
  * Every text cell that came from a person (names, titles, feedback) is stored as a STRING, never a formula, and a leading = + - @ is
    quote-prefixed, so a student named "=HYPERLINK(...)" cannot inject a formula (CSV/Excel injection).
  * Times are shown in the instructor's time zone, which is named in the header.
"""
from __future__ import annotations

import io
import re
from datetime import datetime, timezone
from typing import Any, Iterable, Optional
from zoneinfo import ZoneInfo

from openpyxl import Workbook
from openpyxl.formatting.rule import CellIsRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.worksheet import Worksheet

FONT = "Arial"
INK, MUTED = "141102", "5F5D53"
BRAND, BRAND_LIGHT, SURFACE_MUTED = "FA9500", "FEECD1", "F6F4EA"
GOOD, BAD = "E6F0E6", "F5E4E2"
LINE = Side(style="thin", color="D9DBC1")
BORDER = Border(left=LINE, right=LINE, top=LINE, bottom=LINE)
PCT, PTS, DT, DAY = "0.0%", "0.##;-0.##;0", "yyyy-mm-dd hh:mm", "yyyy-mm-dd"

STATUS_LABEL = {"graded": "Graded", "ungraded": "Ungraded", "missing": "Missing", "not_submitted": "Not submitted", "not_assigned": "Not assigned"}
SOURCE_LABEL = {"manual": "Instructor", "ai": "AI draft, released by instructor", "ai_edited": "AI draft, edited by instructor",
                "ai_auto": "AI, released automatically"}
_DANGEROUS = ("=", "+", "-", "@", "\t", "\r")


# ---------------------------------------------------------------- cell helpers
def _font(bold=False, size=10, color=INK, italic=False) -> Font:
    return Font(name=FONT, bold=bold, size=size, color=color, italic=italic)


def put_text(ws: Worksheet, row: int, col: int, value: Optional[str], **style) -> Any:
    """Write untrusted text: always a string cell, never a formula."""
    cell = ws.cell(row=row, column=col)
    text = "" if value is None else re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(value))[:32000]
    cell.value = text
    cell.data_type = "s"
    if text.startswith(_DANGEROUS):
        cell.quotePrefix = True
    _style(cell, **style)
    return cell


def put(ws: Worksheet, row: int, col: int, value: Any, **style) -> Any:
    """Write a number, date or one of OUR formulas."""
    cell = ws.cell(row=row, column=col, value=value)
    _style(cell, **style)
    return cell


def _style(cell, *, bold=False, size=10, color=INK, italic=False, fill: Optional[str] = None, fmt: Optional[str] = None,
           border=True, wrap=False, align: Optional[str] = None) -> None:
    cell.font = _font(bold, size, color, italic)
    if fill:
        cell.fill = PatternFill("solid", start_color=fill, end_color=fill)
    if fmt:
        cell.number_format = fmt
    if border:
        cell.border = BORDER
    cell.alignment = Alignment(wrap_text=wrap, vertical="top" if wrap else "center", horizontal=align)


def _header(ws: Worksheet, row: int, labels: Iterable[str], start: int = 1) -> None:
    for i, label in enumerate(labels):
        put_text(ws, row, start + i, label, bold=True, fill=BRAND, wrap=True)
    ws.row_dimensions[row].height = 30


def _title(ws: Worksheet, title: str, subtitle: str, width: int) -> None:
    put_text(ws, 1, 1, title, bold=True, size=14, border=False)
    put_text(ws, 2, 1, subtitle, color=MUTED, border=False)
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=max(1, width))
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=max(1, width))
    ws.row_dimensions[1].height = 22


def _widths(ws: Worksheet, widths: dict[int, float]) -> None:
    for col, w in widths.items():
        ws.column_dimensions[get_column_letter(col)].width = w


def _print(ws: Worksheet, header_row: int) -> None:
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_title_rows = f"{header_row}:{header_row}"


def sheet_name(title: str, used: set[str], prefix: str = "") -> str:
    base = re.sub(r"[\[\]:*?/\\']", " ", f"{prefix}{title}").strip() or "Sheet"
    base = " ".join(base.split())[:31]
    name, n = base, 2
    while name.lower() in used:
        suffix = f" ({n})"
        name, n = base[: 31 - len(suffix)] + suffix, n + 1
    used.add(name.lower())
    return name


def _ref(sheet: str) -> str:
    return "'" + sheet.replace("'", "''") + "'"


def _local(dt: Optional[datetime], tz: ZoneInfo) -> Optional[datetime]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(tz).replace(tzinfo=None)                 # Excel has no time zones: local wall time, zone named in the header


def _student_label(s: dict) -> str:
    return " ".join(p for p in (s.get("first_name"), s.get("last_name")) if p) or s.get("email") or s["id"]


# ---------------------------------------------------------------- the workbook
def build_gradebook(*, course: dict, assignments: list[dict], students: list[dict], cells: dict[tuple[str, str], dict],
                    exported_by: str, tz_name: str = "UTC", include_feedback: bool = True, include_rubric: bool = True,
                    scope_title: Optional[str] = None, now: Optional[datetime] = None) -> bytes:
    tz = ZoneInfo(tz_name)
    exported_at = _local(now or datetime.now(timezone.utc), tz)
    wb = Workbook()
    used: set[str] = set()
    summary = wb.active
    summary.title = sheet_name("Summary", used)
    gb_name = sheet_name("Gradebook", used)
    gb = wb.create_sheet(gb_name)
    first_data, n = 7, len(students)
    last_data = first_data + max(n, 1) - 1

    # ------------------------------------------------ Gradebook
    fixed = ["Student ID", "Last name", "First name", "Email", "Section", "Enrollment"]
    acol: dict[str, tuple[int, int]] = {}                       # assignment id -> (points column, percent column)
    col = len(fixed) + 1
    for a in assignments:
        acol[a["id"]] = (col, col + 1)
        col += 2
    graded_col, missing_col, avg_col = col, col + 1, col + 2
    heading = f"{course['code']} · {course['title']} — {scope_title or 'Gradebook'}"
    _title(gb, heading, f"Exported {exported_at:%Y-%m-%d %H:%M} ({tz_name}) by {exported_by}. Percentages and averages count graded work only: "
                        "blank means not graded, never 0.", avg_col)
    for i, label in enumerate(fixed, 1):
        put_text(gb, 4, i, label, bold=True, fill=BRAND, wrap=True)
        put_text(gb, 5, i, "", fill=BRAND)
        gb.merge_cells(start_row=4, start_column=i, end_row=5, end_column=i)
    for a in assignments:
        p, q = acol[a["id"]]
        due = _local(a.get("due_at"), tz)
        put_text(gb, 4, p, f"{a['title']}" + (f" (due {due:%Y-%m-%d})" if due else ""), bold=True, fill=BRAND, wrap=True)
        put_text(gb, 4, q, "", fill=BRAND)
        gb.merge_cells(start_row=4, start_column=p, end_row=4, end_column=q)
        put_text(gb, 5, p, "Points", bold=True, fill=BRAND_LIGHT, align="center")
        put_text(gb, 5, q, "%", bold=True, fill=BRAND_LIGHT, align="center")
    for c_, label in ((graded_col, "Graded"), (missing_col, "Missing"), (avg_col, "Course average %")):
        put_text(gb, 4, c_, label, bold=True, fill=BRAND, wrap=True)
        put_text(gb, 5, c_, "", fill=BRAND)
        gb.merge_cells(start_row=4, start_column=c_, end_row=5, end_column=c_)
    gb.row_dimensions[4].height = 42
    put_text(gb, 6, 1, "Max points", bold=True, fill=SURFACE_MUTED)
    for i in range(2, len(fixed) + 1):
        put_text(gb, 6, i, "", fill=SURFACE_MUTED)
    for a in assignments:
        p, q = acol[a["id"]]
        put(gb, 6, p, float(a["points"]), bold=True, fill=SURFACE_MUTED, fmt=PTS, align="center")
        put_text(gb, 6, q, "", fill=SURFACE_MUTED)
    for c_ in (graded_col, missing_col, avg_col):
        put_text(gb, 6, c_, "", fill=SURFACE_MUTED)

    for r, s in enumerate(students, first_data):
        for i, v in enumerate((s.get("code") or s["id"], s.get("last_name"), s.get("first_name"), s.get("email"), s.get("section"),
                               "Active" if s.get("status", "active") == "active" else "Removed"), 1):
            put_text(gb, r, i, v)
        missing = 0
        for a in assignments:
            p, q = acol[a["id"]]
            cell = cells.get((s["id"], a["id"])) or {"status": "not_submitted"}
            if cell["status"] == "graded":
                put(gb, r, p, float(cell.get("points", cell["score"])), fmt=PTS, align="center")
            else:
                missing += cell["status"] == "missing"
                put_text(gb, r, p, STATUS_LABEL[cell["status"]], italic=True, color=MUTED, align="center")
            pl = get_column_letter(p)
            put(gb, r, q, f"=IF(ISNUMBER({pl}{r}),{pl}{r}/{pl}$6,\"\")", fmt=PCT, align="center")
        pts_refs = ",".join(f"{get_column_letter(acol[a['id']][0])}{r}" for a in assignments)
        pct_refs = ",".join(f"{get_column_letter(acol[a['id']][1])}{r}" for a in assignments)
        put(gb, r, graded_col, f"=COUNT({pts_refs})" if assignments else 0, align="center")
        put(gb, r, missing_col, missing, align="center")
        put(gb, r, avg_col, f"=IFERROR(AVERAGE({pct_refs}),\"\")" if assignments else "", fmt=PCT, bold=True, align="center")
    if not students:
        put_text(gb, first_data, 1, "No students are enrolled.", italic=True, color=MUTED, border=False)

    avg_row = last_data + 1
    put_text(gb, avg_row, 1, "Class average", bold=True, fill=SURFACE_MUTED)
    for i in range(2, avg_col + 1):
        put_text(gb, avg_row, i, "", fill=SURFACE_MUTED)
    if students:
        for a in assignments:
            q = get_column_letter(acol[a["id"]][1])
            put(gb, avg_row, acol[a["id"]][1], f"=IFERROR(AVERAGE({q}{first_data}:{q}{last_data}),\"\")", fmt=PCT, bold=True, fill=SURFACE_MUTED, align="center")
        av = get_column_letter(avg_col)
        put(gb, avg_row, avg_col, f"=IFERROR(AVERAGE({av}{first_data}:{av}{last_data}),\"\")", fmt=PCT, bold=True, fill=SURFACE_MUTED, align="center")

    pct_cols = [acol[a["id"]][1] for a in assignments] + [avg_col]
    if students:
        for c_ in pct_cols:
            rng = f"{get_column_letter(c_)}{first_data}:{get_column_letter(c_)}{last_data}"
            gb.conditional_formatting.add(rng, CellIsRule(operator="lessThan", formula=["0.6"], fill=PatternFill("solid", start_color=BAD, end_color=BAD)))
            gb.conditional_formatting.add(rng, CellIsRule(operator="greaterThanOrEqual", formula=["0.9"], fill=PatternFill("solid", start_color=GOOD, end_color=GOOD)))
    gb.freeze_panes = gb.cell(row=first_data, column=len(fixed) + 1)
    _widths(gb, {1: 16, 2: 16, 3: 16, 4: 28, 5: 14, 6: 11, **{c_: 11 for a in assignments for c_ in acol[a["id"]]}, graded_col: 9, missing_col: 9, avg_col: 13})
    _print(gb, 5)

    # ------------------------------------------------ Summary
    ws = summary
    _title(ws, heading, f"SocratiQ grade export · {exported_at:%Y-%m-%d %H:%M} ({tz_name})", 12)
    facts = [("Course", f"{course['code']} · {course['title']}"), ("Instructor(s)", ", ".join(course.get("instructors") or []) or "—"),
             ("Sections", ", ".join(course.get("sections") or []) or "—"), ("Students", n), ("Assignments", len(assignments)),
             ("Exported by", exported_by), ("Exported at", f"{exported_at:%Y-%m-%d %H:%M} ({tz_name})")]
    for i, (k, v) in enumerate(facts, 4):
        put_text(ws, i, 1, k, bold=True, fill=SURFACE_MUTED)
        if isinstance(v, (int, float)):
            put(ws, i, 2, v, align="left")
        else:
            put_text(ws, i, 2, v)
        ws.merge_cells(start_row=i, start_column=2, end_row=i, end_column=4)
    top = 4 + len(facts) + 1
    put_text(ws, top, 1, "Assignments", bold=True, size=12, border=False)
    labels = ["Assignment", "Due", "Points", "Submitted", "Graded", "Missing", "Average %", "Median %", "Highest %", "Lowest %", "By instructor", "AI-assisted"]
    _header(ws, top + 1, labels)
    for i, a in enumerate(assignments, top + 2):
        q = get_column_letter(acol[a["id"]][1])
        rng = f"{_ref(gb_name)}!{q}{first_data}:{q}{last_data}"
        mine = [cells.get((s["id"], a["id"])) or {"status": "not_submitted"} for s in students]
        put_text(ws, i, 1, a["title"], wrap=True)
        due = _local(a.get("due_at"), tz)
        put(ws, i, 2, due, fmt=DAY) if due else put_text(ws, i, 2, "—", color=MUTED)
        put(ws, i, 3, float(a["points"]), fmt=PTS)
        put(ws, i, 4, sum(1 for m in mine if m["status"] in ("graded", "ungraded")))
        put(ws, i, 5, f"=COUNT({rng})" if students else 0)
        put(ws, i, 6, sum(1 for m in mine if m["status"] == "missing"))
        if students:
            put(ws, i, 7, f"=IFERROR(AVERAGE({rng}),\"\")", fmt=PCT)
            put(ws, i, 8, f"=IFERROR(MEDIAN({rng}),\"\")", fmt=PCT)
            put(ws, i, 9, f"=IF(COUNT({rng})=0,\"\",MAX({rng}))", fmt=PCT)
            put(ws, i, 10, f"=IF(COUNT({rng})=0,\"\",MIN({rng}))", fmt=PCT)
        else:
            for c_ in (7, 8, 9, 10):
                put_text(ws, i, c_, "")
        put(ws, i, 11, sum(1 for m in mine if m["status"] == "graded" and m.get("source") == "manual"))
        put(ws, i, 12, sum(1 for m in mine if m["status"] == "graded" and m.get("source") in ("ai", "ai_edited", "ai_auto")))
    if not assignments:
        put_text(ws, top + 2, 1, "No published assignments yet.", italic=True, color=MUTED, border=False)

    dist_top = top + 3 + max(len(assignments), 1)
    put_text(ws, dist_top, 1, "Distribution of course averages", bold=True, size=12, border=False)
    _header(ws, dist_top + 1, ["Band", "Students"])
    av = get_column_letter(avg_col)
    avg_rng = f"{_ref(gb_name)}!{av}{first_data}:{av}{last_data}"
    bands = [("90–100 %", ">=0.9", None), ("80–89 %", ">=0.8", "<0.9"), ("70–79 %", ">=0.7", "<0.8"), ("60–69 %", ">=0.6", "<0.7"), ("Below 60 %", "<0.6", None)]
    for i, (label, lo, hi) in enumerate(bands, dist_top + 2):
        put_text(ws, i, 1, label)
        crit = f'{avg_rng},"{lo}"' + (f',{avg_rng},"{hi}"' if hi else "")
        put(ws, i, 2, f"=COUNTIFS({crit})" if students else 0)
    i = dist_top + 2 + len(bands)
    put_text(ws, i, 1, "No graded work yet")
    put(ws, i, 2, f"=COUNTIF({avg_rng},\"\")" if students else 0)

    notes_top = i + 2
    put_text(ws, notes_top, 1, "How to read this workbook", bold=True, size=12, border=False)
    for k, line in enumerate([
        "Percentages and averages use graded work only. Ungraded, missing or not-yet-submitted work is blank, never counted as 0.",
        "Missing = the due date has passed and nothing was submitted. Not submitted = not handed in yet (no due date or not yet due).",
        "Course average = the mean of a student's graded assignment percentages (each assignment weighs the same).",
        "Grade source (Details sheet): Instructor; AI draft released by instructor; AI draft edited by instructor; AI released automatically.",
        "Statistics on this sheet are formulas over the Gradebook sheet: editing a grade there updates them.",
    ], notes_top + 1):
        put_text(ws, k, 1, line, color=MUTED, border=False)
    _widths(ws, {1: 34, 2: 14, 3: 10, 4: 11, 5: 10, 6: 10, 7: 11, 8: 11, 9: 11, 10: 11, 11: 13, 12: 12})
    _print(ws, top + 1)

    # ------------------------------------------------ Details
    det = wb.create_sheet(sheet_name("Details", used))
    cols = ["Student ID", "Student", "Email", "Section", "Assignment", "Due", "Status", "Submitted at", "Late", "Attempt", "Score", "Max", "%",
            "Grade source", "Graded by", "Graded at"] + (["Feedback to student"] if include_feedback else [])
    _title(det, f"{course['code']} · {course['title']} — Details", f"One row per student and assignment. Times in {tz_name}.", len(cols))
    _header(det, 4, cols)
    r = 5
    for s in students:
        for a in assignments:
            cell = cells.get((s["id"], a["id"])) or {"status": "not_submitted"}
            due = _local(a.get("due_at"), tz)
            put_text(det, r, 1, s.get("code") or s["id"])
            put_text(det, r, 2, _student_label(s))
            put_text(det, r, 3, s.get("email"))
            put_text(det, r, 4, s.get("section"))
            put_text(det, r, 5, a["title"])
            put(det, r, 6, due, fmt=DAY) if due else put_text(det, r, 6, "")
            put_text(det, r, 7, STATUS_LABEL[cell["status"]])
            sub_at = _local(cell.get("submitted_at"), tz)
            put(det, r, 8, sub_at, fmt=DT) if sub_at else put_text(det, r, 8, "")
            put_text(det, r, 9, "Yes" if cell.get("late") else ("No" if sub_at else ""))
            put(det, r, 10, cell["attempt"]) if cell.get("attempt") else put_text(det, r, 10, "")
            if cell["status"] == "graded":
                put(det, r, 11, float(cell["score"]), fmt=PTS)
                put(det, r, 12, float(cell["max_score"]), fmt=PTS)
                put(det, r, 13, f"=IF(AND(ISNUMBER(K{r}),L{r}>0),K{r}/L{r},\"\")", fmt=PCT)
                put_text(det, r, 14, SOURCE_LABEL.get(cell.get("source") or "manual", "Instructor"))
                put_text(det, r, 15, cell.get("graded_by") or ("SocratiQ" if cell.get("source") == "ai_auto" else ""))
                g_at = _local(cell.get("graded_at"), tz)
                put(det, r, 16, g_at, fmt=DT) if g_at else put_text(det, r, 16, "")
            else:
                for c_ in range(11, 17):
                    put_text(det, r, c_, "")
            if include_feedback:
                put_text(det, r, 17, cell.get("feedback") if cell["status"] == "graded" else "", wrap=True)
            r += 1
    if r > 5:
        det.auto_filter.ref = f"A4:{get_column_letter(len(cols))}{r - 1}"
    det.freeze_panes = "C5"
    _widths(det, {1: 16, 2: 24, 3: 28, 4: 12, 5: 30, 6: 11, 7: 13, 8: 16, 9: 6, 10: 8, 11: 8, 12: 8, 13: 8, 14: 28, 15: 18, 16: 16, 17: 60})
    _print(det, 4)

    # ------------------------------------------------ Rubric sheets
    if include_rubric:
        for a in assignments:
            rubric = a.get("rubric") or []
            if not rubric:
                continue
            rs = wb.create_sheet(sheet_name(a["title"], used, prefix="Rubric · "))
            labels = ["Student ID", "Student"] + [f"{c['title']} (/{float(c['points']):g})" for c in rubric] + ["Total", "%", "Grade source"]
            _title(rs, f"{a['title']} — rubric scores", "Points per criterion for grades given with the rubric. Holistic grades show only the total.", len(labels))
            _header(rs, 4, labels)
            first, k = 5, len(rubric)
            for rr, s in enumerate(students, first):
                cell = cells.get((s["id"], a["id"])) or {"status": "not_submitted"}
                put_text(rs, rr, 1, s.get("code") or s["id"])
                put_text(rs, rr, 2, _student_label(s))
                by_id = {c["id"]: c for c in cell.get("criteria") or []} if cell["status"] == "graded" else {}
                for j, c in enumerate(rubric, 3):
                    got = by_id.get(c["id"])
                    put(rs, rr, j, float(got["points_awarded"]), fmt=PTS, align="center") if got else put_text(rs, rr, j, "")
                lo, hi = get_column_letter(3), get_column_letter(2 + k)
                tot = 3 + k
                if cell["status"] == "graded" and not by_id:
                    put(rs, rr, tot, float(cell.get("points", cell["score"])), fmt=PTS, bold=True, align="center")       # holistic grade: total only
                else:
                    put(rs, rr, tot, f"=IF(COUNT({lo}{rr}:{hi}{rr})=0,\"\",SUM({lo}{rr}:{hi}{rr}))", fmt=PTS, bold=True, align="center")
                tl = get_column_letter(tot)
                put(rs, rr, tot + 1, f"=IF(ISNUMBER({tl}{rr}),{tl}{rr}/{float(a['points']):g},\"\")", fmt=PCT, align="center")
                put_text(rs, rr, tot + 2, SOURCE_LABEL.get(cell.get("source") or "manual", "") if cell["status"] == "graded" else STATUS_LABEL[cell["status"]])
            if students:
                last = first + len(students) - 1
                ar = last + 1
                put_text(rs, ar, 1, "Average", bold=True, fill=SURFACE_MUTED)
                put_text(rs, ar, 2, "", fill=SURFACE_MUTED)
                for j in range(3, 3 + k + 2):
                    L = get_column_letter(j)
                    put(rs, ar, j, f"=IFERROR(AVERAGE({L}{first}:{L}{last}),\"\")", fmt=PCT if j == tot + 1 else PTS, bold=True, fill=SURFACE_MUTED, align="center")
                put_text(rs, ar, tot + 2, "", fill=SURFACE_MUTED)
            rs.freeze_panes = "C5"
            _widths(rs, {1: 16, 2: 24, **{j: 14 for j in range(3, 3 + k)}, 3 + k: 9, 4 + k: 9, 5 + k: 28})
            _print(rs, 4)

    wb.properties.title = heading
    wb.properties.creator = "SocratiQ"
    wb.properties.subject = "Grade export"
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def export_filename(course_code: str, scope: Optional[str], today: datetime) -> tuple[str, str]:
    """(ASCII fallback name, UTF-8 name) for Content-Disposition."""
    def part(s: str) -> str:
        return re.sub(r"[^\w.-]+", "_", s, flags=re.UNICODE).strip("_")[:60]
    name = "_".join(p for p in ("SocratiQ", part(course_code), part(scope) if scope else "", "grades", f"{today:%Y-%m-%d}") if p) + ".xlsx"
    ascii_name = re.sub(r"_+", "_", re.sub(r"[^A-Za-z0-9_.-]", "_", name))
    return ascii_name, name
