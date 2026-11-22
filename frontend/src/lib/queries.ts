import { useMemo } from "react"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { api, ApiError, apiBlob, apiStream, upload } from "./api"
import type { Board, BoardReport } from "./whiteboard"
import { useAuth } from "./auth"
import type {
  ActivityEntry, AttentionItem, Assignment, AssignmentStatus, Capabilities, ChatMessage, Course, DashboardOverview, EvidenceEntry, FileInfo, LearningSignal, Material, ReviewQueueRow,
  RiskAssessment, Role, StudentDetailInfo, StudentRow, SubmissionRow,
} from "@/types"

const enc = encodeURIComponent

// ================================================================== shared
export function useCourses(role: Role) {
  const { status } = useAuth()
  return useQuery({
    queryKey: [role, "courses"],
    enabled: status === "ready",
    queryFn: async () => (await api<{ courses: Course[] }>(`/${role}/courses`)).courses,
  })
}

export function useCapabilities(purpose: "MATERIAL" | "ASSIGNMENT_ATTACHMENT" | "SUBMISSION", role?: "PROMPT" | "SUPPORTING") {
  return useQuery({
    queryKey: ["capabilities", purpose, role],
    staleTime: 10 * 60_000,
    queryFn: () => api<Capabilities>(`/files/capabilities?purpose=${purpose}${role ? `&role=${role}` : ""}`),
  })
}

export async function downloadFile(fileId: string) {
  const link = await api<{ url: string; filename: string }>(`/files/${enc(fileId)}/download-link`, { method: "POST" })
  window.open(link.url, "_blank", "noopener")
}

/** `teacherCodeRequired`: the API client camelCases keys, so the server's `teacher_code_required` arrives under this name. */
export interface Universities { universities: { id: string; name: string }[]; teacherCodeRequired?: boolean }
export const fetchUniversities = () => api<Universities>("/universities", { auth: false })

// ================================================================== student
export const studentKeys = { all: ["student"] as const }

export function useStudentHome() {
  return useQuery({ queryKey: ["student", "home"], queryFn: () => api<{ user: { id: string; name: string }; courses: Course[]; assignments: Assignment[] }>("/student/home") })
}

// ------------------------------------------------------------------ progress & insights (additive endpoints; see backend/app/insights.py)
/** One week of a trend line. Each value is null when there was nothing to measure that week (never a made-up zero). */
export interface TrendPoint { weekStart: string; averageGrade: number | null; completion: number | null; verificationSuccess: number | null }

export interface StudentOverview {
  kpis: {
    courses: number; assignments: number; submitted: number; graded: number; awaitingGrade: number; averageGrade: number | null
    verificationsPassed: number; verificationsTotal: number; verificationsReady: number; dueThisWeek: number
    next: { assignmentId: string; courseId: string; title: string; dueAt: string } | null
  }
  /** Percentage-point change against 30 days earlier; null when there is no earlier value to compare with. */
  deltas: { completion: number | null; averageGrade: number | null }
  trend: TrendPoint[]
  courses: { courseId: string; done: number; total: number; averageGrade: number | null; verificationPassed: number; verificationTotal: number
    nextDue: { assignmentId: string; title: string; dueAt: string } | null }[]
  assignments: { assignmentId: string; courseId: string; status: AssignmentStatus; coachTurns: number; submittedAt: string | null
    grade: { percentage: number; gradedAt: string; feedback: string | null } | null
    verification: { passed: number; total: number; status: string } | null }[]
}

export interface TeacherInsights {
  trend: TrendPoint[]
  deltas: { students: number | null; completion: number | null; averageGrade: number | null; verificationSuccess: number | null }
  grades: { graded: number; awaiting: number; highest: number | null; lowest: number | null; distribution: { bucket: string; count: number }[] }
  assignments: { id: string; title: string; lifecycle: "DRAFT" | "PUBLISHED" | "ARCHIVED"; dueAt: string | null; maxScore: number | null; students: number; submitted: number
    graded: number; averageGrade: number | null; verificationRate: number | null }[]
  /** Per enrolled student. Averages use graded work only; ungraded work is never counted as 0. */
  students: { id: string; averageGrade: number | null; graded: number; submitted: number; awaiting: number; verificationRate: number | null; recentGrades: number[] }[]
  /** Each student's latest submission per assignment in this course. */
  submissions: { studentId: string; studentName: string; assignmentId: string; assignmentTitle: string; attemptNumber: number; submittedAt: string
    grade: { percentage: number; gradedAt: string } | null; verification: { status: string; outcome: string | null; passed: number; total: number } | null }[]
  signals: { byType: { signal: string; label: string; students: number }[]; byLevel: { none: number; one: number; two: number; threePlus: number } }
  coachWeekly: { weekStart: string; turns: number }[]
  /** Verified mastery per concept across the class (verification results only). */
  concepts: { name: string; mastery: number | null; level: "Strong" | "Moderate" | "Weak" | null; assignments: number }[]
  /** Class activity in the selected period, newest first. */
  activity: (ActivityEntry & { studentId?: string; studentName?: string })[]
}

