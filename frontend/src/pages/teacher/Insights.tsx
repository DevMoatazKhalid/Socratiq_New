import { useState } from "react"
import { Link, useSearchParams } from "react-router-dom"
import { Search } from "lucide-react"
import { AppShell } from "@/components/layout/AppShell"
import { Avatar, BarChart, GradeValue, Kpi, LineChart, NoData, PageTitle, Pill, Section, palette, weekLabel } from "@/components/ds"
import { CourseSelect, NoCourseYet, WeeksSelect, useTeacherScope } from "@/components/teacher/scope"
import { DashboardSkeleton } from "@/components/socratiq/Skeletons"
import type { Dashboard, useTeacherCourse } from "@/lib/queries"
import type { ActivityEntry, Course } from "@/types"
import { QueryState } from "@/components/ui/States"
import { matches } from "@/lib/search"
import { formatDay, formatTime } from "@/lib/time"

const KIND = { submission: "Submission", revision: "Revision", verification: "Verification", coach_session: "AI Coach" } as const
type Kind = keyof typeof KIND
type When = "" | "today" | "yesterday" | "7" | "30"
/** Activity date presets (approved design): Today, Yesterday, Last 7 days, Last 30 days, inside the loaded time range. */
function inWhen(iso: string, when: When) {
  if (!when) return true
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const t = Date.parse(iso), day = 86_400_000
  if (when === "today") return t >= start.getTime()
  if (when === "yesterday") return t >= start.getTime() - day && t < start.getTime()
  return t >= Date.now() - Number(when) * day
}
function WhenSelect({ value, onChange }: { value: When; onChange: (w: When) => void }) {
  return (
    <select aria-label="Date" className="ds-sel" value={value} onChange={(e) => onChange(e.target.value as When)}>
      <option value="">Any day</option><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option>
    </select>
  )
}

