import { useEffect, useRef, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { cn } from "@/lib/utils"
import { CheckCircle2 } from "lucide-react"
import { useAnswerVerification, useStartVerification, useStudentAssignment, useStudentCourse, type VerificationState } from "@/lib/queries"
import { ApiError } from "@/lib/api"
import { useQueryClient } from "@tanstack/react-query"
import { celebrateVerification } from "@/lib/celebrate"
import { usePasteGuard } from "@/lib/pasteGuard"

const LABEL: Record<string, string> = { EXPLAIN: "Explain", MODIFY: "Modify", TRANSFER: "Transfer" }

export default function Verification() {
  const { courseId = "", assignmentId = "" } = useParams()
  const course = useStudentCourse(courseId)
  const assignment = useStudentAssignment(assignmentId)
  const start = useStartVerification()
  const answerM = useAnswerVerification()
  const qc = useQueryClient()

  const [state, setState] = useState<VerificationState | null>(null)
  const [answer, setAnswer] = useState("")
  const [feedback, setFeedback] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [blocked, setBlocked] = useState<string | null>(null)
  const began = useRef(false)
  // The three comprehension answers must be the student's own words: paste is blocked in this field only (see lib/pasteGuard.ts).
  const pasteGuard = usePasteGuard()

  async function begin() {
    setError(null)
    try {
      setState(await start.mutateAsync(assignmentId))
    } catch (e) {
      if (e instanceof ApiError && e.code === "not_submitted") setBlocked("Submit your work first, then come back for the verification.")
      else setError(e instanceof ApiError ? e.message : "We couldn't start the verification.")
    }
  }

  useEffect(() => {
    if (!began.current) {
      began.current = true
      void begin()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function submit() {
    if (!state || !answer.trim()) return
    setError(null)
    try {
      const r = await answerM.mutateAsync({ verificationId: state.verificationId, answer })
      setFeedback(r.result.feedback || null)
      setAnswer("")
      pasteGuard.dismiss()
      setState(r.state)
      if (r.state.status === "COMPLETED" && state.status !== "COMPLETED")
        void celebrateVerification(qc, { title: assignment.data?.title ?? "this assignment", passed: r.state.outcome === "PASS" })
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "ai_unavailable" ? "We couldn't evaluate your answer just now. It wasn't recorded, so you can send it again."
        : e instanceof ApiError ? e.message : "Your answer couldn't be sent."
      )
    }
  }

  const back = `/student/courses/${courseId}/assignments/${assignmentId}`
  const done = state?.status === "COMPLETED"
  const current = state?.current
  const stepIndex = state ? Math.max(0, state.steps.findIndex((s) => s.status === "current")) : 0

  return (
    <AppShell
      role="student"
      crumbs={[
        { label: "Courses", to: "/student/courses" },
        { label: course.data?.course.name ?? "Course", to: `/student/courses/${courseId}` },
        { label: assignment.data?.title ?? "Assignment", to: back },
        { label: "Verification" },
      ]}
    >
      {blocked ? (
        <section className="mx-auto max-w-[770px] rounded-2xl border border-[var(--color-border)] bg-[#f6f4ea] p-6" role="status">
          <div className="rounded-[12px] border border-[var(--color-border)] bg-white px-6 py-5">
            <h1 className="text-lg font-semibold text-[var(--color-ink)]">Not ready yet</h1>
            <p className="mt-1 text-[15px] text-[var(--color-ink-soft)]">{blocked}</p>
            <Link to={back} className="ds-btn ds-btn-sm mt-4">Back to assignment</Link>
          </div>
        </section>
      ) : (
        <section className={cn("mx-auto max-w-[770px] rounded-2xl border border-[var(--color-border)] px-8 py-8", done ? "bg-[#f6f4ea]" : "bg-white shadow-[0_1px_2px_rgb(20_17_2/0.05)]")}>
          <div>
            {!done ? (
              <>
                <p className="text-[13px] font-semibold text-[var(--color-teal-dark)]">Show what you understand</p>
                <h1 className="mt-1 text-[22px] font-bold text-[var(--color-ink)]">{assignment.data?.title}</h1>
                <p className="mt-2 text-[15px] leading-relaxed text-[var(--color-ink-soft)]">
                  A short conversation about the solution you submitted — this isn't a re-test, it's a chance to show the reasoning behind your work.
                </p>

                <div className="mt-5 flex gap-2">
                  {(state?.steps ?? [{ type: "EXPLAIN" }, { type: "MODIFY" }, { type: "TRANSFER" }]).map((s, i) => (
                    <span key={s.type} className={`h-[6px] flex-1 rounded-full ${i <= stepIndex ? "bg-[var(--color-teal)]" : "bg-[#e2e3cf]"}`} />
                  ))}
                </div>

                {feedback && (
                  <p role="status" className="mt-4 rounded-[12px] border border-[var(--color-border)] bg-[var(--color-teal-light)] px-4 py-2.5 text-[15px] text-[var(--color-ink)]">
                    <span className="font-bold">On your last answer: </span>
                    {feedback}
                  </p>
                )}

                {current ? (
                  <>
                    <div className="mt-6 rounded-[12px] bg-[var(--color-surface-muted)] px-5 py-4">
                      <span className="ds-pill ds-pill-info">{LABEL[current.type] ?? current.type}</span>
                      <p id="verification-question" className="mt-3 text-base text-[var(--color-ink)]">{current.question}</p>
                    </div>
                    <textarea dir="auto"
                      {...pasteGuard.guardProps}
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                      rows={5}
                      maxLength={8000}
                      aria-label="Your response"
                      aria-describedby={pasteGuard.notice ? "verification-question verification-paste-notice" : "verification-question"}
                      data-paste-guard="verification"
                      placeholder="Write your response…"
                      className="mt-5 w-full rounded-[12px] border border-[var(--color-control-border)] px-4 py-3 text-[15px] placeholder:text-[var(--color-ink-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-teal-dark)]"
                    />
                    {/* Always mounted so screen readers announce the message when it appears. */}
                    <p id="verification-paste-notice" role="status" aria-live="polite" className="mt-2 min-h-[20px] text-[13px] text-[var(--color-ink-soft)]">
                      {pasteGuard.notice}
                    </p>
                  </>
                ) : (
                  <p className="mt-5 text-sm text-[var(--color-ink-soft)]" aria-live="polite">
                    {start.isPending || answerM.isPending ? "Preparing your question…" : state?.needsQuestion ? "Your next question isn't ready yet." : "Loading…"}
                  </p>
                )}

                {error && (
                  <p role="alert" className="mt-3 text-[15px] text-[var(--color-danger-ink)]">
                    {error}
                  </p>
                )}

                <div className="mt-4 flex justify-between">
                  <Link to={back} className="ds-btn">Go back</Link>
                  {current ? (
                    <button type="button" className="ds-btn ds-btn-pri" onClick={submit} disabled={!answer.trim() || answerM.isPending}>
                      {answerM.isPending ? "Sending…" : stepIndex < 2 ? "Continue" : "Finish verification"}
                    </button>
                  ) : (
                    <button type="button" className="ds-btn ds-btn-pri" onClick={begin} disabled={start.isPending}>Retry</button>
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center py-6 text-center" role="status">
                <CheckCircle2 className="h-10 w-10 text-[var(--color-teal-dark)]" strokeWidth={1.8} aria-hidden="true" />
                <h1 className="mt-3 text-[22px] font-bold text-[var(--color-ink)]">Verification complete</h1>
                <p className="mt-1 max-w-[400px] text-[15px] text-[var(--color-ink-soft)]">
                  Your reasoning has been added to this assignment's learning evidence. Your instructor will see it alongside your submission.
                </p>
                <Link to={back} className="ds-btn ds-btn-pri mt-5">Back to assignment</Link>
              </div>
            )}
          </div>
        </section>
      )}
    </AppShell>
  )
}
