import { useCallback, useSyncExternalStore } from "react"
import type { Course } from "@/types"

/**
 * The course an instructor is currently looking at. The approved teacher design scopes Overview, Grading & Review, Grade work, Students,
 * Assignments and Insights to one course (course selector in the page header), so the choice is shared by all of those pages and survives
 * navigation and reloads. It is only a UI preference; every request still names the course explicitly and the API enforces access.
 */
const KEY = "socratiq.teacher.activeCourse"
const listeners = new Set<() => void>()

function read(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

export function setActiveCourseId(id: string) {
  try {
    localStorage.setItem(KEY, id)
  } catch {
    /* storage unavailable (private mode): the choice lasts for this page only */
  }
  memory = id
  listeners.forEach((l) => l())
}

let memory: string | null = null
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
const snapshot = () => memory ?? read()

/** Returns the stored course if it is still one of the instructor's courses, otherwise the first course. */
export function useActiveCourse(courses: Course[] | undefined): [Course | undefined, (id: string) => void] {
  const stored = useSyncExternalStore(subscribe, snapshot, () => null)
  const course = courses?.find((c) => c.id === stored) ?? courses?.[0]
  const set = useCallback((id: string) => setActiveCourseId(id), [])
  return [course, set]
}
