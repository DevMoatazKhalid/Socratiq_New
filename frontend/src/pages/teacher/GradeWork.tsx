import { lazy, Suspense, useEffect, useMemo, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { ChevronLeft, ChevronRight, Download, Loader2 } from "lucide-react"
import type { SubmissionRow } from "@/types"
import { AppShell } from "@/components/layout/AppShell"
import { Avatar, GradeValue, NoData, PageTitle, Pill } from "@/components/ds"
import { NoCourseYet, useTeacherScope } from "@/components/teacher/scope"
import { RiskPanel } from "@/components/socratiq/RiskPanel"
import { SmartBoard } from "@/components/socratiq/SmartBoard"
import { SubmissionSkeleton } from "@/components/socratiq/Skeletons"
import { QueryState, Skeleton } from "@/components/ui/States"
import { formatBytes } from "@/lib/files"
import { formatNumber } from "@/lib/grades"
import { downloadFile, useGradingOverview, useSubmissionReview, useTeacherAssignment, useTeacherStudent, type GradingRow, type SubmissionReviewData } from "@/lib/queries"
import { AssessmentBar } from "@/components/teacher/AssessmentBar"
import { ExportGradesButton } from "@/components/teacher/ExportGradesButton"
import { GradePanel } from "@/components/teacher/GradePanel"
import { useWhiteboardRealtimeSync } from "@/lib/realtime"
import { formatDateTime } from "@/lib/time"
import { gradeLink } from "@/lib/teacherWork"
import { cn } from "@/lib/utils"
import { fromServer, isEmptyBoard } from "@/lib/whiteboard"

// The native board's drawing engine is large: load it only when a teacher opens a student's native board.
const SceneViewer = lazy(() => import("@/components/smartboard/SceneViewer"))

const TABS = ["Submission", "Whiteboard", "AI Coach", "Verification", "Revisions", "History"] as const
type Tab = (typeof TABS)[number]
const outcomeLabel = (o?: string | null) => (o === "PASS" ? { t: "Understood", tone: "ok" as const } : o === "FAIL" ? { t: "Not yet", tone: "bad" as const } : o ? { t: "Partly", tone: "warn" as const } : { t: "Pending", tone: "or" as const })

function Picker({ n, label, children }: { n: number; label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="mb-2 flex items-center gap-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-[var(--color-ink-muted)]">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-plum)] text-xs font-bold text-[var(--color-ink)]">{n}</span>{label}
      </p>
      {children}
    </div>
  )
}

function Whiteboard({ r }: { r: SubmissionReviewData }) {
  if (!r.whiteboard || (!r.whiteboard.scene && isEmptyBoard(fromServer(r.whiteboard)))) return <NoData title="No whiteboard work">The student hasn't used the whiteboard on this assignment.</NoData>
  const wb = fromServer(r.whiteboard)
  return (
    <>
      <p className="mb-3 text-[13px] text-[var(--color-ink-muted)]">The board as the student left it. Items with a teal edge were written by SocratiQ; everything else was written or drawn by the student.</p>
      {wb.scene ? <Suspense fallback={<p role="status" className="text-sm text-[var(--color-ink-muted)]">Loading the board…</p>}><SceneViewer scene={wb.scene} /></Suspense> : <SmartBoard board={wb} readOnly fit="width" />}
    </>
  )
}

function VerificationList({ r }: { r: SubmissionReviewData }) {
  if (!r.verification || r.verification.entries.length === 0) return <p className="text-sm text-[var(--color-ink-muted)]">No verification activity yet.</p>
  return (
    <div className="space-y-3">
      {r.verification.entries.map((e, i) => {
        const o = outcomeLabel(e.answer ? e.outcome : null)
        return (
          <div key={e.label + i} className="rounded-[12px] border border-[var(--color-border)] px-5 py-4">
            <div className="flex items-center justify-between gap-2"><Pill tone="or">Question {i + 1} · {e.label}</Pill><Pill tone={o.tone}>{o.t}</Pill></div>
            <p className="mt-2.5 font-semibold">{e.prompt}</p>
            {e.answer ? <p className="mt-1 whitespace-pre-wrap text-[var(--color-ink-muted)]">{e.answer}</p> : <p className="mt-1 text-[var(--color-ink-muted)]">Not answered yet</p>}
            {e.feedback && <p className="mt-2 rounded-[8px] bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-ink-muted)]">Feedback shown to the student: {e.feedback}</p>}
          </div>
        )
      })}
    </div>
  )
}

