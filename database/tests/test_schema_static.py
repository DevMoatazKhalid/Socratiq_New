from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
MIG = ROOT / "migrations"

def read(name):
    return (MIG / name).read_text(encoding="utf-8")

def test_migration_order():
    assert [p.name for p in sorted(MIG.glob("*.sql"))] == [
        "000_extensions.sql","001_rag_pgvector_schema.sql","002_core_university_schema.sql",
        "003_learning_workflow_schema.sql","004_ai_coach_schema.sql","005_verification_schema.sql",
        "006_learning_evidence_schema.sql","007_rls.sql","008_indexes_triggers.sql",
        "009_tenant_integrity.sql","010_domain_lifecycle.sql","011_file_pipeline.sql","012_indexes.sql","013_rls.sql","014_grading.sql","015_whiteboard.sql","016_whiteboard_scene.sql","017_teaching_personas.sql","018_student_notes.sql","019_notes_board.sql","020_assessment.sql","021_course_icon.sql"]

def test_rag_contract():
    s = read("001_rag_pgvector_schema.sql")
    for x in ["documents","document_chunks","embedding vector(2048)","tsv_content tsvector GENERATED ALWAYS",
              "USING gin (tsv_content)","concepts jsonb","assignment_ids jsonb"]:
        assert x in s
    for x in ["pending","parsing","chunking","embedding","stored","failed","definition","explanation","example","code","formula","table","summary","exercise"]:
        assert x in s

def test_ai_ids_are_not_bigint():
    s = "\n".join(p.read_text(encoding="utf-8") for p in MIG.glob("*.sql"))
    assert not re.search(r"\b(student_id|assignment_id|attempt_id|session_id|interaction_id|event_id)\s+bigint\b", s, re.I)

def test_workflow_and_verification_are_separate():
    assert "public.attempts" in read("003_learning_workflow_schema.sql")
    assert "public.submissions" in read("003_learning_workflow_schema.sql")
    s = read("005_verification_schema.sql")
    for x in ["verification_runs","verification_questions","verification_responses","verification_results"]:
        assert f"public.{x}" in s

def test_forbidden_fields_absent():
    s = "\n".join(p.read_text(encoding="utf-8") for p in MIG.glob("*.sql")).lower()
    assert "ai_dependency_score" not in s
    for x in ["chain_of_thought","hidden_reasoning","private_reasoning"]:
        assert x not in s


def test_learning_events_use_the_live_column_names():
    """006 once declared id/timestamp, which no other file (or the live schema) uses, and could not deploy."""
    s = read("006_learning_evidence_schema.sql")
    assert "event_id text PRIMARY KEY" in s and "occurred_at timestamptz" in s and "REFERENCES public.learning_events(event_id)" in s

def test_rls_migration_is_authoritative_and_default_deny():
    s = read("013_rls.sql")
    assert "DROP POLICY" in s and "REVOKE ALL ON ALL TABLES" in s and "ENABLE ROW LEVEL SECURITY" in s
    assert "TO authenticated" in s and "FOR INSERT" not in s and "FOR UPDATE" not in s and "FOR DELETE" not in s   # read-only Data API


def test_grading_migration_reuses_submissions_and_constrains_the_scale():
    s = read("014_grading.sql")
    assert "CREATE TABLE" not in s                                   # one source of truth: columns on public.submissions
    for x in ["max_score", "feedback", "graded_at", "graded_by", "submissions_grade_consistent_chk", "score <= max_score", "max_score > 0"]:
        assert x in s


def test_whiteboard_migration_extends_attempts_without_a_new_table():
    s = read("015_whiteboard.sql")
    assert "CREATE TABLE" not in s and "ALTER TABLE public.attempts ADD COLUMN IF NOT EXISTS whiteboard" in s and "attempts_whiteboard_shape_chk" in s


def test_whiteboard_scene_migration_only_raises_the_cap_and_is_idempotent():
    raw = read("016_whiteboard_scene.sql")
    s = "\n".join(l for l in raw.splitlines() if not l.strip().startswith("--"))                    # judge the executable SQL, not the comments
    assert "CREATE TABLE" not in s and "DELETE" not in s.upper() and "UPDATE" not in s.upper() and "TRUNCATE" not in s.upper()      # no data is changed or removed
    assert "attempts_whiteboard_shape_chk" in s and "IF EXISTS (SELECT 1 FROM pg_constraint" in s     # re-runnable
    assert "<= 3500000" in s and "<= 400000" not in s


