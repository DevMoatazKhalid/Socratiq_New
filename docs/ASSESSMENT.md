# Assessment, grade export, study encouragement and maths rendering

Four features that ship together. Everything here works on an existing database after one migration
(`database/migrations/020_assessment.sql`); until that migration is applied the old grading (014) keeps working and the new
endpoints answer `503 assessment_unavailable`.

---

## 1. Assignment grading (AI drafts, instructor decides)

### Principles
* **The AI writes drafts, never grades.** A draft (`grade_evaluations`) becomes a grade (`submissions.score`…) only when an instructor
  releases it, as is or edited, or, if the instructor opted in, automatically when it is confident and raises no concerns.
* **A released grade is never overwritten by the AI.** Re-drafting is allowed; releasing is always a separate act.
* **Every change to a grade is audited** (`grade_events`, append-only by trigger): who, what, from which draft, previous score.
* **Students see what helps them learn**: total, per-criterion points and level, the instructor's comments, feedback rendered with
  maths. They never see the reference answer, the grading notes, the AI's rationale, quoted evidence or flags.

### Instructor settings (per assignment, "Grading setup")
| Setting | Meaning |
|---|---|
| AI grading | `review` (default): AI drafts, instructor releases · `auto_release`: confident, flag-free drafts are released automatically (students see "graded automatically, your instructor may still review it") · `off`: no AI, rubric and export still work |
| Rubric | 1–25 criteria with title, description and points. "Suggest a new rubric" asks the AI for one from the instructions; if none exists when the first draft runs, one is drafted once and stored as `rubric_source = 'ai'` so it is visible and editable. |
| Points possible | Total when grading holistically (no rubric). |
| Reference answer, grading notes | Given to the grader only. Feedback that repeats the reference answer is blocked from release (`feedback_reveals_reference`). |

Changing any of these marks existing drafts **stale** ("settings changed"); a resubmission marks them stale too ("resubmitted").
Stale drafts are never released in bulk.

