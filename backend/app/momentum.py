"""
Study momentum: streaks, milestones and "your grade is in" moments, computed from the student's REAL activity (pure functions here; the
queries live in routers/momentum.py).

A celebration is identified by a stable key ("streak:7", "submissions:10", "grade:<submission id>", "comeback:2026-11-21") and is shown
at most once per student, on any device: the client reports what it showed (POST /student/momentum/seen, table student_celebrations).
Tiered milestones only ever offer the HIGHEST tier reached that has not been seen, so a student who already has 30 submissions when the
feature ships sees one "25 submissions" moment, not five in a row.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Iterable, Optional

STREAK_TIERS = (3, 7, 14, 30, 60, 100)
SUBMISSION_TIERS = (1, 5, 10, 25, 50, 100)
VERIFIED_TIERS = (1, 5, 10, 25, 50)
COMEBACK_GAP_DAYS = 4
GRADE_WINDOW_DAYS = 14
PRIORITY = {"grade": 0, "streak": 1, "verified": 2, "submissions": 3, "comeback": 4}


def streak(days: Iterable[date], today: date) -> dict:
    """Consecutive active days ending today, or ending yesterday (the streak is still alive until today ends)."""
    s = set(days)
    active_today = today in s
    cur = today if active_today else today - timedelta(days=1)
    n = 0
    while cur in s:
        n += 1
        cur -= timedelta(days=1)
    best, run, prev = 0, 0, None
    for d in sorted(s):
        run = run + 1 if prev is not None and d - prev == timedelta(days=1) else 1
        best, prev = max(best, run), d
    return {"current": n, "active_today": active_today, "longest": best,
            "week": [{"date": (today - timedelta(days=i)).isoformat(), "active": (today - timedelta(days=i)) in s} for i in range(6, -1, -1)]}


def highest_tier(value: int, tiers: Iterable[int]) -> Optional[int]:
    reached = [t for t in tiers if value >= t]
    return max(reached) if reached else None


def next_tier(value: int, tiers: Iterable[int]) -> Optional[int]:
    ahead = [t for t in tiers if value < t]
    return min(ahead) if ahead else None


def _tier_seen(seen: set[str], kind: str, tier: int) -> bool:
    """Seeing a higher (or equal) tier of the same kind counts as having celebrated this one."""
    for k in seen:
        if k.startswith(kind + ":"):
            try:
                if int(k.split(":", 1)[1]) >= tier:
                    return True
            except ValueError:
                continue
    return False


def celebrations(*, today: date, days: set[date], submissions: int, verified: int, grades: list[dict], seen: set[str]) -> list[dict]:
    """Unseen celebrations, most important first. `grades` are recent releases: {submission_id, assignment_id, course_id, title, percentage,
    previous_average (or None)}."""
    out: list[dict] = []
    for g in grades:
        key = f"grade:{g['submission_id']}"
        if key in seen:
            continue
        improved = None
        if g.get("previous_average") is not None and g["percentage"] - g["previous_average"] >= 5:
            improved = round(g["percentage"] - g["previous_average"], 1)
        band = "excellent" if g["percentage"] >= 90 else "strong" if g["percentage"] >= 75 else "solid" if g["percentage"] >= 60 else "growing"
        out.append({"key": key, "kind": "grade", "band": band, "assignment_id": g["assignment_id"], "course_id": g["course_id"],
                    "title": g["title"], "percentage": g["percentage"], "improved_by": improved})
    st = streak(days, today)
    for kind, value, tiers in (("streak", st["current"], STREAK_TIERS), ("verified", verified, VERIFIED_TIERS), ("submissions", submissions, SUBMISSION_TIERS)):
        tier = highest_tier(value, tiers)
        if tier is not None and not _tier_seen(seen, kind, tier):
            out.append({"key": f"{kind}:{tier}", "kind": kind, "value": tier})
    if today in days:
        earlier = [d for d in days if d < today]
        if earlier and (today - max(earlier)).days >= COMEBACK_GAP_DAYS and f"comeback:{today.isoformat()}" not in seen:
            out.append({"key": f"comeback:{today.isoformat()}", "kind": "comeback", "value": (today - max(earlier)).days})
    return sorted(out, key=lambda c: PRIORITY[c["kind"]])