/** A server that predates these endpoints answers 404: the pages then show their "not enough data yet" states instead of an error. */
async function optional<T>(path: string): Promise<T | null> {
  try {
    return await api<T>(path)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null
    throw e
  }
}

export function useStudentOverview(weeks = 8) {
  return useQuery({ queryKey: ["student", "overview", weeks], queryFn: () => optional<StudentOverview>(`/student/overview?weeks=${weeks}`) })
}

export function useTeacherInsights(courseId?: string, weeks = 8) {
  return useQuery({ queryKey: ["teacher", "insights", courseId, weeks], enabled: !!courseId, queryFn: () => optional<TeacherInsights>(`/teacher/courses/${enc(courseId!)}/insights?weeks=${weeks}`) })
}

export function useStudentCourse(courseId?: string) {
  return useQuery({
    queryKey: ["student", "course", courseId], enabled: !!courseId,
    queryFn: () => api<{ course: Course; materials: Material[]; assignments: Assignment[] }>(`/student/courses/${enc(courseId!)}`),
  })
}

export function useStudentMaterial(id?: string) {
  return useQuery({ queryKey: ["student", "material", id], enabled: !!id, queryFn: () => api<Material>(`/student/materials/${enc(id!)}`) })
}

export interface StudentAssignmentDetail extends Assignment {
  attempt: { id: string; attemptNumber: number; status: string; startedAt: string; draftText?: string | null } | null
  submission: { id: string; type: string; submittedAt: string; filename?: string | null } | null
  verification: { id: string; status: string; outcome?: string | null } | null
  grade: Grade | null
}

/** The one persisted grade: the teacher review page and the student's assignment page both render exactly this. */
export interface GradeCriterion { id: string; title: string; pointsAwarded: number; pointsPossible: number; level: CriterionLevel | null; comment?: string }
export type CriterionLevel = "excellent" | "proficient" | "developing" | "beginning" | "missing"
export interface Grade {
  score: number; maxScore: number; percentage: number; feedback: string | null; gradedAt: string; gradedBy: string | null
  /** manual | ai (an AI draft released unchanged) | ai_edited (an AI draft the instructor changed). Absent on servers before migration 020. */
  source?: "manual" | "ai" | "ai_edited"
  /** false only for an AI grade released automatically that no instructor has looked at yet */
  reviewed?: boolean
  /** per-criterion breakdown for rubric grades; empty for one overall score */
  criteria?: GradeCriterion[]
}

export function useStudentAssignment(id?: string) {
  return useQuery({ queryKey: ["student", "assignment", id], enabled: !!id, queryFn: () => api<StudentAssignmentDetail>(`/student/assignments/${enc(id!)}`) })
}

/**
 * Grades of handed-in work for servers without /student/overview (older backend). Reads each handed-in assignment from the long-standing
 * assignment endpoint (same cache as the assignment page), so "Finished & graded" and course averages still show real grades.
 * Returns undefined while the overview itself decides; an empty map when nothing is needed.
 */
export function useFallbackGrades(assignments: Assignment[] | undefined, overview: StudentOverview | null | undefined) {
  const need = overview === null ? (assignments ?? []).filter((a) => a.status === "submitted" || a.status === "verified").slice(0, 40) : []
  const results = useQueries({
    queries: need.map((a) => ({ queryKey: ["student", "assignment", a.id], staleTime: 30_000, queryFn: () => api<StudentAssignmentDetail>(`/student/assignments/${enc(a.id)}`) })),
  })
  const stamp = need.map((a, i) => `${a.id}:${results[i]?.dataUpdatedAt ?? 0}`).join(",")
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const map = useMemo(() => buildFallback(need, results.map((r) => r.data)), [stamp])
  return { map, loading: results.some((r) => r.isPending) }
}

