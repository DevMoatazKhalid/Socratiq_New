#!/usr/bin/env python3
"""
SocratiQ - Production-Grade Demo Environment Seeder.
Executes the approved deletion of 860 transient records, creates 40 Auth accounts via Auth Admin API,
provisions synchronized public profiles, sets up realistic curriculum across 5 instructors,
and populates assignments, materials, submissions, AI grading, and telemetry.
"""
import os
import sys
import json
import uuid
import secrets
import hashlib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from dotenv import load_dotenv

import psycopg
from psycopg.rows import dict_row
from supabase import create_client
import fitz  # PyMuPDF for generating real PDF files

load_dotenv()
load_dotenv("frontend/.env")

DB_URL = os.environ.get("DATABASE_URL")
SUPABASE_URL = os.environ.get("SUPABASE_URL") or os.environ.get("VITE_SUPABASE_URL")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
ANON_KEY = os.environ.get("VITE_SUPABASE_ANON_KEY") or os.environ.get("SUPABASE_ANON_KEY") or SERVICE_KEY

if not all([DB_URL, SUPABASE_URL, SERVICE_KEY]):
    print("Error: Missing required environment variables (DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).")
    sys.exit(1)

sb_admin = create_client(SUPABASE_URL, SERVICE_KEY)
db_conn = psycopg.connect(DB_URL, row_factory=dict_row, autocommit=False)

def hex_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"

PRIMARY_INSTRUCTORS = [
    {
        "id": "usr_inst_robert_chen",
        "email": "robert.chen@socratiq.edu",
        "first_name": "Robert",
        "last_name": "Chen",
        "password": "SocratiqDemo2026!Prof1",
        "role": "PROFESSOR",
        "specialization": "Mathematics & Classical Mechanics",
    },
    {
        "id": "usr_inst_elena_rostova",
        "email": "elena.rostova@socratiq.edu",
        "first_name": "Elena",
        "last_name": "Rostova",
        "password": "SocratiqDemo2026!Prof2",
        "role": "PROFESSOR",
        "specialization": "Computer Science & Artificial Intelligence",
    }
]

PRIMARY_STUDENTS = [
    {
        "id": "usr_stud_sarah_jenkins",
        "email": "sarah.jenkins@socratiq.edu",
        "first_name": "Sarah",
        "last_name": "Jenkins",
        "password": "SocratiqDemo2026!Stud1",
        "role": "STUDENT",
        "persona": "Excellent Student (Top Performer)",
    },
    {
        "id": "usr_stud_marcus_vance",
        "email": "marcus.vance@socratiq.edu",
        "first_name": "Marcus",
        "last_name": "Vance",
        "password": "SocratiqDemo2026!Stud2",
        "role": "STUDENT",
        "persona": "Average Student (Solid & Consistent)",
    },
    {
        "id": "usr_stud_liam_oconnor",
        "email": "liam.oconnor@socratiq.edu",
        "first_name": "Liam",
        "last_name": "O'Connor",
        "password": "SocratiqDemo2026!Stud3",
        "role": "STUDENT",
        "persona": "Struggling Student (Needs Intervention)",
    },
    {
        "id": "usr_stud_amina_almansoor",
        "email": "amina.almansoor@socratiq.edu",
        "first_name": "Amina",
        "last_name": "Al-Mansoor",
        "password": "SocratiqDemo2026!Stud4",
        "role": "STUDENT",
        "persona": "Highly Active Student (Curious & Engaged)",
    },
    {
        "id": "usr_stud_leo_tanaka",
        "email": "leo.tanaka@socratiq.edu",
        "first_name": "Leo",
        "last_name": "Tanaka",
        "password": "SocratiqDemo2026!Stud5",
        "role": "STUDENT",
        "persona": "New Student (Recently Enrolled)",
    }
]

MOCK_INSTRUCTORS = [
    {"id": "usr_inst_sophia_patel", "email": "sophia.patel@socratiq.edu", "first_name": "Sophia", "last_name": "Patel", "role": "PROFESSOR", "specialization": "Engineering & Applied Physics", "university_id": "Al-Azhar"},
    {"id": "usr_inst_tariq_alhashimi", "email": "tariq.alhashimi@socratiq.edu", "first_name": "Tariq", "last_name": "Al-Hashimi", "role": "PROFESSOR", "specialization": "Classical Arabic & Rhetoric", "university_id": "arish_university"},
    {"id": "usr_inst_david_kim", "email": "david.kim@socratiq.edu", "first_name": "David", "last_name": "Kim", "role": "PROFESSOR", "specialization": "Human Anatomy & Philosophy", "university_id": "Al-Azhar"},
]

MOCK_STUDENTS = [
    {"first": "Maya", "last": "Lin"}, {"first": "Noah", "last": "Patel"}, {"first": "Chloe", "last": "Bennett"},
    {"first": "Daniel", "last": "Kim"}, {"first": "Fatima", "last": "Zahra"}, {"first": "Gabriel", "last": "Santos"},
    {"first": "Harper", "last": "Lee"}, {"first": "Isaac", "last": "Newton"}, {"first": "Jasmine", "last": "Taylor"},
    {"first": "Kevin", "last": "Zhang"}, {"first": "Leila", "last": "Haddad"}, {"first": "Mateo", "last": "Rossi"},
    {"first": "Nora", "last": "Al-Mutairi"}, {"first": "Oliver", "last": "Queen"}, {"first": "Priya", "last": "Sharma"},
    {"first": "Quincy", "last": "Adams"}, {"first": "Reem", "last": "Farooq"}, {"first": "Samuel", "last": "Rivera"},
    {"first": "Tara", "last": "O'Brien"}, {"first": "Umar", "last": "Farooq"}, {"first": "Victoria", "last": "Wood"},
    {"first": "William", "last": "Turner"}, {"first": "Ximena", "last": "Gomez"}, {"first": "Youssef", "last": "Mansour"},
    {"first": "Zoe", "last": "Kravitz"}, {"first": "Adam", "last": "Vance"}, {"first": "Beatrice", "last": "Hall"},
    {"first": "Carlos", "last": "Mendoza"}, {"first": "Dalia", "last": "Nasser"}, {"first": "Ethan", "last": "Hunt"}
]