/** Insights & Activity (approved design): deeper analysis of grades, understanding and Coach usage, and everything that happened in the class. */
export default function TeacherInsights() {
  const [params, setParams] = useSearchParams()
  const tab = params.get("tab") === "activity" ? "activity" : "insights"
  const [weeks, setWeeks] = useState(8)
  const { courses, course, setCourse, dash, insights, detail } = useTeacherScope({ weeks })
  const [assignment, setAssignment] = useState("")
  const [query, setQuery] = useState("")
  const [kind, setKind] = useState<"all" | Kind>("all")
  const [when, setWhen] = useState<When>("")

  return (
    <AppShell role="teacher" crumbs={[{ label: "Insights & Activity" }]}>
      <PageTitle title="Insights & Activity" subtitle={tab === "insights" ? "Deeper analysis of grades, understanding and Coach usage" : "Everything that happened in the class, newest first"} />
      <div className="ds-tabs mb-5" role="tablist" aria-label="Insights and activity">
        {(["insights", "activity"] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className="ds-tab" onClick={() => setParams(t === "activity" ? { tab: "activity" } : {}, { replace: true })}>{t === "insights" ? "Insights" : "Activity"}</button>
        ))}
      </div>
      <QueryState query={courses} what="Insights" skeleton={<DashboardSkeleton />}>
        {(list) => !course ? <NoCourseYet /> : (
          <QueryState query={insights} what="Insights" skeleton={<DashboardSkeleton />}>
            {(ins) => {
              if (!ins) return <LimitedInsights tab={tab} list={list} course={course} setCourse={setCourse} weeks={weeks} setWeeks={setWeeks} dash={dash.data} detail={detail.data}
                query={query} setQuery={setQuery} kind={kind} setKind={setKind} when={when} setWhen={setWhen} />
              const asgs = ins.assignments.filter((a) => a.lifecycle !== "DRAFT")
              const grades = ins.trend.map((t) => t.averageGrade)
              const firstI = grades.findIndex((g) => g != null)
              const lastI = grades.length - 1 - [...grades].reverse().findIndex((g) => g != null)
              const change = firstI >= 0 && lastI > firstI ? (grades[lastI]! - grades[firstI]!) : null
              const filters = (
                <div className="mb-5 flex flex-wrap items-center gap-2.5">
                  {list.length > 1 ? <CourseSelect courses={list} course={course} onChange={setCourse} /> : <span className="ds-sel">Course: {course.name}</span>}
                  <WeeksSelect value={weeks} onChange={setWeeks} />
                  {tab === "insights" && (
                    <select aria-label="Assignment" className="ds-sel" value={assignment} onChange={(e) => setAssignment(e.target.value)}>
                      <option value="">Assignment: All</option>{asgs.map((a) => <option key={a.id} value={a.id}>Assignment: {a.title}</option>)}
                    </select>
                  )}
                </div>
              )
              if (tab === "activity") {
                const items = ins.activity.filter((e) => inWhen(e.date, when)).filter((e) => kind === "all" || e.kind === kind).filter((e) => matches(query, e.detail, e.assignmentTitle, e.studentName))
                const days = new Map<string, typeof items>()
                items.forEach((e) => { const k = formatDay(e.date); days.set(k, [...(days.get(k) ?? []), e]) })
                return (
                  <>
                    <div className="mb-4 flex flex-wrap items-center gap-2.5">
                      <label className="ds-search w-full sm:w-[260px]"><Search className="h-4 w-4 shrink-0" aria-hidden="true" />
                        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search activity" aria-label="Search activity" /></label>
                      <WhenSelect value={when} onChange={setWhen} />
                      <WeeksSelect value={weeks} onChange={setWeeks} />
                      {list.length > 1 ? <CourseSelect courses={list} course={course} onChange={setCourse} /> : <span className="ds-sel">{course.name}</span>}
                      <span className="text-sm text-[var(--color-ink-muted)]">{items.length} event{items.length === 1 ? "" : "s"}</span>
                    </div>
                    <div role="group" aria-label="Type" className="mb-5 flex flex-wrap gap-2">
                      <button type="button" className="ds-chip" aria-pressed={kind === "all"} onClick={() => setKind("all")}>All</button>
                      {(Object.keys(KIND) as Kind[]).map((k) => <button key={k} type="button" className="ds-chip" aria-pressed={kind === k} onClick={() => setKind(k)}>{KIND[k]}s</button>)}
                    </div>
                    {items.length === 0 ? <NoData title="No activity">Nothing matches in this period.</NoData> : [...days.entries()].map(([day, evs]) => (
                      <div key={day} className="mb-5">
                        <Section title={`${day} · ${evs.length} event${evs.length === 1 ? "" : "s"}`} flush>
                          <table className="ds-table">
                            <thead><tr><th>Activity</th><th>Type</th><th>Time</th></tr></thead>
                            <tbody>{evs.map((e) => (
                              <tr key={e.id}>
                                <td>{e.studentId ? <Link to={`/teacher/students/${e.studentId}`} className="font-semibold hover:underline">{e.studentName}</Link> : e.studentName && <b className="font-semibold">{e.studentName}</b>} {e.detail.replace(e.studentName ?? "\u0000", "").trim()}{!e.detail.includes(e.assignmentTitle) && e.assignmentTitle ? ` · ${e.assignmentTitle}` : ""}</td>
                                <td><Pill tone={e.kind === "submission" ? "info" : e.kind === "verification" ? "ok" : e.kind === "revision" ? "or" : "neu"}>{KIND[e.kind]}</Pill></td>
                                <td className="whitespace-nowrap text-[var(--color-ink-muted)]">{formatTime(e.date)}</td>
                              </tr>
                            ))}</tbody>
                          </table>
                        </Section>
                      </div>
                    ))}
                  </>
                )
              }
              const perf = asgs.filter((a) => !assignment || a.id === assignment)
              const support = (dash.data?.reviewQueue ?? []).filter((q) => q.kind === "learning_support" || q.focus === "learning_difficulty" || q.focus === "verification")
              return (
                <>
                  {filters}
                  <div className="grid gap-4 lg:grid-cols-2">
                    <section className="ds-card ds-card-pad" aria-labelledby="agt">
                      <h2 id="agt" className="ds-h2 text-base">Average grade trend</h2>
                      <p className="ds-sub mb-3 text-[13px]">Weekly mean of graded work{change != null ? ` · ${change >= 0 ? "up" : "down"} ${Math.abs(change).toFixed(1)} points since ${weekLabel(ins.trend[firstI].weekStart)}` : ""}</p>
                      {firstI >= 0 ? <LineChart height={230} labels={ins.trend.map((t) => weekLabel(t.weekStart))} fill="#fff1dc" series={[{ name: "Average grade", color: palette.orange, values: grades }]} />
                        : <NoData>No graded work in this period.</NoData>}
                    </section>
                    <section className="ds-card ds-card-pad" aria-labelledby="gba">
                      <h2 id="gba" className="ds-h2 text-base">Grade by assignment</h2>
                      <p className="ds-sub mb-3 text-[13px]">Average of graded submissions · highlighted = open work, partly graded</p>
                      {asgs.some((a) => a.averageGrade != null) ? (
                        <BarChart width={620} height={260} unit="%" max={100} bars={asgs.filter((a) => a.averageGrade != null).map((a) => ({ label: a.title.length > 12 ? a.title.slice(0, 11) + "…" : a.title, value: Math.round(a.averageGrade!), color: a.graded < a.submitted ? palette.orange : "#babd8e" }))} />
                      ) : <NoData>No graded work yet.</NoData>}
                    </section>
                  </div>

                  <div className="mt-4 grid gap-4 lg:grid-cols-2">
                    <Section title="Performance by assignment" flush>
                      <table className="ds-table">
                        <thead><tr><th>Assignment</th><th>Avg grade</th><th>Completion</th><th>Verification success</th></tr></thead>
                        <tbody>{perf.length === 0 ? <tr><td colSpan={4} className="text-[var(--color-ink-muted)]">No published assignments.</td></tr> : perf.map((a) => (
                          <tr key={a.id}><td className="font-semibold">{a.title}</td><td><GradeValue pct={a.averageGrade} bold={false} /></td>
                            <td className="ds-num">{a.students ? Math.round((a.submitted / a.students) * 100) : 0}%</td><td className="ds-num">{a.verificationRate == null ? "—" : `${a.verificationRate}%`}</td></tr>
                        ))}</tbody>
                      </table>
                    </Section>
                    <Section title="Concept difficulty" flush>
                      <table className="ds-table">
                        <thead><tr><th>Concept</th><th>Verified mastery</th><th>Level</th><th>Evidence</th></tr></thead>
                        <tbody>{ins.concepts.length === 0 ? <tr><td colSpan={4} className="text-[var(--color-ink-muted)]">No verified concepts yet.</td></tr> : ins.concepts.map((c) => (
                          <tr key={c.name}><td className="font-semibold">{c.name}</td><td className="ds-num">{c.mastery == null ? "—" : `${Math.round(c.mastery * 100)}%`}</td>
                            <td><Pill tone={c.level === "Strong" ? "ok" : c.level === "Weak" ? "bad" : c.level ? "or" : "neu"}>{c.level ?? "No data"}</Pill></td>
                            <td className="text-[var(--color-ink-muted)]">{c.assignments ? `${c.assignments} assignment${c.assignments === 1 ? "" : "s"}` : "No evidence yet"}</td></tr>
                        ))}</tbody>
                      </table>
                    </Section>
                  </div>

                  <div className="mt-4 grid gap-4 lg:grid-cols-2">
                    <section className="ds-card ds-card-pad" aria-labelledby="acu">
                      <h2 id="acu" className="ds-h2 text-base">AI Coach usage</h2>
                      <p className="ds-sub mb-3 text-[13px]">Coach turns per week · engagement only, not a measure of mastery</p>
                      {ins.coachWeekly.some((w) => w.turns > 0) ? <BarChart width={620} height={240} bars={ins.coachWeekly.map((w) => ({ label: weekLabel(w.weekStart), value: w.turns, color: "#babd8e" }))} /> : <NoData>No Coach sessions in this period.</NoData>}
                    </section>
                    <Section title="Students who may benefit from support" flush>
                      <table className="ds-table">
                        <thead><tr><th>Student</th><th>Focus area</th><th>Confidence</th></tr></thead>
                        <tbody>{support.length === 0 ? <tr><td colSpan={3} className="text-[var(--color-ink-muted)]">No students flagged for support.</td></tr> : support.map((q) => (
                          <tr key={q.studentId}><td><Link to={`/teacher/students/${q.studentId}`} className="flex items-center gap-3 hover:underline"><Avatar name={q.name} /><b className="font-semibold">{q.name}</b></Link></td>
                            <td>{q.primaryReason ?? "Learning support"}</td><td><Pill tone={q.confidenceLabel === "High" ? "bad" : q.confidenceLabel === "Medium" ? "warn" : "neu"}>{q.confidenceLabel}</Pill></td></tr>
                        ))}</tbody>
                      </table>
                    </Section>
                  </div>
                </>
              )
            }}
          </QueryState>
        )}
      </QueryState>
    </AppShell>
  )
}