function buildFallback(need: Assignment[], data: (StudentAssignmentDetail | undefined)[]) {
  const map = new Map<string, StudentOverview["assignments"][number]>()
  data.forEach((d, i) => {
    if (!d) return
    map.set(need[i].id, {
      assignmentId: need[i].id, courseId: need[i].courseId, status: need[i].status ?? "submitted", coachTurns: 0, submittedAt: d.submission?.submittedAt ?? null,
      grade: d.grade ? { percentage: d.grade.percentage, gradedAt: d.grade.gradedAt, feedback: d.grade.feedback } : null,
      verification: null,
    })
  })
  return map
}

export function useJoinCourse() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (code: string) => api<Course>("/student/courses/join", { method: "POST", body: { code } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["student"] }).then(() => qc.invalidateQueries({ queryKey: ["student", "courses"] })),
  })
}

export function useStartAttempt() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (assignmentId: string) => api<{ id: string }>(`/student/assignments/${enc(assignmentId)}/attempts`, { method: "POST" }),
    onSuccess: (_d, assignmentId) => qc.invalidateQueries({ queryKey: ["student", "assignment", assignmentId] }),
  })
}

export interface SubmitResult { submissionId: string; textExtracted?: boolean; warning?: string; file?: FileInfo }

export function useSubmitFile(assignmentId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ attemptId, file, onProgress }: { attemptId: string; file: File; onProgress?: (p: number) => void }) => {
      const form = new FormData()
      form.append("file", file)
      return upload<SubmitResult>(`/student/attempts/${enc(attemptId)}/submit-file`, form, onProgress)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["student"] }),
    meta: { assignmentId },
  })
}

export function useCoachHistory(assignmentId?: string) {
  return useQuery({
    queryKey: ["student", "coach", assignmentId], enabled: !!assignmentId,
    queryFn: async () => (await api<{ messages: ChatMessage[] }>(`/student/assignments/${enc(assignmentId!)}/coach`)).messages,
  })
}

/** A visual the COACH decided to place on the board. `grant` is the server's single-use permission to draw exactly this plan; the page cannot make one. */
export interface CoachVisual { grant: string; kind: "diagram" | "simulation"; request: string; why: string; explorePrompt: string; concept?: string | null; interactionId: string }
export interface CoachReply {
  interactionId: string
  turn: number
  message: ChatMessage
  sources: { documentTitle?: string; pageNumber?: number; section?: string }[]
  /** present only when the Coach wrote on the board (or a board command ran): the board AS STORED after the turn + what was applied/rejected */
  board?: Partial<Board> & { report: BoardReport }
  /** present only when the Coach decided a diagram or simulation would help and the server validated and granted it */
  visual?: CoachVisual
  /** true when this is the stored reply to a message that was already processed (a retry): nothing new was generated or written */
  replayed?: boolean
  timings?: { totalMs: number; contextMs: number; graphMs: number; persistMs: number; firstTextMs: number | null; providerMs: number; localMs: number }
}
export interface CoachSend { assignmentId: string; message: string; mode?: "chat" | "board"; selectedId?: string | null; boardIntent?: string; /** this page can display a Coach visual (it only enables the possibility; the server decides) */ visuals?: boolean; /** idempotency key for THIS message; reuse it when retrying the same message */ clientTurnId?: string }
/** Streaming turn (same server logic as /ai/coach). `onStage` receives real pipeline steps. */
export function sendCoachStream(v: CoachSend, onStage: (label: string) => void, signal?: AbortSignal, onDelta?: (text: string) => void) {
  const body: Record<string, unknown> = { assignment_id: v.assignmentId, message: v.message, mode: v.mode ?? "chat" }
  if (v.selectedId) body.selected_id = v.selectedId
  if (v.boardIntent) body.board_intent = v.boardIntent
  if (v.visuals) body.visuals = true
  if (v.clientTurnId) body.client_turn_id = v.clientTurnId
  return apiStream<CoachReply>("/ai/coach/stream", body, (label) => onStage(label), signal, onDelta)
}
// ---- teaching personas (the choice is stored server-side and applies to Chat, Board and Live Voice alike)
/** The server's public persona view is the single source of truth for names and descriptions. `ar` is delivered by the API but the application UI is
 *  English-only, so it is intentionally never rendered. `socratic` ("high" | "medium") summarises how much the persona leads with questions. */
