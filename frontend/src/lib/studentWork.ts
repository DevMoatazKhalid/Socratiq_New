import { dueInfo, type DueInfo } from "./dates"
import type { StudentOverview } from "./queries"
import type { Assignment, AssignmentStatus, Course } from "@/types"

/** One assignment as the student's "My work" sees it: the learning loop step it is on and the one next action. */
export interface WorkRow {
  a: Assignment
  course: Course | undefined
  status: AssignmentStatus
  /** 1 Attempt · 2 Coach · 3 Submit · 4 Verify. `done` once verified. */
  step: number
  done: boolean
  coachTurns: number
  due: DueInfo
  grade: StudentOverview["assignments"][number]["grade"]
  verification: StudentOverview["assignments"][number]["verification"]
  action: { label: "Start" | "Continue" | "Verify" | "Open" | "View feedback"; to: string; primary: boolean }
  bucket: "todo" | "coach" | "verify" | "done"
}

export const workPath = (a: Pick<Assignment, "id" | "courseId">) => `/student/courses/${a.courseId}/assignments/${a.id}`

/**
 * The step is the NEXT thing to do in the project's learning loop. Not started: Attempt. In progress without coaching yet: Coach.
 * In progress after coaching: Submit. Submitted: Verify. Verified: all done.
 */
export function stepOf(status: AssignmentStatus, coachTurns: number): { step: number; done: boolean } {
  if (status === "verified") return { step: 4, done: true }
  if (status === "submitted") return { step: 4, done: false }
  if (status === "in_progress") return { step: coachTurns > 0 ? 3 : 2, done: false }
  return { step: 1, done: false }
}

export function workRows(assignments: Assignment[], courses: Course[], overview: StudentOverview | null | undefined,
  fallback?: Map<string, StudentOverview["assignments"][number]>): WorkRow[] {
  const byCourse = new Map(courses.map((c) => [c.id, c]))
  const extra = new Map(overview ? overview.assignments.map((x) => [x.assignmentId, x]) : [...(fallback ?? new Map()).entries()])
  return assignments.map((a) => {
    const x = extra.get(a.id)
    const status = (x?.status ?? a.status ?? "not_started") as AssignmentStatus
    const coachTurns = x?.coachTurns ?? 0
    const { step, done } = stepOf(status, coachTurns)
    const handedIn = status === "submitted" || status === "verified"
    const base = workPath(a)
    const action: WorkRow["action"] =
      status === "submitted" ? { label: "Verify", to: `${base}/verify`, primary: true }
        : status === "verified" ? (x?.grade ? { label: "View feedback", to: `${base}#grade`, primary: false } : { label: "Open", to: base, primary: false })
          : status === "in_progress" ? { label: "Continue", to: base, primary: false }
            : { label: "Start", to: base, primary: false }
    const bucket: WorkRow["bucket"] = done ? "done" : status === "submitted" ? "verify" : status === "in_progress" && coachTurns > 0 ? "coach" : "todo"
    return { a, course: byCourse.get(a.courseId), status, step, done, coachTurns, due: dueInfo(a.dueDate, handedIn), grade: x?.grade ?? null, verification: x?.verification ?? null, action, bucket }
  })
}

/** Open work first: what is overdue or due soonest, then work without a date; submitted work waiting for verification keeps its place by date. */
export function byWhatNeedsYou(a: WorkRow, b: WorkRow) {
  const rank = (r: WorkRow) => (r.status === "submitted" ? 0 : 0) + (r.due.time == null ? 1 : 0)
  const d = rank(a) - rank(b)
  if (d) return d
  return (a.due.time ?? Infinity) - (b.due.time ?? Infinity)
}

export const statusTone: Record<AssignmentStatus, "or" | "neu" | "info" | "ok"> = { in_progress: "or", submitted: "info", not_started: "neu", verified: "ok" }

/** "in 3 days" / "tomorrow" / "today" / "2 days late" for the small pill next to a due date; null when nothing urgent. */
export function duePill(r: WorkRow): { text: string; tone: "or" | "bad" } | null {
  if (r.done || r.status === "submitted" || r.due.time == null) return null
  const ms = r.due.time - Date.now()
  const day = 86_400_000
  if (ms < 0) {
    const late = Math.max(1, Math.floor(-ms / day))
    return { text: `${late} day${late === 1 ? "" : "s"} late`, tone: "bad" }
  }
  if (ms > 7 * day) return null
  const days = Math.round(ms / day)
  return { text: days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`, tone: "or" }
}

export const shortDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "2-digit" }) : "—"
