import { useState } from "react"
import { AppShell } from "@/components/layout/AppShell"
import { PageTitle } from "@/components/ds"
import { CourseCard, JoinCourseCard } from "@/components/socratiq/CourseCard"
import { JoinCodeForm } from "@/components/student/JoinCodeForm"
import { NoMatches, QueryState } from "@/components/ui/States"
import { useCourses, useStudentHome } from "@/lib/queries"
import { matches } from "@/lib/search"

/** My courses (approved design): course cards, each with its assignment count and how many are still open, plus an inline "Join a course" card. */
export default function StudentCourses() {
  const courses = useCourses("student")
  const home = useStudentHome()
  const [query, setQuery] = useState("")
  return (
    <AppShell role="student" crumbs={[{ label: "My courses" }]} search={{ value: query, onChange: setQuery, placeholder: "Search courses" }}>
      <PageTitle title="Your courses" subtitle="Open a course to see its assignments and materials" />
      <QueryState query={courses} what="Courses">
        {(all) => {
          const list = all.filter((c) => matches(query, c.name, c.code, c.description, c.teacher))
          if (query.trim() && list.length === 0) return <NoMatches query={query} onClear={() => setQuery("")} />
          return (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((c) => {
                const open = home.data?.assignments.filter((a) => a.courseId === c.id && (a.status === "not_started" || a.status === "in_progress")).length
                return (
                  <CourseCard key={c.id} course={c} to={`/student/courses/${c.id}`}
                    footer={`${c.assignmentCount} assignment${c.assignmentCount === 1 ? "" : "s"}${open != null ? ` · ${open} open` : ""}`} />
                )
              })}
              {!query.trim() && (
                <JoinCourseCard label="Join a course" className={all.length === 0 ? "sm:col-span-2 xl:col-span-1" : undefined}>
                  <p className="text-[13px] text-[var(--color-ink-muted)]">{all.length === 0 ? "You haven't joined a course yet. " : ""}Enter the invite code from your instructor</p>
                  <JoinCodeForm className="mt-2" />
                </JoinCourseCard>
              )}
            </div>
          )
        }}
      </QueryState>
    </AppShell>
  )
}