export interface PersonaInfo { id: string; version: number; name: { en: string; ar?: string }; tagline: { en: string; ar?: string }; description: { en: string; ar?: string }; tone: string; formality: string; socratic?: string; visual?: string }
export interface PersonaState { personas: PersonaInfo[]; selected: { id: string; version: number }; default: string }
export function usePersonas() {
  return useQuery({ queryKey: ["student", "personas"], queryFn: () => api<PersonaState>("/student/teaching-personas"), staleTime: 5 * 60_000 })
}
export function useSetPersona() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { personaId: string; assignmentId?: string }) => api<PersonaState>("/student/teaching-personas", { method: "PUT", body: { persona_id: v.personaId, ...(v.assignmentId ? { assignment_id: v.assignmentId } : {}) } }),
    onMutate: async (v) => {          // the selector reflects the choice immediately and rolls back if the server refuses it
      await qc.cancelQueries({ queryKey: ["student", "personas"] })
      const prev = qc.getQueryData<PersonaState>(["student", "personas"])
      if (prev) qc.setQueryData<PersonaState>(["student", "personas"], { ...prev, selected: { id: v.personaId, version: prev.personas.find((p) => p.id === v.personaId)?.version ?? 1 } })
      return { prev }
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(["student", "personas"], ctx.prev) },
    onSuccess: (d) => qc.setQueryData(["student", "personas"], d),
  })
}
export function useSendCoach() {
  return useMutation({ mutationFn: (v: { assignmentId: string; message: string }) => api<CoachReply>("/ai/coach", { method: "POST", body: { assignment_id: v.assignmentId, message: v.message } }) })
}

export interface VerificationState {
  verificationId: string
  status: "IN_PROGRESS" | "COMPLETED" | "ABANDONED"
  outcome?: string | null
  steps: { type: "EXPLAIN" | "MODIFY" | "TRANSFER"; status: "done" | "current" | "upcoming" }[]
  current: { questionId: string; type: string; question: string; index: number } | null
  needsQuestion: boolean
}
export function useStartVerification() {
  return useMutation({ mutationFn: (assignmentId: string) => api<VerificationState>(`/student/assignments/${enc(assignmentId)}/verification`, { method: "POST" }) })
}
export function useAnswerVerification() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { verificationId: string; answer: string }) =>
      api<{ result: { outcome: string; feedback: string }; completed: boolean; state: VerificationState }>(`/student/verification/${enc(v.verificationId)}/response`, { method: "POST", body: { answer: v.answer } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["student"] }),
  })
}

// ================================================================== teacher
export function useTeacherCourse(courseId?: string) {
  return useQuery({
    queryKey: ["teacher", "course", courseId], enabled: !!courseId,
    // materials are still being processed -> poll until every file has settled
    refetchInterval: (q) => (q.state.data?.materials.some((m) => m.file && ["QUEUED", "PROCESSING"].includes(m.file.status)) ? 2500 : false),
    queryFn: () => api<{ course: Course; classrooms: { id: string; name: string; joinCode: string; joinEnabled: boolean }[]; materials: Material[];
      assignments: (Assignment & { submittedCount: number; studentCount: number })[] }>(`/teacher/courses/${enc(courseId!)}`),
  })
}

function attentionTo(courseId: string, t: { type: string; assignmentId?: string; studentId?: string }): string {
  if (t.type === "submission") return `/teacher/courses/${courseId}/assignments/${t.assignmentId}/submissions/${t.studentId}`
  if (t.type === "student") return `/teacher/students/${t.studentId}`
  return `/teacher/courses/${courseId}/assignments/${t.assignmentId}`
}

export interface Dashboard {
  course: Course
  overview: DashboardOverview
  reviewQueue: ReviewQueueRow[]
  riskDisclaimer: string
  metrics: { assignmentCompletion: number; averageGrade: number | null; socraticAiUsage: number; observedSignalRate: number; verificationRate: number }
  students: StudentRow[]
  attention: AttentionItem[]
  activity: ActivityEntry[]
}
export function useDashboard(courseId?: string) {
  return useQuery({
    queryKey: ["teacher", "dashboard", courseId], enabled: !!courseId,
    queryFn: async (): Promise<Dashboard> => {
      const d = await api<Omit<Dashboard, "attention"> & { attention: (Omit<AttentionItem, "to"> & { target: { type: string; assignmentId?: string; studentId?: string } })[] }>(`/teacher/courses/${enc(courseId!)}/dashboard`)
      return { ...d, attention: d.attention.map(({ target, ...a }) => ({ ...a, to: attentionTo(courseId!, target) })) }
    },
  })
}

export function useTeacherStudent(studentId?: string) {
  return useQuery({ queryKey: ["teacher", "student", studentId], enabled: !!studentId, queryFn: () => api<StudentDetailInfo>(`/teacher/students/${enc(studentId!)}`) })
}

