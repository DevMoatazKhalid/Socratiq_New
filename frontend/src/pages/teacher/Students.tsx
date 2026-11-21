import { useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { Clock, Eye, GraduationCap, Search, Users } from "lucide-react"
import { AppShell } from "@/components/layout/AppShell"
import { Avatar, Kpi, PageTitle, Pill, Sparkline, gradeColor, palette } from "@/components/ds"
import { CourseSelect, NoCourseYet, ago, useTeacherScope } from "@/components/teacher/scope"
import { DashboardSkeleton } from "@/components/socratiq/Skeletons"
import { QueryState } from "@/components/ui/States"
import { matches } from "@/lib/search"
import { signalTone } from "@/lib/teacherWork"
import type { TeacherInsights } from "@/lib/queries"
import type { StudentRow as Row } from "@/types"

type Band = "all" | "90" | "80" | "70" | "60" | "lt60" | "ungraded" | "signals"
const BANDS: { key: Band; label: string; test: (g: number | null, s: number) => boolean }[] = [
  { key: "all", label: "All", test: () => true },
  { key: "90", label: "90–100", test: (g) => g != null && g >= 90 },
  { key: "80", label: "80–89", test: (g) => g != null && g >= 80 && g < 90 },
  { key: "70", label: "70–79", test: (g) => g != null && g >= 70 && g < 80 },
  { key: "60", label: "60–69", test: (g) => g != null && g >= 60 && g < 70 },
  { key: "lt60", label: "<60", test: (g) => g != null && g < 60 },
  { key: "ungraded", label: "Not graded", test: (g) => g == null },
  { key: "signals", label: "With signals", test: (_g, s) => s > 0 },
]

function attention(st: Row, per: TeacherInsights["students"][number] | undefined): { t: string; tone: "ok" | "or" | "warn" | "neu" | "bad" } {
  if (st.risk.level === "high" || st.risk.level === "moderate") return st.risk.focus === "verification" ? { t: "Verification review", tone: "warn" } : { t: "Review", tone: "warn" }
  if (st.mastery === "Weak") return { t: "Learning support", tone: "warn" }
  if (per && per.awaiting > 0 && per.graded === 0) return { t: "Awaiting first grade", tone: "neu" }
  if (per && per.awaiting > 0) return { t: "Grading pending", tone: "or" }
  if (st.taskSubmission < 50) return { t: "Missing submissions", tone: "neu" }
  return { t: "On track", tone: "ok" }
}

function csv(rows: (string | number | null)[][]) {
  return rows.map((r) => r.map((v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }).join(",")).join("\n")
}

/** Students (approved design): academic performance, understanding and engagement, side by side. */
export default function TeacherStudents() {
  const navigate = useNavigate()
  const { courses, course, setCourse, dash, insights, detail } = useTeacherScope()
  const [query, setQuery] = useState("")
  const [band, setBand] = useState<Band>("all")
  const [sort, setSort] = useState<"grade" | "name" | "activity" | "signals">("grade")

  return (
    <AppShell role="teacher" crumbs={[{ label: "Students" }]} search={{ value: query, onChange: setQuery, placeholder: "Search students, assignments and materials" }}>
      <QueryState query={courses} what="Students" skeleton={<DashboardSkeleton />}>
        {(list) => !course ? <><PageTitle title="Students" /><NoCourseYet /></> : (
          <QueryState query={dash} what="Students" skeleton={<DashboardSkeleton />}>
            {(d) => {
              const per = new Map((insights.data?.students ?? []).map((s) => [s.id, s]))
              const all = d.students.map((s) => ({ s, p: per.get(s.id), g: per.get(s.id)?.averageGrade ?? null, sig: s.observedSignalCount ?? 0 }))
              const rows = all
                .filter((r) => BANDS.find((b) => b.key === band)!.test(r.g, r.sig))
                .filter((r) => matches(query, r.s.name))
                .sort((a, b) => sort === "name" ? a.s.name.localeCompare(b.s.name) : sort === "signals" ? b.sig - a.sig
                  : sort === "activity" ? (b.s.risk.lastActivityAt ?? "").localeCompare(a.s.risk.lastActivityAt ?? "") : (b.g ?? -1) - (a.g ?? -1))
              const graded = all.filter((r) => r.g != null).length
              const withSig = all.filter((r) => r.sig > 0)
              const awaiting = insights.data?.grades.awaiting
              const section = detail.data?.classrooms.map((k) => k.name).join(", ")
              const exportCsv = () => {
                const body = csv([["Student", "Average grade %", "Graded", "Submitted", "Verification %", "Last activity", "Review signals", "Attention"],
                  ...rows.map((r) => [r.s.name, r.g, r.p?.graded ?? null, r.p?.submitted ?? null, r.p?.verificationRate ?? null, r.s.risk.lastActivityAt, r.sig, attention(r.s, r.p).t])])
                const url = URL.createObjectURL(new Blob([body], { type: "text/csv" }))
                const a = Object.assign(document.createElement("a"), { href: url, download: `${course.code || "course"}-students.csv` })
                a.click(); URL.revokeObjectURL(url)
              }
              return (
                <>
                  <PageTitle title="Students" subtitle="Academic performance, understanding and engagement, side by side"
                    actions={<>{list.length > 1 && <CourseSelect courses={list} course={course} onChange={setCourse} />}
                      {section && <span className="ds-sel">{section}</span>}
                      <button type="button" className="ds-btn" onClick={exportCsv} disabled={rows.length === 0}>Export</button></>} />

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <Kpi icon={<span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[var(--color-slate-light)]"><Users className="h-4 w-4" /></span>} label="Total students" value={d.overview.students} hint="Enrolled" />
                    <Kpi highlight icon={<span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[var(--color-plum-light)]"><GraduationCap className="h-4 w-4" /></span>} label="Average grade"
                      value={d.metrics.averageGrade == null ? "—" : `${d.metrics.averageGrade}%`} spark={(insights.data?.trend ?? []).map((t) => t.averageGrade)} hint={`${graded} graded of ${d.overview.students} · ungraded excluded`} />
                    <Kpi icon={<span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[var(--color-slate-light)]"><Eye className="h-4 w-4" /></span>} label="Review signals" value={withSig.length}
                      hint={`${withSig.filter((r) => r.sig >= 2).length} with 2+ signals · ${withSig.filter((r) => r.sig === 1).length} with 1 signal`} />
                    <Kpi icon={<span className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[var(--color-success-light)]"><Clock className="h-4 w-4" /></span>} label="Awaiting grades" value={awaiting ?? "—"} hint="Submitted, not graded yet" />
                  </div>

                  <div className="mt-5 flex flex-wrap items-center gap-2">
                    <label className="ds-search w-full sm:w-[260px]"><Search className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name" aria-label="Search students by name" /></label>
                    {BANDS.map((b) => {
                      const n = all.filter((r) => b.test(r.g, r.sig)).length
                      return <button key={b.key} type="button" className="ds-chip" aria-pressed={band === b.key} onClick={() => setBand(b.key)}>{b.label} · {n}</button>
                    })}
                    <select aria-label="Sort" className="ds-sel ml-auto" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
                      <option value="grade">Sort: Grade ↓</option><option value="name">Sort: Name</option><option value="activity">Sort: Last activity</option><option value="signals">Sort: Signals</option>
                    </select>
                  </div>

                  <div className="ds-card mt-4 overflow-hidden">
                    <div className="ds-table-wrap">
                      <table className="ds-table min-w-[1060px]">
                        <thead><tr><th>Student</th><th>Average grade</th><th>Graded / submitted</th><th>Verification</th><th>Trend</th><th>Last activity</th><th>Review signals</th><th>Attention</th></tr></thead>
                        <tbody>
                          {rows.length === 0 && <tr><td colSpan={8} className="py-8 text-center text-[var(--color-ink-muted)]">{all.length ? "No students match." : "No students have joined yet. Share the course join code."}</td></tr>}
                          {rows.map(({ s, p, g, sig }) => {
                            const at = attention(s, p)
                            const rg = p?.recentGrades ?? []
                            return (
                              <tr key={s.id} data-href onClick={() => navigate(`/teacher/students/${s.id}`)}>
                                <td><Link to={`/teacher/students/${s.id}`} onClick={(e) => e.stopPropagation()} className="flex items-center gap-3 whitespace-nowrap hover:underline"><Avatar name={s.name} className="!h-10 !w-10" /><b className="font-semibold">{s.name}</b></Link></td>
                                <td>{g == null ? <Pill tone="neu">Not graded</Pill> : (
                                  <span className="flex min-w-[170px] items-center gap-3"><b className="w-10 ds-num">{Math.round(g)}%</b><span className="ds-bar"><i style={{ width: `${g}%`, background: gradeColor(g) }} /></span></span>
                                )}</td>
                                <td className="ds-num">{p ? `${p.graded} / ${p.submitted}` : "—"}</td>
                                <td className="ds-num">{p?.verificationRate == null ? "No data" : `${p.verificationRate}%`}</td>
                                <td>{rg.length >= 2 ? <Sparkline values={rg} width={96} height={28} color={rg[rg.length - 1] >= rg[0] ? palette.sage : palette.rose} /> : <span className="text-xs text-[var(--color-ink-muted)]">Not enough data</span>}</td>
                                <td className="whitespace-nowrap">{ago(s.risk.lastActivityAt)}</td>
                                <td><Pill tone={signalTone(sig)}>{sig === 0 ? "No signals" : `${sig} signal${sig === 1 ? "" : "s"}`}</Pill>{sig > 0 && s.risk.primaryReason && <span className="mt-0.5 block max-w-[200px] text-xs text-[var(--color-ink-muted)]">{s.risk.primaryReason}</span>}</td>
                                <td><Pill tone={at.tone}>{at.t}</Pill></td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p className="border-t border-[#eeeee0] px-5 py-3 text-xs text-[var(--color-ink-muted)]">Showing {rows.length} of {all.length} · averages use graded work only · “Not graded” is never treated as 0%</p>
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

