import { useSyncExternalStore } from "react"
import { api, ApiError } from "./api"

/**
 * Student notes: API + a small sync engine that owns every unsaved edit.
 *
 * The server is the only persistence: nothing is kept in localStorage. The engine lives at module level (not in a component), so an edit keeps
 * saving when the notes panel closes or the student moves to another page. Rules it guarantees:
 *  - "Saved" is shown only after the server confirmed THAT text (a response for older text does not count);
 *  - one request per note at a time; edits made meanwhile are saved right after;
 *  - retries are safe: a note is created with an id chosen here, so a retried create can never make a second note, and a retried update of the
 *    same text is answered as saved by the server;
 *  - an edit made elsewhere (other tab/device) is never overwritten silently: it becomes a conflict the student resolves;
 *  - leaving the page with unsaved text asks first.
 */

export interface Note {
  id: string
  title: string
  content: string
  version: number
  sourceKind?: "coach_message" | null
  sourceRef?: string | null
  createdAt: string
  updatedAt: string
  duplicate?: boolean
}

export interface NoteSummary {
  id: string
  title: string
  preview: string
  version: number
  sourceKind?: "coach_message" | null
  sourceRef?: string | null
  createdAt: string
  updatedAt: string
}

const enc = encodeURIComponent

export interface NotesApi {
  list(q?: string, signal?: AbortSignal): Promise<NoteSummary[]>
  get(id: string): Promise<Note>
  create(body: { id: string; title: string; content: string; source_kind?: "coach_message"; source_ref?: string }): Promise<Note>
  update(id: string, body: { base_version: number; title: string; content: string }): Promise<Note>
  remove(id: string): Promise<void>
}

export const notesApi: NotesApi = {
  list: async (q, signal) => (await api<{ notes: NoteSummary[] }>(`/student/notes${q?.trim() ? `?q=${enc(q.trim())}` : ""}`, { signal })).notes,
  get: (id) => api<Note>(`/student/notes/${enc(id)}`),
  create: (body) => api<Note>("/student/notes", { method: "POST", body }),
  update: (id, body) => api<Note>(`/student/notes/${enc(id)}`, { method: "PATCH", body }),
  remove: async (id) => {
    try {
      await api<void>(`/student/notes/${enc(id)}`, { method: "DELETE" })
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e        // already gone (a retried delete): that is the goal
    }
  },
}

export function newNoteId(): string {
  const hex = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "")
    : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("")
  return `note_${hex.toLowerCase()}`
}

export type SaveState = "saved" | "pending" | "saving" | "error" | "conflict" | "deleted_elsewhere"

export interface Draft {
  id: string
  title: string
  content: string
  /** server version this text is based on; null until the server has created the note */
  version: number | null
  state: SaveState
  error: string | null
  /** what the server holds for this note (the last confirmed save) */
  saved: { title: string; content: string } | null
  updatedAt: string
  createdAt: string
}

interface Internal extends Draft {
  timer: ReturnType<typeof setTimeout> | null
  inFlight: Promise<void> | null
  attempt: number
  waiters: (() => void)[]
}

export interface SyncOptions {
  debounceMs?: number
  retryDelaysMs?: number[]
  now?: () => string
}

const isTransient = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status === 429 || e.status >= 500

export class NotesSync {
  private notes = new Map<string, Internal>()
  private listeners = new Set<() => void>()
  private version = 0
  private readonly debounceMs: number
  private readonly retryDelays: number[]
  private readonly now: () => string
  private readonly client: NotesApi

  constructor(client: NotesApi = notesApi, opts: SyncOptions = {}) {
    this.client = client
    this.debounceMs = opts.debounceMs ?? 800
    this.retryDelays = opts.retryDelaysMs ?? [1000, 2000, 5000, 10000, 30000]
    this.now = opts.now ?? (() => new Date().toISOString())
  }

  // ---------------------------------------------------------------- subscription (useSyncExternalStore)
  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
  getVersion = () => this.version
  private emit() {
    this.version++
    this.listeners.forEach((fn) => fn())
  }

  draft(id: string): Draft | undefined {
    const n = this.notes.get(id)
    return n ? { ...n } : undefined
  }
  drafts(): Draft[] {
    return [...this.notes.values()].map((n) => ({ ...n }))
  }
  hasUnsaved(): boolean {
    return [...this.notes.values()].some((n) => n.state !== "saved")
  }