export interface TeacherAssignmentDetail extends Assignment {
  submissions: SubmissionRow[]
  linkedMaterials: { id: string; title: string }[]
  concepts: string[]
  counts: { students: number; submitted: number; verified: number }
}
export function useTeacherAssignment(id?: string) {
  return useQuery({
    queryKey: ["teacher", "assignment", id], enabled: !!id,
    refetchInterval: (q) => (q.state.data?.attachments?.some((a) => ["QUEUED", "PROCESSING"].includes(a.status)) ? 2500 : false),
    queryFn: () => api<TeacherAssignmentDetail>(`/teacher/assignments/${enc(id!)}`),
  })
}

export interface SubmissionReviewData {
  assignment: { id: string; title: string; version: number }
  /** assessment (migration 020); null/empty on older servers */
  grading?: GradingSettings | null
  evaluation?: GradeEvaluation | null
  gradeHistory?: GradeHistoryEntry[]
  student: { id: string; name: string; email: string }
  attempt: { id: string; number: number; status: string; assignmentVersion: number } | null
  submission: { id: string; type: string; submittedAt: string; textPreview: string; textTruncated: boolean; file: FileInfo | null } | null
  verification: { id: string; status: string; outcome?: string | null; entries: (EvidenceEntry & { outcome?: string | null; feedback?: string | null })[] } | null
  grade: Grade | null
  whiteboard: Partial<Board> | null
  coachInteractions: number
  signals: LearningSignal[]
  signalsNote: string
  risk: RiskAssessment
}
export function useSubmissionReview(assignmentId?: string, studentId?: string) {
  return useQuery({
    queryKey: ["teacher", "review", assignmentId, studentId], enabled: !!assignmentId && !!studentId,
    queryFn: () => api<SubmissionReviewData>(`/teacher/assignments/${enc(assignmentId!)}/students/${enc(studentId!)}`),
  })
}

/** Holistic (score + maxScore) or per rubric criterion. `evaluationId` = the AI draft this grade is based on (the server records whether it was changed). */
export interface GradeInput { score?: number; maxScore?: number; feedback: string; criteria?: { id: string; points: number; comment?: string }[]; evaluationId?: string | null }

export function useSetGrade(assignmentId: string, studentId: string) {
  const qc = useQueryClient()
  const done = () => Promise.all([qc.invalidateQueries({ queryKey: ["teacher"] }), qc.invalidateQueries({ queryKey: ["student", "assignment", assignmentId] })])
  const base = `/teacher/assignments/${enc(assignmentId)}/students/${enc(studentId)}/grade`
  return {
    save: useMutation({
      mutationFn: (v: GradeInput) => api<{ grade: Grade }>(base, { method: "PUT", body: {
        ...(v.criteria ? { criteria: v.criteria.map((c) => ({ id: c.id, points: c.points, ...(c.comment?.trim() ? { comment: c.comment.trim() } : {}) })) } : { score: v.score, max_score: v.maxScore }),
        feedback: v.feedback || null, ...(v.evaluationId ? { evaluation_id: v.evaluationId } : {}) } }),
      onSuccess: done,
    }),
    clear: useMutation({ mutationFn: () => api<{ grade: null }>(base, { method: "DELETE" }), onSuccess: done }),
  }
}

// ------------------------------------------------------------------ assessment: rubric, AI grading drafts, release (migration 020)
export type AiGradingMode = "off" | "review" | "auto_release"
export interface RubricCriterion { id: string; title: string; description: string; points: number }
export interface GradingSettings {
  assignmentId: string; aiGrading: AiGradingMode; pointsPossible: number; rubric: RubricCriterion[]; rubricSource: "none" | "teacher" | "ai"
  updatedAt: string | null; referenceAnswer?: string; gradingNotes?: string
}
export interface GradingFlag { code: string; message: string; severity: "info" | "review" | "block" }
export interface EvaluationCriterion { id: string; title: string; pointsAwarded: number; pointsPossible: number; level: CriterionLevel; rationale: string; evidence: string }
export interface GradeEvaluation {
  id: string; status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED"; trigger: string; submissionId: string
  score: number | null; maxScore: number | null; percentage: number | null; confidence: number | null
  criteria: EvaluationCriterion[]; feedback: string | null; rationale: string | null; flags: GradingFlag[]; needsReview: boolean; error: string | null
  stale: boolean; staleReasons: ("settings_changed" | "resubmitted")[]; createdAt: string; completedAt: string | null
}
export interface GradeHistoryEntry { id: string; action: "released" | "edited" | "auto_released" | "cleared"; source: string | null; at: string; actor: string
  score: number | null; maxScore: number | null; previousScore: number | null; previousMax: number | null; note: string | null }
