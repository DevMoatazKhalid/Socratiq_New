import { useMemo, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { ArrowRight } from "lucide-react"
import { AppShell } from "@/components/layout/AppShell"
import { PageTitle, Section } from "@/components/ds"
import { GradedTable, UpcomingTable } from "@/components/student/WorkTables"
import { NoMatches, QueryState } from "@/components/ui/States"
import { useFallbackGrades, useStudentCourse, useStudentOverview } from "@/lib/queries"
import { matches } from "@/lib/search"
import { byWhatNeedsYou, shortDate, workRows } from "@/lib/studentWork"

function MiniStat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="ds-card px-5 py-4">
      <p className="text-[13px] font-semibold text-[var(--color-ink-muted)]">{label}</p>
      <p className="mt-1 font-serif text-[30px] font-bold leading-tight text-[var(--color-ink)] ds-num">{value}</p>
      <p className="text-[13px] text-[var(--color-ink-muted)]">{hint}</p>
    </div>
  )
}

/** Course page (approved design): your progress in this course, what's next, graded work and the course materials. */
export default function StudentCourseDetail() {
  const { courseId = "" } = useParams()
  const navigate = useNavigate()
  const q = useStudentCourse(courseId)
  const overview = useStudentOverview()
  const [query, setQuery] = useState("")

  const fb = useFallbackGrades(q.data?.assignments, overview.data)
  const rows = useMemo(() => (q.data ? workRows(q.data.assignments, [q.data.course], overview.data, fb.map) : []), [q.data, overview.data, fb.map])

  return (
    <AppShell role="student" crumbs={[{ label: "Courses", to: "/student/courses" }, { label: q.data?.course.name ?? "Course" }]}
      search={{ value: query, onChange: setQuery, placeholder: "Search assignments and materials" }}>
      <QueryState query={q} what="Course">
        {({ course, materials }) => {
          const shown = rows.filter((r) => matches(query, r.a.title, r.a.topic, r.a.prompt))
          const mats = materials.filter((m) => matches(query, m.title, m.summary))
          const upcoming = shown.filter((r) => !r.done).sort(byWhatNeedsYou)
          const graded = shown.filter((r) => r.grade).sort((a, b) => (b.grade!.gradedAt > a.grade!.gradedAt ? 1 : -1))
          const verified = rows.filter((r) => r.done).length
          const next = rows.filter((r) => !r.done && r.status !== "submitted" && r.a.dueDate).sort(byWhatNeedsYou)[0]
          const resume = rows.filter((r) => r.status === "in_progress").sort(byWhatNeedsYou)[0] ?? rows.filter((r) => r.status === "not_started").sort(byWhatNeedsYou)[0]
          const ov = overview.data?.courses.find((c) => c.courseId === course.id)
          const gradedN = rows.filter((r) => r.grade).length
          // the overview's figure when the server sends it; otherwise the mean of the grades read from each assignment
          const avg = ov ? ov.averageGrade : gradedN ? rows.reduce((t, r) => t + (r.grade?.percentage ?? 0), 0) / gradedN : null
          return (
            <>
              <PageTitle title={course.name} subtitle={[course.description, course.teacher].filter(Boolean).join(" · ")}
                actions={resume && (
                  <button type="button" className="ds-btn ds-btn-pri" onClick={() => navigate(resume.action.to)}>
                    {resume.status === "in_progress" ? "Continue" : "Start"} {resume.a.title}
                  </button>
                )} />

              {query.trim() && shown.length === 0 && mats.length === 0 ? <NoMatches query={query} onClear={() => setQuery("")} /> : (
                <>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 lg:max-w-[1032px]">
                    <MiniStat label="Your progress" value={`${verified} of ${rows.length}`} hint="assignments verified" />
                    <MiniStat label="Next due" value={next ? shortDate(next.a.dueDate) : "—"} hint={next ? next.a.title : "Nothing due"} />
                    <MiniStat label="Course average" value={avg != null ? `${Math.round(avg)}%` : "—"} hint={gradedN ? `${gradedN} graded` : "No graded work yet"} />
                  </div>

                  <div className="mt-5"><UpcomingTable rows={upcoming} showCourse={false} empty="Nothing to do in this course right now." /></div>
                  <div className="mt-5"><GradedTable rows={graded} showCourse={false} /></div>

                  <div className="mt-5">
                    <Section title="Materials" flush>
                      {mats.length === 0 ? (
                        <p className="px-5 pb-6 text-sm text-[var(--color-ink-muted)]">{materials.length ? "No materials match your search." : "Course readings and slides will show up here once your instructor posts them."}</p>
                      ) : (
                        <div className="ds-table-wrap">
                          <table className="ds-table min-w-[560px]">
                            <thead><tr><th>Material</th><th>Summary</th><th>Added</th><th><span className="sr-only">Open</span></th></tr></thead>
                            <tbody>
                              {mats.map((m) => {
                                const to = `/student/courses/${course.id}/materials/${m.id}`
                                return (
                                  <tr key={m.id} data-href onClick={() => navigate(to)}>
                                    <td><Link to={to} className="font-semibold hover:underline" onClick={(e) => e.stopPropagation()}>{m.title}</Link></td>
                                    <td className="text-[var(--color-ink-muted)]">{m.summary || "—"}</td>
                                    <td className="whitespace-nowrap ds-num">{shortDate(m.createdAt)}</td>
                                    <td className="w-10 text-right"><ArrowRight className="ml-auto h-4 w-4" aria-hidden="true" /></td>
                                  </tr>
                                )
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </Section>
                  </div>
                </>
              )}
            </>
          )
        }}
      </QueryState>
    </AppShell>
  )
}
