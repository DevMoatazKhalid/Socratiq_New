import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { PageTitle } from "@/components/ds"
import { CourseCard, JoinCourseCard } from "@/components/socratiq/CourseCard"
import { NoMatches, QueryState } from "@/components/ui/States"
import { useCourses } from "@/lib/queries"
import { matches } from "@/lib/search"

/** Instructor course list (approved "E-courses"). */
export default function TeacherCourses() {
  const navigate = useNavigate()
  const courses = useCourses("teacher")
  const [query, setQuery] = useState("")
  return (
    <AppShell role="teacher" crumbs={[{ label: "My courses" }]} search={{ value: query, onChange: setQuery, placeholder: "Search courses" }}>
      <PageTitle title="Your courses" subtitle="Open a course to manage its assignments and materials" />
      <QueryState query={courses} what="Courses">
        {(all) => {
          const list = all.filter((c) => matches(query, c.name, c.code, c.description))
          if (all.length > 0 && list.length === 0) return <NoMatches query={query} onClear={() => setQuery("")} />
          return (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((c) => <CourseCard key={c.id} course={c} to={`/teacher/courses/${c.id}`} footer={`${c.studentCount ?? 0} student${c.studentCount === 1 ? "" : "s"}`} />)}
              {!query.trim() && <JoinCourseCard label={all.length ? "Add course" : "Create your first course"} onClick={() => navigate("/teacher/courses/new")} className="!bg-white" />}
            </div>
          )
        }}
      </QueryState>
    </AppShell>
  )
}