export interface GradingRow {
  studentId: string; studentName: string; email: string
  submission: { id: string; submittedAt: string; attemptNumber: number; type: string; hasText: boolean } | null
  grade: Grade | null; evaluation: GradeEvaluation | null
}
export interface GradingOverview {
  settings: GradingSettings; students: GradingRow[]
  counts: { students: number; submitted: number; graded: number; draftsReady: number; needsReview: number; inProgress: number; failed: number; autoReleased: number }
}

const gradingKey = (assignmentId?: string) => ["teacher", "grading", assignmentId] as const
const busy = (e?: GradeEvaluation | null) => !!e && (e.status === "QUEUED" || e.status === "RUNNING")

/** null = this server has no AI grading yet (migration 020 not applied): the page keeps the classic grading flow. */
export function useGradingOverview(assignmentId?: string) {
  return useQuery({
    queryKey: gradingKey(assignmentId), enabled: !!assignmentId,
    refetchInterval: (q) => ((q.state.data?.students ?? []).some((r) => busy(r.evaluation)) ? 2500 : false),
    queryFn: async () => {
      try {
        return await api<GradingOverview>(`/teacher/assignments/${enc(assignmentId!)}/grading`)
      } catch (e) {
        if (e instanceof ApiError && (e.status === 404 || e.code === "assessment_unavailable")) return null
        throw e
      }
    },
  })
}

export function useGradingActions(assignmentId: string) {
  const qc = useQueryClient()
  const base = `/teacher/assignments/${enc(assignmentId)}`
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: gradingKey(assignmentId) }), qc.invalidateQueries({ queryKey: ["teacher", "review", assignmentId] }),
    qc.invalidateQueries({ queryKey: ["teacher", "insights"] }), qc.invalidateQueries({ queryKey: ["teacher", "assignment", assignmentId] }),
    qc.invalidateQueries({ queryKey: ["teacher", "dashboard"] })])
  return {
    saveSettings: useMutation({
      mutationFn: (v: Partial<{ aiGrading: AiGradingMode; pointsPossible: number; rubric: RubricCriterion[]; referenceAnswer: string; gradingNotes: string }>) =>
        api<{ settings: GradingSettings }>(`${base}/grading`, { method: "PUT", body: {
          ...(v.aiGrading !== undefined ? { ai_grading: v.aiGrading } : {}), ...(v.pointsPossible !== undefined ? { points_possible: v.pointsPossible } : {}),
          ...(v.rubric !== undefined ? { rubric: v.rubric } : {}), ...(v.referenceAnswer !== undefined ? { reference_answer: v.referenceAnswer } : {}),
          ...(v.gradingNotes !== undefined ? { grading_notes: v.gradingNotes } : {}) } }),
      onSuccess: refresh,
    }),
    suggestRubric: useMutation({ mutationFn: (pointsPossible?: number) =>
      api<{ criteria: RubricCriterion[]; pointsPossible: number }>(`${base}/grading/rubric-suggestion`, { method: "POST", body: pointsPossible ? { points_possible: pointsPossible } : {} }) }),
    run: useMutation({ mutationFn: (v: { studentIds?: string[]; includeGraded?: boolean; regrade?: boolean } = {}) =>
      api<{ queued: number; skipped: { inProgress: number; upToDate: number; graded: number } }>(`${base}/grading/run`, { method: "POST", body: {
        ...(v.studentIds ? { student_ids: v.studentIds } : {}), include_graded: !!v.includeGraded, regrade: !!v.regrade } }), onSuccess: refresh }),
    gradeOne: useMutation({ mutationFn: (studentId: string) => api<{ evaluation: GradeEvaluation }>(`${base}/students/${enc(studentId)}/evaluation`, { method: "POST" }), onSuccess: refresh }),
    release: useMutation({ mutationFn: (v: { studentIds?: string[]; minConfidence?: number } = {}) =>
      api<{ released: number; skipped: { needsReview: number; blocked: number; lowConfidence: number; notReady: number } }>(`${base}/grading/release`, { method: "POST", body: {
        ...(v.studentIds ? { student_ids: v.studentIds } : {}), min_confidence: v.minConfidence ?? 0 } }),
      onSuccess: () => Promise.all([refresh(), qc.invalidateQueries({ queryKey: ["teacher"] })]) }),
  }
}

