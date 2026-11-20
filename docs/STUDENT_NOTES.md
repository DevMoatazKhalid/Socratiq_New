# My Notes — persistent student notes

A personal notes space for every student, available on every student page (classes, assignments, the SocratiQ AI chat and workspace).

## Experience
* **My Notes** button in the page header of every student page (icon-only on phones). It opens a side panel over the page: no navigation,
  the chat, streaming replies, the board and Live Voice keep working. The panel stays open (on the same note) when the student changes page.
* List (newest first) with search over titles and text, empty state, loading and error states.
* Editor: title + Markdown body (toolbar for bold, italic, heading, list, code) and a Preview (react-markdown, raw HTML skipped).
* Delete asks for confirmation inline.
* **Save to notes** under every finished SocratiQ AI reply stores the reply with its formatting (code fences included). Saving the same reply
  again returns the same note (client cache + server unique index).

## Auto-save guarantees (`frontend/src/lib/notes.ts`)
* Debounced (800 ms); states **Saving… / Saved / Save failed**. *Saved* appears only after the server confirmed the exact text on screen.
* One request per note at a time; edits made meanwhile are sent right after.
* Safe retries with backoff (1, 2, 5, 10, 30 s) on network/5xx/429. The note id is generated in the browser before the first save, so a retried
  create can never produce a second note; a retried update of the same text is answered as saved by the server.
* Concurrent edits (two tabs/devices) use optimistic versions: a stale save becomes a **conflict** (Keep my version / Use the saved version),
  never a silent overwrite. A note deleted elsewhere can be saved as a new note.
* Closing the panel or changing page flushes pending text; the sync engine is module-level, so saves continue after the panel unmounts.
  Leaving the site with unsaved text triggers the browser's "leave page?" prompt. localStorage is not used.

## API (`backend/app/routers/notes.py`, students only)
| Method | Path | |
|---|---|---|
| GET | `/api/v1/student/notes?q=` | summaries (title, 240-char preview, version, timestamps), newest first |
| GET | `/api/v1/student/notes/{id}` | full note |
| POST | `/api/v1/student/notes` | `{id, title, content, source_kind?, source_ref?}` → 201, or 200 for a replay / already-saved reply |
| PATCH | `/api/v1/student/notes/{id}` | `{base_version, title?, content?}` → note, or 409 `version_conflict` |
| DELETE | `/api/v1/student/notes/{id}` | 204 |
A note id that is not yours behaves exactly like one that does not exist (404). Limits: title 200, content 100 000 chars, 240 writes/min.

## Database (`database/migrations/018_student_notes.sql`, reverse: `database/migrations/down/018_student_notes.down.sql`)
`public.student_notes(note_id text PK 'note_<32 hex>', student_id, university_id, title, content, source_kind, source_ref, version, created_at, updated_at)`
* composite FK `(student_id, university_id) → students` ON DELETE CASCADE (same tenant rule as migration 009); `updated_at` trigger;
  index `(student_id, updated_at DESC)`; partial unique index `(student_id, source_kind, source_ref)` for Save-to-Notes.
* RLS enabled; ownership policies for SELECT, INSERT, UPDATE and DELETE (`student_id = app.current_user_id()`, writes also pin the university);
  only SELECT is granted to `authenticated` — the Data API stays read-only, as migration 013 requires — and nothing to `anon`.
  The backend (service connection) enforces ownership in every statement.

Apply: `python database/run_migrations.py` (it skips applied files). Roll back: back up the table, then
`psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f database/migrations/down/018_student_notes.down.sql`.