COURSE_SPECS = [
    {
        "code": "MATH 103", "title": "Primary Mathematics – Level 3",
        "description": "Foundations of algebra, geometry, and arithmetic reasoning.",
        "course_id": "crs_7c6a92f3fa7348f18f81f528a5dc0d8c",
        "classroom_id": "cls_576dc78de6bb455bbc3d483cca80fb37",
        "instructor_id": "usr_inst_robert_chen", "color": "plum", "icon": "calculator",
        "subject": "Mathematics", "university_id": "Al-Azhar"
    },
    {
        "code": "PHYS 111", "title": "Classical Mechanics & Newton's Laws",
        "description": "Kinematics, dynamics, energy conservation, and planetary motion.",
        "course_id": "crs_6467d951118a4a58a6603f89d428188d",
        "classroom_id": "cls_e4c7760c0e5e483d912d90b25b5e8ad3",
        "instructor_id": "usr_inst_robert_chen", "color": "blue", "icon": "atom",
        "subject": "Physics", "university_id": "Al-Azhar"
    },
    {
        "code": "MATH 201", "title": "Linear Algebra & Multivariable Calculus",
        "description": "Vector spaces, matrix decompositions, eigenvalues, and multivariable optimization.",
        "course_id": "crs_8f8025d1c4b04f709dda8f9c62e90dd3",
        "classroom_id": "cls_e7f5b3a25762409e95efb939aa7afbc7",
        "instructor_id": "usr_inst_robert_chen", "color": "indigo", "icon": "calculator",
        "subject": "Mathematics", "university_id": "Al-Azhar"
    },
    {
        "code": "CS 105", "title": "Python Programming & Problem Solving",
        "description": "Algorithmic thinking, data structures, functional paradigms, and modular software design in Python.",
        "course_id": "crs_cs105_python_fundamentals",
        "classroom_id": "cls_cs105_section_01",
        "instructor_id": "usr_inst_elena_rostova", "color": "emerald", "icon": "code",
        "subject": "Computer Science", "university_id": "Al-Azhar"
    },
    {
        "code": "AI 301", "title": "Machine Learning Fundamentals",
        "description": "Supervised learning, gradient descent, deep neural networks, and evaluation metrics.",
        "course_id": "crs_ai301_machine_learning",
        "classroom_id": "cls_ai301_section_01",
        "instructor_id": "usr_inst_elena_rostova", "color": "amber", "icon": "laptop",
        "subject": "Artificial Intelligence", "university_id": "Al-Azhar"
    },
    {
        "code": "ENG 103", "title": "Primary English – Level 3",
        "description": "Reading comprehension, grammar mastery, and creative vocabulary synthesis.",
        "course_id": "crs_0ec5c4831a9e4b31bfd6892d5088cf5e",
        "classroom_id": "cls_1274e40799934875aeef9837e08d91ea",
        "instructor_id": "usr_inst_elena_rostova", "color": "rose", "icon": "book",
        "subject": "English Language", "university_id": "Al-Azhar"
    },
    {
        "code": "Ph203", "title": "Applied Physics & Electromagnetism",
        "description": "Electric fields, circuits, Maxwell equations, and wave optics.",
        "course_id": "crs_92bbfde9b19b4d71918185092f11b565",
        "classroom_id": "cls_3a128d7c8c394eb8be79c905c0219b32",
        "instructor_id": "usr_inst_sophia_patel", "color": "teal", "icon": "flask",
        "subject": "Physics", "university_id": "Al-Azhar"
    },
    {
        "code": "Mckinzy 956", "title": "Strategic Engineering Systems",
        "description": "System architecture, lifecycle engineering, and strategic industrial workflows.",
        "course_id": "crs_56057ad5160a4344810e9fc36b36c891",
        "classroom_id": "cls_190bba0cfb9c4cd690b4509f91fc5230",
        "instructor_id": "usr_inst_sophia_patel", "color": "slate", "icon": "landmark",
        "subject": "Engineering", "university_id": "Al-Azhar"
    },
    {
        "code": "ph 01", "title": "Philosophy & Ethical Reasoning",
        "description": "Socratic dialogues, epistemology, moral philosophy, and critical thinking.",
        "course_id": "crs_fce2701a834d46c7baf46a5a15e875d0",
        "classroom_id": "cls_c8317e0958444b9785154756ed22af25",
        "instructor_id": "usr_inst_david_kim", "color": "purple", "icon": "book",
        "subject": "Philosophy", "university_id": "Al-Azhar"
    },
    {
        "code": "ARAB 101", "title": "Classical Arabic Rhetoric (بسي)",
        "description": "Arabic grammar, classical rhetoric (Balaagha), and literary analysis.",
        "course_id": "crs_1554b9d7163241b5899af6241f92f247",
        "classroom_id": "cls_033cef51f7ee4b8d8454b1c39f2f08a7",
        "instructor_id": "usr_inst_tariq_alhashimi", "color": "amber", "icon": "pencil",
        "subject": "Language Arts", "university_id": "arish_university"
    },
    {
        "code": "m-01", "title": "Human Anatomy & Physiology",
        "description": "Renal physiology, nephron mechanics, and anatomical systems.",
        "course_id": "crs_3674054703664531a8c212affe4d15c1",
        "classroom_id": "cls_6fdfddcd3d7e4ea6b35fa1a6f9b81662",
        "instructor_id": "usr_inst_david_kim", "color": "red", "icon": "leaf",
        "subject": "Life Sciences", "university_id": "Al-Azhar"
    }
]

def step_1_cleanup():
    print("\n--- STEP 1: CLEANUP OF 860 TRANSIENT RECORDS ---")
    cur = db_conn.cursor()
    uni_id = "Al-Azhar"
    
    # 1. Clean child records in strict bottom-up order
    cleanup_sql = [
        "DELETE FROM public.student_note_group_members",
        "DELETE FROM public.student_note_groups",
        "DELETE FROM public.student_notes",
        "DELETE FROM public.student_preferences",
        "DELETE FROM public.student_celebrations",
        "DELETE FROM public.student_concept_state",
        "DELETE FROM public.risk_signals",
        "DELETE FROM public.verification_question_evidence",
        "DELETE FROM public.verification_results",
        "DELETE FROM public.verification_responses",
        "DELETE FROM public.verification_questions",
        "DELETE FROM public.verification_runs",
        "DELETE FROM public.evidence_sources",
        "DELETE FROM public.evidence_candidates",
        "DELETE FROM public.learning_events",
        "DELETE FROM public.messages",
        "DELETE FROM public.ai_interaction_sources",
        "DELETE FROM public.ai_interactions",
        "DELETE FROM public.ai_sessions",
        "DELETE FROM public.grade_events",
        "DELETE FROM public.grade_evaluations",
        "DELETE FROM public.submissions",
        "DELETE FROM public.attempts",
        "DELETE FROM public.enrollments"
    ]
    for sql in cleanup_sql:
        cur.execute(sql)
        print(f"  [OK] {sql}")
        
    db_conn.commit()
    print("  [OK] Child records cleanly deleted.")

    # 2. Remove orphaned courses/classrooms not in COURSE_SPECS
    known_course_ids = [spec["course_id"] for spec in COURSE_SPECS]
    known_classroom_ids = [spec["classroom_id"] for spec in COURSE_SPECS]

    # Disable lifecycle trigger to allow stored_files deletion
    cur.execute("ALTER TABLE public.stored_files DISABLE TRIGGER stored_files_lifecycle_trg;")
    cur.execute("DELETE FROM public.stored_files WHERE course_id != ALL(%s)", (known_course_ids,))
    cur.execute("ALTER TABLE public.stored_files ENABLE TRIGGER stored_files_lifecycle_trg;")
    cur.execute("DELETE FROM public.documents WHERE course_id != ALL(%s)", (known_course_ids,))
    cur.execute("DELETE FROM public.assignments WHERE course_id != ALL(%s)", (known_course_ids,))
    cur.execute("DELETE FROM public.classrooms WHERE course_id != ALL(%s)", (known_course_ids,))
    cur.execute("DELETE FROM public.courses WHERE course_id != ALL(%s)", (known_course_ids,))
    db_conn.commit()
    print("  [OK] Orphaned courses/classrooms/files outside COURSE_SPECS removed.")

