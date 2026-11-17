-- 017_teaching_personas.sql -- the student's chosen teaching persona, and honest attribution of it on every Coach interaction.
--
-- Additive and forward-only: no existing row is changed or deleted, no existing constraint is touched, no earlier migration is edited.
-- * public.student_preferences: ONE row per student (created on first selection). The persona id is validated by the application against its
--   registry (ai/brain/personas.py) so that adding a persona never needs a migration; the CHECK here only keeps the value well-formed.
-- * ai_interactions gains nullable persona_id / persona_version (which persona and version spoke on THAT turn: a student may switch mid-session)
--   and diagnosis_concept (the concept the Coach actually diagnosed; before this only referenced_concepts[0] was stored, which is a different
--   thing and made repeated-difficulty detection guess). Legacy rows keep NULL and are read with the old fallback.
-- RLS: the table follows 013's default-deny model: read-only through the Data API, a student reads only their own row, nothing else does.
-- Idempotent: safe to run repeatedly.
BEGIN;

CREATE TABLE IF NOT EXISTS public.student_preferences (
  student_id       text PRIMARY KEY REFERENCES public.students(student_id) ON DELETE CASCADE,
  university_id    text NOT NULL REFERENCES public.universities(university_id) ON DELETE CASCADE,
  teaching_persona text NOT NULL DEFAULT 'socratic_guide' CHECK (teaching_persona ~ '^[a-z][a-z0-9_]{1,40}$'),
  persona_version  integer NOT NULL DEFAULT 1 CHECK (persona_version >= 1),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.ai_interactions
  ADD COLUMN IF NOT EXISTS persona_id text CHECK (persona_id IS NULL OR persona_id ~ '^[a-z][a-z0-9_]{1,40}$'),
  ADD COLUMN IF NOT EXISTS persona_version integer CHECK (persona_version IS NULL OR persona_version >= 1),
  ADD COLUMN IF NOT EXISTS diagnosis_concept text CHECK (diagnosis_concept IS NULL OR char_length(diagnosis_concept) <= 300);

ALTER TABLE public.student_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.student_preferences FROM anon, authenticated;
DROP POLICY IF EXISTS student_preferences_select ON public.student_preferences;
CREATE POLICY student_preferences_select ON public.student_preferences FOR SELECT TO authenticated USING (student_id = app.current_user_id());
GRANT SELECT ON public.student_preferences TO authenticated;

COMMIT;
