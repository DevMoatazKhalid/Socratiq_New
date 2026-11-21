import { useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { ClipboardCheck, LifeBuoy, Search, ShieldQuestion, Signal } from "lucide-react"
import { AppShell } from "@/components/layout/AppShell"
import { Avatar, GradeValue, PageTitle, Pill, StatTile } from "@/components/ds"
import { CourseSelect, NoCourseYet, ago, useTeacherScope } from "@/components/teacher/scope"
import { DashboardSkeleton } from "@/components/socratiq/Skeletons"
import { QueryState } from "@/components/ui/States"
import { matches } from "@/lib/search"
import { categoryLabel, categoryTone, reviewRows, type ReviewCategory } from "@/lib/teacherWork"

/** Grading & review (approved design): grade submissions and review learning evidence, in one list. */
export default function TeacherReview() {
  const navigate = useNavigate()
  const { courses, course, setCourse, dash, insights } = useTeacherScope()
  const [cat, setCat] = useState<"all" | ReviewCategory>("all")
  const [query, setQuery] = useState("")
  const [assignment, setAssignment] = useState("")
  const [sort, setSort] = useState<"old" | "new">("old")

  return (
    <AppShell role="teacher" crumbs={[{ label: "Grading & Review" }]} search={{ value: query, onChange: setQuery, placeholder: "Search students, assignments and materials" }}>
      <PageTitle title="Grading & review" subtitle="Grade submissions and review learning evidence, in one list" />
      <QueryState query={courses} what="Grading & review" skeleton={<DashboardSkeleton />}>
        {(list) => !course ? <NoCourseYet /> : (
          <QueryState query={dash} what="Grading & review" skeleton={<DashboardSkeleton />}>
            {(d) => {
              const all = reviewRows(course.id, d, insights.data)
              const count = (c: ReviewCategory) => all.filter((r) => r.category === c).length
              const titles = [...new Set(all.map((r) => r.assignmentTitle).filter((t) => t && t !== "—"))]
              const rows = all
                .filter((r) => cat === "all" || r.category === cat)
                .filter((r) => !assignment || r.assignmentTitle === assignment)
                .filter((r) => matches(query, r.studentName, r.assignmentTitle, r.reason))
                .sort((a, b) => (sort === "old" ? 1 : -1) * ((a.lastActivity ?? "￿").localeCompare(b.lastActivity ?? "￿")))
              return (
                <>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    <StatTile icon={<ClipboardCheck className="h-5 w-5" />} tone="or" value={count("grade")} label="Pending grading" active={cat === "grade"} onClick={() => setCat(cat === "grade" ? "all" : "grade")} />
                    <StatTile icon={<LifeBuoy className="h-5 w-5" />} tone="bad" value={count("support")} label="Learning support" active={cat === "support"} onClick={() => setCat(cat === "support" ? "all" : "support")} />
                    <StatTile icon={<ShieldQuestion className="h-5 w-5" />} tone="info" value={count("verification")} label="Verification to inspect" active={cat === "verification"} onClick={() => setCat(cat === "verification" ? "all" : "verification")} />
                    <StatTile icon={<Signal className="h-5 w-5" />} tone="ok" value={count("other")} label="Other signals" active={cat === "other"} onClick={() => setCat(cat === "other" ? "all" : "other")} />
                  </div>

                  <div role="group" aria-label="Show" className="mt-5 flex flex-wrap gap-2">
                    <button type="button" className="ds-chip" aria-pressed={cat === "all"} onClick={() => setCat("all")}>All · {all.length}</button>
                    {(["grade", "support", "verification", "other"] as const).map((c) => (
                      <button key={c} type="button" className="ds-chip" aria-pressed={cat === c} onClick={() => setCat(c)}>{categoryLabel[c]} · {count(c)}</button>
                    ))}
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-2.5">
                    <label className="ds-search w-full sm:w-[260px]"><Search className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search student or assignment" aria-label="Search student or assignment" /></label>
                    {list.length > 1 && <CourseSelect courses={list} course={course} onChange={setCourse} />}
                    <select aria-label="Assignment" className="ds-sel" value={assignment} onChange={(e) => setAssignment(e.target.value)}>
                      <option value="">Assignment: All</option>{titles.map((t) => <option key={t} value={t}>Assignment: {t}</option>)}
                    </select>
                    <select aria-label="Sort" className="ds-sel" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
                      <option value="old">Sort: Oldest</option><option value="new">Sort: Newest</option>
                    </select>
                  </div>

                  <div className="ds-card mt-5 overflow-hidden">
                    {rows.length === 0 ? <p className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)]">{all.length ? "Nothing matches these filters." : "All caught up: nothing to grade or review."}</p> : (
                      <div className="ds-table-wrap">
                        <table className="ds-table min-w-[980px]">
                          <thead><tr><th>Student</th><th>Assignment</th><th>Category</th><th>Reason</th><th>Grade</th><th>Submission</th><th>Last activity</th><th><span className="sr-only">Action</span></th></tr></thead>
                          <tbody>
                            {rows.map((r) => (
                              <tr key={r.key}>
                                <td>{r.studentId ? <Link to={`/teacher/students/${r.studentId}`} className="flex items-center gap-3 hover:underline"><Avatar name={r.studentName} /><b className="font-semibold">{r.studentName}</b></Link> : <span className="text-[var(--color-ink-muted)]">{r.studentName}</span>}</td>
                                <td>{r.assignmentTitle}</td>
                                <td><Pill tone={categoryTone[r.category]}>{categoryLabel[r.category]}</Pill></td>
                                <td className="max-w-[260px] text-[var(--color-ink-muted)]">{r.reason}</td>
                                <td>{r.submission === "Missing" ? "" : <GradeValue pct={r.grade} />}</td>
                                <td>{r.submission && <Pill tone={r.submission === "Graded" ? "ok" : r.submission === "Missing" ? "bad" : "info"}>{r.submission}</Pill>}</td>
                                <td className="whitespace-nowrap">{ago(r.lastActivity)}</td>
                                <td className="text-right"><button type="button" className={r.action.label === "Grade" ? "ds-btn ds-btn-pri ds-btn-sm !rounded-full" : "ds-btn ds-btn-sm !rounded-full"} onClick={() => navigate(r.action.to)}>{r.action.label}</button></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <p className="border-t border-[#eeeee0] px-5 py-3 text-xs text-[var(--color-ink-muted)]">{d.riskDisclaimer}</p>
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