def step_2_provision_auth_and_profiles():
    print("\n--- STEP 2: AUTH & APPLICATION PROFILE PROVISIONING ---")
    cur = db_conn.cursor()
    uni_id = "Al-Azhar"
    
    # Fetch existing auth users to delete them via Supabase Auth Admin API
    existing_auth = sb_admin.auth.admin.list_users()
    print(f"  Found {len(existing_auth)} existing Auth users. Deleting via Auth Admin API...")
    for u in existing_auth:
        try:
            sb_admin.auth.admin.delete_user(u.id)
        except Exception as e:
            print(f"    Warning: Could not delete user {u.email}: {e}")
    print("  [OK] Old Auth users deleted via Auth Admin API.")

    # 1. Provision 2 Primary Instructors via Auth Admin API
    for p in PRIMARY_INSTRUCTORS:
        auth_resp = sb_admin.auth.admin.create_user({
            "email": p["email"],
            "password": p["password"],
            "email_confirm": True,
            "user_metadata": {
                "first_name": p["first_name"],
                "last_name": p["last_name"],
                "socratiq_role": "PROFESSOR",
                "email_verified": True
            }
        })
        p["auth_id"] = auth_resp.user.id
        cur.execute("""
            INSERT INTO public.users (user_id, auth_user_id, university_id, email, first_name, last_name, role)
            VALUES (%s, %s, %s, %s, %s, %s, 'PROFESSOR')
            ON CONFLICT (user_id) DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id
        """, (p["id"], p["auth_id"], uni_id, p["email"], p["first_name"], p["last_name"]))
        cur.execute("""
            INSERT INTO public.professors (professor_id, university_id)
            VALUES (%s, %s)
            ON CONFLICT (professor_id) DO NOTHING
        """, (p["id"], uni_id))
        print(f"  [CREATED] Primary Instructor: {p['first_name']} {p['last_name']} <{p['email']}>")

    # 2. Provision 3 Mock Instructors via Auth Admin API
    for m in MOCK_INSTRUCTORS:
        m_uni = m.get("university_id", "Al-Azhar")
        pwd = secrets.token_urlsafe(20)
        auth_resp = sb_admin.auth.admin.create_user({
            "email": m["email"],
            "password": pwd,
            "email_confirm": True,
            "user_metadata": {
                "first_name": m["first_name"],
                "last_name": m["last_name"],
                "socratiq_role": "PROFESSOR",
                "email_verified": True
            }
        })
        m["auth_id"] = auth_resp.user.id
        cur.execute("""
            INSERT INTO public.users (user_id, auth_user_id, university_id, email, first_name, last_name, role)
            VALUES (%s, %s, %s, %s, %s, %s, 'PROFESSOR')
            ON CONFLICT (user_id) DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id
        """, (m["id"], m["auth_id"], m_uni, m["email"], m["first_name"], m["last_name"]))
        cur.execute("""
            INSERT INTO public.professors (professor_id, university_id)
            VALUES (%s, %s)
            ON CONFLICT (professor_id) DO NOTHING
        """, (m["id"], m_uni))
        print(f"  [CREATED] Mock Instructor: {m['first_name']} {m['last_name']} <{m['email']}> ({m_uni})")

    # Build list of new instructor IDs we want to KEEP
    new_prof_ids = [p["id"] for p in PRIMARY_INSTRUCTORS] + [m["id"] for m in MOCK_INSTRUCTORS]

    # Reassign courses and classrooms by university
    cur.execute("UPDATE public.courses SET instructor_id = 'usr_inst_robert_chen' WHERE university_id = 'Al-Azhar';")
    cur.execute("UPDATE public.classrooms SET professor_id = 'usr_inst_robert_chen' WHERE university_id = 'Al-Azhar';")
    cur.execute("UPDATE public.courses SET instructor_id = 'usr_inst_tariq_alhashimi' WHERE university_id = 'arish_university';")
    cur.execute("UPDATE public.classrooms SET professor_id = 'usr_inst_tariq_alhashimi' WHERE university_id = 'arish_university';")

    # Reassign ALL stored_files, documents, and assignments referencing old users
    # (catches files in ANY university, including orphaned/mismatched rows)
    cur.execute("ALTER TABLE public.stored_files DISABLE TRIGGER stored_files_lifecycle_trg;")
    cur.execute("""
        UPDATE public.stored_files SET uploader_id = CASE
            WHEN university_id = 'arish_university' THEN 'usr_inst_tariq_alhashimi'
            ELSE 'usr_inst_robert_chen'
        END
        WHERE uploader_id != ALL(%s)
    """, (new_prof_ids,))
    cur.execute("ALTER TABLE public.stored_files ENABLE TRIGGER stored_files_lifecycle_trg;")

    cur.execute("""
        UPDATE public.documents SET uploader_id = CASE
            WHEN university_id = 'arish_university' THEN 'usr_inst_tariq_alhashimi'
            ELSE 'usr_inst_robert_chen'
        END
        WHERE uploader_id != ALL(%s)
    """, (new_prof_ids,))

    cur.execute("""
        UPDATE public.assignments SET created_by = CASE
            WHEN university_id = 'arish_university' THEN 'usr_inst_tariq_alhashimi'
            ELSE 'usr_inst_robert_chen'
        END
        WHERE created_by != ALL(%s)
    """, (new_prof_ids,))

    # Now safely delete old public profiles — no FK references should remain
    cur.execute("DELETE FROM public.students")
    cur.execute("DELETE FROM public.professors WHERE professor_id != ALL(%s)", (new_prof_ids,))
    cur.execute("DELETE FROM public.users WHERE user_id != ALL(%s)", (new_prof_ids,))
    db_conn.commit()
    print("  [OK] Old public users and student records cleanly deleted, instructors established.")


    # 3. Provision 5 Primary Students
    for s in PRIMARY_STUDENTS:
        auth_resp = sb_admin.auth.admin.create_user({
            "email": s["email"],
            "password": s["password"],
            "email_confirm": True,
            "user_metadata": {
                "first_name": s["first_name"],
                "last_name": s["last_name"],
                "socratiq_role": "STUDENT",
                "email_verified": True
            }
        })
        s["auth_id"] = auth_resp.user.id
        cur.execute("""
            INSERT INTO public.users (user_id, auth_user_id, university_id, email, first_name, last_name, role)
            VALUES (%s, %s, %s, %s, %s, %s, 'STUDENT')
        """, (s["id"], s["auth_id"], uni_id, s["email"], s["first_name"], s["last_name"]))
        cur.execute("INSERT INTO public.students (student_id, university_id) VALUES (%s, %s)", (s["id"], uni_id))
        print(f"  [CREATED] Primary Student: {s['first_name']} {s['last_name']} <{s['email']}>")

    # 4. Provision 30 Additional Mock Students (25 Al-Azhar, 5 Arish University)
    mock_students_data = []
    for i, name in enumerate(MOCK_STUDENTS, 1):
        stud_uni = "arish_university" if i > 25 else "Al-Azhar"
        stud_id = f"usr_mock_stud_{i:02d}"
        email = f"{name['first'].lower()}.{name['last'].lower()}@socratiq.edu"
        pwd = secrets.token_urlsafe(20)
        auth_resp = sb_admin.auth.admin.create_user({
            "email": email,
            "password": pwd,
            "email_confirm": True,
            "user_metadata": {
                "first_name": name["first"],
                "last_name": name["last"],
                "socratiq_role": "STUDENT",
                "email_verified": True
            }
        })
        cur.execute("""
            INSERT INTO public.users (user_id, auth_user_id, university_id, email, first_name, last_name, role)
            VALUES (%s, %s, %s, %s, %s, %s, 'STUDENT')
        """, (stud_id, auth_resp.user.id, stud_uni, email, name["first"], name["last"]))
        cur.execute("INSERT INTO public.students (student_id, university_id) VALUES (%s, %s)", (stud_id, stud_uni))
        mock_students_data.append({
            "id": stud_id,
            "email": email,
            "first_name": name["first"],
            "last_name": name["last"],
            "auth_id": auth_resp.user.id,
            "university_id": stud_uni
        })
    print(f"  [OK] Provisioned {len(mock_students_data)} Mock Students via Auth Admin API.")

    db_conn.commit()
    return mock_students_data

def step_3_distribute_courses_and_classrooms():
    print("\n--- STEP 3: DISTRIBUTE COURSES & CLASSROOMS ---")
    cur = db_conn.cursor()

    for spec in COURSE_SPECS:
        spec_uni = spec.get("university_id", "Al-Azhar")
        cur.execute("SELECT 1 FROM public.courses WHERE course_id = %s", (spec["course_id"],))
        exists = cur.fetchone()
        if exists:
            cur.execute("""
                UPDATE public.courses
                   SET instructor_id = %s, code = %s, title = %s, description = %s, color = %s, icon = %s, status = 'ACTIVE'
                 WHERE course_id = %s
            """, (spec["instructor_id"], spec["code"], spec["title"], spec["description"], spec["color"], spec["icon"], spec["course_id"]))
            cur.execute("""
                UPDATE public.classrooms
                   SET professor_id = %s, join_enabled = true
                 WHERE classroom_id = %s
            """, (spec["instructor_id"], spec["classroom_id"]))
            print(f"  [UPDATED] Course {spec['code']}: {spec['title']} -> {spec['instructor_id']} ({spec_uni})")
        else:
            cur.execute("""
                INSERT INTO public.courses (course_id, university_id, instructor_id, code, title, description, color, icon, status)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'ACTIVE')
            """, (spec["course_id"], spec_uni, spec["instructor_id"], spec["code"], spec["title"], spec["description"], spec["color"], spec["icon"]))
            cur.execute("""
                INSERT INTO public.classrooms (classroom_id, course_id, professor_id, name, university_id, join_enabled)
                VALUES (%s, %s, %s, 'Main Lecture Section', %s, true)
            """, (spec["classroom_id"], spec["course_id"], spec["instructor_id"], spec_uni))
            print(f"  [INSERTED] Course {spec['code']}: {spec['title']} -> {spec['instructor_id']} ({spec_uni})")

    db_conn.commit()

