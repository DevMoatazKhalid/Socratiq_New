import { useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { PageTitle, Pill, Section } from "@/components/ds"
import { Badge } from "@/components/ui/Badge"
import { NoMatches, QueryState } from "@/components/ui/States"
import { setActiveCourseId } from "@/lib/activeCourse"
import { shortDate } from "@/lib/studentWork"
import { matches } from "@/lib/search"
import { ArrowRight, Copy, Plus, RefreshCw, UploadCloud } from "lucide-react"
import { useRotateJoinCode, useTeacherCourse } from "@/lib/queries"
import { statusLabel } from "@/lib/files"
import { ExportGradesButton } from "@/components/teacher/ExportGradesButton"

const lifecyclePill = { DRAFT: "or", PUBLISHED: "ok", ARCHIVED: "neu" } as const
const lifecycleText = { DRAFT: "Draft", PUBLISHED: "Published", ARCHIVED: "Archived" } as const

export default function TeacherCourseDetail() {
  const { courseId = "" } = useParams()
  const navigate = useNavigate()
  const q = useTeacherCourse(courseId)
  const rotate = useRotateJoinCode()
  const [copied, setCopied] = useState(false)
  const [query, setQuery] = useState("")

  return (
    <AppShell role="teacher" crumbs={[{ label: "My courses", to: "/teacher/courses" }, { label: q.data?.course.name ?? "Course" }]} search={{ value: query, onChange: setQuery, placeholder: "Search assignments and materials" }}>
      <QueryState query={q} what="Course">
        {({ course, classrooms, assignments: allAssignments, materials: allMaterials }) => {
          const assignments = allAssignments.filter((a) => matches(query, a.title, a.topic, lifecycleText[a.lifecycle ?? "DRAFT"]))
          const materials = allMaterials.filter((m) => matches(query, m.title, m.summary))
          const searching = query.trim() !== ""
          const open = (to: string) => navigate(to)
          return (
          <>
            <PageTitle title={course.name} subtitle={[course.description, `${course.studentCount ?? 0} student${course.studentCount === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}
              actions={<>
                <ExportGradesButton courseId={course.id} courseLabel={`${course.name} · ${course.code}`} />
                <button type="button" className="ds-btn" onClick={() => { setActiveCourseId(course.id); navigate("/teacher") }}>View course overview</button>
              </>} />

            <div className="flex flex-wrap gap-4">
              {classrooms.map((k) => (
                <section key={k.id} className="ds-card w-full max-w-[520px] p-6" aria-label={`Invite code ${k.name}`}>
                  <p className="text-[13px] font-semibold text-[var(--color-ink-muted)]">Invite code · {k.name}</p>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                    <code className="font-serif text-[30px] font-bold tracking-[0.12em] text-[var(--color-ink)]">{k.joinCode}</code>
                    <div className="flex gap-2">
                      <button type="button" className="ds-btn ds-btn-sm" onClick={() => { void navigator.clipboard?.writeText(k.joinCode); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" /> {copied ? "Copied" : "Copy"}
                      </button>
                      <button type="button" className="ds-btn ds-btn-sm" disabled={rotate.isPending} title="Old code stops working immediately" onClick={() => rotate.mutate(k.id)}>
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> New code
                      </button>
                    </div>
                  </div>
                  <p className="mt-2 text-xs text-[var(--color-ink-muted)]">Students enter this code under “Join a course”. A new code doesn't remove anyone already in the course.</p>
                </section>
              ))}
            </div>

            {searching && assignments.length === 0 && materials.length === 0 ? <div className="mt-5"><NoMatches query={query} onClear={() => setQuery("")} /></div> : (
              <>
                <div className="mt-5">
                  <Section title="Assignments" count={allAssignments.length} countTone="neu" flush
                    right={<Link to={`/teacher/courses/${course.id}/assignments/new`} className="ds-btn ds-btn-pri ds-btn-sm"><Plus className="h-3.5 w-3.5" aria-hidden="true" />New assignment</Link>}>
                    {allAssignments.length === 0 ? <p className="px-5 pb-6 text-sm text-[var(--color-ink-muted)]">No assignments yet. Create one so students have something to work on.</p> : assignments.length === 0 ? <p className="px-5 pb-6 text-sm text-[var(--color-ink-muted)]">No assignments match.</p> : (
                      <div className="ds-table-wrap">
                        <table className="ds-table min-w-[640px]">
                          <thead><tr><th>Assignment</th><th>Topic</th><th>Status</th><th>Submitted</th><th>Due</th><th><span className="sr-only">Open</span></th></tr></thead>
                          <tbody>{assignments.map((a) => {
                            const to = `/teacher/courses/${course.id}/assignments/${a.id}`
                            return (
                              <tr key={a.id} data-href onClick={() => open(to)}>
                                <td><Link to={to} className="font-semibold hover:underline" onClick={(e) => e.stopPropagation()}>{a.title}</Link></td>
                                <td className="text-[var(--color-ink-muted)]">{a.topic || "—"}</td>
                                <td><Pill tone={lifecyclePill[a.lifecycle ?? "DRAFT"]}>{lifecycleText[a.lifecycle ?? "DRAFT"]}</Pill></td>
                                <td className="ds-num">{a.submittedCount}/{a.studentCount}</td>
                                <td className="ds-num">{a.dueDate ? shortDate(a.dueDate) : "—"}</td>
                                <td className="w-10"><ArrowRight className="h-4 w-4" aria-hidden="true" /></td>
                              </tr>
                            )
                          })}</tbody>
                        </table>
                      </div>
                    )}
                  </Section>
                </div>
                <div className="mt-5">
                  <Section title="Materials" count={allMaterials.length} countTone="neu" flush
                    right={<Link to={`/teacher/courses/${course.id}/materials/new`} className="ds-btn ds-btn-sm"><UploadCloud className="h-3.5 w-3.5" aria-hidden="true" />Upload material</Link>}>
                    {allMaterials.length === 0 ? <p className="px-5 pb-6 text-sm text-[var(--color-ink-muted)]">No materials yet. Upload a reading, slide deck, spreadsheet or notes for this course.</p> : materials.length === 0 ? <p className="px-5 pb-6 text-sm text-[var(--color-ink-muted)]">No materials match.</p> : (
                      <div className="ds-table-wrap">
                        <table className="ds-table min-w-[560px]">
                          <thead><tr><th>Material</th><th>Summary</th><th>Status</th><th><span className="sr-only">Open</span></th></tr></thead>
                          <tbody>{materials.map((m) => {
                            const st = m.file ? statusLabel(m.file) : null
                            const to = `/teacher/courses/${course.id}/materials/${m.id}`
                            return (
                              <tr key={m.id} data-href onClick={() => open(to)}>
                                <td><Link to={to} className="font-semibold hover:underline" onClick={(e) => e.stopPropagation()}>{m.title}</Link></td>
                                <td className="text-[var(--color-ink-muted)]">{m.summary || "—"}</td>
                                <td>{st ? <Badge tone={st.tone}>{st.text}</Badge> : "—"}</td>
                                <td className="w-10"><ArrowRight className="h-4 w-4" aria-hidden="true" /></td>
                              </tr>
                            )
                          })}</tbody>
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
