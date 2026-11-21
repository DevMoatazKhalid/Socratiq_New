import { useId, useState, type KeyboardEvent } from "react"
import { cn } from "@/lib/utils"

/**
 * Screenshots of the real interface (captured from the app itself, rendered with sample course data).
 * Files live in /public/landing and are 1600x1000 WebP. When the UI changes, re-capture them rather than editing the images.
 */
const shots = [
  { id: "student-home", tab: "Student home", title: "Everything a student needs, in one place",
    caption: "Progress, grades by course, what's due next and recent notes. Ungraded work is never counted as zero.",
    alt: "Student home page with completion, average grade, verification and due-this-week cards, a weekly performance chart and grades by course." },
  { id: "notes-board", tab: "Notes board", title: "Notes that stay organised",
    caption: "Save a Coach reply in one tap, then sort notes by course, importance or your own groups.",
    alt: "Notes board showing sticky notes in coloured groups, with filters for course, importance, group, source and date." },
  { id: "teacher-overview", tab: "Teacher overview", title: "The whole class at a glance",
    caption: "Completion, grades, verification and review indicators for each course, drawn from the class's own work.",
    alt: "Instructor overview with student, completion, average grade and verification cards, a class trend chart and a grade distribution." },
  { id: "grade-work", tab: "Grade work", title: "Grade with the evidence next to the work",
    caption: "Submission, whiteboard, Coach activity and verification side by side, then grade and move to the next student.",
    alt: "Grade work page with a student list, the selected student's submitted code and a grade and feedback panel." },
] as const

export function ProductPreviews() {
  const [active, setActive] = useState(0)
  const base = useId()
  const shot = shots[active]

  function onKey(e: KeyboardEvent<HTMLButtonElement>) {
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0
    if (!d) return
    e.preventDefault()
    const next = (active + d + shots.length) % shots.length
    setActive(next)
    document.getElementById(`${base}-tab-${next}`)?.focus()
  }

  return (
    <div>
      <div role="tablist" aria-label="Product screens" className="flex flex-wrap gap-2">
        {shots.map((s, i) => (
          <button key={s.id} id={`${base}-tab-${i}`} type="button" role="tab" aria-selected={i === active} aria-controls={`${base}-panel`}
            tabIndex={i === active ? 0 : -1} onClick={() => setActive(i)} onKeyDown={onKey}
            className={cn("rounded-full border px-4 py-2 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-plum)]",
              i === active ? "border-[var(--color-plum)] bg-[var(--color-plum)] text-[var(--color-ink)]" : "border-[var(--color-border-strong)] bg-white text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]")}>
            {s.tab}
          </button>
        ))}
      </div>

      <figure id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-tab-${active}`}
        className="mt-6 overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white shadow-[0_20px_50px_-24px_rgb(60_40_10/0.35)]">
        <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] px-4 py-2.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-border-strong)]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-border-strong)]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-border-strong)]" />
        </div>
        <img key={shot.id} src={`/landing/${shot.id}.webp`} alt={shot.alt} width={1600} height={1000} loading="lazy" decoding="async"
          className="block aspect-[16/10] w-full bg-[var(--color-canvas)] object-cover object-top" />
        <figcaption className="flex flex-col gap-1 border-t border-[var(--color-border)] px-5 py-4 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
          <span>
            <span className="block font-semibold text-[var(--color-ink)]">{shot.title}</span>
            <span className="mt-0.5 block text-sm text-[var(--color-ink-muted)]">{shot.caption}</span>
          </span>
          <span className="shrink-0 text-xs text-[var(--color-ink-muted)]">Actual interface · sample course data</span>
        </figcaption>
      </figure>
    </div>
  )
}