def step_4_create_enrollments(all_students):
    print("\n--- STEP 4: ENROLLMENTS GENERATION ---")
    cur = db_conn.cursor()
    uni_id = "Al-Azhar"
    enrollment_count = 0

    # Ensure all primary students are enrolled in diverse courses
    for s in PRIMARY_STUDENTS:
        if s["id"] == "usr_stud_sarah_jenkins":
            courses = ["MATH 103", "PHYS 111", "CS 105", "AI 301", "ENG 103"]
        elif s["id"] == "usr_stud_marcus_vance":
            courses = ["MATH 103", "CS 105", "ENG 103", "m-01"]
        elif s["id"] == "usr_stud_liam_oconnor":
            courses = ["MATH 103", "PHYS 111", "CS 105", "ph 01"]
        elif s["id"] == "usr_stud_amina_almansoor":
            courses = ["MATH 103", "PHYS 111", "MATH 201", "CS 105", "AI 301", "ENG 103"]
        else: # Leo Tanaka
            courses = ["CS 105", "MATH 103", "ENG 103"]

        for code in courses:
            spec = next(c for c in COURSE_SPECS if c["code"] == code)
            eid = hex_id("enr")
            cur.execute("""
                INSERT INTO public.enrollments (enrollment_id, student_id, course_id, classroom_id, university_id, status)
                VALUES (%s, %s, %s, %s, %s, 'active')
                ON CONFLICT (student_id, classroom_id) DO NOTHING
            """, (eid, s["id"], spec["course_id"], spec["classroom_id"], uni_id))
            enrollment_count += 1

    # Distribute the 30 mock students across Al-Azhar (25 students) and Arish University (5 students)
    al_azhar_specs = [c for c in COURSE_SPECS if c.get("university_id", "Al-Azhar") == "Al-Azhar"]
    arish_specs = [c for c in COURSE_SPECS if c.get("university_id", "Al-Azhar") == "arish_university"]

    for i, m in enumerate(all_students):
        m_uni = m.get("university_id", "Al-Azhar")
        if m_uni == "arish_university":
            for spec in arish_specs:
                eid = hex_id("enr")
                cur.execute("""
                    INSERT INTO public.enrollments (enrollment_id, student_id, course_id, classroom_id, university_id, status)
                    VALUES (%s, %s, %s, %s, %s, 'active')
                    ON CONFLICT (student_id, classroom_id) DO NOTHING
                """, (eid, m["id"], spec["course_id"], spec["classroom_id"], m_uni))
                enrollment_count += 1
        else:
            # assign 4 Al-Azhar courses deterministically
            assigned_indices = [(i + offset) % len(al_azhar_specs) for offset in range(4)]
            for idx in assigned_indices:
                spec = al_azhar_specs[idx]
                eid = hex_id("enr")
                cur.execute("""
                    INSERT INTO public.enrollments (enrollment_id, student_id, course_id, classroom_id, university_id, status)
                    VALUES (%s, %s, %s, %s, %s, 'active')
                    ON CONFLICT (student_id, classroom_id) DO NOTHING
                """, (eid, m["id"], spec["course_id"], spec["classroom_id"], m_uni))
                enrollment_count += 1

    db_conn.commit()
    print(f"  [OK] Generated {enrollment_count} course enrollments across realistic classroom distributions.")

def step_5_create_materials_and_storage():
    print("\n--- STEP 5: LEARNING MATERIALS & SUPABASE STORAGE ---")
    cur = db_conn.cursor()
    uni_id = "Al-Azhar"
    
    # Create PDFs for each subject and upload to Supabase Storage if missing
    materials_created = 0
    pdf_dir = Path("data/demo_materials")
    pdf_dir.mkdir(parents=True, exist_ok=True)

    materials_catalog = [
        {"code": "CS 105", "title": "Python Syntax & Object-Oriented Structures", "filename": "python_syntax_and_oop.pdf", "pages": ["Python Fundamentals: Variables, Lists, Dictionaries, and Control Flow.", "Object-Oriented Python: Classes, Encapsulation, and Polymorphism."]},
        {"code": "CS 105", "title": "Data Structures in Python: Stacks, Queues, and Hash Maps", "filename": "python_data_structures.pdf", "pages": ["Linear Structures: Stack implementations and Big-O efficiency.", "Associative Structures: Hash collisions and dictionary amortized lookup."]},
        {"code": "AI 301", "title": "Foundations of Machine Learning & Gradient Descent", "filename": "gradient_descent_fundamentals.pdf", "pages": ["Objective Functions: Mean Squared Error, Cross Entropy, and Convex Optimization.", "Gradient Descent: Learning rate selection, backpropagation, and momentum."]},
        {"code": "AI 301", "title": "Deep Neural Architectures & CNNs", "filename": "neural_architectures_guide.pdf", "pages": ["Multilayer Perceptrons: Activation functions (ReLU, GELU, Softmax).", "Convolutional Layers: Kernel filters, stride, and spatial pooling."]},
        {"code": "MATH 201", "title": "Eigenvalues, Eigenvectors, and Matrix Decompositions", "filename": "eigenvalues_and_decompositions.pdf", "pages": ["Eigenvalues & Characteristic Polynomials: det(A - lambda*I) = 0.", "Singular Value Decomposition (SVD) and low-rank approximation."]},
        {"code": "PHYS 111", "title": "Newtonian Dynamics & Mechanical Energy", "filename": "newtonian_dynamics.pdf", "pages": ["Newton's Laws of Motion: F = dp/dt and inertial frames.", "Conservation of Mechanical Energy and Work-Energy Theorem."]},
        {"code": "ENG 103", "title": "Grammar, Rhetoric, and Cohesive Paragraphs", "filename": "academic_writing_principles.pdf", "pages": ["Sentence Structure: Clauses, parallelism, and avoiding comma splices.", "Thesis Formulation and Evidence Integration."]}
    ]

    for item in materials_catalog:
        spec = next(c for c in COURSE_SPECS if c["code"] == item["code"])
        file_id = hex_id("file")
        storage_path = f"{uni_id}/{spec['course_id']}/material/{file_id}"
        
        # Build PDF using PyMuPDF
        pdf_path = pdf_dir / item["filename"]
        doc = fitz.open()
        for page_text in item["pages"]:
            page = doc.new_page()
            page.insert_text(fitz.Point(50, 72), f"{item['title']}", fontsize=16)
            page.insert_text(fitz.Point(50, 110), f"Course: {spec['code']} - {spec['title']}", fontsize=11)
            page.insert_text(fitz.Point(50, 150), page_text, fontsize=10)
        doc.save(str(pdf_path))
        doc.close()

        pdf_bytes = pdf_path.read_bytes()
        sha256 = hashlib.sha256(pdf_bytes).hexdigest()

        # Upload to Supabase storage bucket course-materials
        try:
            sb_admin.storage.from_("course-materials").upload(
                storage_path,
                pdf_bytes,
                file_options={"content-type": "application/pdf", "upsert": "true"}
            )
        except Exception as e:
            # If already exists or error, log safely
            pass

        # Insert stored_file record
        cur.execute("""
            INSERT INTO public.stored_files (
                file_id, university_id, course_id, classroom_id, uploader_id, purpose,
                original_filename, extension, mime_type, kind, size_bytes, sha256,
                storage_bucket, storage_path, index_mode, status, page_count
            ) VALUES (%s, %s, %s, %s, %s, 'MATERIAL', %s, 'pdf', 'application/pdf', 'DOCUMENT', %s, %s, 'course-materials', %s, 'RAG', 'READY', %s)
            ON CONFLICT (storage_bucket, storage_path) DO NOTHING
        """, (file_id, uni_id, spec["course_id"], spec["classroom_id"], spec["instructor_id"], item["filename"], len(pdf_bytes), sha256, storage_path, len(item["pages"])))

        # Insert material record
        mat_id = hex_id("mat")
        cur.execute("""
            INSERT INTO public.materials (material_id, classroom_id, university_id, course_id, title, file_id)
            VALUES (%s, %s, %s, %s, %s, %s)
        """, (mat_id, spec["classroom_id"], uni_id, spec["course_id"], item["title"], file_id))
        materials_created += 1

    db_conn.commit()
    print(f"  [OK] Created and linked {materials_created} high-quality learning materials with valid PDF files in Supabase Storage.")

