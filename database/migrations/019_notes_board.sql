-- 019_notes_board.sql -- the organisation layer of the Notes board (approved "Notes board v2" design).
--
-- Additive and forward-only. Existing notes keep working unchanged: every new column is nullable or has a default, and the existing
-- /student/notes endpoints read and write exactly the columns they did before. Reverse with database/migrations/down/019_notes_board.down.sql.
--
-- * student_notes gains:
--     course_id / assignment_id  the course (and optionally the assignment) a note is filed under. ON DELETE SET NULL: removing a course or
--                                an assignment never deletes a student's notes, they just become "no course".
--     importance                 high | medium | low | NULL (shown as the sticky-note colour)
--     pinned                     pinned notes sort first
--   These are ORGANISATION fields. They are changed through PATCH /student/notes/{id}/meta and do NOT bump `version`, so re-colouring or
--   pinning a note can never cause a text-edit conflict in another tab.
-- * student_note_groups: a student's own named groups. A group may be attached to one assignment; its notes can come from any course.
-- * student_note_group_members: many-to-many between groups and notes. Both sides cascade, so deleting a note or a group cleans up.
--   The backend only ever links a student's own notes into that student's own groups (checked in code on every write).
--
-- RLS: identical model to 018 -- ownership policies for the Data API, SELECT-only grant to `authenticated`, writes go through the backend.
-- Idempotent: safe to run repeatedly.
BEGIN;

ALTER TABLE public.student_notes ADD COLUMN IF NOT EXISTS course_id     text;
ALTER TABLE public.student_notes ADD COLUMN IF NOT EXISTS assignment_id text;
ALTER TABLE public.student_notes ADD COLUMN IF NOT EXISTS importance    text;
ALTER TABLE public.student_notes ADD COLUMN IF NOT EXISTS pinned        boolean NOT NULL DEFAULT false;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'student_notes_course_fk') THEN
    ALTER TABLE public.student_notes ADD CONSTRAINT student_notes_course_fk
      FOREIGN KEY (course_id) REFERENCES public.courses (course_id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'student_notes_assignment_fk') THEN
    ALTER TABLE public.student_notes ADD CONSTRAINT student_notes_assignment_fk
      FOREIGN KEY (assignment_id) REFERENCES public.assignments (assignment_id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'student_notes_importance_chk') THEN
    ALTER TABLE public.student_notes ADD CONSTRAINT student_notes_importance_chk
      CHECK (importance IS NULL OR importance IN ('high', 'medium', 'low'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS student_notes_course_idx     ON public.student_notes (course_id)     WHERE course_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS student_notes_assignment_idx ON public.student_notes (assignment_id) WHERE assignment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.student_note_groups (
  group_id       text PRIMARY KEY CHECK (group_id ~ '^grp_[0-9a-f]{32}$'),
  student_id     text NOT NULL,
  university_id  text NOT NULL,
  name           text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  assignment_id  text REFERENCES public.assignments (assignment_id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_note_groups_student_university_fk FOREIGN KEY (student_id, university_id)
    REFERENCES public.students (student_id, university_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS student_note_groups_student_idx ON public.student_note_groups (student_id, created_at);

DROP TRIGGER IF EXISTS student_note_groups_set_updated_at ON public.student_note_groups;
CREATE TRIGGER student_note_groups_set_updated_at BEFORE UPDATE ON public.student_note_groups
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.student_note_group_members (
  group_id   text NOT NULL REFERENCES public.student_note_groups (group_id) ON DELETE CASCADE,
  note_id    text NOT NULL REFERENCES public.student_notes (note_id) ON DELETE CASCADE,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, note_id)
);
CREATE INDEX IF NOT EXISTS student_note_group_members_note_idx ON public.student_note_group_members (note_id);

-- ------------------------------------------------------------------ RLS (same model as 018)
ALTER TABLE public.student_note_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_note_group_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.student_note_groups FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.student_note_group_members FROM PUBLIC, anon, authenticated;

DROP POLICY IF EXISTS student_note_groups_select ON public.student_note_groups;
DROP POLICY IF EXISTS student_note_groups_insert ON public.student_note_groups;
DROP POLICY IF EXISTS student_note_groups_update ON public.student_note_groups;
DROP POLICY IF EXISTS student_note_groups_delete ON public.student_note_groups;
CREATE POLICY student_note_groups_select ON public.student_note_groups FOR SELECT TO authenticated
  USING (student_id = app.current_user_id());
CREATE POLICY student_note_groups_insert ON public.student_note_groups FOR INSERT TO authenticated
  WITH CHECK (student_id = app.current_user_id() AND university_id = app.current_university_id());
CREATE POLICY student_note_groups_update ON public.student_note_groups FOR UPDATE TO authenticated
  USING (student_id = app.current_user_id())
  WITH CHECK (student_id = app.current_user_id() AND university_id = app.current_university_id());
CREATE POLICY student_note_groups_delete ON public.student_note_groups FOR DELETE TO authenticated
  USING (student_id = app.current_user_id());

-- a membership row is visible/writable only when BOTH the group and the note belong to the current student
DROP POLICY IF EXISTS student_note_group_members_select ON public.student_note_group_members;
DROP POLICY IF EXISTS student_note_group_members_insert ON public.student_note_group_members;
DROP POLICY IF EXISTS student_note_group_members_delete ON public.student_note_group_members;
CREATE POLICY student_note_group_members_select ON public.student_note_group_members FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.student_note_groups g WHERE g.group_id = student_note_group_members.group_id AND g.student_id = app.current_user_id()));
CREATE POLICY student_note_group_members_insert ON public.student_note_group_members FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.student_note_groups g WHERE g.group_id = student_note_group_members.group_id AND g.student_id = app.current_user_id())
          AND EXISTS (SELECT 1 FROM public.student_notes n WHERE n.note_id = student_note_group_members.note_id AND n.student_id = app.current_user_id()));
CREATE POLICY student_note_group_members_delete ON public.student_note_group_members FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.student_note_groups g WHERE g.group_id = student_note_group_members.group_id AND g.student_id = app.current_user_id()));

GRANT SELECT ON public.student_note_groups TO authenticated;           -- read-only Data API (013); writes go through the backend
GRANT SELECT ON public.student_note_group_members TO authenticated;

COMMIT;