// ------------------------------------------------------------------ Excel export
/** Downloads the workbook with the user's token (a plain link could not send it). `scope` = a course or one assignment. */
export async function downloadGradesXlsx(scope: { courseId: string } | { assignmentId: string }, opts: { includeFeedback?: boolean; includeInactive?: boolean; includeRubric?: boolean } = {}) {
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" } catch { return "UTC" } })()
  const q = new URLSearchParams({ tz, include_feedback: String(opts.includeFeedback ?? true), include_inactive: String(opts.includeInactive ?? false),
    include_rubric: String(opts.includeRubric ?? true) })
  const path = "courseId" in scope ? `/teacher/courses/${enc(scope.courseId)}/grades.xlsx` : `/teacher/assignments/${enc(scope.assignmentId)}/grades.xlsx`
  const { blob, filename } = await apiBlob(`${path}?${q}`)
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename ?? "SocratiQ_grades.xlsx"
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
  return filename
}

// ------------------------------------------------------------------ study momentum (motivation)
export interface Momentum {
  today: string
  streak: { current: number; activeToday: boolean; longest: number; week: { date: string; active: boolean }[] }
  totals: { submissions: number; verified: number; graded: number; activeDays30: number }
  next: { streak: number | null; submissions: number | null; verified: number | null }
  lastActive: string | null
  celebrations: import("./motivation").ServerCelebration[]
}
const tzParam = () => { try { return `?tz=${enc(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC")}` } catch { return "" } }
export const fetchMomentum = () => api<Momentum>(`/student/momentum${tzParam()}`)
/** null = this server has no momentum endpoint yet. */
export function useMomentum() {
  return useQuery({ queryKey: ["student", "momentum"], staleTime: 60_000, queryFn: async () => {
    try { return await fetchMomentum() } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e }
  } })
}

export function useTeacherMaterial(id?: string) {
  return useQuery({
    queryKey: ["teacher", "material", id], enabled: !!id,
    refetchInterval: (q) => (q.state.data?.file && ["QUEUED", "PROCESSING"].includes(q.state.data.file.status) ? 2000 : false),
    queryFn: () => api<Material>(`/teacher/materials/${enc(id!)}`),
  })
}

export function useCreateCourse() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { code: string; title: string; description: string; color: string; icon?: string | null }) => api<Course>("/teacher/courses", { method: "POST", body: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["teacher"] }),
  })
}

export function useUploadMaterial(courseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ file, title, onProgress }: { file: File; title?: string; onProgress?: (p: number) => void }) => {
      const form = new FormData()
      form.append("file", file)
      if (title) form.append("title", title)
      return upload<Material>(`/teacher/courses/${enc(courseId)}/materials`, form, onProgress)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["teacher"] }),
  })
}

export function useMaterialActions(courseId: string) {
  const qc = useQueryClient()
  const done = () => qc.invalidateQueries({ queryKey: ["teacher"] })
  return {
    retry: useMutation({ mutationFn: (id: string) => api<Material>(`/teacher/materials/${enc(id)}/retry`, { method: "POST" }), onSuccess: done }),
    remove: useMutation({ mutationFn: (id: string) => api<void>(`/teacher/materials/${enc(id)}`, { method: "DELETE" }), onSuccess: done }),
    courseId,
  }
}

export interface NewAssignmentInput { title: string; topic?: string; prompt: string; dueAt?: string | null; publish: boolean }
export function useCreateAssignment(courseId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { input: NewAssignmentInput; file?: File | null; onProgress?: (p: number) => void }) => {
      if (v.file) {
        const form = new FormData()
        form.append("file", v.file)
        form.append("title", v.input.title)
        if (v.input.topic) form.append("topic", v.input.topic)
        if (v.input.dueAt) form.append("due_at", v.input.dueAt)
        form.append("publish", String(v.input.publish))
        return upload<Assignment>(`/teacher/courses/${enc(courseId)}/assignments/upload`, form, v.onProgress)
      }
      return api<Assignment>(`/teacher/courses/${enc(courseId)}/assignments`, {
        method: "POST", body: { title: v.input.title, topic: v.input.topic || null, prompt: v.input.prompt, due_at: v.input.dueAt || null, publish: v.input.publish },
      })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["teacher"] }),
  })
}