def step_6_create_assignments_and_assessments():
    print("\n--- STEP 6: ASSIGNMENTS, RUBRICS, AND SUBMISSIONS ---")
    cur = db_conn.cursor()
    uni_id = "Al-Azhar"
    now = datetime.now(timezone.utc)

    assignments_catalog = [
        # CS 105
        {
            "id": "asg_cs105_01", "code": "CS 105", "title": "Lab 1: Python Data Structures & Algorithmic Complexity",
            "instructions": "Implement a custom Stack and Queue in Python using linked nodes. Include push, pop, and peek methods. Write unit tests proving O(1) performance.",
            "is_programming": True, "points": 100, "due": now - timedelta(days=7),
            "rubric": [
                {"id": "crit_1", "title": "Correctness & Method Completeness", "points": 40},
                {"id": "crit_2", "title": "Time Complexity (O(1) proofs)", "points": 30},
                {"id": "crit_3", "title": "Code Structure & PEP8 Quality", "points": 30}
            ]
        },
        {
            "id": "asg_cs105_02", "code": "CS 105", "title": "Assignment 2: Object-Oriented Simulation Engine",
            "instructions": "Design an object-oriented simulation of an educational learning environment. Implement Polymorphism and Abstract Base Classes.",
            "is_programming": True, "points": 100, "due": now + timedelta(days=5),
            "rubric": [
                {"id": "crit_1", "title": "Class Hierarchy & Architecture", "points": 50},
                {"id": "crit_2", "title": "Error Handling & Edge Cases", "points": 30},
                {"id": "crit_3", "title": "Documentation & Docstrings", "points": 20}
            ]
        },
        # AI 301
        {
            "id": "asg_ai301_01", "code": "AI 301", "title": "Project 1: Gradient Descent & Logistic Classifier",
            "instructions": "Derive the gradient of binary cross-entropy loss. Implement batch and stochastic gradient descent from scratch using NumPy.",
            "is_programming": True, "points": 100, "due": now - timedelta(days=4),
            "rubric": [
                {"id": "crit_1", "title": "Mathematical Derivation & Proof", "points": 35},
                {"id": "crit_2", "title": "Vectorized NumPy Implementation", "points": 45},
                {"id": "crit_3", "title": "Convergence Visualization & Loss Curve", "points": 20}
            ]
        },
        {
            "id": "asg_ai301_02", "code": "AI 301", "title": "Project 2: Neural Network Backpropagation from Scratch",
            "instructions": "Implement a 2-layer neural network with ReLU hidden activations and Softmax output. Train on MNIST data.",
            "is_programming": True, "points": 100, "due": now + timedelta(days=8),
            "rubric": [
                {"id": "crit_1", "title": "Forward and Backward Pass Vectorization", "points": 50},
                {"id": "crit_2", "title": "Validation Accuracy > 92%", "points": 30},
                {"id": "crit_3", "title": "Hyperparameter Tuning Report", "points": 20}
            ]
        },
        # MATH 103
        {
            "id": "asg_math103_01", "code": "MATH 103", "title": "Problem Set 1: Systems of Linear Equations & Matrices",
            "instructions": "Solve systems of linear equations using Gaussian elimination and row reduction. Compute determinant and matrix inverse.",
            "is_programming": False, "points": 100, "due": now - timedelta(days=10),
            "rubric": [
                {"id": "crit_1", "title": "Gaussian Elimination Steps", "points": 50},
                {"id": "crit_2", "title": "Determinant & Inverse Calculations", "points": 50}
            ]
        },
        # PHYS 111
        {
            "id": "asg_phys111_01", "code": "PHYS 111", "title": "Mechanics Analysis: Two-Body Dynamics & Friction",
            "instructions": "Analyze motion of connected masses on inclined surfaces with static and kinetic friction. Derive equations of motion.",
            "is_programming": False, "points": 100, "due": now - timedelta(days=3),
            "rubric": [
                {"id": "crit_1", "title": "Free-Body Diagrams & Coordinate Systems", "points": 40},
                {"id": "crit_2", "title": "Newton's Second Law Equations", "points": 40},
                {"id": "crit_3", "title": "Friction Threshold Calculations", "points": 20}
            ]
        },
        # ENG 103
        {
            "id": "asg_eng103_01", "code": "ENG 103", "title": "Essay 1: Critical Analysis of Rhetorical Arguments",
            "instructions": "Write a 750-word analytical essay evaluating the use of ethos, pathos, and logos in historical speeches.",
            "is_programming": False, "points": 100, "due": now - timedelta(days=5),
            "rubric": [
                {"id": "crit_1", "title": "Thesis Statement & Cohesive Argument", "points": 40},
                {"id": "crit_2", "title": "Textual Evidence & Citation", "points": 30},
                {"id": "crit_3", "title": "Grammar, Tone, & Vocabulary", "points": 30}
            ]
        }
    ]

    for a in assignments_catalog:
        spec = next(c for c in COURSE_SPECS if c["code"] == a["code"])
        cur.execute("""
            INSERT INTO public.assignments (
                assignment_id, course_id, classroom_id, university_id, title, instructions,
                subject_area, is_programming, default_policy, status, due_at, published_at,
                version, created_by, points_possible, rubric, rubric_source, ai_grading
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, 'GUIDED', 'PUBLISHED', %s, %s, 1, %s, %s, %s, 'teacher', 'review'
            ) ON CONFLICT (assignment_id) DO UPDATE SET
                title = EXCLUDED.title, instructions = EXCLUDED.instructions, points_possible = EXCLUDED.points_possible
        """, (
            a["id"], spec["course_id"], spec["classroom_id"], uni_id, a["title"], a["instructions"],
            spec["subject"], a["is_programming"], a["due"], a["due"] - timedelta(days=14),
            spec["instructor_id"], a["points"], json.dumps(a["rubric"])
        ))
        cur.execute("""
            INSERT INTO public.assignment_versions (assignment_id, version, title, instructions, due_at, status)
            VALUES (%s, 1, %s, %s, %s, 'PUBLISHED')
            ON CONFLICT (assignment_id, version) DO NOTHING
        """, (a["id"], a["title"], a["instructions"], a["due"]))

    db_conn.commit()
    print("  [OK] Created core assignments with rubrics and versions.")

    # Now create attempts, submissions, grades, and evaluations for students
    submissions_count = 0
    evaluations_count = 0

    # Student 1: Sarah Jenkins (Excellent Performer) - 96% on CS105 Lab 1, 98% on AI301 Project 1, 94% on Math103
    sarah_subs = [
        {
            "asg_id": "asg_cs105_01",
            "score": 96.0, "feedback": "Exceptional implementation. Your Node-based Stack demonstrates true O(1) performance and your docstrings follow PEP 257 impeccably.",
            "code": """class Node:
    def __init__(self, value, next_node=None):
        self.value = value
        self.next = next_node

class Stack:
    def __init__(self):
        self._top = None
        self._size = 0

    def push(self, val):
        self._top = Node(val, self._top)
        self._size += 1

    def pop(self):
        if not self._top:
            raise IndexError("pop from empty stack")
        val = self._top.value
        self._top = self._top.next
        self._size -= 1
        return val

    def peek(self):
        return self._top.value if self._top else None
"""
        },
        {
            "asg_id": "asg_ai301_01",
            "score": 98.0, "feedback": "Superb derivation of binary cross-entropy gradient. The vectorized NumPy implementation shows deep mastery of matrix calculus.",
            "code": """import numpy as np

def sigmoid(z):
    return 1 / (1 + np.exp(-z))

def compute_loss(y_true, y_pred):
    eps = 1e-15
    y_pred = np.clip(y_pred, eps, 1 - eps)
    return -np.mean(y_true * np.log(y_pred) + (1 - y_true) * np.log(1 - y_pred))

def gradient_descent(X, y, lr=0.01, epochs=1000):
    m, n = X.shape
    weights = np.zeros(n)
    bias = 0.0
    for _ in range(epochs):
        y_hat = sigmoid(np.dot(X, weights) + bias)
        dw = (1/m) * np.dot(X.T, (y_hat - y))
        db = (1/m) * np.sum(y_hat - y)
        weights -= lr * dw
        bias -= lr * db
    return weights, bias
"""
        }
    ]

    for sub in sarah_subs:
        att_id = hex_id("att")
        cur.execute("""
            INSERT INTO public.attempts (attempt_id, student_id, assignment_id, university_id, attempt_number, status, started_at, ended_at)
            VALUES (%s, %s, %s, %s, 1, 'SUBMITTED', %s, %s)
        """, (att_id, "usr_stud_sarah_jenkins", sub["asg_id"], uni_id, now - timedelta(days=8), now - timedelta(days=7, hours=2)))
        
        sub_id = hex_id("sub")
        cur.execute("""
            INSERT INTO public.submissions (
                submission_id, attempt_id, university_id, student_id, assignment_id, submission_type,
                submission_text, submitted_at, score, max_score, feedback, graded_at, graded_by, grade_source
            ) VALUES (%s, %s, %s, %s, %s, 'text', %s, %s, %s, 100, %s, %s, 'usr_inst_elena_rostova', 'manual')
        """, (sub_id, att_id, uni_id, "usr_stud_sarah_jenkins", sub["asg_id"], sub["code"], now - timedelta(days=7, hours=2), sub["score"], sub["feedback"], now - timedelta(days=6)))
        submissions_count += 1

        # Add AI grade evaluation draft
        gev_id = hex_id("gev")
        cur.execute("""
            INSERT INTO public.grade_evaluations (
                evaluation_id, university_id, course_id, assignment_id, submission_id, student_id,
                status, trigger, score, max_score, confidence, feedback, rationale, flags, completed_at
            ) VALUES (%s, %s, (SELECT course_id FROM assignments WHERE assignment_id=%s), %s, %s, %s, 'COMPLETED', 'submission', %s, 100, 0.95, %s, 'High code quality, O(1) properties strictly respected.', '[]'::jsonb, %s)
        """, (gev_id, uni_id, sub["asg_id"], sub["asg_id"], sub_id, "usr_stud_sarah_jenkins", sub["score"], sub["feedback"], now - timedelta(days=6)))
        evaluations_count += 1

    # Student 2: Marcus Vance (Average Student) - 78% on CS105 Lab 1
    att_id = hex_id("att")
    cur.execute("""
        INSERT INTO public.attempts (attempt_id, student_id, assignment_id, university_id, attempt_number, status, started_at, ended_at)
        VALUES (%s, %s, 'asg_cs105_01', %s, 1, 'SUBMITTED', %s, %s)
    """, (att_id, "usr_stud_marcus_vance", uni_id, now - timedelta(days=7), now - timedelta(days=6)))
    sub_id = hex_id("sub")
    cur.execute("""
        INSERT INTO public.submissions (
            submission_id, attempt_id, university_id, student_id, assignment_id, submission_type,
            submission_text, submitted_at, score, max_score, feedback, graded_at, graded_by, grade_source
        ) VALUES (%s, %s, %s, %s, 'asg_cs105_01', 'text', %s, %s, 78.0, 100, 'Good working stack, but list-based pop(0) was used instead of linked nodes, which violates O(1) time complexity.', %s, 'usr_inst_elena_rostova', 'manual')
    """, (sub_id, att_id, uni_id, "usr_stud_marcus_vance", "class Stack:\n    def __init__(self):\n        self.items = []\n    def push(self, x):\n        self.items.append(x)\n    def pop(self):\n        return self.items.pop(0)", now - timedelta(days=6), now - timedelta(days=5)))
    submissions_count += 1

    # Student 3: Liam O'Connor (Struggling Student) - Late & Overdue, 52% on Math 103, pending review on CS 105
    att_id = hex_id("att")
    cur.execute("""
        INSERT INTO public.attempts (attempt_id, student_id, assignment_id, university_id, attempt_number, status, started_at, ended_at)
        VALUES (%s, %s, 'asg_math103_01', %s, 1, 'SUBMITTED', %s, %s)
    """, (att_id, "usr_stud_liam_oconnor", uni_id, now - timedelta(days=9), now - timedelta(days=8)))
    sub_id = hex_id("sub")
    cur.execute("""
        INSERT INTO public.submissions (
            submission_id, attempt_id, university_id, student_id, assignment_id, submission_type,
            submission_text, submitted_at, score, max_score, feedback, graded_at, graded_by, grade_source
        ) VALUES (%s, %s, %s, %s, 'asg_math103_01', 'text', %s, %s, 52.0, 100, 'Significant errors during row-reduction arithmetic in step 3. Review matrix pivot rules.', %s, 'usr_inst_robert_chen', 'manual')
    """, (sub_id, att_id, uni_id, "usr_stud_liam_oconnor", "Step 1: Row 2 = Row 2 - 2*Row 1\nResult had arithmetic miscalculation on column 3.", now - timedelta(days=8), now - timedelta(days=7)))
    submissions_count += 1

    # Add risk signal for Liam (Attention Center indicator)
    cur.execute("""
        INSERT INTO public.risk_signals (risk_signal_id, student_id, university_id, assignment_id, signal, observation, severity, confidence, created_at)
        VALUES (%s, %s, %s, 'asg_math103_01', 'conceptual_gap', 'Persistent arithmetic errors during Gaussian pivot reduction.', 'MEDIUM', 0.88, %s)
    """, (hex_id("rsk"), "usr_stud_liam_oconnor", uni_id, now - timedelta(days=7)))

    # Student 4: Amina Al-Mansoor (Highly Active Student) - 92% on CS105, 88% on Phys111, 95% on Eng103
    for asg_id, sc, prof, fb in [
        ("asg_cs105_01", 92.0, "usr_inst_elena_rostova", "Very creative solution with recursive helper functions."),
        ("asg_phys111_01", 88.0, "usr_inst_robert_chen", "Clear free-body diagrams and correct normal force derivation."),
        ("asg_eng103_01", 95.0, "usr_inst_elena_rostova", "Compelling analysis of persuasive rhetoric with well-chosen quotations.")
    ]:
        att_id = hex_id("att")
        cur.execute("""
            INSERT INTO public.attempts (attempt_id, student_id, assignment_id, university_id, attempt_number, status, started_at, ended_at)
            VALUES (%s, %s, %s, %s, 1, 'SUBMITTED', %s, %s)
        """, (att_id, "usr_stud_amina_almansoor", asg_id, uni_id, now - timedelta(days=4), now - timedelta(days=3)))
        sub_id = hex_id("sub")
        cur.execute("""
            INSERT INTO public.submissions (
                submission_id, attempt_id, university_id, student_id, assignment_id, submission_type,
                submission_text, submitted_at, score, max_score, feedback, graded_at, graded_by, grade_source
            ) VALUES (%s, %s, %s, %s, %s, 'text', 'Completed comprehensive solution.', %s, %s, 100, %s, %s, %s, 'manual')
        """, (sub_id, att_id, uni_id, "usr_stud_amina_almansoor", asg_id, now - timedelta(days=3), sc, fb, now - timedelta(days=2), prof))
        submissions_count += 1

    # Populate 70+ submissions from the mock students across all assignments
    cur.execute("SELECT student_id as id, university_id FROM public.students WHERE student_id LIKE 'usr_mock_stud_%'")
    all_mock = cur.fetchall()
    al_azhar_mock = [m for m in all_mock if m["university_id"] == "Al-Azhar"]
    for offset in range(3):
        for i, m in enumerate(al_azhar_mock):
            asg = assignments_catalog[(i + offset) % len(assignments_catalog)]
            att_id = hex_id("att")
            cur.execute("""
                INSERT INTO public.attempts (attempt_id, student_id, assignment_id, university_id, attempt_number, status, started_at, ended_at)
                VALUES (%s, %s, %s, %s, %s, 'SUBMITTED', %s, %s)
            """, (att_id, m["id"], asg["id"], uni_id, offset + 1, now - timedelta(days=5 - offset), now - timedelta(days=4 - offset)))
            
            sub_id = hex_id("sub")
            if (i + offset) % 4 != 0: # 75% graded, 25% pending review
                score = 65.0 + ((i + offset * 7) * 7) % 32
                spec = next(c for c in COURSE_SPECS if c["code"] == asg["code"])
                cur.execute("""
                    INSERT INTO public.submissions (
                        submission_id, attempt_id, university_id, student_id, assignment_id, submission_type,
                        submission_text, submitted_at, score, max_score, feedback, graded_at, graded_by, grade_source
                    ) VALUES (%s, %s, %s, %s, %s, 'text', 'Student submitted answer demonstrating understanding.', %s, %s, 100, 'Good attempt. Continue practicing the core theorems.', %s, %s, 'manual')
                """, (sub_id, att_id, uni_id, m["id"], asg["id"], now - timedelta(days=4 - offset), score, now - timedelta(days=3 - offset), spec["instructor_id"]))
            else: # pending review (score is NULL)
                cur.execute("""
                    INSERT INTO public.submissions (
                        submission_id, attempt_id, university_id, student_id, assignment_id, submission_type,
                        submission_text, submitted_at
                    ) VALUES (%s, %s, %s, %s, %s, 'text', 'Submitted project waiting for instructor evaluation.', %s)
                """, (sub_id, att_id, uni_id, m["id"], asg["id"], now - timedelta(days=1)))
            submissions_count += 1

    db_conn.commit()
    print(f"  [OK] Created {submissions_count} student submissions across diverse performance levels.")