def test_student_notes_migration_is_additive_owned_and_read_only_through_the_data_api():
    raw = read("018_student_notes.sql")
    s = "\n".join(l for l in raw.splitlines() if not l.strip().startswith("--"))
    assert "CREATE TABLE IF NOT EXISTS public.student_notes" in s and s.count("CREATE TABLE") == 1
    assert "ALTER TABLE public.student_notes ENABLE ROW LEVEL SECURITY" in s
    assert "REFERENCES public.students (student_id, university_id) ON DELETE CASCADE" in s        # tenant integrity like 009
    for verb in ("SELECT", "INSERT", "UPDATE", "DELETE"):                                       # strict ownership policy for every verb
        assert re.search(rf"FOR {verb} TO authenticated\s+(USING|WITH CHECK) \(student_id = app.current_user_id\(\)", s), verb
    assert "GRANT SELECT ON public.student_notes TO authenticated" in s
    assert not re.search(r"GRANT\s+(ALL|INSERT|UPDATE|DELETE)", s)                               # Data API stays read-only (013)
    for other in ("ALTER TABLE public.students", "ALTER TABLE public.users", "DROP TABLE", "TRUNCATE", "DELETE FROM", "UPDATE public."):
        assert other not in s                                                                    # nothing existing is touched
    down = (MIG / "down" / "018_student_notes.down.sql").read_text(encoding="utf-8")
    assert "DROP TABLE IF EXISTS public.student_notes" in down and "students" not in down.replace("student_notes", "")


def test_notes_board_migration_is_additive_owned_and_read_only_through_the_data_api():
    raw = read("019_notes_board.sql")
    s = "\n".join(l for l in raw.splitlines() if not l.strip().startswith("--"))
    for col in ("course_id", "assignment_id", "importance", "pinned"):                           # new columns only, all nullable or defaulted
        assert f"ALTER TABLE public.student_notes ADD COLUMN IF NOT EXISTS {col}" in s
    assert "pinned        boolean NOT NULL DEFAULT false" in s
    assert "ON DELETE SET NULL" in s                                                              # removing a course/assignment never deletes notes
    assert s.count("CREATE TABLE IF NOT EXISTS") == 2
    assert "REFERENCES public.students (student_id, university_id) ON DELETE CASCADE" in s        # tenant integrity like 009/018
    for t in ("student_note_groups", "student_note_group_members"):
        assert f"ALTER TABLE public.{t} ENABLE ROW LEVEL SECURITY" in s and f"GRANT SELECT ON public.{t} TO authenticated" in s
    assert not re.search(r"GRANT\s+(ALL|INSERT|UPDATE|DELETE)", s)                               # Data API stays read-only (013)
    for other in ("DROP TABLE", "TRUNCATE", "DELETE FROM", "UPDATE public.", "DROP COLUMN", "ALTER TABLE public.students", "DROP TRIGGER IF EXISTS student_notes_set_updated_at"):
        assert other not in s                                                                    # nothing existing is removed or rewritten
    down = (MIG / "down" / "019_notes_board.down.sql").read_text(encoding="utf-8")
    assert "DROP TABLE IF EXISTS public.student_note_groups" in down and "DROP TABLE IF EXISTS public.student_notes;" not in down


def test_assessment_migration_keeps_one_grade_source_and_hides_drafts_from_students():
    raw = read("020_assessment.sql")
    s = "\n".join(l for l in raw.splitlines() if not l.strip().startswith("--"))
    assert s.count("CREATE TABLE IF NOT EXISTS") == 3                                             # drafts, audit trail, celebrations
    for col in ("points_possible", "rubric", "rubric_source", "reference_answer", "grading_notes", "ai_grading", "grading_updated_at"):
        assert f"ALTER TABLE public.assignments ADD COLUMN IF NOT EXISTS {col}" in s
    for col in ("grade_source", "grade_evaluation_id", "grade_criteria"):                           # the released grade stays on submissions (014)
        assert f"ALTER TABLE public.submissions ADD COLUMN IF NOT EXISTS {col}" in s
    assert "grade_evaluations_one_active_uk" in s and "WHERE status IN ('QUEUED', 'RUNNING')" in s   # one active grading per submission
    assert "REFERENCES public.submissions (submission_id, university_id, student_id, assignment_id) ON DELETE CASCADE" in s   # tenant integrity (009)
    assert "USING (app.teaches_assignment(assignment_id))" in s                                     # AI drafts: instructors only
    assert "grade_events is append-only" in s
    assert not re.search(r"GRANT\s+(ALL|INSERT|UPDATE|DELETE)", s)                                 # Data API stays read-only (013)
    for other in ("DROP TABLE", "TRUNCATE", "DELETE FROM", "DROP COLUMN"):
        assert other not in s
    down = (MIG / "down" / "020_assessment.down.sql").read_text(encoding="utf-8")
    assert "DROP TABLE IF EXISTS public.grade_evaluations" in down and "DROP COLUMN IF EXISTS score" not in down   # released grades survive a rollback


def test_course_icon_migration_is_additive_and_limited_to_the_design_icons():
    raw = read("021_course_icon.sql")
    s = "\n".join(l for l in raw.splitlines() if not l.strip().startswith("--"))
    assert "ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS icon text" in s
    for icon in ("book", "calculator", "flask", "globe", "code", "music", "palette", "atom", "landmark", "pencil", "laptop", "leaf"):
        assert f"'{icon}'" in s                                                                   # the 12 icons of the approved Create course design
    for other in ("DROP TABLE", "TRUNCATE", "DELETE FROM", "DROP COLUMN"):
        assert other not in s
    down = (MIG / "down" / "021_course_icon.down.sql").read_text(encoding="utf-8")
    assert "DROP COLUMN IF EXISTS icon" in down and "DROP TABLE" not in down
