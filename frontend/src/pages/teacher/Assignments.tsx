import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { ArrowRight, Plus } from "lucide-react"
import { AppShell } from "@/components/layout/AppShell"
import { BarChart, GradeValue, NoData, PageTitle, Pill, palette } from "@/components/ds"
import { CourseSelect, NoCourseYet, useTeacherScope } from "@/components/teacher/scope"
import { DashboardSkeleton } from "@/components/socratiq/Skeletons"
import { QueryState, Skeleton } from "@/components/ui/States"
import { useTeacherAssignment, type TeacherInsights } from "@/lib/queries"
import { shortDate } from "@/lib/studentWork"
import { gradeLink } from "@/lib/teacherWork"
import { cn } from "@/lib/utils"

type Asg = TeacherInsights["assignments"][number]
type Filter = "all" | "open" | "closed" | "draft"
const stateOf = (a: Asg): Exclude<Filter, "all"> =>
  a.lifecycle === "DRAFT" ? "draft" : a.lifecycle === "ARCHIVED" || (a.dueAt && Date.parse(a.dueAt) < Date.now()) ? "closed" : "open"
const STATE = { open: { t: "Open", tone: "ok" }, closed: { t: "Closed", tone: "neu" }, draft: { t: "Draft", tone: "or" } } as const
const POLICY: Record<string, string[]> = { guided: ["Hints only", "Verification required", "No code generation"], assisted: ["Worked hints", "Verification required"], open: ["Open assistance", "Verification required"] }
const BUCKETS = [["<50", 0, 50, palette.rose], ["50–59", 50, 60, palette.red], ["60–69", 60, 70, palette.red], ["70–79", 70, 80, palette.orange], ["80–89", 80, 90, palette.orange], ["90+", 90, 101, palette.sage]] as const

function Donut({ graded, pending, missing }: { graded: number; pending: number; missing: number }) {
  const total = graded + pending + missing || 1
  const R = 80, C = 2 * Math.PI * R
  let off = 0
  const seg = (n: number, color: string) => {
    const len = (n / total) * C
    const el = <circle key={color} r={R} cx="100" cy="100" fill="none" stroke={color} strokeWidth="26" strokeDasharray={`${Math.max(0, len - 3)} ${C}`} strokeDashoffset={-off} transform="rotate(-90 100 100)" />
    off += len
    return el
  }
  return (
    <svg viewBox="0 0 200 200" className="h-[190px] w-[190px] shrink-0" role="img" aria-label={`${graded + pending} of ${total} submitted: ${graded} graded, ${pending} pending grading, ${missing} not submitted`}>
      <circle r={R} cx="100" cy="100" fill="none" stroke="#edecdf" strokeWidth="26" />
      {seg(graded, palette.sage)}{seg(pending, palette.orange)}{seg(missing, "#d8dac4")}
      <text x="100" y="104" textAnchor="middle" fontSize="34" fontWeight="700" fill="#141102">{graded + pending}/{total}</text>
      <text x="100" y="126" textAnchor="middle" fontSize="12" fill="#5f5d53">submitted</text>
    </svg>
  )
}

