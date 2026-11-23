#!/usr/bin/env python3
"""
Database Restoration Script for SocratiQ.
Can restore a backup created by backup_db.py back to the database.
Usage: python scripts/restore_db.py <path_to_backup_dir>
"""
import sys
import os
import json
from pathlib import Path
from dotenv import load_dotenv
import psycopg
from psycopg.rows import dict_row

load_dotenv()

if len(sys.argv) < 2:
    print("Usage: python scripts/restore_db.py <path_to_backup_dir>")
    sys.exit(1)

backup_dir = Path(sys.argv[1])
manifest_file = backup_dir / "manifest.json"
if not manifest_file.exists():
    print(f"Error: manifest.json not found in {backup_dir}")
    sys.exit(1)

with open(manifest_file, "r") as f:
    manifest = json.load(f)

print(f"Restoring from backup created at {manifest['timestamp']}...")
db_url = os.environ.get("DATABASE_URL")
if not db_url:
    print("DATABASE_URL not set in environment or .env")
    sys.exit(1)

conn = psycopg.connect(db_url, autocommit=False)

# Order of restoration to respect foreign key constraints
restore_order = [
    "universities",
    "users",
    "students",
    "professors",
    "courses",
    "classrooms",
    "enrollments",
    "documents",
    "document_chunks",
    "stored_files",
    "materials",
    "concepts",
    "assignments",
    "assignment_versions",
    "assignment_attachments",
    "assignment_concepts",
    "assignment_materials",
    "document_chunk_assignments",
    "document_chunk_concepts",
    "attempts",
    "submissions",
    "grade_evaluations",
    "grade_events",
    "student_celebrations",
    "ai_sessions",
    "ai_interactions",
    "messages",
    "ai_interaction_sources",
    "verification_runs",
    "verification_questions",
    "verification_responses",
    "verification_results",
    "verification_question_evidence",
    "learning_events",
    "evidence_candidates",
    "evidence_sources",
    "risk_signals",
    "student_concept_state",
    "student_preferences",
    "student_notes",
    "student_note_groups",
    "student_note_group_members",
]

try:
    with conn.cursor() as cur:
        # Restore auth.users if needed
        auth_file = backup_dir / "data" / "auth_users.json"
        if auth_file.exists():
            with open(auth_file, "r") as f:
                auth_users = json.load(f)
            print(f"Auth users count in backup: {len(auth_users)}")
            for au in auth_users:
                cur.execute("""
                    INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, raw_user_meta_data, raw_app_meta_data, role, aud)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                      email = EXCLUDED.email,
                      email_confirmed_at = EXCLUDED.email_confirmed_at,
                      raw_user_meta_data = EXCLUDED.raw_user_meta_data
                """, (
                    au["id"], au.get("email"), au.get("encrypted_password"),
                    au.get("email_confirmed_at"), json.dumps(au.get("raw_user_meta_data") or {}),
                    json.dumps(au.get("raw_app_meta_data") or {}), au.get("role", "authenticated"), au.get("aud", "authenticated")
                ))

        for table in restore_order:
            tbl_file = backup_dir / "data" / f"{table}.json"
            if not tbl_file.exists():
                continue
            with open(tbl_file, "r") as f:
                rows = json.load(f)
            if not rows:
                continue
            print(f"Restoring {len(rows)} rows to public.{table}...")
            cols = list(rows[0].keys())
            placeholders = ", ".join(["%s"] * len(cols))
            col_names = ", ".join([f'"{c}"' for c in cols])
            update_clauses = ", ".join([f'"{c}" = EXCLUDED."{c}"' for c in cols])
            
            # Determine primary key or unique conflict target if possible
            sql = f'INSERT INTO public."{table}" ({col_names}) VALUES ({placeholders}) ON CONFLICT DO NOTHING'
            
            for row in rows:
                vals = []
                for c in cols:
                    v = row[c]
                    if isinstance(v, (dict, list)):
                        vals.append(json.dumps(v))
                    else:
                        vals.append(v)
                cur.execute(sql, vals)
                
    conn.commit()
    print("[SUCCESS] Database restoration complete.")
except Exception as e:
    conn.rollback()
    print(f"[ERROR] Restoration failed, rolled back: {e}")
    sys.exit(1)
finally:
    conn.close()
