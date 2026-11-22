import { useEffect, useRef } from "react"
import { Flame, Quote, Target } from "lucide-react"
import { celebrateFromMomentum } from "@/lib/celebrate"
import { dailyEncouragement } from "@/lib/motivation"
import { useMomentum, type Momentum } from "@/lib/queries"
import { cn } from "@/lib/utils"

const DAY = ["S", "M", "T", "W", "T", "F", "S"]

function nextGoal(m: Momentum): { label: string; value: number; target: number } | null {
  const t = m.totals
  if (m.next.submissions) return { label: `${m.next.submissions - t.submissions} more to ${m.next.submissions} assignments handed in`, value: t.submissions, target: m.next.submissions }
  if (m.next.verified) return { label: `${m.next.verified - t.verified} more verified to reach ${m.next.verified}`, value: t.verified, target: m.next.verified }
  return null
}

/**
 * The student's study momentum on Home: this week's active days, the current streak, the next milestone, and one encouraging line a day.
 * It also offers the most important unseen celebration (a released grade first) when the page opens; the governor decides if it is shown.
 */
export function MomentumCard() {
  const q = useMomentum()
  const offered = useRef(false)
  useEffect(() => {
    if (q.data && !offered.current) {
      offered.current = true
      celebrateFromMomentum(q.data)
    }
  }, [q.data])
  const m = q.data
  if (!m) return null                                     // loading, or a server without the momentum endpoint: Home stays as it was
  const goal = nextGoal(m)
  const streak = m.streak.current
  return (
    <section className="ds-card mb-4 grid gap-4 px-5 py-4 sm:px-6 lg:grid-cols-[auto_1fr_1.2fr] lg:items-center lg:gap-8" aria-label="Your study momentum">
      <div className="flex items-center gap-3.5">
        <span className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-full", streak ? "bg-[var(--color-plum-light)] text-[#c76a00]" : "bg-[var(--color-slate-light)] text-[var(--color-ink-muted)]")}>
          <Flame className="h-6 w-6" aria-hidden="true" />
        </span>
        <div>
          <p className="text-[17px] font-bold leading-tight">{streak ? `${streak}-day streak` : "Start a streak today"}</p>
          <p className="text-[13px] text-[var(--color-ink-muted)]">
            {streak && !m.streak.activeToday ? "Study today to keep it going" : m.streak.longest > streak ? `Best: ${m.streak.longest} days` : `${m.totals.activeDays30} active day${m.totals.activeDays30 === 1 ? "" : "s"} this month`}
          </p>
        </div>
      </div>
      <div>
        <ol className="flex gap-1.5" aria-label="Active days this week">
          {m.streak.week.map((d, i) => {
            const date = new Date(`${d.date}T12:00:00`)
            const today = i === m.streak.week.length - 1
            return (
              <li key={d.date} className={cn("sq-day", d.active && "is-on", today && "is-today")} title={`${date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}${d.active ? " · studied" : ""}`}>
                <span aria-hidden="true">{DAY[date.getDay()]}</span>
                <span className="sr-only">{date.toLocaleDateString(undefined, { weekday: "long" })}: {d.active ? "studied" : "no activity"}</span>
              </li>
            )
          })}
        </ol>
        {goal && (
          <div className="mt-2.5 flex items-center gap-2 text-[13px]">
            <Target className="h-3.5 w-3.5 shrink-0 text-[var(--color-teal-dark)]" aria-hidden="true" />
            <span className="ds-bar max-w-[120px]" aria-hidden="true"><i style={{ width: `${(goal.value / goal.target) * 100}%`, background: "#fa9500" }} /></span>
            <span className="text-[var(--color-ink-muted)]">{goal.label}</span>
          </div>
        )}
      </div>
      <p className="flex items-start gap-2.5 border-t border-[#eeeee0] pt-3 text-[14px] italic leading-snug text-[var(--color-ink)] lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0">
        <Quote className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-plum)]" aria-hidden="true" />{dailyEncouragement()}
      </p>
    </section>
  )
}
