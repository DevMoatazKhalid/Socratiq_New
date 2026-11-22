-- 020_assessment.sql -- the assessment layer: rubric-based grading, AI grading drafts, a grade audit trail, and student celebrations.
--
-- Additive and forward-only. Every new column is nullable or has a default, so the existing grading endpoints (014) keep working unchanged.
-- Reverse with database/migrations/down/020_assessment.down.sql.
--
-- Principles
-- * public.submissions stays the ONE source of truth for the grade a student sees (014). An AI evaluation is a DRAFT in
--   grade_evaluations until an instructor releases it (or the instructor opted the assignment into auto-release, and the draft
--   passed every integrity and confidence check). Drafts are never readable by students, through the API or the Data API.
-- * assignments gain grading settings: points_possible, a rubric (criteria with points), an optional reference answer and private
--   grading notes for the grader, and ai_grading (off | review | auto_release). None of these bump the assignment version
--   (010 only versions what students see), so changing a rubric never re-versions a student's attempt.
-- * grade_evaluations: one row per AI grading run (a queue + history). At most one QUEUED/RUNNING run per submission (partial unique
--   index), so a double-click or a parallel "grade all" can never grade the same work twice at once. Rows are claimed by the backend
--   worker with FOR UPDATE SKIP LOCKED, like the file pipeline (011).
-- * submissions gain the provenance of the released grade (manual | ai | ai_edited), the evaluation it came from, and the final
--   per-criterion breakdown the student sees.
-- * grade_events: an append-only audit trail of every grade change (who, what, from which value, from which evaluation).
-- * student_celebrations: which motivational milestones a student has already seen, so a celebration is shown once, on any device.
--
-- RLS: same model as 013/018. The Data API is read-only; AI drafts and the audit trail are visible to the assignment's instructors only.
-- Idempotent: safe to run repeatedly.
BEGIN;

