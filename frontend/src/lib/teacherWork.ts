import type { Dashboard, TeacherInsights } from "./queries"

export type ReviewCategory = "grade" | "support" | "verification" | "other"
export const categoryLabel: Record<ReviewCategory, string> = { grade: "Pending grading", support: "Learning support", verification: "Verification", other: "Other" }
/** Short label used in the Overview "Needs attention" table (approved design). */
export const shortLabel: Record<ReviewCategory, string> = { grade: "Grade", support: "Support", verification: "Inspect", other: "Follow up" }

export interface ReviewRow {
  key: string
  category: ReviewCategory
  studentId: string | null
  studentName: string
  assignmentId: string | null
  assignmentTitle: string
  reason: string
  grade: number | null
  submission: "Submitted" | "Graded" | "Missing" | null
  lastActivity: string | null
  signals: number
  signalReason: string | null
  action: { label: "Grade" | "Review" | "Open"; to: string }
}

const ago = (iso: string) => {
  const h = (Date.now() - Date.parse(iso)) / 3_600_000
  return h < 1 ? `${Math.max(1, Math.round(h * 60))}m ago` : h < 24 ? `${Math.round(h)}h ago` : Math.round(h / 24) === 1 ? "yesterday" : `${Math.round(h / 24)}d ago`
}

export const gradeLink = (courseId: string, assignmentId: string, studentId?: string) =>
  `/teacher/grade?course=${encodeURIComponent(courseId)}&assignment=${encodeURIComponent(assignmentId)}${studentId ? `&student=${encodeURIComponent(studentId)}` : ""}`

/**
 * One list for grading and review (approved "Grading & review"): submissions waiting for a grade, students who need learning support,
 * verification results worth inspecting, and other follow-ups. Built only from rows the API returns; nothing is inferred here.
 */
export function reviewRows(courseId: string, dash: Dashboard | undefined, ins: TeacherInsights | null | undefined): ReviewRow[] {
  if (!dash) return []
  const byStudent = new Map(dash.students.map((s) => [s.id, s]))
  const signalsOf = (id: string | null) => (id ? byStudent.get(id)?.observedSignalCount ?? 0 : 0)
  const reasonOf = (id: string | null) => (id ? byStudent.get(id)?.risk.primaryReason ?? null : null)
  const rows: ReviewRow[] = []
  for (const s of ins?.submissions ?? []) {
    if (s.grade) continue
    const bits = [`Submitted ${ago(s.submittedAt)}`]
    if (s.attemptNumber > 1) bits.push(`${s.attemptNumber - 1} revision${s.attemptNumber === 2 ? "" : "s"}`)
    if (!s.verification || s.verification.status !== "COMPLETED") bits.push("verification pending")
    rows.push({ key: `g:${s.studentId}:${s.assignmentId}`, category: "grade", studentId: s.studentId, studentName: s.studentName, assignmentId: s.assignmentId,
      assignmentTitle: s.assignmentTitle, reason: bits.join(" · "), grade: null, submission: "Submitted", lastActivity: s.submittedAt,
      signals: signalsOf(s.studentId), signalReason: reasonOf(s.studentId), action: { label: "Grade", to: gradeLink(courseId, s.assignmentId, s.studentId) } })
  }
  const latestGrade = (studentId: string, assignmentId: string | null) =>
    assignmentId ? ins?.submissions.find((x) => x.studentId === studentId && x.assignmentId === assignmentId) : undefined
  for (const q of dash.reviewQueue) {
    const sub = latestGrade(q.studentId, q.assignmentId)
    const category: ReviewCategory = q.kind === "learning_support" ? "support" : q.focus === "verification" ? "verification" : "other"
    rows.push({ key: `q:${q.studentId}`, category, studentId: q.studentId, studentName: q.name, assignmentId: q.assignmentId, assignmentTitle: q.assignmentTitle ?? "—",
      reason: q.primaryReason ?? "Review indicator", grade: sub?.grade?.percentage ?? null, submission: sub ? (sub.grade ? "Graded" : "Submitted") : null,
      lastActivity: q.lastActivityAt, signals: signalsOf(q.studentId), signalReason: reasonOf(q.studentId),
      action: q.assignmentId ? { label: "Review", to: gradeLink(courseId, q.assignmentId, q.studentId) } : { label: "Open", to: `/teacher/students/${q.studentId}` } })
  }
  for (const a of dash.attention.filter((x) => x.kind === "deadline")) {
    rows.push({ key: `d:${a.id}`, category: "other", studentId: null, studentName: "Students not yet submitted", assignmentId: null, assignmentTitle: a.title.replace(/ is due soon$/, ""),
      reason: a.description, grade: null, submission: "Missing", lastActivity: null, signals: 0, signalReason: null, action: { label: "Open", to: a.to } })
  }
  const order: Record<ReviewCategory, number> = { grade: 0, verification: 1, support: 2, other: 3 }
  return rows.sort((a, b) => order[a.category] - order[b.category] || (a.lastActivity ?? "").localeCompare(b.lastActivity ?? ""))
}

export const categoryTone: Record<ReviewCategory, "or" | "warn" | "bad" | "neu"> = { grade: "or", support: "warn", verification: "warn", other: "neu" }

export function signalTone(n: number): "ok" | "or" | "warn" | "bad" {
  return n === 0 ? "ok" : n === 1 ? "or" : n === 2 ? "warn" : "bad"
}