/** The state of one student in the list: graded (with a marker if no instructor reviewed it yet), an AI draft (ready / needs review /
 *  being drafted / failed), to grade, or not submitted. */
function RowState({ state, grade, row }: { state: "todo" | "graded" | "missing"; grade: { percentage: number; reviewed?: boolean } | null; row?: GradingRow }) {
  if (state === "missing") return <Pill tone="neu">Not submitted</Pill>
  if (state === "graded") return (
    <span className="flex items-center gap-1.5">
      {grade?.reviewed === false && <Pill tone="warn" title="Released automatically by SocratiQ; not reviewed yet">Auto</Pill>}
      <GradeValue pct={grade?.percentage} />
    </span>
  )
  const ev = row?.evaluation
  if (ev && (ev.status === "QUEUED" || ev.status === "RUNNING")) return <Pill tone="neu"><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />Drafting</Pill>
  if (ev?.status === "COMPLETED" && !ev.stale) return <Pill tone={ev.needsReview ? "warn" : "info"} title={ev.needsReview ? "AI draft — needs your review" : "AI draft ready to release"}>{ev.needsReview ? "Review" : "Draft"} {formatNumber(Math.round(ev.percentage ?? 0))}%</Pill>
  if (ev?.status === "FAILED") return <Pill tone="bad">AI failed</Pill>
  return <Pill tone="or">To grade</Pill>
}