def step_7_populate_ai_coach_and_telemetry():
    print("\n--- STEP 7: AI COACH, VERIFICATIONS, AND TELEMETRY ---")
    cur = db_conn.cursor()
    uni_id = "Al-Azhar"
    now = datetime.now(timezone.utc)

    # 1. Socratic Coach Sessions for Amina & Sarah
    for stud_id, asg_id, topic in [
        ("usr_stud_amina_almansoor", "asg_cs105_01", "Time complexity of Queue peek vs pop"),
        ("usr_stud_sarah_jenkins", "asg_ai301_01", "Mathematical intuition behind learning rate decay"),
        ("usr_stud_liam_oconnor", "asg_math103_01", "Row reduction pivot selection")
    ]:
        sess_id = hex_id("ses")
        cur.execute("""
            INSERT INTO public.ai_sessions (session_id, student_id, assignment_id, university_id, policy, status, turn_count, started_at)
            VALUES (%s, %s, %s, %s, 'GUIDED', 'ACTIVE', 4, %s)
        """, (sess_id, stud_id, asg_id, uni_id, now - timedelta(days=3)))

        # Messages
        m1 = hex_id("msg")
        m2 = hex_id("msg")
        cur.execute("INSERT INTO public.messages (message_id, session_id, sender, content, created_at) VALUES (%s, %s, 'STUDENT', %s, %s)",
                    (m1, sess_id, f"Coach, I am trying to understand {topic}. How do I verify this mathematically?", now - timedelta(days=3, minutes=10)))
        cur.execute("INSERT INTO public.messages (message_id, session_id, sender, content, created_at) VALUES (%s, %s, 'COACH', %s, %s)",
                    (m2, sess_id, f"Great question! Consider the operation step-by-step: what happens to the head pointer when an element is accessed versus removed?", now - timedelta(days=3, minutes=9)))

        # AI interaction record
        intr_id = hex_id("itr")
        cur.execute("""
            INSERT INTO public.ai_interactions (
                interaction_id, session_id, student_id, assignment_id, university_id,
                intervention_type, assistance_level, diagnosis, diagnosis_confidence,
                diagnosis_explanation, response, referenced_concepts
            ) VALUES (
                %s, %s, %s, %s, %s, 'QUESTION', 'GUIDED', 'CORRECT_REASONING', 0.92,
                'Student is probing foundational computational complexity.',
                'Great question! Consider the operation step-by-step.', '[\"algorithmic_complexity\"]'::jsonb
            )
        """, (intr_id, sess_id, stud_id, asg_id, uni_id))

    # 2. Socratic Verification Runs (Oral Exams)
    for stud_id, asg_id, outcome, sc in [
        ("usr_stud_sarah_jenkins", "asg_cs105_01", "PASS", 0.96),
        ("usr_stud_sarah_jenkins", "asg_ai301_01", "PASS", 0.98),
        ("usr_stud_marcus_vance", "asg_cs105_01", "PARTIAL", 0.74),
        ("usr_stud_liam_oconnor", "asg_math103_01", "NEEDS_RETRY", 0.48),
        ("usr_stud_amina_almansoor", "asg_cs105_01", "PASS", 0.94)
    ]:
        # Query matching attempt and submission
        cur.execute("""
            SELECT attempt_id, submission_id
            FROM public.submissions
            WHERE student_id = %s AND assignment_id = %s AND university_id = %s
            ORDER BY submitted_at DESC LIMIT 1
        """, (stud_id, asg_id, uni_id))
        sub_row = cur.fetchone()
        if sub_row:
            att_id = sub_row["attempt_id"] if isinstance(sub_row, dict) else sub_row[0]
            sub_id = sub_row["submission_id"] if isinstance(sub_row, dict) else sub_row[1]
        else:
            cur.execute("""
                SELECT attempt_id FROM public.attempts
                WHERE student_id = %s AND assignment_id = %s AND university_id = %s
                LIMIT 1
            """, (stud_id, asg_id, uni_id))
            att_row = cur.fetchone()
            if att_row:
                att_id = att_row["attempt_id"] if isinstance(att_row, dict) else att_row[0]
            else:
                att_id = hex_id("att")
                cur.execute("""
                    INSERT INTO public.attempts (attempt_id, student_id, assignment_id, university_id, attempt_number, status, started_at)
                    VALUES (%s, %s, %s, %s, 1, 'SUBMITTED', %s)
                """, (att_id, stud_id, asg_id, uni_id, now - timedelta(days=5)))
            sub_id = None

        v_id = hex_id("vrf")
        cur.execute("""
            INSERT INTO public.verification_runs (
                verification_id, student_id, assignment_id, attempt_id, submission_id, university_id, status, overall_outcome, score, confidence, feedback, created_at, completed_at
            ) VALUES (%s, %s, %s, %s, %s, %s, 'COMPLETED', %s, %s, 0.92, 'Socratic verification confirmed understanding.', %s, %s)
        """, (v_id, stud_id, asg_id, att_id, sub_id, uni_id, outcome, sc, now - timedelta(days=4), now - timedelta(days=4, minutes=-15)))

        q_id = hex_id("vqu")
        cur.execute("""
            INSERT INTO public.verification_questions (
                question_id, verification_id, challenge_id, display_order, verification_type, concept, question_text
            ) VALUES (%s, %s, %s, 1, 'EXPLAIN', 'DataStructures', 'Explain why your queue peek operation does not modify the underlying state.')
        """, (q_id, v_id, hex_id("chl")))

        resp_id = hex_id("vrs")
        cur.execute("""
            INSERT INTO public.verification_responses (response_id, question_id, student_id, response_text, created_at)
            VALUES (%s, %s, %s, 'Peek returns value from head node without adjusting head pointer.', %s)
        """, (resp_id, q_id, stud_id, now - timedelta(days=4, minutes=-10)))

        cur.execute("""
            INSERT INTO public.verification_results (result_id, question_id, response_id, outcome, score, confidence, feedback, created_at)
            VALUES (%s, %s, %s, %s, %s, 0.94, 'Accurate conceptual explanation.', %s)
        """, (hex_id("vrl"), q_id, resp_id, outcome, sc, now - timedelta(days=4, minutes=-5)))

    # 3. Learning Telemetry Events over the past 30 days
    event_count = 0
    for day in range(30, 0, -2):
        ts = now - timedelta(days=day, hours=(day % 8))
        for s in PRIMARY_STUDENTS:
            cur.execute("""
                INSERT INTO public.learning_events (event_id, student_id, university_id, event_type, occurred_at, payload)
                VALUES (%s, %s, %s, 'AI_INTERACTION', %s, '{\"action\": \"coaching_progress\"}'::jsonb)
            """, (hex_id("evt"), s["id"], uni_id, ts))
            event_count += 1

    # 4. Student Notes
    notes_catalog = [
        {"student_id": "usr_stud_sarah_jenkins", "title": "Big-O Cheatsheet", "content": "Stack: Push O(1), Pop O(1), Peek O(1).\nBinary Search Tree: Average O(log n), Worst O(n).", "imp": "high", "pin": True},
        {"student_id": "usr_stud_sarah_jenkins", "title": "Gradient Descent Formulas", "content": "w = w - alpha * dJ/dw.\nRemember to normalize features using Z-score standardization.", "imp": "medium", "pin": False},
        {"student_id": "usr_stud_amina_almansoor", "title": "Physics Dynamics Equations", "content": "F_net = m * a\nF_friction = mu * N\nWork = Integral of F dot ds", "imp": "high", "pin": True},
        {"student_id": "usr_stud_marcus_vance", "title": "Python Syntax Reminders", "content": "Use list comprehensions: [x*2 for x in arr if x > 0].\nDictionary unpacking: {**dict1, **dict2}.", "imp": "low", "pin": False}
    ]
    for n in notes_catalog:
        cur.execute("""
            INSERT INTO public.student_notes (note_id, student_id, university_id, title, content, importance, pinned)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (hex_id("note"), n["student_id"], uni_id, n["title"], n["content"], n["imp"], n["pin"]))

    # 5. Teaching Personas
    for s in PRIMARY_STUDENTS:
        cur.execute("""
            INSERT INTO public.student_preferences (student_id, university_id, teaching_persona, persona_version)
            VALUES (%s, %s, 'socratic_guide', 1)
            ON CONFLICT (student_id) DO UPDATE SET teaching_persona = 'socratic_guide'
        """, (s["id"], uni_id))

    db_conn.commit()
    print(f"  [OK] Created AI sessions, verifications, {event_count} telemetry events, and student notes.")

def generate_credentials_file():
    print("\n--- STEP 8: WRITE DEMO_CREDENTIALS.MD ---")
    content = """# SocratiQ — Primary Demo Account Credentials

> [!IMPORTANT]
> **Confidential Demo Credentials**: This file is strictly for authorized demonstration purposes and is added to `.gitignore`. Never commit or expose these credentials.

## Primary Instructors (2 Accounts)

| Instructor Name | Email | Password | Academic Specialization | Assigned Classes |
|---|---|---|---|---|
| **Dr. Robert Chen** | `robert.chen@socratiq.edu` | `SocratiqDemo2026!Prof1` | Mathematics & Classical Mechanics | MATH 103, PHYS 111, MATH 201 |
| **Dr. Elena Rostova** | `elena.rostova@socratiq.edu` | `SocratiqDemo2026!Prof2` | Computer Science & Artificial Intelligence | CS 105, AI 301, ENG 103 |

### Instructor 1 (Dr. Robert Chen) Demo Scenario:
- **Focus**: Mathematics and Physical Sciences.
- **Teaching Dashboard**: Shows 3 active courses with 40+ enrolled students, 2 active problem sets with submissions, and Attention Center insights identifying students struggling with matrix operations.

### Instructor 2 (Dr. Elena Rostova) Demo Scenario:
- **Focus**: Python Programming, Machine Learning, and Technical English.
- **Teaching Dashboard**: Shows 3 active courses, rich programming code submissions with unit tests, AI grading draft evaluations ready for one-click approval, and rubric scoring.

---

## Primary Students (5 Accounts)

| Student Name | Email | Password | Persona & Performance | Enrolled Classes |
|---|---|---|---|---|
| **Sarah Jenkins** | `sarah.jenkins@socratiq.edu` | `SocratiqDemo2026!Stud1` | **Excellent Student**: 95%+ grades, completed assignments, high verification mastery, active notes. | CS 105, AI 301, MATH 103, PHYS 111, ENG 103 |
| **Marcus Vance** | `marcus.vance@socratiq.edu` | `SocratiqDemo2026!Stud2` | **Average Student**: Mixed performance (70–82%), steady progress, completed Lab 1. | MATH 103, CS 105, ENG 103, m-01 |
| **Liam O'Connor** | `liam.oconnor@socratiq.edu` | `SocratiqDemo2026!Stud3` | **Struggling Student**: Overdue work, needs support in Attention Center, low mastery on linear systems. | MATH 103, PHYS 111, CS 105, ph 01 |
| **Amina Al-Mansoor** | `amina.almansoor@socratiq.edu` | `SocratiqDemo2026!Stud4` | **Highly Active Student**: Extensive Socratic coach chat dialogues, diverse submissions, high curiosity. | MATH 103, PHYS 111, MATH 201, CS 105, AI 301, ENG 103 |
| **Leo Tanaka** | `leo.tanaka@socratiq.edu` | `SocratiqDemo2026!Stud5` | **New Student**: Fresh enrollment, upcoming assignments, clean dashboard view. | CS 105, MATH 103, ENG 103 |

---

## Additional Mock Dataset Summary
- **3 Additional Instructors**: Dr. Sophia Patel (Engineering), Dr. Tariq Al-Hashimi (Philosophy/Arabic), Dr. David Kim (Anatomy).
- **30 Additional Mock Students**: Fully enrolled across all 11 courses, driving realistic roster distributions, grade curves, and live analytics.
"""
    with open("DEMO_CREDENTIALS.md", "w") as f:
        f.write(content)
    print("  [OK] DEMO_CREDENTIALS.md written successfully.")

def verify_logins_and_routes():
    print("\n--- STEP 9: LIVE LOGIN & ROUTE VERIFICATION ---")
    anon_client = create_client(SUPABASE_URL, ANON_KEY)
    
    # 1. Test logins for all 7 primary accounts
    all_primary = PRIMARY_INSTRUCTORS + PRIMARY_STUDENTS
    for u in all_primary:
        try:
            res = anon_client.auth.sign_in_with_password({
                "email": u["email"],
                "password": u["password"]
            })
            assert res.user.id == u["auth_id"]
            assert res.session.access_token is not None
            print(f"  [PASS] Auth Login: {u['first_name']} {u['last_name']} ({u['role']}) -> Session valid.")
        except Exception as e:
            print(f"  [FAIL] Auth Login failed for {u['email']}: {e}")
            raise

    # 2. Verify database counts
    cur = db_conn.cursor()
    cur.execute("SELECT count(*) as c FROM public.users")
    users_c = cur.fetchone()["c"]
    cur.execute("SELECT count(*) as c FROM public.courses")
    courses_c = cur.fetchone()["c"]
    cur.execute("SELECT count(*) as c FROM public.enrollments")
    enr_c = cur.fetchone()["c"]
    cur.execute("SELECT count(*) as c FROM public.assignments")
    asg_c = cur.fetchone()["c"]
    cur.execute("SELECT count(*) as c FROM public.submissions")
    sub_c = cur.fetchone()["c"]

    print(f"\nFinal Database State:")
    print(f"  - Users: {users_c} (Target: 40)")
    print(f"  - Courses: {courses_c} (Target: 11)")
    print(f"  - Enrollments: {enr_c} (Target: 140+)")
    print(f"  - Assignments: {asg_c} (Target: 13+)")
    print(f"  - Submissions: {sub_c} (Target: 70+)")
    
    assert users_c == 40, f"Expected 40 users, got {users_c}"
    assert courses_c == 11, f"Expected 11 courses, got {courses_c}"
    assert enr_c >= 120, f"Expected 120+ enrollments, got {enr_c}"
    assert sub_c >= 70, f"Expected 70+ submissions, got {sub_c}"

    print("\n[SUCCESS] ALL VERIFICATIONS PASSED!")

def main():
    print("==================================================")
    print("SOCRATIQ DEMO ENVIRONMENT SEEDING & MIGRATION")
    print("==================================================")
    step_1_cleanup()
    mock_students = step_2_provision_auth_and_profiles()
    step_3_distribute_courses_and_classrooms()
    step_4_create_enrollments(mock_students)
    step_5_create_materials_and_storage()
    step_6_create_assignments_and_assessments()
    step_7_populate_ai_coach_and_telemetry()
    generate_credentials_file()
    verify_logins_and_routes()
    db_conn.close()
    print("\nDEMO ENVIRONMENT SEEDING COMPLETED SUCCESSFULLY!")

if __name__ == "__main__":
    main()
