import { useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { Plus } from "lucide-react"
import { AppShell } from "@/components/layout/AppShell"
import { ArrowLink, Avatar, BarChart, Delta, GradeValue, Kpi, Legend, LineChart, NoData, PageTitle, Pill, Section, palette, weekLabel } from "@/components/ds"
import { CourseSelect, NoCourseYet, WeeksSelect, ago, useTeacherScope } from "@/components/teacher/scope"
import { DashboardSkeleton } from "@/components/socratiq/Skeletons"
import { QueryState } from "@/components/ui/States"
import { categoryTone, reviewRows, shortLabel, signalTone } from "@/lib/teacherWork"
import { shortDate } from "@/lib/studentWork"

const BUCKET_COLOR: Record<string, string> = { "<50": palette.rose, "50-59": palette.red, "60-69": palette.red, "70-79": palette.orange, "80-89": palette.orange, "90-100": palette.sage }
const lifecycle = { DRAFT: { t: "Draft", tone: "neu" }, PUBLISHED: { t: "Open", tone: "ok" }, ARCHIVED: { t: "Closed", tone: "neu" } } as const

/** Instructor Overview (approved "E-overview"): where the course stands, how it is trending, and who needs attention. */
export default function TeacherDashboard() {
  const navigate = useNavigate()
  const [weeks, setWeeks] = useState(8)
  const { courses, course, setCourse, dash, insights, detail } = useTeacherScope({ weeks })
  const section = detail.data?.classrooms.map((k) => k.name).join(", ")

  return (
    <AppShell role="teacher" crumbs={[{ label: "Overview" }]}>
      <QueryState query={courses} what="Overview" skeleton={<DashboardSkeleton />}>
        {(list) => !course ? <><PageTitle title="Overview" /><NoCourseYet /></> : (
          <>
            <PageTitle title="Overview"
              subtitle={[course.name, course.code, section, dash.data ? `${dash.data.overview.students} enrolled student${dash.data.overview.students === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ")}
              actions={<>
                {list.length > 1 && <CourseSelect courses={list} course={course} onChange={setCourse} />}
                <WeeksSelect value={weeks} onChange={setWeeks} />
                <Link to={`/teacher/courses/${course.id}/assignments/new`} className="ds-btn ds-btn-pri"><Plus className="h-4 w-4" aria-hidden="true" />New assignment</Link>
              </>} />

            <QueryState query={dash} what="Overview" skeleton={<DashboardSkeleton />}>
              {(d) => {
                const ins = insights.data
                const trend = ins?.trend ?? []
                const withSignals = d.students.filter((s) => (s.observedSignalCount ?? 0) > 0)
                const rows = reviewRows(course.id, d, ins)
                const hasTrend = trend.some((t) => t.averageGrade != null || t.completion != null || t.verificationSuccess != null)
                return (
                  <>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                      <Kpi label="Students" value={d.overview.students}
                        hint={`Enrolled${section ? ` in ${section}` : ""}`} footer={<Delta value={ins?.deltas.students} unit="" />} />
                      <Kpi label="Assignment completion" value={`${d.metrics.assignmentCompletion}%`} spark={trend.map((t) => t.completion)} sparkColor={palette.sage}
                        hint="Submissions received on open + closed work" footer={<Delta value={ins?.deltas.completion} />} />
                      <Kpi label="Average grade" highlight value={d.metrics.averageGrade == null ? "—" : `${d.metrics.averageGrade}%`} spark={trend.map((t) => t.averageGrade)}
                        hint={ins ? `Mean of ${ins.grades.graded} graded · ${ins.grades.awaiting} awaiting a grade` : d.metrics.averageGrade == null ? "No graded work yet" : "Mean of graded work"}
                        footer={<Delta value={ins?.deltas.averageGrade} unit="" />} />
                      <Kpi label="Verification success" value={`${d.metrics.verificationRate}%`} spark={trend.map((t) => t.verificationSuccess)} sparkColor={palette.olive}
                        hint={`Verifications showing understanding (${d.overview.verificationsCompleted} completed)`} footer={<Delta value={ins?.deltas.verificationSuccess} />} />
                      <Kpi label="Review signals" value={withSignals.length} sparkColor={palette.red}
                        hint={`Students with at least 1 signal · ${withSignals.filter((s) => (s.observedSignalCount ?? 0) >= 2).length} have 2 or more`} />
                    </div>

                    <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
                      <section className="ds-card ds-card-pad" aria-labelledby="perf-h">
                        <div className="mb-3.5 flex items-start justify-between gap-3">
                          <div><h2 id="perf-h" className="ds-h2 text-base">Academic performance trend</h2><p className="ds-sub text-[13px]">Average grade of graded work, completion and verification success · weekly</p></div>
                          <WeeksSelect small value={weeks} onChange={setWeeks} />
                        </div>
                        {hasTrend ? (
                          <>
                            <LineChart labels={trend.map((t) => weekLabel(t.weekStart))} fill="#fff1dc"
                              series={[{ name: "Average grade", color: palette.orange, values: trend.map((t) => t.averageGrade) }, { name: "Completion", color: palette.olive, values: trend.map((t) => t.completion) },
                                { name: "Verification success", color: palette.sage, values: trend.map((t) => t.verificationSuccess) }]} />
                            <Legend items={[{ label: "Average grade", color: palette.orange }, { label: "Completion", color: palette.olive }, { label: "Verification success", color: palette.sage }]} />
                          </>
                        ) : <NoData>The weekly trend fills in as students submit and you grade work.</NoData>}
                      </section>
                      <section className="ds-card ds-card-pad flex flex-col" aria-labelledby="dist-h">
                        <h2 id="dist-h" className="ds-h2 text-base">Grade distribution</h2>
                        <p className="ds-sub text-[13px]">{ins ? `${ins.grades.graded} graded · ${ins.grades.awaiting} awaiting grades (not counted as zero)` : "Graded work only"}</p>
                        {ins && ins.grades.graded > 0 ? (
                          <>
                            <div className="mt-4 flex-1"><BarChart height={190} yTicks={[0, 2, 4, 6].filter((t) => t <= Math.max(...ins.grades.distribution.map((b) => b.count)) + 2)}
                              bars={ins.grades.distribution.map((b) => ({ label: b.bucket.replace("-", "–"), value: b.count, color: BUCKET_COLOR[b.bucket] ?? palette.orange }))} /></div>
                            <Legend items={[{ label: "90+", color: palette.sage }, { label: "70–89", color: palette.orange }, { label: "50–69", color: palette.red }, { label: "Below 50", color: palette.rose }]} />
                            <div className="mt-2 flex items-center justify-between text-xs text-[var(--color-ink-muted)]">
                              <span>Highest {ins.grades.highest}% · Lowest {ins.grades.lowest}%</span><ArrowLink to="/teacher/students">Open roster</ArrowLink>
                            </div>
                          </>
                        ) : <NoData className="mt-4 flex-1">No graded work yet.</NoData>}
                      </section>
                    </div>

                    <div className="mt-5">
                      <Section title="Needs attention" sub="Neutral signals from evidence, not conclusions" flush right={rows.length > 0 ? <ArrowLink to="/teacher/review">View all {rows.length}</ArrowLink> : undefined}>
                        {rows.length === 0 ? <p className="px-5 pb-6 text-sm text-[var(--color-ink-muted)]">Nothing needs you right now.</p> : (
                          <div className="ds-table-wrap">
                            <table className="ds-table min-w-[960px]">
                              <thead><tr><th>Student</th><th>Label</th><th>Assignment</th><th>Reason</th><th>Grade</th><th>Review signals</th><th>Last activity</th><th><span className="sr-only">Open</span></th></tr></thead>
                              <tbody>
                                {rows.slice(0, 5).map((r) => (
                                  <tr key={r.key}>
                                    <td>{r.studentId ? <Link to={`/teacher/students/${r.studentId}`} className="flex items-center gap-3 hover:underline"><Avatar name={r.studentName} /><b className="font-semibold">{r.studentName}</b></Link> : <span className="text-[var(--color-ink-muted)]">{r.studentName}</span>}</td>
                                    <td><Pill tone={categoryTone[r.category]}>{shortLabel[r.category]}</Pill></td>
                                    <td>{r.assignmentTitle}</td>
                                    <td className="max-w-[240px] text-[var(--color-ink-muted)]">{r.reason}</td>
                                    <td><GradeValue pct={r.grade} /></td>
                                    <td>{r.studentId && <><Pill tone={signalTone(r.signals)}>{r.signals === 0 ? "No signals" : `${r.signals} signal${r.signals === 1 ? "" : "s"}`}</Pill>{r.signals > 0 && r.signalReason && <span className="mt-0.5 block text-xs text-[var(--color-ink-muted)]">{r.signalReason}</span>}</>}</td>
                                    <td className="whitespace-nowrap">{ago(r.lastActivity)}</td>
                                    <td className="text-right"><button type="button" className="ds-btn ds-btn-sm !rounded-full" onClick={() => navigate(r.action.to)}>Open</button></td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </Section>
                    </div>

                    <div className="mt-5 grid gap-4 lg:grid-cols-2">
                      <Section title="Review signals by type" sub="Signals seen across the class" flush>
                        {ins && ins.signals.byType.length > 0 ? (
                          <table className="ds-table">
                            <thead><tr><th>Review signal</th><th>Students</th><th>Share of class</th></tr></thead>
                            <tbody>{ins.signals.byType.map((s) => (
                              <tr key={s.signal}><td className="font-semibold">{s.label}</td><td className="ds-num">{s.students}</td>
                                <td className="w-[40%]"><span className="flex"><span className="ds-bar !h-2"><i style={{ width: `${d.overview.students ? (s.students / d.overview.students) * 100 : 0}%`, background: palette.red }} /></span></span></td></tr>
                            ))}</tbody>
                          </table>
                        ) : <p className="px-5 pb-6 text-sm text-[var(--color-ink-muted)]">No review signals in this course.</p>}
                      </Section>
                      <Section title="Review signal levels" sub="Students by number of signals · same colors used in every table" flush>
                        {ins ? (
                          <>
                            <table className="ds-table">
                              <tbody>
                                {([["none", "No signals", "ok", palette.sage], ["one", "1 signal", "or", palette.orange], ["two", "2 signals", "warn", palette.red], ["threePlus", "3+ signals", "bad", palette.rose]] as const).map(([k, label, tone, color]) => {
                                  const n = ins.signals.byLevel[k]
                                  const total = Object.values(ins.signals.byLevel).reduce((a, b) => a + b, 0) || 1
                                  return <tr key={k}><td className="w-[120px]"><Pill tone={tone}>{label}</Pill></td><td><span className="flex"><span className="ds-bar !h-2"><i style={{ width: `${(n / total) * 100}%`, background: color }} /></span></span></td><td className="w-12 text-right font-bold ds-num">{n}</td></tr>
                                })}
                              </tbody>
                            </table>
                            <p className="border-t border-[#eeeee0] px-5 py-3 text-xs text-[var(--color-ink-muted)]">{d.riskDisclaimer}</p>
                          </>
                        ) : <p className="px-5 pb-6 text-sm text-[var(--color-ink-muted)]">Signal levels appear once students are active.</p>}
                      </Section>
                    </div>

                    <div className="mt-5">
                      <Section title="Active & recent assignments" flush right={<ArrowLink to="/teacher/assignments">All assignments</ArrowLink>}>
                        {(ins?.assignments ?? []).length === 0 ? <p className="px-5 pb-6 text-sm text-[var(--color-ink-muted)]">No assignments yet. <Link className="underline" to={`/teacher/courses/${course.id}/assignments/new`}>Create one</Link>.</p> : (
                          <div className="ds-table-wrap">
                            <table className="ds-table min-w-[760px]">
                              <thead><tr><th>Assignment</th><th>Status</th><th>Due</th><th>Submitted</th><th>Graded</th><th>Avg grade</th><th>Verification</th></tr></thead>
                              <tbody>{ins!.assignments.filter((a) => a.lifecycle !== "DRAFT").slice(0, 5).map((a) => {
                                const st = a.lifecycle === "PUBLISHED" && a.dueAt && Date.parse(a.dueAt) < Date.now() ? { t: "Closed", tone: "neu" as const } : lifecycle[a.lifecycle]
                                return (
                                  <tr key={a.id} data-href onClick={() => navigate(`/teacher/courses/${course.id}/assignments/${a.id}`)}>
                                    <td><Link to={`/teacher/courses/${course.id}/assignments/${a.id}`} className="font-semibold hover:underline" onClick={(e) => e.stopPropagation()}>{a.title}</Link></td>
                                    <td><Pill tone={st.tone}>{st.t}</Pill></td><td className="ds-num">{shortDate(a.dueAt)}</td>
                                    <td className="ds-num">{a.submitted}/{a.students}</td><td className="ds-num">{a.graded}/{a.submitted}</td>
                                    <td className="font-bold ds-num">{a.averageGrade == null ? "—" : `${a.averageGrade.toFixed(1)}%`}</td><td className="ds-num">{a.verificationRate == null ? "—" : `${a.verificationRate}%`}</td>
                                  </tr>
                                )
                              })}</tbody>
                            </table>
                          </div>
                        )}
                      </Section>
                    </div>
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