/** Grade work (approved design): pick a course and an assignment, then grade each student without leaving the page. */
export default function GradeWork() {
  const navigate = useNavigate()
  const route = useParams()
  const [params, setParams] = useSearchParams()
  const { courses, course, setCourse, detail, insights } = useTeacherScope()
  const urlCourse = params.get("course") ?? route.courseId
  useEffect(() => { if (urlCourse && courses.data?.some((c) => c.id === urlCourse) && course?.id !== urlCourse) setCourse(urlCourse) }, [urlCourse, courses.data, course?.id, setCourse])

  const assignments = useMemo(() => (detail.data?.assignments ?? []).filter((a) => a.lifecycle !== "DRAFT"), [detail.data])
  const assignmentId = params.get("assignment") ?? route.assignmentId ?? assignments.find((a) => (insights.data?.submissions ?? []).some((s) => s.assignmentId === a.id && !s.grade))?.id ?? assignments[0]?.id
  const asg = useTeacherAssignment(assignmentId)
  const overview = useGradingOverview(assignmentId)
  const rowOf = (sid?: string): GradingRow | undefined => overview.data?.students.find((r) => r.studentId === sid)
  const [filter, setFilter] = useState<"all" | "todo" | "graded">("all")
  const subs = (insights.data?.submissions ?? []).filter((s) => s.assignmentId === assignmentId)
  // Grade status, most direct source first: the assignment roster itself (any server with this release), then AI grading, then insights.
  // A grade saved on this page is reflected at once because saving refreshes these queries.
  // Grades read from opened submissions (every server sends the grade there), so an older server without the sources above still shows
  // a student as graded once their work has been opened or graded on this page.
  const [seen, setSeen] = useState<Record<string, { percentage: number; gradedAt: string }>>({})
  const gradeOf = (sid: string, own?: SubmissionRow["grade"]) =>
    (own ? { percentage: own.percentage, gradedAt: own.gradedAt ?? "" } : null) ?? rowOf(sid)?.grade ?? subs.find((s) => s.studentId === sid)?.grade ?? seen[`${assignmentId}:${sid}`] ?? null
  const roster = (asg.data?.submissions ?? []).map((s) => {
    const handed = s.status === "submitted" || s.status === "verified"
    const g = gradeOf(s.studentId, s.grade)
    return { ...s, handed, grade: g, state: !handed ? "missing" as const : g ? "graded" as const : "todo" as const }
  }).sort((a, b) => ({ todo: 0, graded: 1, missing: 2 })[a.state] - ({ todo: 0, graded: 1, missing: 2 })[b.state] || a.studentName.localeCompare(b.studentName))
  const handedIn = roster.filter((s) => s.handed)
  const todo = roster.filter((s) => s.state === "todo")
  const studentId = params.get("student") ?? route.studentId ?? (todo[0] ?? handedIn[0] ?? roster[0])?.studentId
  const idx = Math.max(0, roster.findIndex((s) => s.studentId === studentId))
  const shown = roster.filter((s) => filter === "all" || (filter === "todo" ? s.state === "todo" : s.state === "graded"))
  const review = useSubmissionReview(assignmentId, studentId)
  const reviewed = review.data?.grade
  useEffect(() => {
    if (!assignmentId || !studentId) return
    const k = `${assignmentId}:${studentId}`
    setSeen((m) => {
      if (reviewed) return m[k]?.gradedAt === reviewed.gradedAt ? m : { ...m, [k]: { percentage: reviewed.percentage, gradedAt: reviewed.gradedAt } }
      if (review.data && m[k]) { const rest = { ...m }; delete rest[k]; return rest }
      return m
    })
  }, [assignmentId, studentId, reviewed, review.data])
  const student = useTeacherStudent(studentId)
  const [tab, setTab] = useState<Tab>("Submission")
  useWhiteboardRealtimeSync(assignmentId)

  const go = (p: { assignment?: string; student?: string }) => {
    setTab("Submission")
    if (route.studentId) return navigate(gradeLink(course!.id, p.assignment ?? assignmentId!, p.student))
    setParams((q) => { if (course) q.set("course", course.id); if (p.assignment) { q.set("assignment", p.assignment); q.delete("student") } if (p.student) q.set("student", p.student); return q }, { replace: true })
  }
  const next = () => {
    const after = [...roster.slice(idx + 1), ...roster.slice(0, idx)].find((s) => s.state === "todo") ?? roster[idx + 1]
    if (after) go({ student: after.studentId })
  }
  const graded = handedIn.filter((s) => s.grade).length

  return (
    <AppShell role="teacher" crumbs={[{ label: "Grade work" }]}>
      <PageTitle title="Grade work" subtitle="Pick a course and an assignment, then grade each student without leaving the page" />
      <QueryState query={courses} what="Grade work" skeleton={<SubmissionSkeleton />}>
        {(list) => !course ? <NoCourseYet /> : (
          <>
            <div className="ds-card grid gap-4 px-5 py-5 md:grid-cols-2 xl:grid-cols-[1.1fr_1.3fr_1fr_0.9fr] xl:px-6">
              <Picker n={1} label="Course">
                <select aria-label="Course" className="ds-sel w-full !py-3 !text-[15px] !font-semibold" value={course.id} onChange={(e) => { setCourse(e.target.value); setParams({ course: e.target.value }, { replace: true }) }}>
                  {list.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.code}</option>)}
                </select>
              </Picker>
              <Picker n={2} label="Assignment">
                <select aria-label="Assignment" className="ds-sel w-full !py-3 !text-[15px] !font-semibold" value={assignmentId ?? ""} onChange={(e) => go({ assignment: e.target.value })} disabled={!assignments.length}>
                  {assignments.length === 0 && <option value="">No published assignments</option>}
                  {assignments.map((a) => {
                    const open = !a.dueDate || Date.parse(a.dueDate) > Date.now()
                    const left = (insights.data?.submissions ?? []).filter((s) => s.assignmentId === a.id && !s.grade).length
                    return <option key={a.id} value={a.id}>{a.title} · {open ? "Open" : "Closed"}{left ? ` · ${left} to grade` : ""}</option>
                  })}
                </select>
              </Picker>
              <Picker n={3} label="Student">
                <select aria-label="Student" className="ds-sel w-full !py-3 !text-[15px] !font-semibold" value={studentId ?? ""} onChange={(e) => go({ student: e.target.value })} disabled={!roster.length}>
                  {roster.map((s, i) => <option key={s.studentId} value={s.studentId}>{s.studentName} · {i + 1} of {roster.length}</option>)}
                </select>
              </Picker>
              <div>
                <p className="mb-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-[var(--color-ink-muted)]">Progress</p>
                <span className="flex"><span className="ds-bar"><i style={{ width: `${handedIn.length ? (graded / handedIn.length) * 100 : 0}%`, background: "#6f9a7b" }} /></span></span>
                <p className="mt-2 text-sm text-[var(--color-ink-muted)]"><b className="text-[var(--color-ink)]">{graded}</b> of {handedIn.length} graded · {todo.length} to grade</p>
              </div>
            </div>

            {assignmentId && overview.data && (
              <AssessmentBar assignmentId={assignmentId} assignmentTitle={asg.data?.title ?? "Assignment"} courseId={course.id}
                courseLabel={`${course.name} · ${course.code}`} overview={overview.data} />
            )}
            {assignmentId && overview.data === null && (
              <div className="mt-5 flex justify-end"><ExportGradesButton compact courseId={course.id} courseLabel={`${course.name} · ${course.code}`} assignment={asg.data ? { id: asg.data.id, title: asg.data.title } : undefined} /></div>
            )}
            {!assignmentId ? <div className="mt-5"><NoData title="Nothing to grade yet">Publish an assignment and wait for submissions.</NoData></div> : (
              <div className="mt-5 grid items-start gap-5 xl:grid-cols-[280px_minmax(0,1fr)_360px]">
                <section className="ds-card overflow-hidden" aria-labelledby="st-h">
                  <div className="px-5 pt-5">
                    <h2 id="st-h" className="text-lg font-bold">Students</h2>
                    <p className="text-[13px] text-[var(--color-ink-muted)]">{asg.data?.title}</p>
                    <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Show">
                      <button type="button" className="ds-chip" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>All</button>
                      <button type="button" className="ds-chip" aria-pressed={filter === "todo"} onClick={() => setFilter("todo")}>To grade {todo.length}</button>
                      <button type="button" className="ds-chip" aria-pressed={filter === "graded"} onClick={() => setFilter("graded")}>Graded {graded}</button>
                    </div>
                  </div>
                  <ul className="mt-3 max-h-[640px] overflow-y-auto thin-scroll">
                    {asg.isPending ? <li className="p-5"><Skeleton className="h-24 w-full" /></li> : shown.length === 0 ? <li className="px-5 pb-5 text-sm text-[var(--color-ink-muted)]">No students here.</li> : shown.map((s) => (
                      <li key={s.studentId}>
                        <button type="button" onClick={() => go({ student: s.studentId })} aria-current={s.studentId === studentId ? "true" : undefined}
                          className={cn("flex w-full items-center gap-3 border-t border-[#eeeee0] px-5 py-3.5 text-left", s.studentId === studentId ? "bg-[var(--color-plum-light)]" : "hover:bg-[#fffaf6]", s.state === "missing" && "opacity-70")}>
                          <Avatar name={s.studentName} className="!h-10 !w-10" />
                          <b className="min-w-0 flex-1 break-words font-semibold leading-snug">{s.studentName}</b>
                          <RowState state={s.state} grade={s.grade} row={rowOf(s.studentId)} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>

                <section className="ds-card min-w-0 overflow-hidden">
                  <div className="ds-tabs flex-wrap px-3 [&_.ds-tab]:px-2.5" role="tablist" aria-label="Submission views">
                    {TABS.map((t) => <button key={t} type="button" role="tab" aria-selected={tab === t} className="ds-tab !text-[15px]" onClick={() => setTab(t)}>{t}</button>)}
                  </div>
                  <div className="p-6" role="tabpanel" aria-label={tab}>
                    <QueryState query={review} what="Submission" skeleton={<SubmissionSkeleton />}>
                      {(r) => {
                        const file = r.submission?.file
                        const mastery = asg.data?.submissions.find((s) => s.studentId === studentId)?.mastery ?? null
                        const signals = r.signals.length
                        return (
                          <>
                            <div className="flex flex-wrap items-center gap-3">
                              <Avatar name={r.student.name} className="!h-14 !w-14 !text-base" />
                              <div className="min-w-[220px] flex-1">
                                <Link to={`/teacher/students/${r.student.id}`} className="text-2xl font-bold leading-tight hover:underline">{r.student.name}</Link>
                                <p className="text-sm text-[var(--color-ink-muted)]">{r.assignment.title}{r.attempt && ` · attempt ${r.attempt.number}`}{r.submission && ` · submitted ${formatDateTime(r.submission.submittedAt)}`}</p>
                              </div>
                              <div className="flex flex-wrap gap-1.5">
                                <Pill tone="neu">{r.coachInteractions} Coach turn{r.coachInteractions === 1 ? "" : "s"}</Pill>
                                <Pill tone={signals ? "warn" : "ok"}>{signals ? `${signals} review signal${signals === 1 ? "" : "s"}` : "No review signals"}</Pill>
                                {mastery && <Pill tone={mastery === "Strong" ? "ok" : mastery === "Weak" ? "bad" : "or"}>{mastery === "Moderate" ? "Developing" : mastery} mastery</Pill>}
                              </div>
                            </div>

                            <div className="mt-5">
                              {tab === "Submission" && (
                                <>
                                  {!r.submission ? <NoData title="Not submitted">This student hasn't submitted yet.</NoData> : (
                                    <>
                                      {file && (
                                        <div className="flex items-center justify-between gap-3 rounded-[12px] border border-[var(--color-border)] px-5 py-3.5">
                                          <span className="min-w-0 truncate"><b>{file.filename}</b> <span className="text-sm text-[var(--color-ink-muted)]">· {formatBytes(file.sizeBytes)}</span></span>
                                          <button type="button" className="ds-btn ds-btn-sm !rounded-full" onClick={() => void downloadFile(file.fileId)}><Download className="h-3.5 w-3.5" aria-hidden="true" />Download</button>
                                        </div>
                                      )}
                                      {r.submission.textPreview ? (
                                        <pre dir="ltr" className="mt-3 max-h-[360px] overflow-auto rounded-[12px] bg-[#fbf8f1] p-5 font-mono text-[13px] leading-relaxed text-[var(--color-ink)]">{r.submission.textPreview}{r.submission.textTruncated ? "\n…" : ""}</pre>
                                      ) : <p className="mt-3 text-sm text-[var(--color-ink-muted)]">No text could be read from this file, so only the original file is available.</p>}
                                    </>
                                  )}
                                  <h3 className="mb-3 mt-6 text-lg font-bold">Learning verification</h3>
                                  <VerificationList r={r} />
                                  <h3 className="mb-1.5 mt-6 text-lg font-bold">Review signals</h3>
                                  {signals === 0 ? <p className="text-[var(--color-ink-muted)]">No review signals for this submission. {r.signalsNote}</p> : (
                                    <ul className="space-y-1.5">{r.signals.map((s, i) => <li key={i} className="text-sm"><Pill tone={s.tone === "watch" ? "warn" : s.tone === "positive" ? "ok" : "neu"}>{s.label}</Pill> <span className="text-[var(--color-ink-muted)]">{s.detail}</span></li>)}</ul>
                                  )}
                                  <details className="mt-3"><summary className="cursor-pointer text-sm font-semibold text-[var(--color-teal-dark)]">Full review evidence</summary><div className="mt-3"><RiskPanel risk={r.risk} assignmentTitles={{ [r.assignment.id]: r.assignment.title }} /></div></details>
                                </>
                              )}
                              {tab === "Whiteboard" && <Whiteboard r={r} />}
                              {tab === "AI Coach" && (
                                <NoData title={`${r.coachInteractions} Coach turn${r.coachInteractions === 1 ? "" : "s"} on this assignment`}>
                                  Coach usage is engagement, not a measure of mastery. <Link className="underline" to={`/teacher/students/${r.student.id}`}>See how this student uses the Coach</Link>.
                                </NoData>
                              )}
                              {tab === "Verification" && <VerificationList r={r} />}
                              {tab === "Revisions" && (
                                r.attempt ? (
                                  <ul className="space-y-2 text-sm">
                                    {Array.from({ length: r.attempt.number }, (_, i) => r.attempt!.number - i).map((n) => (
                                      <li key={n} className="flex items-center justify-between rounded-[12px] border border-[var(--color-border)] px-4 py-3">
                                        <span><b>Attempt {n}</b>{n === r.attempt!.number ? " · latest" : ""}</span>
                                        <span className="text-[var(--color-ink-muted)]">{n === r.attempt!.number ? `Assignment version ${r.attempt!.assignmentVersion}${r.attempt!.assignmentVersion !== r.assignment.version ? ` (now v${r.assignment.version})` : ""}` : "Earlier attempt"}</span>
                                      </li>
                                    ))}
                                  </ul>
                                ) : <p className="text-sm text-[var(--color-ink-muted)]">No attempts yet.</p>
                              )}
                              {tab === "History" && (
                                student.isPending ? <Skeleton className="h-32 w-full" /> : (() => {
                                  const tl = (student.data?.timeline ?? []).filter((t) => t.assignmentId === r.assignment.id)
                                  return tl.length === 0 ? <p className="text-sm text-[var(--color-ink-muted)]">No recorded activity on this assignment yet.</p> : (
                                    <ol className="space-y-2">{tl.map((t) => (
                                      <li key={t.id} className="flex items-start justify-between gap-3 border-b border-[#eeeee0] pb-2 text-sm">
                                        <span><b className="font-semibold">{t.label}</b>{t.signals.length > 0 && <span className="text-[var(--color-ink-muted)]"> · {t.signals.join(", ")}</span>}</span>
                                        <span className="shrink-0 text-[var(--color-ink-muted)]">{formatDateTime(t.at)}</span>
                                      </li>
                                    ))}</ol>
                                  )
                                })()
                              )}
                            </div>
                          </>
                        )
                      }}
                    </QueryState>
                  </div>
                </section>

                <div className="space-y-5 xl:sticky xl:top-24">
                  {review.data && studentId && !overview.isPending ? (
                    <GradePanel key={`${studentId}:${review.data.grade?.gradedAt ?? "none"}:${overview.data?.settings.updatedAt ?? ""}:${review.data.submission?.id ?? ""}`}
                      assignmentId={assignmentId} studentId={studentId} grade={review.data.grade}
                      hasSubmission={!!review.data.submission} firstName={review.data.student.name.split(" ")[0]} onNext={next}
                      settings={overview.data?.settings ?? null}
                      evaluation={rowOf(studentId)?.evaluation ?? review.data.evaluation ?? null}
                      history={review.data.gradeHistory ?? []} />
                  ) : <Skeleton className="h-[360px] rounded-2xl" />}
                  <section className="ds-card p-6" aria-labelledby="le-h">
                    <h2 id="le-h" className="text-lg font-bold">Learning evidence</h2>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(student.data?.concepts ?? []).filter((c) => c.level).slice(0, 6).map((c) => <Pill key={c.name} tone={c.level === "Strong" ? "ok" : c.level === "Weak" ? "bad" : "or"}>{c.name} · {c.level}</Pill>)}
                      {student.data && !student.data.concepts.some((c) => c.level) && <p className="text-sm text-[var(--color-ink-muted)]">No verified concepts yet.</p>}
                    </div>
                    <div className="mt-4 flex items-center justify-between border-t border-[#eeeee0] pt-4">
                      <button type="button" className="ds-btn ds-btn-sm !rounded-full" disabled={idx <= 0} onClick={() => go({ student: roster[idx - 1].studentId })}><ChevronLeft className="h-4 w-4" aria-hidden="true" />Previous</button>
                      <span className="text-sm text-[var(--color-ink-muted)]">{roster.length ? idx + 1 : 0} of {roster.length}</span>
                      <button type="button" className="ds-btn ds-btn-sm !rounded-full" disabled={idx >= roster.length - 1} onClick={() => go({ student: roster[idx + 1].studentId })}>Next<ChevronRight className="h-4 w-4" aria-hidden="true" /></button>
                    </div>
                  </section>
                </div>
              </div>
            )}
          </>
        )}
      </QueryState>
    </AppShell>
  )
}
