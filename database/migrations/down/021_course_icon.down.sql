-- Reverses 021_course_icon.sql: courses go back to the icon derived from their title. Run manually:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/down/021_course_icon.down.sql
BEGIN;
ALTER TABLE public.courses DROP CONSTRAINT IF EXISTS courses_icon_chk;
ALTER TABLE public.courses DROP COLUMN IF EXISTS icon;
DELETE FROM public.schema_migrations WHERE filename = '021_course_icon.sql';
COMMIT;
