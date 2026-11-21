-- Reverses 019_notes_board.sql. DESTROYS note groups and the importance / pin / course links on notes (the notes themselves and their
-- text are kept). Back them up first, e.g.
--   pg_dump --data-only --table=public.student_note_groups --table=public.student_note_group_members "$DATABASE_URL" > note_groups_backup.sql
-- Run manually (the migration runner only applies forward migrations from database/migrations/*.sql):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/down/019_notes_board.down.sql
-- Touches nothing but the objects 019 created, then forgets 019 so it can be re-applied later.
BEGIN;
DROP TABLE IF EXISTS public.student_note_group_members;
DROP TABLE IF EXISTS public.student_note_groups;
DROP INDEX IF EXISTS public.student_notes_course_idx;
DROP INDEX IF EXISTS public.student_notes_assignment_idx;
ALTER TABLE public.student_notes DROP CONSTRAINT IF EXISTS student_notes_course_fk;
ALTER TABLE public.student_notes DROP CONSTRAINT IF EXISTS student_notes_assignment_fk;
ALTER TABLE public.student_notes DROP CONSTRAINT IF EXISTS student_notes_importance_chk;
ALTER TABLE public.student_notes DROP COLUMN IF EXISTS course_id;
ALTER TABLE public.student_notes DROP COLUMN IF EXISTS assignment_id;
ALTER TABLE public.student_notes DROP COLUMN IF EXISTS importance;
ALTER TABLE public.student_notes DROP COLUMN IF EXISTS pinned;
DELETE FROM public.schema_migrations WHERE filename = '019_notes_board.sql';
COMMIT;