type CourseDetailData = NonNullable<ReturnType<typeof useTeacherCourse>["data"]>

/**
 * The page on a server without the insights endpoint (older backend, or migrations not applied). Everything here comes from the course
 * dashboard and course endpoints that every server has, so the numbers are real; the analyses that need the insights endpoint (grade
 * trend, grade by assignment, concept mastery, Coach usage per week) are named instead of being drawn empty.
 */
function LimitedInsights({ tab, list, course, setCourse, weeks, setWeeks, dash, detail, query, setQuery, kind, setKind, when, setWhen }: {
  tab: "insights" | "activity"; list: Course[]; course: Course; setCourse: (id: string) => void; weeks: number; setWeeks: (n: number) => void
  dash?: Dashboard; detail?: CourseDetailData; query: string; setQuery: (q: string) => void; kind: "all" | Kind; setKind: (k: "all" | Kind) => void; when: When; setWhen: (w: When) => void
}) {
  const note = (
    <p className="mb-4 rounded-[12px] border border-[#ecd9b8] bg-[#fff8ea] px-4 py-2.5 text-[13px] text-[#6b4f1d]" role="note">
      Showing the course summary. Grade trends, grades by assignment, concept mastery and weekly Coach usage appear once the server is updated.
    </p>
  )
  const courseSel = list.length > 1 ? <CourseSelect courses={list} course={course} onChange={setCourse} /> : <span className="ds-sel">Course: {course.name}</span>
  if (!dash) return <DashboardSkeleton />
  if (tab === "activity") {
    const since = Date.now() - weeks * 7 * 86_400_000
    const items: ActivityEntry[] = dash.activity.filter((e) => Date.parse(e.date) >= since && inWhen(e.date, when)).filter((e) => kind === "all" || e.kind === kind).filter((e) => matches(query, e.detail, e.assignmentTitle))
    const days = new Map<string, ActivityEntry[]>()
    items.forEach((e) => { const k = formatDay(e.date); days.set(k, [...(days.get(k) ?? []), e]) })
    return (
      <>
        <div className="mb-4 flex flex-wrap items-center gap-2.5">
          <label className="ds-search w-full sm:w-[260px]"><Search className="h-4 w-4 shrink-0" aria-hidden="true" />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search activity" aria-label="Search activity" /></label>
          <WhenSelect value={when} onChange={setWhen} />
          <WeeksSelect value={weeks} onChange={setWeeks} />
          {courseSel}
          <span className="text-sm text-[var(--color-ink-muted)]">{items.length} event{items.length === 1 ? "" : "s"}</span>
        </div>
        <div role="group" aria-label="Type" className="mb-5 flex flex-wrap gap-2">
          <button type="button" className="ds-chip" aria-pressed={kind === "all"} onClick={() => setKind("all")}>All</button>
          {(Object.keys(KIND) as Kind[]).map((k) => <button key={k} type="button" className="ds-chip" aria-pressed={kind === k} onClick={() => setKind(k)}>{KIND[k]}s</button>)}
        </div>
        {items.length === 0 ? <NoData title="No activity">Nothing matches in this period.</NoData> : [...days.entries()].map(([day, evs]) => (
          <div key={day} className="mb-5">
            <Section title={`${day} · ${evs.length} event${evs.length === 1 ? "" : "s"}`} flush>
              <table className="ds-table">
                <thead><tr><th>Activity</th><th>Type</th><th>Time</th></tr></thead>
                <tbody>{evs.map((e) => (
                  <tr key={e.id}>
                    <td>{e.detail}{!e.detail.includes(e.assignmentTitle) && e.assignmentTitle ? ` · ${e.assignmentTitle}` : ""}</td>
                    <td><Pill tone={e.kind === "submission" ? "info" : e.kind === "verification" ? "ok" : e.kind === "revision" ? "or" : "neu"}>{KIND[e.kind]}</Pill></td>
                    <td className="whitespace-nowrap text-[var(--color-ink-muted)]">{formatTime(e.date)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </Section>
          </div>
        ))}
      </>
    )
  }
  const m = dash.metrics
  const asgs = (detail?.assignments ?? []).filter((a) => a.lifecycle !== "DRAFT")
  const support = dash.reviewQueue.filter((q) => q.kind === "learning_support" || q.focus === "learning_difficulty" || q.focus === "verification")
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2.5">{courseSel}</div>
      {note}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Kpi label="Assignment completion" value={`${m.assignmentCompletion}%`} hint="Share of published work submitted" />
        <Kpi label="Average grade" highlight value={m.averageGrade == null ? "—" : `${m.averageGrade}%`} hint={m.averageGrade == null ? "No graded work yet" : "Mean of graded work"} />
        <Kpi label="Verification success" value={`${m.verificationRate}%`} hint="Verifications passed" />
        <Kpi label="AI Coach use" value={`${m.socraticAiUsage}%`} hint="Assignments with Coach help" />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="ds-card ds-card-pad" aria-labelledby="cba">
          <h2 id="cba" className="ds-h2 text-base">Completion by assignment</h2>
          <p className="ds-sub mb-3 text-[13px]">Students who submitted, out of everyone enrolled</p>
          {asgs.length ? <BarChart width={620} height={240} unit="%" max={100} bars={asgs.map((a) => ({ label: a.title.length > 12 ? a.title.slice(0, 11) + "…" : a.title, value: a.studentCount ? Math.round((a.submittedCount / a.studentCount) * 100) : 0, color: "#babd8e" }))} />
            : <NoData>No published assignments.</NoData>}
        </section>
        <Section title="Students who may benefit from support" flush>
          <table className="ds-table">
            <thead><tr><th>Student</th><th>Focus area</th><th>Confidence</th></tr></thead>
            <tbody>{support.length === 0 ? <tr><td colSpan={3} className="text-[var(--color-ink-muted)]">No students flagged for support.</td></tr> : support.map((q) => (
              <tr key={q.studentId}><td><Link to={`/teacher/students/${q.studentId}`} className="flex items-center gap-3 hover:underline"><Avatar name={q.name} /><b className="font-semibold">{q.name}</b></Link></td>
                <td>{q.primaryReason ?? "Learning support"}</td><td><Pill tone={q.confidenceLabel === "High" ? "bad" : q.confidenceLabel === "Medium" ? "warn" : "neu"}>{q.confidenceLabel}</Pill></td></tr>
            ))}</tbody>
          </table>
        </Section>
      </div>
      <Section title="Assignments" flush className="mt-4">
        <table className="ds-table">
          <thead><tr><th>Assignment</th><th>Due</th><th>Submitted</th><th>Completion</th><th></th></tr></thead>
          <tbody>{asgs.length === 0 ? <tr><td colSpan={5} className="text-[var(--color-ink-muted)]">No published assignments.</td></tr> : asgs.map((a) => (
            <tr key={a.id}><td className="font-semibold">{a.title}</td><td className="whitespace-nowrap text-[var(--color-ink-muted)]">{a.dueDate ? formatDay(a.dueDate) : "No due date"}</td>
              <td className="ds-num">{a.submittedCount} / {a.studentCount}</td><td className="ds-num">{a.studentCount ? Math.round((a.submittedCount / a.studentCount) * 100) : 0}%</td>
              <td className="text-right"><Link to={`/teacher/grade?course=${a.courseId}&assignment=${a.id}`} className="text-[13px] font-semibold underline">Grade work</Link></td></tr>
          ))}</tbody>
        </table>
      </Section>
    </>
  )
}
