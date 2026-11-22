import { useEffect, useSyncExternalStore } from "react"
import { api, ApiError } from "./api"

/** What the connected server supports (GET /capabilities). The frontend can be deployed ahead of the backend, and some features
 *  also need a database migration: knowing this lets pages say so plainly instead of showing empty tables or impossible numbers. */
export interface Capabilities {
  apiLevel: number
  features: { insights: boolean; notesBoard: boolean; assessment: boolean; courseIcons: boolean }
  migrations: Partial<Record<"notes_board" | "assessment" | "course_icons", string>>
}

/** `outdated`: the server predates /capabilities, so it also lacks insights, per-student grades and note organisation. */
export type ServerState = { status: "unknown" } | { status: "ok"; caps: Capabilities } | { status: "outdated" }

let state: ServerState = { status: "unknown" }
let inFlight = false
const listeners = new Set<() => void>()
const set = (s: ServerState) => { state = s; listeners.forEach((l) => l()) }

function load() {
  if (inFlight || state.status !== "unknown") return
  inFlight = true
  api<Capabilities>("/capabilities")
    .then((caps) => set({ status: "ok", caps }))
    .catch((e) => { if (e instanceof ApiError && e.status === 404) set({ status: "outdated" }) })   // other errors: stay unknown, retry later
    .finally(() => { inFlight = false })
}

export function useServerState(): ServerState {
  const s = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l) }, () => state, () => state)
  useEffect(load, [])
  return s
}

/** Plain-language list of what is unavailable and why, for the notice in the app shell. Empty when everything is available. */
export function missingFeatures(s: ServerState, role: "student" | "teacher"): { text: string; fix: string } | null {
  if (s.status === "outdated") {
    return {
      text: role === "teacher"
        ? "The server is running an older version of SocratiQ, so per-student grades, insights, grading status and note groups can't load yet."
        : "The server is running an older version of SocratiQ, so your grades overview and note groups can't load yet.",
      fix: "Redeploy the backend from the latest code, then run the database migrations.",
    }
  }
  if (s.status !== "ok") return null
  const f = s.caps.features
  const parts: [boolean, string, string | undefined][] = role === "teacher"
    ? [[f.notesBoard, "note groups and importance", s.caps.migrations.notes_board], [f.assessment, "AI grading drafts and Excel export", s.caps.migrations.assessment],
       [f.courseIcons, "course icons", s.caps.migrations.course_icons]]
    : [[f.notesBoard, "note groups, importance and pinning", s.caps.migrations.notes_board]]
  const missing = parts.filter(([ok]) => !ok)
  if (!missing.length) return null
  return {
    text: `Not available until the database is updated: ${missing.map(([, what]) => what).join(", ")}.`,
    fix: `Run ${missing.map(([, , m]) => m).filter(Boolean).join(", ")} with database/run_migrations.py.`,
  }
}
