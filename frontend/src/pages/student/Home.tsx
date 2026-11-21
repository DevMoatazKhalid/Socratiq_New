import { useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { CourseCard, courseColor } from "@/components/socratiq/CourseCard"
import { ArrowLink, Bar, BarChart, Delta, GradeValue, Kpi, Legend, LineChart, NoData, PageTitle, Pill, Section, Select, palette, weekLabel } from "@/components/ds"
import { GradedTable, UpcomingTable, verificationPill } from "@/components/student/WorkTables"
import { NoMatches, QueryState, Skeleton } from "@/components/ui/States"
import { useAuth } from "@/lib/auth"
import { notesPanel } from "@/lib/notes"
import { useNotesBoard, type BoardNote } from "@/lib/notesBoard"
import { useStudentHome, useStudentOverview } from "@/lib/queries"
import { matches } from "@/lib/search"
import { byWhatNeedsYou, shortDate, workRows } from "@/lib/studentWork"
import { relativeTime } from "@/lib/time"

function HomeSkeleton() {
  return (
    <div aria-busy="true" className="space-y-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-[170px] rounded-2xl" />)}</div>
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]"><Skeleton className="h-[380px] rounded-2xl" /><Skeleton className="h-[380px] rounded-2xl" /></div>
    </div>
  )
}

const noteOrigin = (n: BoardNote) => `${n.sourceKind === "coach_message" ? "Saved from coach" : "Written by you"} · ${relativeTime(n.updatedAt).toLowerCase()}`

