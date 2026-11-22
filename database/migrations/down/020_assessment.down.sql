-- Reverses 020_assessment.sql. DESTROYS AI grading drafts, the grade audit trail, rubrics / grading settings and the celebrations a
-- student has seen. Released grades themselves (score, max_score, feedback, graded_at, graded_by on public.submissions) are KEPT.
-- Back up first, e.g.
--   pg_dump --data-only --table=public.grade_evaluations --table=public.grade_events --table=public.student_celebrations "$DATABASE_URL" > assessment_backup.sql
-- Run manually (the migration runner only applies forward migrations from database/migrations/*.sql):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/down/020_assessment.down.sql
-- Touches nothing but the objects 020 created, then forgets 020 so it can be re-applied later.
BEGIN;
ALTER TABLE public.submissions DROP CONSTRAINT IF EXISTS submissions_grade_source_chk;
ALTER TABLE public.submissions DROP CONSTRAINT IF EXISTS submissions_grade_evaluation_fk;
ALTER TABLE public.submissions DROP COLUMN IF EXISTS grade_source;
ALTER TABLE public.submissions DROP COLUMN IF EXISTS grade_evaluation_id;
ALTER TABLE public.submissions DROP COLUMN IF EXISTS grade_criteria;
DROP TABLE IF EXISTS public.grade_events;
DROP FUNCTION IF EXISTS public.grade_events_append_only();
DROP TABLE IF EXISTS public.grade_evaluations;
DROP TABLE IF EXISTS public.student_celebrations;
ALTER TABLE public.assignments DROP CONSTRAINT IF EXISTS assignments_points_possible_chk;
ALTER TABLE public.assignments DROP CONSTRAINT IF EXISTS assignments_rubric_shape_chk;
ALTER TABLE public.assignments DROP CONSTRAINT IF EXISTS assignments_rubric_source_chk;
ALTER TABLE public.assignments DROP CONSTRAINT IF EXISTS assignments_ai_grading_chk;
ALTER TABLE public.assignments DROP CONSTRAINT IF EXISTS assignments_grading_text_len_chk;
ALTER TABLE public.assignments DROP COLUMN IF EXISTS points_possible;
ALTER TABLE public.assignments DROP COLUMN IF EXISTS rubric;
ALTER TABLE public.assignments DROP COLUMN IF EXISTS rubric_source;
ALTER TABLE public.assignments DROP COLUMN IF EXISTS reference_answer;
ALTER TABLE public.assignments DROP COLUMN IF EXISTS grading_notes;
ALTER TABLE public.assignments DROP COLUMN IF EXISTS ai_grading;
ALTER TABLE public.assignments DROP COLUMN IF EXISTS grading_updated_at;
DELETE FROM public.schema_migrations WHERE filename = '020_assessment.sql';
COMMIT;
