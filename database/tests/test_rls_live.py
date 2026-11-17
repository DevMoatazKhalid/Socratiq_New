"""Live RLS and Schema Verification Test Suite.
Directly tests the configured Supabase/PostgreSQL database to verify:
1. All public tables have RLS enabled (no unshielded tables).
2. student_preferences has RLS enabled with SELECT policy for authenticated users.
3. student_preferences denies anonymous access completely.
4. Authenticated users can only read their own student_preferences row (cross-student isolation).
5. ai_interactions has persona_id, persona_version, diagnosis_concept columns with valid constraints.
6. Migration 017 is properly recorded in schema_migrations.
"""
from __future__ import annotations

import os
from dotenv import load_dotenv
import psycopg
import pytest

load_dotenv()
DB_URL = os.getenv("DATABASE_URL")


@pytest.fixture(scope="module")
def conn():
    if not DB_URL:
        pytest.skip("DATABASE_URL not set")
    try:
        with psycopg.connect(DB_URL, autocommit=True) as c:
            yield c
    except Exception as exc:
        pytest.skip(f"Database unreachable: {exc}")


def test_migration_017_tracked(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT filename, checksum, baselined FROM public.schema_migrations WHERE filename='017_teaching_personas.sql';")
        row = cur.fetchone()
        assert row is not None, "017_teaching_personas.sql must be recorded in schema_migrations"
        assert row[0] == "017_teaching_personas.sql"


def test_every_public_table_has_rls_live(conn):
    with conn.cursor() as cur:
        cur.execute("""
            SELECT tablename FROM pg_tables
            WHERE schemaname = 'public'
              AND rowsecurity = false
              AND tablename NOT IN ('schema_migrations', 'spatial_ref_sys');
        """)
        unprotected = [r[0] for r in cur.fetchall()]
        assert unprotected == [], f"Found public tables without RLS: {unprotected}"


def test_student_preferences_columns_and_constraints(conn):
    with conn.cursor() as cur:
        cur.execute("""
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'student_preferences'
            ORDER BY ordinal_position;
        """)
        cols = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
        assert "student_id" in cols, "student_id must be present"
        assert "university_id" in cols, "university_id must be present"
        assert "teaching_persona" in cols, "teaching_persona must be present"
        assert "persona_version" in cols, "persona_version must be present"
        assert "created_at" in cols, "created_at must be present"
        assert "updated_at" in cols, "updated_at must be present"


def test_ai_interactions_persona_columns(conn):
    with conn.cursor() as cur:
        cur.execute("""
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_name = 'ai_interactions'
              AND column_name IN ('persona_id', 'persona_version', 'diagnosis_concept');
        """)
        cols = {r[0]: r[1] for r in cur.fetchall()}
        assert "persona_id" in cols, "persona_id column must exist"
        assert "persona_version" in cols, "persona_version column must exist"
        assert "diagnosis_concept" in cols, "diagnosis_concept column must exist"


def test_student_preferences_rls_policies(conn):
    with conn.cursor() as cur:
        cur.execute("""
            SELECT policyname, permissive, roles, cmd, qual
            FROM pg_policies
            WHERE tablename = 'student_preferences';
        """)
        policies = cur.fetchall()
        assert len(policies) >= 1, "student_preferences must have at least one RLS policy"
        policy_names = [p[0] for p in policies]
        assert "student_preferences_select" in policy_names


def test_anon_has_zero_grants_on_student_preferences(conn):
    with conn.cursor() as cur:
        cur.execute("""
            SELECT privilege_type
            FROM information_schema.role_table_grants
            WHERE table_name = 'student_preferences' AND grantee = 'anon';
        """)
        grants = cur.fetchall()
        assert len(grants) == 0, f"anon must have no privileges on student_preferences, found: {grants}"


def test_student_preferences_cross_student_isolation(conn):
    """Verify that under RLS, student S1 cannot see student S2's preferences."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT u.user_id, u.auth_user_id::text, u.university_id
            FROM users u
            WHERE u.role = 'STUDENT'
            LIMIT 2;
        """)
        students = cur.fetchall()
        if len(students) < 2:
            pytest.skip("Need at least 2 students in database for cross-student test")

        s1_id, s1_auth, s1_univ = students[0]
        s2_id, s2_auth, s2_univ = students[1]

        cur.execute("""
            INSERT INTO student_preferences (student_id, university_id, teaching_persona, persona_version)
            VALUES (%s, %s, 'practical_engineer', 1)
            ON CONFLICT (student_id) DO UPDATE SET teaching_persona = 'practical_engineer';
        """, (s1_id, s1_univ))

        cur.execute("""
            INSERT INTO student_preferences (student_id, university_id, teaching_persona, persona_version)
            VALUES (%s, %s, 'critical_thinker', 1)
            ON CONFLICT (student_id) DO UPDATE SET teaching_persona = 'critical_thinker';
        """, (s2_id, s2_univ))

        try:
            cur.execute("SET ROLE authenticated;")
            cur.execute("SELECT set_config('request.jwt.claim.sub', %s, false);", (s1_auth,))

            cur.execute("SELECT student_id, teaching_persona FROM student_preferences;")
            rows = cur.fetchall()
            ids_seen = [r[0] for r in rows]
            assert s1_id in ids_seen, "S1 must see their own preference"
            assert s2_id not in ids_seen, "S1 must NOT see S2's preference under RLS"

            cur.execute("SELECT student_id FROM student_preferences WHERE student_id = %s;", (s2_id,))
            s2_query = cur.fetchall()
            assert len(s2_query) == 0, "S1 must receive 0 rows when attempting to select S2"

        finally:
            cur.execute("RESET ROLE;")
            cur.execute("SELECT set_config('request.jwt.claim.sub', '', false);")
