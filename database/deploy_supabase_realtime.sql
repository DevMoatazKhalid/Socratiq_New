-- database/deploy_supabase_realtime.sql
-- Idempotent deployment script to enroll required tables in Supabase Realtime CDC publication.
--
-- TARGET: Run via Supabase SQL Editor or migration runner in the target Supabase project.
-- DO NOT EXECUTE AGAINST PRODUCTION WITHOUT EXPLICIT OPERATIONAL AUTHORIZATION.

BEGIN;

-- 1. Ensure supabase_realtime publication exists (pre-created in Supabase environments)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

-- 2. Safely enroll public.attempts (enables live whiteboard sync & teacher observation)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
      AND schemaname = 'public' 
      AND tablename = 'attempts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.attempts;
  END IF;
END $$;

-- 3. Safely enroll public.materials (enables real-time document indexing status updates)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
      AND schemaname = 'public' 
      AND tablename = 'materials'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.materials;
  END IF;
END $$;

COMMIT;
