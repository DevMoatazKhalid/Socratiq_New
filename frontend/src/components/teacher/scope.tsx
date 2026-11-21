import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { BookOpen } from "lucide-react"
import { NoData } from "@/components/ds"
import { useActiveCourse } from "@/lib/activeCourse"
import { useCourses, useDashboard, useTeacherCourse, useTeacherInsights } from "@/lib/queries"
import type { Course } from "@/types"

/** Everything a course-scoped instructor page needs: the course list, the active course (shared across pages), and that course's data. */
export function useTeacherScope(opts: { weeks?: number } = {}) {
  const courses = useCourses("teacher")
  const [course, setCourse] = useActiveCourse(courses.data)
  const dash = useDashboard(course?.id)
  const insights = useTeacherInsights(course?.id, opts.weeks ?? 8)
  const detail = useTeacherCourse(course?.id)
  return { courses, course, setCourse, dash, insights, detail }
}

export function CourseSelect({ courses, course, onChange, label = "Course" }: { courses: Course[]; course?: Course; onChange: (id: string) => void; label?: string }) {
  return (
    <span className="relative inline-flex">
      <BookOpen className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" aria-hidden="true" />
      <select aria-label={label} className="ds-sel !pl-9" value={course?.id ?? ""} onChange={(e) => onChange(e.target.value)}>
        {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </span>
  )
}

export function WeeksSelect({ value, onChange, small }: { value: number; onChange: (n: number) => void; small?: boolean }) {
  return (
    <select aria-label="Time range" className={small ? "ds-sel ds-sel-sm" : "ds-sel"} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      <option value={4}>Last 4 weeks</option><option value={8}>Last 8 weeks</option><option value={12}>Last 12 weeks</option>
    </select>
  )
}

export function useWeeks() {
  return useState(8)
}

/** Shown when an instructor has no course yet: every course-scoped page starts here. */
export function NoCourseYet() {
  const navigate = useNavigate()
  return (
    <NoData title="Create your first course">
      Your pages fill in as students join and work on assignments.{" "}
      <button type="button" className="font-semibold text-[var(--color-teal-dark)] underline" onClick={() => navigate("/teacher/courses/new")}>Create a course</button>
    </NoData>
  )
}

export const ago = (iso: string | null | undefined) => {
  if (!iso) return "—"
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  const d = Math.round(s / 86400)
  return d === 1 ? "Yesterday" : `${d}d ago`
}