function Detail({ courseId, a, ins }: { courseId: string; a: Asg; ins: TeacherInsights }) {
  const navigate = useNavigate()
  const q = useTeacherAssignment(a.id)
  const subs = ins.submissions.filter((s) => s.assignmentId === a.id)
  const graded = subs.filter((s) => s.grade)
  const pending = subs.filter((s) => !s.grade)
  const st = STATE[stateOf(a)]
  return (
    <section className="ds-card mt-5 overflow-hidden !border-[var(--color-plum)]" aria-labelledby="ad-h">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border)] bg-[#fffaf5] px-7 py-6">
        <div>
          <p className="text-sm text-[var(--color-ink-muted)]">Assignments › {st.t}</p>
          <h2 id="ad-h" className="ds-h1 !text-[30px]">{a.title}</h2>
          <p className="mt-1 text-sm text-[var(--color-ink-muted)]">{[a.dueAt ? `Due ${shortDate(a.dueAt)}` : "No due date", a.maxScore != null ? `Max score ${a.maxScore}` : null, q.data?.aiMode ? `${q.data.aiMode[0].toUpperCase()}${q.data.aiMode.slice(1)} AI assistance` : null].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="flex gap-2">
          <Link to={`/teacher/courses/${courseId}/assignments/${a.id}`} className="ds-btn !rounded-full">Edit</Link>
          {pending[0] && <button type="button" className="ds-btn ds-btn-pri !rounded-full" onClick={() => navigate(gradeLink(courseId, a.id, pending[0].studentId))}>Grade next ungraded</button>}
        </div>
      </div>
      <div className="grid gap-8 px-7 py-6 lg:grid-cols-[1fr_1.4fr_1.3fr]">
        <div>
          <h3 className="text-lg font-bold">Instructions</h3>
          {q.isPending ? <Skeleton className="mt-2 h-16" /> : <p className="mt-2 line-clamp-6 whitespace-pre-wrap text-[15px] leading-relaxed text-[var(--color-ink-muted)]">{q.data?.prompt || "No instructions."}</p>}
          <h3 className="mt-5 text-lg font-bold">AI assistance policy</h3>
          <div className="mt-2 flex flex-wrap gap-2">{(POLICY[q.data?.aiMode ?? "guided"] ?? []).map((p, i) => <Pill key={p} tone={i === 1 ? "warn" : "info"}>{p}</Pill>)}</div>
          <h3 className="mt-5 text-lg font-bold">Materials</h3>
          <p className="mt-1 text-[15px] text-[var(--color-ink-muted)]">{q.data?.linkedMaterials.length ? q.data.linkedMaterials.map((m) => m.title).join(" · ") : "No linked materials"}</p>
        </div>
        <div>
          <h3 className="text-lg font-bold">Submissions</h3>
          <div className="mt-3 flex flex-wrap items-center gap-6">
            <Donut graded={a.graded} pending={Math.max(0, a.submitted - a.graded)} missing={Math.max(0, a.students - a.submitted)} />
            <dl className="min-w-[200px] flex-1 text-[15px]">
              {([["Submitted", `${a.submitted} of ${a.students}`, null], ["Graded", a.graded, palette.sage], ["Pending grading", Math.max(0, a.submitted - a.graded), palette.orange], ["Not submitted", Math.max(0, a.students - a.submitted), "#d8dac4"]] as const).map(([k, v, c]) => (
                <div key={k} className="flex items-center justify-between border-b border-[#eeeee0] py-2 last:border-0">
                  <dt className="flex items-center gap-2 text-[var(--color-ink-muted)]">{c && <i className="ds-dot" style={{ background: c }} />}{k}</dt><dd className="font-bold ds-num">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
        <div>
          <h3 className="text-lg font-bold">Grade distribution <span className="text-sm font-normal text-[var(--color-ink-muted)]">· {graded.length} graded</span></h3>
          {graded.length ? <BarChart height={190} yTicks={[0, 2, 4]} bars={BUCKETS.map(([l, lo, hi, c]) => ({ label: l, value: graded.filter((s) => s.grade!.percentage >= lo && s.grade!.percentage < hi).length, color: c }))} />
            : <NoData className="mt-3">No graded submissions yet.</NoData>}
        </div>
      </div>
      <div className="ds-table-wrap border-t border-[var(--color-border)]">
        <table className="ds-table min-w-[860px]">
          <thead><tr><th>Student</th><th>Submission</th><th>Date</th><th>Grade</th><th>Verification</th><th>Revisions</th><th>Review</th><th><span className="sr-only">Action</span></th></tr></thead>
          <tbody>
            {q.isPending && <tr><td colSpan={8}><Skeleton className="h-10" /></td></tr>}
            {(q.data?.submissions ?? []).map((s) => {
              const sub = subs.find((x) => x.studentId === s.studentId)
              const handed = s.status === "submitted" || s.status === "verified"
              const v = sub?.verification
              return (
                <tr key={s.studentId}>
                  <td><Link to={`/teacher/students/${s.studentId}`} className="font-semibold hover:underline">{s.studentName}</Link></td>
                  <td><Pill tone={handed ? "ok" : "neu"}>{handed ? "Submitted" : "Not submitted"}</Pill></td>
                  <td className="ds-num">{handed ? shortDate(sub?.submittedAt ?? s.submittedAt) : "—"}</td>
                  <td><GradeValue pct={sub?.grade?.percentage ?? null} /></td>
                  <td>{!handed ? "—" : !v || v.status !== "COMPLETED" ? <Pill tone="or">Pending</Pill> : <Pill tone={v.outcome === "PASS" ? "ok" : v.outcome === "FAIL" ? "bad" : "warn"}>{v.outcome === "PASS" ? "Passed" : v.outcome === "FAIL" ? "Not passed" : "Partly"}</Pill>}</td>
                  <td className="ds-num">{sub ? sub.attemptNumber - 1 : 0}</td>
                  <td>{!handed ? "—" : sub?.grade ? <Pill tone="ok">Reviewed</Pill> : <Pill tone="or">Open</Pill>}</td>
                  <td className="text-right">{handed ? <button type="button" className="ds-btn ds-btn-sm !rounded-full" onClick={() => navigate(gradeLink(courseId, a.id, s.studentId))}>Grade</button> : <Link to={`/teacher/students/${s.studentId}`} className="ds-btn ds-btn-sm !rounded-full">Student</Link>}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** Assignments (approved design): create, publish, grade and review every assignment, with the selected one opened below the list. */
export default function TeacherAssignments() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { courses, course, setCourse, insights } = useTeacherScope()
  const filter = (params.get("show") as Filter) || "all"
  const set = (k: string, v: string | null) => setParams((p) => { if (v) p.set(k, v); else p.delete(k); return p }, { replace: true })

  return (
    <AppShell role="teacher" crumbs={[{ label: "Assignments" }]}>
      <QueryState query={courses} what="Assignments" skeleton={<DashboardSkeleton />}>
        {(list) => !course ? <><PageTitle title="Assignments" /><NoCourseYet /></> : (
          <>
            <PageTitle title="Assignments" subtitle="Create, publish, grade and review every assignment"
              actions={<>{list.length > 1 && <CourseSelect courses={list} course={course} onChange={(id) => { setCourse(id); set("id", null) }} />}
                <Link to={`/teacher/courses/${course.id}/assignments/new`} className="ds-btn ds-btn-pri"><Plus className="h-4 w-4" aria-hidden="true" />New assignment</Link></>} />
            <QueryState query={insights} what="Assignments" skeleton={<DashboardSkeleton />}>
              {(ins) => {
                if (!ins) return <NoData title="Assignment statistics aren't available">Open a course to manage its assignments. <Link className="underline" to={`/teacher/courses/${course.id}`}>Go to {course.name}</Link></NoData>
                const count = (f: Filter) => ins.assignments.filter((a) => f === "all" || stateOf(a) === f).length
                const rows = ins.assignments.filter((a) => filter === "all" || stateOf(a) === filter)
                const sel = ins.assignments.find((a) => a.id === params.get("id")) ?? rows.find((a) => stateOf(a) === "open") ?? rows[0]
                return (
                  <>
                    <div className="ds-tabs mb-5" role="tablist" aria-label="Filter assignments">
                      {(["all", "open", "closed", "draft"] as const).map((f) => (
                        <button key={f} type="button" role="tab" aria-selected={filter === f} className="ds-tab !text-[15px]" onClick={() => set("show", f === "all" ? null : f)}>
                          {f === "all" ? "All" : f === "draft" ? "Drafts" : STATE[f].t} · {count(f)}
                        </button>
                      ))}
                    </div>
                    <div className="ds-card overflow-hidden">
                      {rows.length === 0 ? <p className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)]">No assignments here. <Link className="underline" to={`/teacher/courses/${course.id}/assignments/new`}>Create one</Link>.</p> : (
                        <div className="ds-table-wrap">
                          <table className="ds-table min-w-[900px]">
                            <thead><tr><th>Assignment</th><th>Status</th><th>Due</th><th>Submissions</th><th>Graded</th><th>Avg grade</th><th>Verif. success</th><th><span className="sr-only">Open</span></th></tr></thead>
                            <tbody>
                              {rows.map((a) => {
                                const st = STATE[stateOf(a)]
                                return (
                                  <tr key={a.id} data-href onClick={() => set("id", a.id)} className={cn(sel?.id === a.id && "[&>td]:!bg-[#fffaf5]")} aria-selected={sel?.id === a.id}>
                                    <td><button type="button" className="text-left" onClick={() => set("id", a.id)}><b className="block font-semibold">{a.title}</b>{a.maxScore != null && <span className="text-xs text-[var(--color-ink-muted)]">Max score {a.maxScore}</span>}</button></td>
                                    <td><Pill tone={st.tone}>{st.t}</Pill></td>
                                    <td className="ds-num">{a.dueAt ? shortDate(a.dueAt) : "—"}</td>
                                    <td>{a.lifecycle === "DRAFT" ? "–" : <span className="flex min-w-[200px] items-center gap-3"><span className="ds-bar"><i style={{ width: `${a.students ? (a.submitted / a.students) * 100 : 0}%`, background: palette.orange }} /></span><span className="ds-num">{a.submitted}/{a.students}</span></span>}</td>
                                    <td className="ds-num">{a.graded}/{a.submitted}</td>
                                    <td className="font-bold ds-num">{a.averageGrade == null ? "—" : `${a.averageGrade.toFixed(1)}%`}</td>
                                    <td className="ds-num">{a.verificationRate == null ? "—" : `${a.verificationRate}%`}</td>
                                    <td className="w-10"><button type="button" aria-label={`Open ${a.title}`} onClick={(e) => { e.stopPropagation(); navigate(`/teacher/courses/${course.id}/assignments/${a.id}`) }}><ArrowRight className="h-4 w-4" /></button></td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                    {sel && <Detail key={sel.id} courseId={course.id} a={sel} ins={ins} />}
                  </>
                )
              }}
            </QueryState>
          </>
        )}
      </QueryState>
    </AppShell>
  )
}