/** Student home (approved "Student flow redesign", page 1): where I stand, how I'm trending, and what needs me next. */
export default function StudentHome() {
  const navigate = useNavigate()
  const { me } = useAuth()
  const home = useStudentHome()
  const [weeks, setWeeks] = useState(8)
  const overview = useStudentOverview(weeks)
  const notes = useNotesBoard()
  const [query, setQuery] = useState("")
  const [courseId, setCourseId] = useState("all")

  const view = useMemo(() => {
    const d = home.data
    if (!d) return null
    const ov = overview.data
    const inCourse = (id: string) => courseId === "all" || id === courseId
    const all = workRows(d.assignments, d.courses, ov).filter((r) => inCourse(r.a.courseId))
    const rows = all.filter((r) => matches(query, r.a.title, r.a.topic, r.course?.name, r.course?.code))
    const upcoming = rows.filter((r) => !r.done).sort(byWhatNeedsYou)
    const graded = rows.filter((r) => r.grade).sort((a, b) => (b.grade!.gradedAt > a.grade!.gradedAt ? 1 : -1))
    const courses = d.courses.filter((c) => inCourse(c.id) && matches(query, c.name, c.code, c.description, c.teacher))
    const noteList = (notes.data?.notes ?? []).filter((n) => (courseId === "all" || n.courseId === courseId) && matches(query, n.title, n.preview))
      .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1))
    const resume = all.filter((r) => r.status === "in_progress").sort(byWhatNeedsYou)[0] ?? all.filter((r) => r.status === "not_started").sort(byWhatNeedsYou)[0]
    return { all, upcoming, graded, courses, notes: noteList, resume, ov }
  }, [home.data, overview.data, notes.data, query, courseId])

  const searching = query.trim() !== ""
  const name = me?.name ?? ""

  return (
    <AppShell role="student" crumbs={[{ label: "Home" }]} search={{ value: query, onChange: setQuery, placeholder: "Search assignments, courses and notes" }}>
      <QueryState query={home} what="Home" skeleton={<><PageTitle title="Home" /><HomeSkeleton /></>}>
        {(d) => {
          if (!view) return null
          const ov = view.ov
          const k = ov?.kpis
          const open = d.assignments.filter((a) => a.status === "not_started" || a.status === "in_progress").length
          const overdue = view.all.filter((r) => r.due.state === "overdue").length
          const nextDue = k?.next ?? null
          const nextIn = nextDue ? Math.max(0, Math.round((Date.parse(nextDue.dueAt) - Date.now()) / 86_400_000)) : null
          const trend = ov?.trend ?? []
          const hasTrend = trend.some((t) => t.averageGrade != null || t.completion != null || t.verificationSuccess != null)
          const perCourse = (ov?.courses ?? []).filter((c) => courseId === "all" || c.courseId === courseId)
          const courseById = new Map(d.courses.map((c) => [c.id, c]))
          const gradedPct = (ov?.assignments ?? []).map((a) => a.grade?.percentage).filter((v): v is number => v != null)
          return (
            <>
              <PageTitle
                title="Home"
                subtitle={`${name}${name ? " · " : ""}${d.courses.length} course${d.courses.length === 1 ? "" : "s"} · ${d.assignments.length} assignment${d.assignments.length === 1 ? "" : "s"}`}
                actions={
                  <>
                    <Select label="Course" value={courseId} onChange={setCourseId}>
                      <option value="all">Course: All courses</option>
                      {d.courses.map((c) => <option key={c.id} value={c.id}>Course: {c.name}</option>)}
                    </Select>
                    <Select label="Time range" value={String(weeks)} onChange={(v) => setWeeks(Number(v))}>
                      <option value="4">Last 4 weeks</option><option value="8">Last 8 weeks</option><option value="12">Last 12 weeks</option>
                    </Select>
                    {view.resume && (
                      <button type="button" className="ds-btn ds-btn-pri" onClick={() => navigate(`/student/courses/${view.resume!.a.courseId}/assignments/${view.resume!.a.id}/coach`)}>
                        Resume with coach
                      </button>
                    )}
                  </>
                }
              />

              {searching && view.upcoming.length + view.graded.length + view.courses.length + view.notes.length === 0 ? (
                <NoMatches query={query} onClear={() => setQuery("")} />
              ) : (
                <>
                  {!searching && (
                    <>
                      {/* KPIs */}
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
                        <Kpi label="Courses" value={d.courses.length} hint="Active this term"
                          footer={overdue > 0 ? <Pill tone="bad">{overdue} overdue</Pill> : <Pill tone="ok">All on track</Pill>} />
                        <Kpi label="Completion" spark={trend.map((t) => t.completion)} sparkColor={palette.olive}
                          value={k ? `${k.assignments ? Math.round((k.submitted / k.assignments) * 100) : 0}%` : "—"}
                          hint={k ? `${k.submitted} of ${k.assignments} submitted` : `${d.assignments.length - open} of ${d.assignments.length} handed in`}
                          footer={<Delta value={ov?.deltas.completion} />} />
                        <Kpi label="Average grade" highlight spark={trend.map((t) => t.averageGrade)} sparkColor={palette.orange}
                          value={k?.averageGrade != null ? `${k.averageGrade}%` : "—"}
                          hint={k ? (k.graded ? `${k.graded} graded · ${k.awaitingGrade} awaiting a grade` : "No graded work yet") : "Appears once work is graded"}
                          footer={<Delta value={ov?.deltas.averageGrade} unit="" />} />
                        <Kpi label="Verification" spark={trend.map((t) => t.verificationSuccess)} sparkColor={palette.sage}
                          value={k ? `${k.verificationsPassed} of ${k.verificationsTotal}` : "—"} hint="Submitted work verified"
                          footer={k && k.verificationsReady > 0 ? <Pill tone="or">{k.verificationsReady} ready now</Pill> : undefined} />
                        <Kpi label="Due this week" value={k?.dueThisWeek ?? "—"} hint={nextDue ? `Next: ${nextDue.title}` : "Nothing due soon"}
                          footer={nextIn != null ? <Pill tone="warn">{nextIn === 0 ? "Due today" : nextIn === 1 ? "Due tomorrow" : `Due in ${nextIn} days`}</Pill> : undefined} />
                      </div>

                      {/* Trend + grade by course */}
                      <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
                        <section className="ds-card ds-card-pad" aria-labelledby="trend-h">
                          <div className="mb-3.5 flex items-start justify-between gap-3">
                            <div>
                              <h2 id="trend-h" className="ds-h2 text-base">My performance trend</h2>
                              <p className="ds-sub text-[13px]">Average grade of graded work, completion and verification success · weekly</p>
                            </div>
                            <Select small label="Trend range" value={String(weeks)} onChange={(v) => setWeeks(Number(v))}>
                              <option value="4">Last 4 weeks</option><option value="8">Last 8 weeks</option><option value="12">Last 12 weeks</option>
                            </Select>
                          </div>
                          {hasTrend ? (
                            <>
                              <LineChart labels={trend.map((t) => weekLabel(t.weekStart))} fill="#fff1dc"
                                series={[{ name: "Average grade", color: palette.orange, values: trend.map((t) => t.averageGrade) },
                                  { name: "Completion", color: palette.olive, values: trend.map((t) => t.completion) },
                                  { name: "Verification success", color: palette.sage, values: trend.map((t) => t.verificationSuccess) }]} />
                              <Legend items={[{ label: "Average grade", color: palette.orange }, { label: "Completion", color: palette.olive }, { label: "Verification success", color: palette.sage }]} />
                            </>
                          ) : <NoData>Your weekly trend appears after your first submissions and grades.</NoData>}
                        </section>
                        <section className="ds-card ds-card-pad flex flex-col" aria-labelledby="gbc-h">
                          <h2 id="gbc-h" className="ds-h2 text-base">Grade by course</h2>
                          <p className="ds-sub text-[13px]">Average of graded work · ungraded work isn't counted as zero</p>
                          {perCourse.some((c) => c.averageGrade != null) ? (
                            <>
                              <div className="mt-6 flex-1">
                                <BarChart unit="%" max={100} height={230}
                                  bars={perCourse.filter((c) => c.averageGrade != null).map((c) => {
                                    const co = courseById.get(c.courseId)
                                    return { label: co?.code ?? "", value: Math.round(c.averageGrade!), color: co ? (courseColor[co.color] ?? palette.orange) : palette.orange }
                                  })} />
                              </div>
                              <div className="mt-4 flex items-center justify-between text-xs text-[var(--color-ink-muted)]">
                                <span>{gradedPct.length ? `Highest ${Math.max(...gradedPct)}% · Lowest ${Math.min(...gradedPct)}%` : ""}</span>
                                <ArrowLink to="/student/courses">Open courses</ArrowLink>
                              </div>
                            </>
                          ) : <NoData className="mt-4 flex-1">No graded work yet.</NoData>}
                        </section>
                      </div>
                    </>
                  )}

                  {/* Courses at a glance + recent notes */}
                  <div className="mt-6 grid gap-4 lg:grid-cols-[2fr_1fr]">
                    <Section title="My courses at a glance" sub="Progress, grades and what's next in each course" right={<ArrowLink to="/student/courses">All courses</ArrowLink>} flush>
                      <div className="ds-table-wrap">
                        <table className="ds-table min-w-[640px]">
                          <thead><tr><th>Course</th><th>Progress</th><th>Avg grade</th><th>Verification</th><th>Next due</th></tr></thead>
                          <tbody>
                            {view.courses.map((c) => {
                              const p = perCourse.find((x) => x.courseId === c.id)
                              const rows = view.all.filter((r) => r.a.courseId === c.id)
                              const done = p?.done ?? rows.filter((r) => r.status === "submitted" || r.status === "verified").length
                              const total = p?.total ?? rows.length
                              const next = p?.nextDue ?? null
                              return (
                                <tr key={c.id} data-href onClick={() => navigate(`/student/courses/${c.id}`)}>
                                  <td><Link to={`/student/courses/${c.id}`} className="block hover:underline" onClick={(e) => e.stopPropagation()}><b className="font-semibold">{c.name}</b><span className="block text-xs text-[var(--color-ink-muted)]">{c.code} · {c.teacher}</span></Link></td>
                                  <td><span className="flex min-w-[140px] items-center gap-3"><Bar value={total ? (done / total) * 100 : 0} label={`${done} of ${total} handed in`} /><span className="whitespace-nowrap ds-num">{done} of {total}</span></span></td>
                                  <td><GradeValue pct={p?.averageGrade ?? null} bold={false} /></td>
                                  <td>{verificationPill(p ? { passed: p.verificationPassed, total: p.verificationTotal, status: "" } : null)}</td>
                                  <td>{next ? `${next.title} · ${shortDate(next.dueAt)}` : <span className="text-[var(--color-ink-muted)]">Nothing due</span>}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </Section>
                    <section className="ds-card ds-card-pad flex flex-col" aria-labelledby="notes-h">
                      <div className="flex items-center justify-between gap-3">
                        <h2 id="notes-h" className="ds-h2 text-base">Recent notes</h2>
                        <Link to="/student/notes?new=1" className="ds-btn ds-btn-sm !rounded-full">New note</Link>
                      </div>
                      {view.notes.length === 0 ? (
                        <p className="mt-4 text-sm text-[var(--color-ink-muted)]">{notes.isPending ? "Loading notes…" : "No notes yet. Save a coach reply or write your own."}</p>
                      ) : (
                        <ul className="mt-3 flex-1">
                          {view.notes.slice(0, 3).map((n) => (
                            <li key={n.id} className="border-b border-[#eeeee0] last:border-0">
                              <button type="button" onClick={() => notesPanel.set({ open: true, noteId: n.id })} className="block w-full py-3 text-left">
                                <b className="block text-sm font-semibold hover:underline">{n.title || "Untitled note"}</b>
                                <span className="text-xs text-[var(--color-ink-muted)]">{noteOrigin(n)}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      <ArrowLink to="/student/notes" className="mt-2">Open notes</ArrowLink>
                    </section>
                  </div>

                  <div className="mt-6"><UpcomingTable rows={view.upcoming} /></div>
                  <div className="mt-6"><GradedTable rows={view.graded} /></div>

                  {view.courses.length > 0 && (
                    <>
                      <div className="mb-3 mt-7 flex items-center justify-between">
                        <h2 className="text-lg font-bold text-[var(--color-ink)]">My courses</h2>
                        <ArrowLink to="/student/courses">All courses</ArrowLink>
                      </div>
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        {view.courses.map((c) => {
                          const rows = view.all.filter((r) => r.a.courseId === c.id)
                          const openN = rows.filter((r) => !r.done && r.status !== "submitted").length
                          return <CourseCard key={c.id} course={c} to={`/student/courses/${c.id}`} footer={`${c.assignmentCount} assignment${c.assignmentCount === 1 ? "" : "s"} · ${openN} open`} />
                        })}
                      </div>
                    </>
                  )}
                </>
              )}
            </>
          )
        }}
      </QueryState>
    </AppShell>
  )
}
