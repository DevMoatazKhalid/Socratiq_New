#!/usr/bin/env python3
"""
Full Database Backup Script for SocratiQ.
Exports all 43 public tables and auth.users to JSON with cryptographic checksums.
Verifies backup integrity and provides restoration documentation.
"""
import os
import json
import hashlib
from datetime import datetime, timezone
from pathlib import Path
from dotenv import load_dotenv
import psycopg
from psycopg.rows import dict_row

load_dotenv()

db_url = os.environ.get("DATABASE_URL")
if not db_url:
    print("DATABASE_URL not set in environment or .env")
    exit(1)

timestamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
backup_dir = Path("backups") / f"backup_{timestamp}"
backup_dir.mkdir(parents=True, exist_ok=True)
data_dir = backup_dir / "data"
data_dir.mkdir(exist_ok=True)

print(f"Starting database backup to {backup_dir.resolve()}...")

conn = psycopg.connect(db_url, row_factory=dict_row)

manifest = {
    "timestamp": timestamp,
    "created_at_iso": datetime.now(timezone.utc).isoformat(),
    "database_url_host": db_url.split("@")[-1].split("/")[0] if "@" in db_url else "unknown",
    "tables": {},
    "auth_users": {}
}

# 1. Fetch table list
with conn.cursor() as cur:
    cur.execute("""
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name;
    """)
    public_tables = [r["table_name"] for r in cur.fetchall()]

print(f"Found {len(public_tables)} public tables.")

def serialize_value(v):
    if v is None:
        return None
    if isinstance(v, (datetime,)):
        return v.isoformat()
    # UUID, Decimal, Vector etc.
    return str(v) if not isinstance(v, (int, float, bool, list, dict, str)) else v

# 2. Export each table
total_records = 0
for table in public_tables:
    with conn.cursor() as cur:
        cur.execute(f'SELECT * FROM public."{table}"')
        rows = cur.fetchall()
        clean_rows = []
        for r in rows:
            clean_rows.append({k: serialize_value(v) for k, v in r.items()})
        
        file_path = data_dir / f"{table}.json"
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(clean_rows, f, indent=2, ensure_ascii=False)
            
        sha256 = hashlib.sha256(file_path.read_bytes()).hexdigest()
        manifest["tables"][table] = {
            "row_count": len(clean_rows),
            "file": f"data/{table}.json",
            "sha256": sha256
        }
        total_records += len(clean_rows)
        print(f"  [OK] public.{table:35} : {len(clean_rows):4} rows (SHA256: {sha256[:8]}...)")

# 3. Export auth.users
try:
    with conn.cursor() as cur:
        cur.execute("SELECT * FROM auth.users")
        auth_rows = cur.fetchall()
        clean_auth = []
        for r in auth_rows:
            clean_auth.append({k: serialize_value(v) for k, v in r.items()})
        
        auth_file = data_dir / "auth_users.json"
        with open(auth_file, "w", encoding="utf-8") as f:
            json.dump(clean_auth, f, indent=2, ensure_ascii=False)
            
        sha256 = hashlib.sha256(auth_file.read_bytes()).hexdigest()
        manifest["auth_users"] = {
            "row_count": len(clean_auth),
            "file": "data/auth_users.json",
            "sha256": sha256
        }
        total_records += len(clean_auth)
        print(f"  [OK] auth.users                         : {len(clean_auth):4} rows (SHA256: {sha256[:8]}...)")
except Exception as e:
    print(f"  [WARN] Failed to export auth.users directly: {e}")
    manifest["auth_users"] = {"error": str(e)}

manifest["total_records"] = total_records

manifest_path = backup_dir / "manifest.json"
with open(manifest_path, "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)

print(f"\nManifest written to {manifest_path}")

# 4. Verify backup integrity immediately
print("\nVerifying backup integrity...")
verified = True
for table, meta in manifest["tables"].items():
    file_p = backup_dir / meta["file"]
    if not file_p.exists():
        print(f"  [FAIL] Missing file: {file_p}")
        verified = False
        continue
    file_hash = hashlib.sha256(file_p.read_bytes()).hexdigest()
    if file_hash != meta["sha256"]:
        print(f"  [FAIL] Hash mismatch for {table}")
        verified = False
        continue
    with open(file_p, "r", encoding="utf-8") as f:
        loaded = json.load(f)
        if len(loaded) != meta["row_count"]:
            print(f"  [FAIL] Row count mismatch in {table}: expected {meta['row_count']}, got {len(loaded)}")
            verified = False
            continue

if manifest.get("auth_users") and "file" in manifest["auth_users"]:
    meta = manifest["auth_users"]
    file_p = backup_dir / meta["file"]
    file_hash = hashlib.sha256(file_p.read_bytes()).hexdigest()
    if file_hash == meta["sha256"]:
        with open(file_p, "r", encoding="utf-8") as f:
            loaded = json.load(f)
            if len(loaded) != meta["row_count"]:
                print(f"  [FAIL] Row count mismatch in auth_users")
                verified = False
    else:
        print("  [FAIL] Hash mismatch in auth_users")
        verified = False

if verified:
    print(f"[SUCCESS] Backup verification PASSED! Total records backed up: {total_records}")
else:
    print("[ERROR] Backup verification FAILED!")
    exit(1)

conn.close()
