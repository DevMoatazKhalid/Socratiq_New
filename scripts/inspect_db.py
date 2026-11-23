"""
Inspect existing database without modifying anything.
Outputs schema details, table row counts, existing users, courses, materials, storage buckets.
"""
import os
import json
from pathlib import Path
from dotenv import load_dotenv
import psycopg
from psycopg.rows import dict_row

load_dotenv()

db_url = os.environ.get("DATABASE_URL")
if not db_url:
    print("DATABASE_URL not found!")
    exit(1)

conn = psycopg.connect(db_url, row_factory=dict_row)

print("=== DATABASE INSPECTION REPORT ===")

# 1. Universities
with conn.cursor() as cur:
    cur.execute("SELECT university_id, name, created_at FROM universities")
    unis = cur.fetchall()
    print(f"\nUniversities ({len(unis)}):")
    for u in unis:
        print(f"  - {u['university_id']}: {u['name']} (created: {u['created_at']})")

# 2. Existing Users in public.users
with conn.cursor() as cur:
    cur.execute("SELECT user_id, auth_user_id, university_id, email, first_name, last_name, role, created_at FROM users")
    users = cur.fetchall()
    print(f"\nExisting Public Users ({len(users)}):")
    for u in users:
        print(f"  - {u['user_id']} ({u['role']}): {u['first_name']} {u['last_name']} <{u['email']}> | auth_id: {u['auth_user_id']} | uni: {u['university_id']}")

# 3. Existing Users in auth.users
with conn.cursor() as cur:
    try:
        cur.execute("SELECT id, email, created_at, last_sign_in_at, email_confirmed_at, raw_user_meta_data FROM auth.users")
        auth_users = cur.fetchall()
        print(f"\nExisting Auth Users ({len(auth_users)}):")
        for au in auth_users:
            print(f"  - {au['id']}: <{au['email']}> | confirmed: {au['email_confirmed_at']} | meta: {au['raw_user_meta_data']}")
    except Exception as e:
        print(f"Could not read auth.users: {e}")

# 4. Table row counts
tables = [
    "users", "students", "professors", "universities",
    "courses", "classrooms", "enrollments",
    "materials", "stored_files", "documents", "document_chunks",
    "concepts", "assignment_concepts", "assignment_materials",
    "assignments", "assignment_versions", "assignment_attachments",
    "attempts", "submissions", "grade_evaluations", "grade_events",
    "student_celebrations",
    "ai_sessions", "ai_interactions", "messages", "ai_interaction_sources",
    "verification_runs", "verification_questions", "verification_responses", "verification_results",
    "learning_events", "evidence_candidates", "evidence_sources", "risk_signals", "student_concept_state",
    "student_preferences", "student_notes", "student_note_groups", "student_note_group_members"
]

print("\nTable Row Counts:")
counts = {}
with conn.cursor() as cur:
    for t in tables:
        try:
            cur.execute(f"SELECT count(*) as c FROM public.{t}")
            cnt = cur.fetchone()['c']
            counts[t] = cnt
            if cnt > 0:
                print(f"  - public.{t}: {cnt}")
            else:
                print(f"  - public.{t}: 0")
        except Exception as e:
            counts[t] = f"ERROR: {e}"
            print(f"  - public.{t}: ERROR {e}")
            conn.rollback()

# 5. Courses & Classrooms
with conn.cursor() as cur:
    cur.execute("SELECT course_id, university_id, instructor_id, code, title, status FROM courses")
    courses = cur.fetchall()
    print(f"\nExisting Courses ({len(courses)}):")
    cur.execute("SELECT classroom_id, course_id, professor_id, name, join_code FROM classrooms")
    classrooms = cur.fetchall()

# Write everything to JSON
inspection_data = {
    "universities": unis,
    "public_users": users,
    "auth_users": auth_users,
    "counts": counts,
    "courses": courses,
    "classrooms": classrooms,
}

with open("scripts/db_inspection.json", "w") as f:
    json.dump(inspection_data, f, indent=2, default=str)

print("Inspection successfully saved to scripts/db_inspection.json")