  // ---------------------------------------------------------------- lifecycle
  /** A new, empty note. It exists on the server only once something is typed (then it is created with this id). */
  createLocal(init: { title?: string; content?: string } = {}): Draft {
    const ts = this.now()
    const n: Internal = { id: newNoteId(), title: init.title ?? "", content: init.content ?? "", version: null, state: "saved", error: null, saved: null,
      updatedAt: ts, createdAt: ts, timer: null, inFlight: null, attempt: 0, waiters: [] }
    if (n.title || n.content) n.state = "pending"
    this.notes.set(n.id, n)
    this.emit()
    if (n.state === "pending") this.schedule(n, 0)
    return { ...n }
  }

  /** Make a server note editable here (no-op if there is already a local draft for it: unsaved text always wins over a refetch). */
  adopt(note: Note): Draft {
    const cur = this.notes.get(note.id)
    if (cur && cur.state !== "saved") return { ...cur }
    const n: Internal = { id: note.id, title: note.title, content: note.content, version: note.version, state: "saved", error: null,
      saved: { title: note.title, content: note.content }, updatedAt: note.updatedAt, createdAt: note.createdAt, timer: null, inFlight: null, attempt: 0, waiters: [] }
    if (cur) { n.waiters = cur.waiters }
    this.notes.set(note.id, n)
    this.emit()
    return { ...n }
  }

  edit(id: string, patch: { title?: string; content?: string }) {
    const n = this.notes.get(id)
    if (!n || n.state === "conflict" || n.state === "deleted_elsewhere") {
      if (n) { Object.assign(n, patch); this.emit() }         // keep typing locally; saving resumes once the student resolves it
      return
    }
    Object.assign(n, patch)
    n.updatedAt = this.now()
    if (n.saved && n.saved.title === n.title && n.saved.content === n.content) {
      if (!n.inFlight) { n.state = "saved"; this.clearTimer(n) }
    } else {
      n.state = n.inFlight ? "saving" : "pending"
      n.error = null
      n.attempt = 0
      this.schedule(n, this.debounceMs)
    }
    this.emit()
  }

  /** Save now (closing the panel, leaving a note). Resolves when this note has nothing unsent (saved, or failed and still retrying). */
  flush(id: string): Promise<void> {
    const n = this.notes.get(id)
    if (!n) return Promise.resolve()
    if (n.state === "pending" || (n.state === "error" && !n.inFlight)) {
      this.clearTimer(n)
      void this.save(n)
    }
    if (!n.inFlight) return Promise.resolve()
    return new Promise((resolve) => n.waiters.push(resolve))
  }

  flushAll(): Promise<void> {
    return Promise.all([...this.notes.keys()].map((id) => this.flush(id))).then(() => undefined)
  }

  /** Forget a draft that is saved (for example after deleting the note). */
  forget(id: string) {
    const n = this.notes.get(id)
    if (n) this.clearTimer(n)
    this.notes.delete(id)
    this.emit()
  }

  async remove(id: string) {
    const n = this.notes.get(id)
    if (n) this.clearTimer(n)
    if (n?.inFlight) await n.inFlight.catch(() => undefined)
    const created = n ? n.version !== null : true
    if (created) await this.client.remove(id)
    this.forget(id)
  }

  // ---------------------------------------------------------------- conflict resolution
  /** Keep the text typed here: save it on top of whatever the server has now. */
  async keepMine(id: string) {
    const n = this.notes.get(id)
    if (!n) return
    try {
      const server = await this.client.get(id)
      n.version = server.version
      n.saved = { title: server.title, content: server.content }
      n.state = "pending"
      n.error = null
      this.emit()
      await this.save(n)
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return this.saveAsNew(id)
      n.error = e instanceof ApiError ? e.message : "Couldn't reach the server."
      this.emit()
    }
  }

  /** Throw away the text typed here and load what the server holds. */
  async useSaved(id: string) {
    const server = await this.client.get(id)
    const n = this.notes.get(id)
    if (n) { this.clearTimer(n); n.state = "saved" }
    this.adopt(server)
  }

  /** The note was deleted elsewhere: keep the text typed here as a brand-new note. */
  saveAsNew(id: string): Draft | undefined {
    const n = this.notes.get(id)
    if (!n) return undefined
    this.forget(id)
    return this.createLocal({ title: n.title, content: n.content })
  }

  // ---------------------------------------------------------------- saving
  private clearTimer(n: Internal) {
    if (n.timer) clearTimeout(n.timer)
    n.timer = null
  }

  private schedule(n: Internal, ms: number) {
    this.clearTimer(n)
    if (n.inFlight) return                     // the in-flight save re-checks for newer text when it finishes
    n.timer = setTimeout(() => { n.timer = null; void this.save(n) }, ms)
  }