-- ------------------------------------------------------------------ 1. grading settings on the assignment
ALTER TABLE public.assignments ADD COLUMN IF NOT EXISTS points_possible   numeric;
ALTER TABLE public.assignments ADD COLUMN IF NOT EXISTS rubric            jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.assignments ADD COLUMN IF NOT EXISTS rubric_source     text  NOT NULL DEFAULT 'none';
ALTER TABLE public.assignments ADD COLUMN IF NOT EXISTS reference_answer  text;
ALTER TABLE public.assignments ADD COLUMN IF NOT EXISTS grading_notes     text;
ALTER TABLE public.assignments ADD COLUMN IF NOT EXISTS ai_grading        text  NOT NULL DEFAULT 'review';
ALTER TABLE public.assignments ADD COLUMN IF NOT EXISTS grading_updated_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assignments_points_possible_chk') THEN
    ALTER TABLE public.assignments ADD CONSTRAINT assignments_points_possible_chk
      CHECK (points_possible IS NULL OR (points_possible > 0 AND points_possible <= 100000));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assignments_rubric_shape_chk') THEN
    ALTER TABLE public.assignments ADD CONSTRAINT assignments_rubric_shape_chk
      CHECK (jsonb_typeof(rubric) = 'array' AND jsonb_array_length(rubric) <= 25 AND pg_column_size(rubric) <= 200000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assignments_rubric_source_chk') THEN
    ALTER TABLE public.assignments ADD CONSTRAINT assignments_rubric_source_chk CHECK (rubric_source IN ('none', 'teacher', 'ai'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assignments_ai_grading_chk') THEN
    ALTER TABLE public.assignments ADD CONSTRAINT assignments_ai_grading_chk CHECK (ai_grading IN ('off', 'review', 'auto_release'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assignments_grading_text_len_chk') THEN
    ALTER TABLE public.assignments ADD CONSTRAINT assignments_grading_text_len_chk
      CHECK ((reference_answer IS NULL OR char_length(reference_answer) <= 50000) AND (grading_notes IS NULL OR char_length(grading_notes) <= 8000));
  END IF;
END $$;

-- ------------------------------------------------------------------ 2. AI grading runs (queue + history)
CREATE TABLE IF NOT EXISTS public.grade_evaluations (
  evaluation_id    text PRIMARY KEY CHECK (evaluation_id ~ '^gev_[0-9a-f]{32}$'),
  university_id    text NOT NULL,
  course_id        text NOT NULL,
  assignment_id    text NOT NULL,
  submission_id    text NOT NULL,
  student_id       text NOT NULL,
  status           text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  trigger          text NOT NULL CHECK (trigger IN ('submission', 'teacher', 'bulk')),
  requested_by     text REFERENCES public.users (user_id) ON DELETE SET NULL,
  attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error            text CHECK (error IS NULL OR char_length(error) <= 1000),
  score            numeric,
  max_score        numeric,
  confidence       numeric,
  criteria         jsonb NOT NULL DEFAULT '[]'::jsonb,
  feedback         text CHECK (feedback IS NULL OR char_length(feedback) <= 4000),        -- student-facing draft
  rationale        text CHECK (rationale IS NULL OR char_length(rationale) <= 4000),      -- instructor-facing summary, never shown to students
  flags            jsonb NOT NULL DEFAULT '[]'::jsonb,
  needs_review     boolean NOT NULL DEFAULT false,
  rubric_snapshot  jsonb,
  rubric_hash      text,
  submission_hash  text,
  model            text,
  prompt_version   text,
  duration_ms      integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  CONSTRAINT grade_evaluations_submission_fk FOREIGN KEY (submission_id, university_id, student_id, assignment_id)
    REFERENCES public.submissions (submission_id, university_id, student_id, assignment_id) ON DELETE CASCADE,
  CONSTRAINT grade_evaluations_assignment_fk FOREIGN KEY (assignment_id, course_id, university_id)
    REFERENCES public.assignments (assignment_id, course_id, university_id) ON DELETE CASCADE,
  CONSTRAINT grade_evaluations_result_chk CHECK (
    status <> 'COMPLETED'
    OR (score IS NOT NULL AND max_score IS NOT NULL AND max_score > 0 AND score >= 0 AND score <= max_score
        AND confidence IS NOT NULL AND confidence >= 0 AND confidence <= 1 AND completed_at IS NOT NULL)),
  CONSTRAINT grade_evaluations_json_chk CHECK (jsonb_typeof(criteria) = 'array' AND jsonb_typeof(flags) = 'array')
);
CREATE UNIQUE INDEX IF NOT EXISTS grade_evaluations_one_active_uk ON public.grade_evaluations (submission_id) WHERE status IN ('QUEUED', 'RUNNING');
CREATE INDEX IF NOT EXISTS grade_evaluations_queue_idx ON public.grade_evaluations (created_at) WHERE status = 'QUEUED';
CREATE INDEX IF NOT EXISTS grade_evaluations_assignment_idx ON public.grade_evaluations (assignment_id, student_id, created_at DESC);
CREATE INDEX IF NOT EXISTS grade_evaluations_submission_idx ON public.grade_evaluations (submission_id, created_at DESC);

-- ------------------------------------------------------------------ 3. provenance of the released grade
ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS grade_source        text;
ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS grade_evaluation_id text;
ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS grade_criteria      jsonb;

UPDATE public.submissions SET grade_source = 'manual' WHERE score IS NOT NULL AND grade_source IS NULL;     -- grades given before 020

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'submissions_grade_evaluation_fk') THEN
    ALTER TABLE public.submissions ADD CONSTRAINT submissions_grade_evaluation_fk
      FOREIGN KEY (grade_evaluation_id) REFERENCES public.grade_evaluations (evaluation_id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'submissions_grade_source_chk') THEN
    ALTER TABLE public.submissions ADD CONSTRAINT submissions_grade_source_chk CHECK (
      (score IS NULL AND grade_source IS NULL AND grade_evaluation_id IS NULL AND grade_criteria IS NULL)
      OR (score IS NOT NULL AND grade_source IS NOT NULL AND grade_source IN ('manual', 'ai', 'ai_edited')
          AND (grade_criteria IS NULL OR jsonb_typeof(grade_criteria) = 'array')));
  END IF;
END $$;

-- ------------------------------------------------------------------ 4. grade audit trail (append-only)
CREATE TABLE IF NOT EXISTS public.grade_events (
  event_id        text PRIMARY KEY CHECK (event_id ~ '^gre_[0-9a-f]{32}$'),
  university_id   text NOT NULL,
  submission_id   text NOT NULL,
  student_id      text NOT NULL,
  assignment_id   text NOT NULL,
  actor_id        text REFERENCES public.users (user_id) ON DELETE SET NULL,          -- NULL = SocratiQ (auto-release)
  action          text NOT NULL CHECK (action IN ('released', 'edited', 'auto_released', 'cleared')),
  source          text CHECK (source IS NULL OR source IN ('manual', 'ai', 'ai_edited')),
  score           numeric,
  max_score       numeric,
  previous_score  numeric,
  previous_max    numeric,
  evaluation_id   text REFERENCES public.grade_evaluations (evaluation_id) ON DELETE SET NULL,
  note            text CHECK (note IS NULL OR char_length(note) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grade_events_submission_fk FOREIGN KEY (submission_id, university_id, student_id, assignment_id)
    REFERENCES public.submissions (submission_id, university_id, student_id, assignment_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS grade_events_submission_idx ON public.grade_events (submission_id, created_at DESC);

-- The only UPDATE allowed is the one Postgres itself makes for ON DELETE SET NULL (a removed user or evaluation): every other field is frozen.
CREATE OR REPLACE FUNCTION public.grade_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.actor_id IS NULL OR NEW.actor_id IS NOT DISTINCT FROM OLD.actor_id)
     AND (NEW.evaluation_id IS NULL OR NEW.evaluation_id IS NOT DISTINCT FROM OLD.evaluation_id)
     AND ROW(NEW.event_id, NEW.university_id, NEW.submission_id, NEW.student_id, NEW.assignment_id, NEW.action, NEW.source, NEW.score,
             NEW.max_score, NEW.previous_score, NEW.previous_max, NEW.note, NEW.created_at)
         IS NOT DISTINCT FROM
         ROW(OLD.event_id, OLD.university_id, OLD.submission_id, OLD.student_id, OLD.assignment_id, OLD.action, OLD.source, OLD.score,
             OLD.max_score, OLD.previous_score, OLD.previous_max, OLD.note, OLD.created_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'grade_events is append-only' USING ERRCODE = 'check_violation';
END $$;
DROP TRIGGER IF EXISTS grade_events_no_update ON public.grade_events;
CREATE TRIGGER grade_events_no_update BEFORE UPDATE ON public.grade_events FOR EACH ROW EXECUTE FUNCTION public.grade_events_append_only();

-- ------------------------------------------------------------------ 5. celebrations a student has already seen
CREATE TABLE IF NOT EXISTS public.student_celebrations (
  student_id     text NOT NULL,
  university_id  text NOT NULL,
  key            text NOT NULL CHECK (key ~ '^[a-z_]{2,40}:[A-Za-z0-9_:.-]{1,120}$'),
  seen_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, key),
  CONSTRAINT student_celebrations_student_university_fk FOREIGN KEY (student_id, university_id)
    REFERENCES public.students (student_id, university_id) ON DELETE CASCADE
);

-- ------------------------------------------------------------------ RLS (same model as 013/018: read-only Data API)
ALTER TABLE public.grade_evaluations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grade_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_celebrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.grade_evaluations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.grade_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.student_celebrations FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS grade_evaluations_select ON public.grade_evaluations;
CREATE POLICY grade_evaluations_select ON public.grade_evaluations FOR SELECT TO authenticated
  USING (app.teaches_assignment(assignment_id));                       -- AI drafts: instructors only, never the student
DROP POLICY IF EXISTS grade_events_select ON public.grade_events;
CREATE POLICY grade_events_select ON public.grade_events FOR SELECT TO authenticated
  USING (app.teaches_assignment(assignment_id));
DROP POLICY IF EXISTS student_celebrations_select ON public.student_celebrations;
CREATE POLICY student_celebrations_select ON public.student_celebrations FOR SELECT TO authenticated
  USING (student_id = app.current_user_id());

GRANT SELECT ON public.grade_evaluations TO authenticated;
GRANT SELECT ON public.grade_events TO authenticated;
GRANT SELECT ON public.student_celebrations TO authenticated;

COMMIT;
