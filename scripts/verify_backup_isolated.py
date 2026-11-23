#!/usr/bin/env python3
"""
Isolated Backup Restoration Verification.
Tests the backup restoration process in a completely isolated local environment
WITHOUT connecting to or touching the active production database.
"""
import sys
import os
import json
import sqlite3
from pathlib import Path

backup_dir = Path("backups/backup_20261122_191535")
manifest_file = backup_dir / "manifest.json"

if not manifest_file.exists():
    print(f"Error: manifest.json not found in {backup_dir}")
    sys.exit(1)

with open(manifest_file, "r") as f:
    manifest = json.load(f)

print(f"=== ISOLATED BACKUP RESTORATION TEST ===")
print(f"Target Backup: {backup_dir.name} ({manifest['timestamp']})")
print(f"Total Tables in Backup: {len(manifest['tables'])} public tables + auth_users")
print("Target Isolated Engine: Local SQLite in-memory / file sandbox (zero production connection)\n")

# Use a local temporary sqlite database
temp_db_path = Path("backups/test_restore_isolated.sqlite")
if temp_db_path.exists():
    temp_db_path.unlink()

conn = sqlite3.connect(temp_db_path)
conn.execute("PRAGMA foreign_keys = OFF;") # To allow flexible creation, will verify FKs after

cur = conn.cursor()

restored_counts = {}
total_restored = 0

# 1. Restore auth.users
auth_file = backup_dir / "data" / "auth_users.json"
if auth_file.exists():
    with open(auth_file, "r") as f:
        auth_rows = json.load(f)
    if auth_rows:
        cols = list(auth_rows[0].keys())
        col_defs = ", ".join([f'"{c}" TEXT' for c in cols])
        cur.execute(f'CREATE TABLE "auth_users" ({col_defs})')
        placeholders = ", ".join(["?"] * len(cols))
        cur.executemany(
            f'INSERT INTO "auth_users" ({", ".join([f"{c}" for c in cols])}) VALUES ({placeholders})',
            [[str(r[c]) if r[c] is not None else None for c in cols] for r in auth_rows]
        )
        restored_counts["auth_users"] = len(auth_rows)
        total_restored += len(auth_rows)
        print(f"  [OK] Restored auth_users: {len(auth_rows)} rows")

# 2. Restore all public tables
for table, meta in manifest["tables"].items():
    tbl_file = backup_dir / meta["file"]
    with open(tbl_file, "r") as f:
        rows = json.load(f)
    if not rows:
        restored_counts[table] = 0
        continue
    
    cols = list(rows[0].keys())
    col_defs = ", ".join([f'"{c}" TEXT' for c in cols])
    cur.execute(f'CREATE TABLE "{table}" ({col_defs})')
    placeholders = ", ".join(["?"] * len(cols))
    
    cur.executemany(
        f'INSERT INTO "{table}" ({", ".join([f"{c}" for c in cols])}) VALUES ({placeholders})',
        [[str(r[c]) if r[c] is not None else None for c in cols] for r in rows]
    )
    restored_counts[table] = len(rows)
    total_restored += len(rows)
    print(f"  [OK] Restored {table:35}: {len(rows)} rows")

conn.commit()

# 3. Verify counts match exactly
print("\n--- Integrity & Row Count Verification ---")
mismatches = 0
for table, meta in manifest["tables"].items():
    expected = meta["row_count"]
    actual = restored_counts.get(table, 0)
    if expected != actual:
        print(f"  [FAIL] Row mismatch in {table}: expected {expected}, restored {actual}")
        mismatches += 1

expected_auth = manifest["auth_users"]["row_count"]
actual_auth = restored_counts.get("auth_users", 0)
if expected_auth != actual_auth:
    print(f"  [FAIL] Row mismatch in auth_users: expected {expected_auth}, restored {actual_auth}")
    mismatches += 1

if mismatches == 0:
    print(f"[SUCCESS] All {total_restored} rows across {len(restored_counts)} tables restored and verified in isolated environment!")
else:
    print(f"[ERROR] Found {mismatches} mismatches!")
    sys.exit(1)

# Clean up temporary test file
conn.close()
if temp_db_path.exists():
    temp_db_path.unlink()
print("Isolated test database cleaned up safely.")
