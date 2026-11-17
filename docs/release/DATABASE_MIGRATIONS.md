# Database migrations and deployment SQL

## Applied changes

**None to any real database.** All database work used a disposable local PostgreSQL 16.15 with pgvector 0.6.0.

## New migrations required by this release

**None.** The revision counter `scene_rev` is stored inside the existing `attempts.whiteboard` JSONB document (next to `scene`), so no schema change is needed. Existing rows without it are treated as revision 0, and legacy clients that never send `base_rev` keep last-write-wins behaviour.

## Existing migrations (verified, not changed)

All 17 migrations (`000_extensions.sql` ... `016_whiteboard_scene.sql`) were applied in order to a fresh scratch database with `python database/run_migrations.py --local-supabase-stub`; all applied cleanly. Do not assume a migration is applied in your environment merely because the file exists: check that migration 016 (3.5 MB scene backstop, replacing 015's 400 KB cap) is applied before enabling large native scenes.

## Deployment checklist (not performed)

1. Confirm migrations 001-016 are applied in the target database.
2. Set a Gemini key (`GEMINI_API_KEY`; the code also reads `GOOGLE_API_KEY`, `AI_DEFAULT_API_KEY` and `GOOGLE_AI_STUDIO_API_KEY_N`, and rotates to the next key on quota errors), `FILE_LINK_SECRET`, and explicit `CORS_ORIGINS`.
3. Do **not** set `GEMINI_API_BASE` / `GEMINI_LIVE_WS_BASE` in production (test-harness overrides).
4. Install Python requirements (`pillow>=13,<14` now required), `npm ci` in `frontend/` (adds pinned `acorn@8.14.0`).
5. Run the real-provider checks listed in `REAL_PROVIDER_AND_BLOCKED.md` before announcing voice/image/simulation generation as verified.
