import { useRef, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { LearningJourney, type JourneyStep } from "@/components/socratiq/LearningJourney"
import { QueryState } from "@/components/ui/States"
import { Clock, Paperclip, MessageCircle, Download } from "lucide-react"
import { assignmentStatusLabel } from "@/lib/assignments"
import { dueInfo } from "@/lib/dates"
import { GradeResult } from "@/components/student/GradeResult"
import { celebrateSubmission } from "@/lib/celebrate"
import { shortDate, statusTone } from "@/lib/studentWork"
import { cn } from "@/lib/utils"
import { useQueryClient } from "@tanstack/react-query"
import { downloadFile, useCapabilities, useStartAttempt, useStudentAssignment, useStudentCourse, useSubmitFile } from "@/lib/queries"
import { formatBytes, precheck } from "@/lib/files"
import { ApiError } from "@/lib/api"
import type { AssignmentStatus } from "@/types"

function journeyFor(status: AssignmentStatus): JourneyStep[] {
  const order: AssignmentStatus[] = ["not_started", "in_progress", "submitted", "verified"]
  const idx = order.indexOf(status)
  const labels = ["Initial attempt", "AI coaching", "Final submission", "Learning verification"]
  return labels.map((label, i) => ({
    label,
    state: i < idx ? "done" : i === idx ? "current" : "upcoming",
  }))
}

export default function StudentAssignmentDetail() {
  const { courseId = "", assignmentId = "" } = useParams()
  const navigate = useNavigate()
  const q = useStudentAssignment(assignmentId)
  const course = useStudentCourse(courseId)
  const caps = useCapabilities("SUBMISSION")
  const startAttempt = useStartAttempt()
  const submit = useSubmitFile(assignmentId)
  const qc = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)

  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  async function handleRevise() {
    setError(null)
    setNotice(null)
    try {
      await startAttempt.mutateAsync(assignmentId)     // opens attempt N+1; server recomputes status, re-enabling upload/submit
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't start a new attempt. Try again.")
    }
  }

  function choose(f: File | undefined) {
    setNotice(null)
    if (!f) return
    const problem = precheck(f, caps.data)
    setError(problem)
    setFile(problem ? null : f)
  }

  async function handleSubmit() {
    if (!file) return
    setError(null)
    setProgress(0)
    try {
      const attempt = await startAttempt.mutateAsync(assignmentId)      // idempotent: reuses the open attempt
      const res = await submit.mutateAsync({ attemptId: attempt.id, file, onProgress: setProgress })
      setNotice(res.warning ?? null)
      setFile(null)
      void celebrateSubmission(qc, { title: q.data?.title ?? "Your assignment", courseId, assignmentId })
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Your file couldn't be submitted. Try again.")
    }
  }

  const status = q.data?.status ?? "not_started"
  const busy = submit.isPending || startAttempt.isPending
  const closed = status === "submitted" || status === "verified"

  const assignmentDue = q.data ? dueInfo(q.data.dueDate, closed) : null

  return (
    <AppShell
      role="student"
      crumbs={[
        { label: "Courses", to: "/student/courses" },
        { label: course.data?.course.name ?? "Course", to: `/student/courses/${courseId}` },
        { label: q.data?.title ?? "Assignment" },
      ]}
    >
      <QueryState query={q} what="Assignment">
        {(assignment) => (
          <div className="grid max-w-[1124px] gap-6">
            <section className="ds-card px-[30px] pb-7 pt-8" aria-labelledby="asg-title">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h1 id="asg-title" className="ds-h1">{assignment.title}</h1>
                  <p className="mt-2 text-[15px] text-[var(--color-ink-muted)]">{[course.data?.course.name, assignment.topic].filter(Boolean).join(" · ")}</p>
                  {assignmentDue && assignmentDue.state !== "none" && (
                    <p className="mt-2">
                      <span className={cn("ds-pill", assignmentDue.state === "overdue" ? "ds-pill-bad" : assignmentDue.state === "soon" ? "ds-pill-or" : "ds-pill-neu")} title={assignmentDue.full ?? undefined}>
                        <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                        {assignmentDue.state === "soon" ? `Due soon · ${shortDate(assignment.dueDate)}, ${assignmentDue.label.replace(/^Due /, "")}` : assignmentDue.label}
                      </span>
                    </p>
                  )}
                </div>
                <span className={cn("ds-pill shrink-0", `ds-pill-${statusTone[status]}`)}>{assignmentStatusLabel[status]}</span>
              </div>

              <p className="mt-5 whitespace-pre-wrap text-[15px] leading-relaxed text-[var(--color-ink)]">{assignment.prompt}</p>

              {assignment.attachments && assignment.attachments.length > 0 && (
                <div className="mt-5">
                  <p className="text-[13px] font-semibold text-[var(--color-ink-soft)]">Attachments</p>
                  <ul className="mt-2 space-y-2">
                    {assignment.attachments.map((a) => (
                      <li key={a.fileId} className="flex items-center justify-between gap-3 rounded-[12px] border border-[var(--color-border)] px-4 py-3.5 text-sm">
                        <span className="min-w-0 truncate text-[var(--color-ink)]">
                          {a.filename} <span className="text-xs text-[var(--color-ink-muted)]">· {formatBytes(a.sizeBytes)}</span>
                        </span>
                        <button onClick={() => void downloadFile(a.fileId)} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--color-teal-dark)] hover:bg-[var(--color-surface-muted)]" aria-label={`Download ${a.filename}`}>
                          <Download className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {file && (
                <p className="mt-5 flex items-center gap-2 text-sm text-[var(--color-ink-soft)]">
                  <Paperclip className="h-4 w-4" aria-hidden="true" /> {file.name} · {formatBytes(file.size)}
                </p>
              )}
              {assignment.submission?.filename && closed && (
                <p className="mt-5 flex items-center gap-2 text-sm text-[var(--color-ink-soft)]">
                  <Paperclip className="h-4 w-4" aria-hidden="true" /> {assignment.submission.filename}
                  {assignment.attempt && <span className="text-[var(--color-ink-muted)]">· Attempt {assignment.attempt.attemptNumber}</span>}
                </p>
              )}
              {busy && progress > 0 && progress < 100 && <p className="mt-2 text-[13px] text-[var(--color-ink-muted)]" role="status">Uploading… {Math.round(progress)}%</p>}
              {error && <p role="alert" className="mt-3 text-sm text-[var(--color-danger-ink)]">{error}</p>}
              {notice && <p role="status" className="mt-3 text-sm text-[var(--color-warning-ink)]">{notice}</p>}

              <div className="mt-5 flex flex-wrap gap-2.5">
                <button type="button" className="ds-btn" onClick={() => navigate(-1)}>Go back</button>
                <input ref={fileInput} type="file" className="hidden" accept={caps.data?.accept} onChange={(e) => { choose(e.target.files?.[0]); e.target.value = "" }} />
                <button type="button" className="ds-btn ds-btn-soft" onClick={() => fileInput.current?.click()} disabled={closed || busy}>Upload</button>
                <button type="button" className="ds-btn ds-btn-pri" onClick={handleSubmit} disabled={!file || busy || closed}>
                  {busy ? "Submitting…" : closed ? "Submitted" : "Submit"}
                </button>
                {closed && (
                  <button type="button" className="ds-btn" onClick={handleRevise} disabled={startAttempt.isPending}>
                    {startAttempt.isPending ? "Starting…" : "Revise & resubmit"}
                  </button>
                )}
                <Link to={`/student/courses/${courseId}/assignments/${assignment.id}/coach`} className="ds-btn ds-btn-pri">
                  <MessageCircle className="h-4 w-4" aria-hidden="true" /> Ask SocratiQ AI
                </Link>
              </div>
              {caps.data && !closed && (
                <p className="mt-2.5 text-[13px] text-[var(--color-ink-muted)]">Accepted: {caps.data.extensions.map((e) => e.toUpperCase()).join(", ")}.</p>
              )}
            </section>

            {status === "submitted" && (
              <section className="rounded-2xl border border-[var(--color-border)] bg-[#f6f4ea] p-5" aria-labelledby="verify-h">
                <div className="rounded-[12px] border border-[var(--color-border)] bg-[var(--color-slate-light)]/70 px-5 py-4">
                  <h2 id="verify-h" className="text-[15px] font-semibold text-[var(--color-ink)]">Ready for learning verification</h2>
                  <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
                    Show what you understand about your solution before it's graded — a short, conversational check tied to what you actually submitted.
                  </p>
                  <Link to={`/student/courses/${courseId}/assignments/${assignment.id}/verify`} className="ds-btn ds-btn-pri ds-btn-sm mt-3">Start verification</Link>
                </div>
              </section>
            )}

            {assignment.grade && <GradeResult grade={assignment.grade} />}

            <section className="ds-card px-6 py-6" aria-labelledby="journey-h">
              <h2 id="journey-h" className="mb-5 text-lg font-semibold text-[var(--color-ink)]">Your learning journey</h2>
              <LearningJourney steps={journeyFor(status)} />
            </section>
          </div>
        )}
      </QueryState>
    </AppShell>
  )
}
