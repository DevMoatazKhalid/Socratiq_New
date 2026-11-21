import type { ReactNode } from "react"
import { Link } from "react-router-dom"
import { BookOpen, Calculator, Code2, FlaskConical, Laptop, Plus } from "lucide-react"
import type { Course } from "@/types"
import { cn } from "@/lib/utils"

/** Header colours of the approved course cards (CS201 red-orange, CS210 orange, MATH120 olive), keyed by the course colour stored by the API. */
export const courseColor: Record<Course["color"], string> = {
  clay: "#eb6424",
  plum: "#fa9500",
  slate: "#a4a060",
  teal: "#babd8e",
}

const icons = [Code2, Laptop, Calculator, BookOpen, FlaskConical]
/** A stable subject icon per course: picked from the course code/name, otherwise from its id, so a course always shows the same icon. */
export function courseIcon(c: Pick<Course, "id" | "code" | "name">) {
  const t = `${c.code} ${c.name}`.toLowerCase()
  if (/math|calc|algebra|stat|discrete|proof/.test(t)) return Calculator
  if (/data struct|system|network|hardware|os\b/.test(t)) return Laptop
  if (/algorithm|program|code|software|cs\d/.test(t)) return Code2
  if (/chem|bio|phys|lab|science/.test(t)) return FlaskConical
  let h = 0
  for (const ch of c.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return icons[h % icons.length]
}

export function CourseCard({ course, to, footer, className }: { course: Course; to: string; footer?: ReactNode; className?: string }) {
  const Icon = courseIcon(course)
  return (
    <div className={className}>
      <Link to={to} className="group block rounded-2xl focus-visible:outline-offset-4">
        <div className="ds-card flex h-full flex-col overflow-hidden transition-shadow group-hover:shadow-[0_6px_16px_-10px_rgb(20_17_2/0.35)]">
          <div className="flex min-h-[92px] items-start justify-between gap-2.5 px-[18px] py-4 text-[var(--color-ink)]" style={{ background: courseColor[course.color] ?? courseColor.plum }}>
            <div className="min-w-0">
              <p className="text-xs font-bold tracking-[0.03em]">{course.code}</p>
              <h3 className="mt-1.5 text-[17px] font-bold leading-[1.25]">{course.name}</h3>
            </div>
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-white/90" aria-hidden="true"><Icon className="h-5 w-5" strokeWidth={1.8} /></span>
          </div>
          <div className="flex flex-1 flex-col gap-3.5 px-[18px] py-4">
            {course.description && <p className="text-[13px] leading-[1.55] text-[var(--color-ink-muted)]">{course.description}</p>}
            <p className="mt-auto text-xs text-[var(--color-ink-muted)]">{course.teacher}{course.status === "Archived" && " · Archived"}</p>
          </div>
        </div>
      </Link>
      {footer && <p className="px-1 pt-2 text-xs text-[var(--color-ink-muted)]">{footer}</p>}
    </div>
  )
}

export function JoinCourseCard({ label = "Join a course", onClick, children, className }: { label?: string; onClick?: () => void; children?: ReactNode; className?: string }) {
  const body = (
    <>
      <Plus className="h-5 w-5 text-[var(--color-teal-dark)]" aria-hidden="true" />
      <span className="text-sm font-semibold text-[var(--color-ink)]">{label}</span>
      {children}
    </>
  )
  const cls = cn("flex h-full min-h-[240px] w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[#fff6f1] p-6 text-center transition-colors", className)
  return onClick ? <button type="button" onClick={onClick} className={cn(cls, "hover:bg-white")}>{body}</button> : <div className={cls}>{body}</div>
}
