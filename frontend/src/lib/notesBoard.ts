import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, ApiError } from "./api"
import { useNotesPanel, type NoteSummary } from "./notes"

/**
 * Notes board (approved "Notes board v2" design): the organisation layer on top of the existing notes API.
 * A note sits in at most one course (the course of the assignment it was saved from, or none), has an importance that is shown as the sticky-note
 * colour, can be pinned, and can be placed in any number of the student's own groups. All of it is stored by the backend
 * (migration 019 + /student/notes); older servers that do not send these fields simply show every note as "no course · no importance".
 */
export type Importance = "high" | "medium" | "low"

export interface BoardNote extends NoteSummary {
  courseId: string | null
  assignmentId: string | null
  importance: Importance | null
  pinned: boolean
  groupIds: string[]
}

export interface NoteGroup {
  id: string
  name: string
  /** A group can be attached to one assignment; otherwise it lives on the board only. Its notes can come from any course. */
  assignmentId: string | null
  createdAt: string
}

export interface NoteMetaPatch {
  importance?: Importance | null
  pinned?: boolean
  course_id?: string | null
  assignment_id?: string | null
  group_ids?: string[]
}

const enc = encodeURIComponent
export const NOTES_BOARD_KEY = ["notes", "board"] as const

function normalise(n: Partial<BoardNote> & NoteSummary): BoardNote {
  return { ...n, courseId: n.courseId ?? null, assignmentId: n.assignmentId ?? null, importance: n.importance ?? null, pinned: !!n.pinned, groupIds: n.groupIds ?? [] }
}

export function useNotesBoard(enabled = true) {
  const { rev } = useNotesPanel()   // bumped when a note is saved from elsewhere (Save to Notes, the drawer), so the board reloads
  return useQuery({
    queryKey: [...NOTES_BOARD_KEY, rev],
    enabled,
    staleTime: 10_000,
    queryFn: async () => {
      const r = await api<{ notes: (Partial<BoardNote> & NoteSummary)[]; groups?: NoteGroup[] }>("/student/notes")
      return { notes: r.notes.map(normalise), groups: r.groups ?? [] }
    },
  })
}

/** Importance, pinning, course link and group membership. These are organisation fields: they never conflict with text edits. */
export function useNoteMeta() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: string; patch: NoteMetaPatch }) => api<BoardNote>(`/student/notes/${enc(v.id)}/meta`, { method: "PATCH", body: v.patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTES_BOARD_KEY }),
  })
}

export function useCreateGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { name: string; assignment_id: string | null; note_ids: string[] }) => api<NoteGroup>("/student/notes/groups", { method: "POST", body: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTES_BOARD_KEY }),
  })
}

export function useDeleteGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api<void>(`/student/notes/groups/${enc(id)}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: NOTES_BOARD_KEY }),
  })
}

/** Creates a note with its organisation fields: the text goes through the existing (idempotent) create, the rest through /meta. */
/** Thrown when the note itself was saved but its organisation (importance, pin, course, groups) was not. */
export class NoteMetaError extends Error {
  note: BoardNote
  cause: unknown
  constructor(note: BoardNote, cause: unknown) {
    super(organiseErrorText(cause))
    this.note = note
    this.cause = cause
  }
}

/** A precise sentence for a failed organisation change (never a bare "Request failed"). */
export function organiseErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "notes_board_unavailable" || e.status === 404 || e.status === 405 || e.status === 503)
      return "The server can't store importance, pins, courses or groups yet. It needs the latest backend update and database migration 019."
    if (e.status === 401) return "Your session has expired. Sign in again and retry."
    if (e.status === 429) return "Too many changes at once. Wait a moment and try again."
    if (e.message && e.message !== "Request failed") return e.message
  }
  return "That change wasn't saved. Check your connection and try again."
}

/** Creates the note, then files it. Creating is idempotent (same id), so a retry after a failed filing never makes a second note. */
export async function createBoardNote(v: { id: string; title: string; content: string; meta: NoteMetaPatch }) {
  const created = normalise(await api<Partial<BoardNote> & NoteSummary>("/student/notes", { method: "POST", body: { id: v.id, title: v.title, content: v.content } }))
  const hasMeta = Object.values(v.meta).some((x) => x != null && !(Array.isArray(x) && x.length === 0) && x !== false)
  if (!hasMeta) return created
  try {
    return normalise(await api<Partial<BoardNote> & NoteSummary>(`/student/notes/${enc(created.id)}/meta`, { method: "PATCH", body: v.meta }))
  } catch (e) {
    throw new NoteMetaError(created, e)
  }
}

export const importanceLabel: Record<Importance, string> = { high: "High", medium: "Medium", low: "Low" }
