-- Reverses 018_student_notes.sql. DESTROYS every student note: back them up first, e.g.
--   pg_dump --data-only --table=public.student_notes "$DATABASE_URL" > student_notes_backup.sql
-- Run manually (the migration runner only applies forward migrations from database/migrations/*.sql):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/down/018_student_notes.down.sql
-- Touches nothing but the objects 018 created, then forgets 018 so it can be re-applied later.
BEGIN;
DROP TABLE IF EXISTS public.student_notes;            -- also drops its indexes, trigger and policies
DELETE FROM public.schema_migrations WHERE filename = '018_student_notes.sql';
COMMIT;
