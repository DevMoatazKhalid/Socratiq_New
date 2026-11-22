-- 021_course_icon.sql -- the course icon chosen on "Create a course" (approved design: a grid of 12 subject icons).
--
-- Additive and forward-only: one nullable column. A course without an icon keeps showing the icon derived from its title, exactly as
-- before, so nothing changes for existing courses. Reverse with database/migrations/down/021_course_icon.down.sql.
-- The allowed names are the frontend's icon set; the backend validates the same list (schemas.COURSE_ICONS). Idempotent.
BEGIN;

ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS icon text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'courses_icon_chk') THEN
    ALTER TABLE public.courses ADD CONSTRAINT courses_icon_chk CHECK (icon IS NULL OR icon IN
      ('book', 'calculator', 'flask', 'globe', 'code', 'music', 'palette', 'atom', 'landmark', 'pencil', 'laptop', 'leaf'));
  END IF;
END $$;

COMMIT;