export function useAssignmentActions(assignmentId: string) {
  const qc = useQueryClient()
  const done = () => qc.invalidateQueries({ queryKey: ["teacher"] })
  const post = (action: string) => () => api<Assignment>(`/teacher/assignments/${enc(assignmentId)}/${action}`, { method: "POST" })
  return {
    publish: useMutation({ mutationFn: post("publish"), onSuccess: done }),
    unpublish: useMutation({ mutationFn: post("unpublish"), onSuccess: done }),
    archive: useMutation({ mutationFn: post("archive"), onSuccess: done }),
    attach: useMutation({
      mutationFn: ({ file, onProgress }: { file: File; onProgress?: (p: number) => void }) => {
        const form = new FormData()
        form.append("file", file)
        return upload<FileInfo>(`/teacher/assignments/${enc(assignmentId)}/attachments`, form, onProgress)
      }, onSuccess: done,
    }),
    detach: useMutation({ mutationFn: (attachmentId: string) => api<void>(`/teacher/assignments/${enc(assignmentId)}/attachments/${enc(attachmentId)}`, { method: "DELETE" }), onSuccess: done }),
  }
}

export function useRotateJoinCode() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: (classroomId: string) => api<{ joinCode: string }>(`/teacher/classrooms/${enc(classroomId)}/join-code/rotate`, { method: "POST" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["teacher"] }) })
}


/** Thinking space of the student's open attempt. The save is the whole board (debounced by the caller). */
export function useWhiteboard(assignmentId?: string) {
  // gcTime 0: the board is edited by the student AND by the Coach, so a cached copy would be stale when the page is opened again.
  return useQuery({ queryKey: ["student", "whiteboard", assignmentId], enabled: !!assignmentId, staleTime: Infinity, gcTime: 0,
    queryFn: () => api<Partial<Board> & { updatedAt: string | null }>(`/student/assignments/${enc(assignmentId!)}/whiteboard`) })
}
/** `wire` is the snake_case body produced by `toWire` (the server schema is snake_case). */
/** Save the native board. Sends ONLY the scene: the server keeps the legacy fields exactly as stored. */
export const saveScene = (assignmentId: string, scene: unknown, baseRev?: number) =>
  api<Partial<Board> & { updatedAt: string }>(`/student/assignments/${enc(assignmentId)}/whiteboard`, { method: "PUT", body: baseRev === undefined ? { scene } : { scene, base_rev: baseRev } })

export interface DiagramRequest { request: string; board: { id: string; text: string }[]; selectedId?: string | null; assignmentId?: string | null; grant?: string | null }
/** Stage 1-2 of the drawing pipeline: a server-validated, coordinate-free diagram specification. */
export const generateDiagram = (body: DiagramRequest) =>
  api<{ spec: unknown; attempts: number; coachElementId?: string }>(`/smartboard/generate-diagram`, { method: "POST", body: { request: body.request, board: body.board, selected_id: body.selectedId ?? null, ...(body.assignmentId ? { assignment_id: body.assignmentId } : {}), ...(body.grant ? { grant: body.grant } : {}) } })

/** One image from POST /smartboard/generate-image. `source: "reference"` means no AI image could be made and a licensed reference image (Wikimedia
 * Commons) was returned instead; its `attribution` must stay visible next to it. */
export interface GeneratedImage {
  imageUrl: string
  mimeType?: string
  width?: number
  height?: number
  source?: "generated" | "reference"
  provider?: string
  model?: string
  style?: string
  aspectRatio?: string
  title?: string
  attribution?: { text: string; url?: string; license?: string; author?: string } | null
}
export interface ImageRequestOptions { style?: string; aspect?: string; quality?: "standard" | "high" }

export const generateImage = (prompt: string, opts: ImageRequestOptions = {}, assignmentId?: string | null) =>
  api<GeneratedImage>(`/smartboard/generate-image`, {
    method: "POST",
    body: {
      prompt,
      size: opts.quality === "high" ? "2K" : "1K",
      style: opts.style ?? "auto",
      aspect_ratio: opts.aspect ?? "auto",
      quality: opts.quality ?? "standard",
      ...(assignmentId ? { assignment_id: assignmentId } : {}),
    },
  })

export const generateSimulation = (prompt: string, title?: string, assignmentId?: string | null, grant?: string | null) =>
  api<{ code: string; coachElementId?: string }>(`/smartboard/generate-simulation`, { method: "POST", body: { prompt, title, ...(assignmentId ? { assignment_id: assignmentId } : {}), ...(grant ? { grant } : {}) } })

export const saveWhiteboard = (assignmentId: string, wire: unknown) =>
  api<Partial<Board> & { updatedAt: string }>(`/student/assignments/${enc(assignmentId)}/whiteboard`, { method: "PUT", body: wire })