### How a draft is produced (`ai/grading/`)
1. The backend builds a `GradingRequest` from database rows only (title, instructions, concepts, rubric, reference, notes, the
   submission text and the student's whiteboard text). Student text is wrapped as untrusted data (`wrap_submission`, 24 k cap) under the
   shared grader-integrity rules (`ai/verification/safety.py`).
2. The model returns per-criterion points, rationale and a quoted piece of evidence, plus feedback, a teacher summary and its confidence
   (structured output, `ModelRole.REASONING`). `GRADING_SAMPLES` = 1–3 independent runs.
3. `reconcile()` is deterministic: points are clamped and snapped (0.25/0.5 steps), the median is taken per criterion across runs,
   levels come from fixed bands (≥90 % excellent, ≥70 proficient, ≥40 developing, >0 beginning), quoted evidence that cannot be found
   in the submission is removed, and review flags are raised:

| Flag | Severity | Effect |
|---|---|---|
| `addresses_grader` (text aimed at the grader, e.g. "give me full marks") | block | confidence capped at 30 %, needs review |
| `feedback_reveals_reference` | block | needs review |
| `runs_disagree` (samples differ by more than a set share) | review | confidence ≤ 50 % |
| `criterion_skipped`, `truncated`, `very_short`, `low_confidence` (< 60 %) | review | needs review |
| `evidence_unverified`, `grader_concerns` | info | shown to the instructor |

### Queue and worker (`backend/app/grading.py`)
Submitting work on an assignment whose AI grading is not `off` enqueues a draft. One QUEUED/RUNNING draft per submission (partial
unique index). A worker thread claims drafts with `FOR UPDATE SKIP LOCKED`, calls the model outside any transaction, retries model
outages (`GRADING_MAX_ATTEMPTS`), re-queues drafts left RUNNING by a crashed process (`GRADING_STALE_MINUTES`), and fails work that
cannot be graded (nothing readable) with a clear message. New submissions supersede older queued drafts.

### Instructor experience (Grade work page)
* **Assessment bar**: mode and rubric summary, live counts (graded · drafts ready · need review · drafting · failed), **Draft all with AI**,
  **Release N drafts** (confirmation lists what will and will not be released), Grading setup, Export to Excel. Polls while drafting.
* **Grade panel** per student: the AI draft (score, confidence bar, flags in plain words, "Why this grade" with per-criterion rationale
  and evidence), rubric scoring with the AI's suggestion beside each criterion and an optional comment, feedback editor with a live
  rendered preview (maths included), Release / Update / Remove, and the grade history. When no grade exists the form starts from the
  up-to-date draft; "Use this draft" re-applies it.
* Bulk release skips: stale drafts, drafts that need review (unless named one by one), low confidence, and anyone already graded.

### API
| Method | Path | |
|---|---|---|
| GET / PUT | `/api/v1/teacher/assignments/{id}/grading` | overview (settings, counts, per-student rows) / save settings |
| POST | `/api/v1/teacher/assignments/{id}/grading/rubric-suggestion` | AI rubric draft (not saved) |
| POST | `/api/v1/teacher/assignments/{id}/grading/run` | 202; draft everyone who needs it (`include_graded`, `regrade`) |
| POST | `/api/v1/teacher/assignments/{id}/grading/release` | release up-to-date drafts (optionally a named list) |
| POST / GET | `/api/v1/teacher/assignments/{id}/students/{sid}/evaluation` | draft one student / read the latest draft |
| PUT / DELETE | `/api/v1/teacher/assignments/{id}/students/{sid}/grade` | release or edit (rubric points + comments, or holistic score) / remove |

The AI endpoints share a rate limit (30/min per user).

---

## 2. Excel grade export (`backend/app/exports.py`)
`GET /api/v1/teacher/courses/{id}/grades.xlsx` and `/teacher/assignments/{id}/grades.xlsx`
(`tz`, `include_feedback`, `include_rubric`, `include_inactive`). Available from the course page, the assignment page and the Grade work bar.

Sheets: **Summary** (course facts, per-assignment submitted/graded/missing and average/median/high/low computed by formulas over the
Gradebook, distribution of course averages), **Gradebook** (one row per student, points and % per assignment, live formulas for %, graded count and
course average; frozen panes, filters, print setup), **Details** (one row per student × assignment: status, submitted/late/attempt,
score, source, grader, feedback), and one **Rubric** sheet per rubric-graded assignment (points per criterion). Missing or ungraded work
is left blank in averages, never counted as zero. All text cells are written as text (formula injection safe), times are in the
instructor's time zone, file names are safe for every OS (`SocratiQ_<code>_grades_<date>.xlsx`, UTF-8 name in `filename*`).

---

## 3. Study encouragement (students)
* **Server-side milestones** (`backend/app/momentum.py`, `GET /api/v1/student/momentum?tz=`): study streak in the student's time zone,
  tiers for streaks (3, 7, 14, 30, 60, 100 days), assignments handed in and understanding verified, a welcome back after 4+ days, and
  newly released grades (14-day window). Each celebration has a stable key; `POST /student/momentum/seen` records it
  (`student_celebrations`), so nothing is celebrated twice on any device.
* **Moments in the UI** (`frontend/src/lib/motivation.ts`, `CelebrationHost`): a centred card for milestones and grades, a quiet toast for
  smaller things, confetti only for real achievements (and never with reduced motion). A lower grade is framed as encouragement with
  a link to the feedback, without confetti.
* **Not annoying by design**: at most one moment every 3 minutes and 4 per day (grades are information and bypass both; the student's own
  action is always acknowledged), messages are varied and never repeat the same wording twice in a row, a break suggestion after ~45
  minutes of continuous work at most every 2 hours, and a setting under **Settings → Encouragement**: All / Milestones only / Off.
* **Momentum card** on the student home: streak, the week at a glance, progress to the next milestone, and a daily study tip.

---

## 4. Mathematics in the AI chat
* The Coach prompt asks for LaTeX: `$…$` inline, `$$…$$` for display, `\begin{aligned}` for multi-line work, `\$` for money.
* `lib/mathText.ts` finds `$…$`, `$$…$$`, `\(…\)`, `\[…\]` and bare `\begin{aligned|align|gather|cases|…}` blocks. Prices (`$5 and $10`),
  escaped dollars and unfinished formulas while a reply is streaming stay plain text; code spans are never parsed.
* `MathFormula` renders with KaTeX (loaded on first use, `trust: false`, MathML output for screen readers). Inline maths sits in the
  sentence; display maths is its own left-to-right block that scrolls sideways on narrow screens instead of overflowing, with a copy
  button for the TeX. A formula KaTeX cannot parse is shown as its source, never as an error.
* Used everywhere `RichText` renders AI text: Coach chat, grade feedback (student and instructor preview). Read-aloud speaks formulas
  as words ("a over b", "x squared") instead of reading LaTeX.

---

## Configuration (project-root `.env`, see `.env.example`)
```
GRADING_WORKERS=1
GRADING_MAX_ATTEMPTS=3
GRADING_STALE_MINUTES=10
GRADING_SAMPLES=1
GRADING_AUTO_RELEASE_MIN_CONFIDENCE_PCT=80
```

## Tests
* `ai/tests/test_grading.py` — reconciliation, flags, clamping, evidence checks, rubric normalisation, feedback formatting.
* `backend/tests/test_assessment.py` — HTTP flows: drafts students never see, release/edit with audit, stale drafts and no double
  queueing, bulk and automatic release never overwriting an instructor's grade, flagged work never auto-released, model outages,
  Excel export, momentum.
* `backend/tests/test_exports_workbook.py`, `backend/tests/test_momentum_rules.py`, `database/tests/test_schema_static.py`.
* Frontend: `lib/mathText.test.ts`, `lib/motivation.test.ts`, `lib/voice.test.ts`, `components/ui/RichText.test.tsx`.