  private save(n: Internal): Promise<void> {
    if (n.inFlight) return n.inFlight
    const snapshot = { title: n.title, content: n.content }
    n.state = "saving"
    this.emit()
    const run = (async () => {
      try {
        const res = n.version === null
          ? await this.client.create({ id: n.id, ...snapshot })
          : await this.client.update(n.id, { base_version: n.version, ...snapshot })
        if (!this.notes.has(n.id)) return
        n.version = res.version
        n.saved = { title: res.title, content: res.content }
        n.createdAt = res.createdAt
        n.attempt = 0
        n.error = null
      } catch (e) {
        if (!this.notes.has(n.id)) return
        if (e instanceof ApiError && e.code === "version_conflict") {
          n.state = "conflict"
          n.error = "This note was changed in another tab or device."
          return
        }
        if (e instanceof ApiError && e.status === 404 && n.version !== null) {
          n.state = "deleted_elsewhere"
          n.error = "This note was deleted somewhere else."
          return
        }
        if (e instanceof ApiError && e.code === "id_conflict") {   // practically impossible (random 128-bit id): pick another and retry
          const old = n.id
          n.id = newNoteId()
          this.notes.delete(old)
          this.notes.set(n.id, n)
        }
        n.state = "error"
        n.error = e instanceof ApiError && !isTransient(e) ? e.message : "Couldn't save. Retrying…"
        if (isTransient(e) || (e instanceof ApiError && e.code === "id_conflict")) {
          const delay = this.retryDelays[Math.min(n.attempt, this.retryDelays.length - 1)]
          n.attempt++
          n.timer = setTimeout(() => { n.timer = null; void this.save(n) }, delay)
        }
        return
      } finally {
        n.inFlight = null
      }
      // success: is what the student sees now exactly what the server confirmed?
      if (n.title === snapshot.title && n.content === snapshot.content) {
        n.state = "saved"
      } else {
        n.state = "pending"
        this.schedule(n, 0)
      }
    })()
    n.inFlight = run
    void run.finally(() => {
      this.emit()
      if (!n.inFlight && (n.state === "saved" || n.state === "error" || n.state === "conflict" || n.state === "deleted_elsewhere")) {
        const w = n.waiters.splice(0)
        w.forEach((fn) => fn())
      }
    })
    return run
  }
}

export const notesSync = new NotesSync()

// Leaving the page (closing the tab, reloading) with text the server does not have yet asks first.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (e) => {
    if (notesSync.hasUnsaved()) {
      void notesSync.flushAll()
      e.preventDefault()
      e.returnValue = ""
    }
  })
}

export function useNotesSync(sync: NotesSync = notesSync) {
  useSyncExternalStore(sync.subscribe, sync.getVersion, sync.getVersion)
  return sync
}

// ---------------------------------------------------------------- panel state (survives page changes: the AppShell remounts per page)
type PanelState = { open: boolean; noteId: string | null; /** bumped when notes change outside the panel (Save to Notes), so the list reloads */ rev: number }
let panel: PanelState = { open: false, noteId: null, rev: 0 }
const panelListeners = new Set<() => void>()
export const notesPanel = {
  get: () => panel,
  set(next: Partial<PanelState>) {
    panel = { ...panel, ...next }
    panelListeners.forEach((fn) => fn())
  },
  subscribe(fn: () => void) {
    panelListeners.add(fn)
    return () => { panelListeners.delete(fn) }
  },
}
export function useNotesPanel(): PanelState {
  return useSyncExternalStore(notesPanel.subscribe, notesPanel.get, notesPanel.get)
}

// ---------------------------------------------------------------- "Save to Notes" from a Coach reply
const savedSources = new Map<string, Promise<Note>>()
/** Saves a Coach reply once. Repeated clicks (or a retry after a dropped response) return the same note: the server deduplicates on the reply id. */
export function saveCoachReply(ref: string, title: string, content: string, client: NotesApi = notesApi): Promise<Note> {
  const cached = savedSources.get(ref)
  if (cached) return cached
  const id = newNoteId()
  const p = (async () => {
    let lastErr: unknown
    for (let i = 0; i < 3; i++) {
      try {
        return await client.create({ id, title, content, source_kind: "coach_message", source_ref: ref })
      } catch (e) {
        lastErr = e
        if (!isTransient(e)) break
        await new Promise((r) => setTimeout(r, 400 * (i + 1)))
      }
    }
    throw lastErr
  })()
  savedSources.set(ref, p)
  p.catch(() => savedSources.delete(ref))
  return p
}

export function titleFrom(content: string, fallback = "Untitled note"): string {
  const line = content.split("\n").map((l) => l.replace(/^[#>*\-\s`]+/, "").trim()).find(Boolean)
  if (!line) return fallback
  return line.length > 80 ? `${line.slice(0, 77)}…` : line
}
