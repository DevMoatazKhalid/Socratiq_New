import { Bot, UserCheck } from "lucide-react"
import { RichText } from "@/components/ui/RichText"
import { formatNumber } from "@/lib/grades"
import type { CriterionLevel, Grade } from "@/lib/queries"
import { cn } from "@/lib/utils"

const LEVEL: Record<CriterionLevel, { label: string; color: string }> = {
  excellent: { label: "Excellent", color: "#6f9a7b" }, proficient: { label: "Proficient", color: "#8fb07f" }, developing: { label: "Developing", color: "#e0a64a" },
  beginning: { label: "Beginning", color: "#d98a5f" }, missing: { label: "Not shown yet", color: "#b96b64" },
}

/** The student's released grade: total, per-criterion breakdown (rubric grades), feedback (with formulas typeset), and who graded it. */
export function GradeResult({ grade }: { grade: Grade }) {
  const date = new Date(grade.gradedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
  const auto = grade.reviewed === false
  const assisted = !auto && (grade.source === "ai" || grade.source === "ai_edited")
  const pct = grade.percentage
  return (
    <section id="grade" className="rounded-2xl border border-[var(--color-border)] bg-[#f6f4ea] p-2.5 sm:p-5" aria-labelledby="grade-h">
      <div className="ds-card px-4 py-5 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 id="grade-h" className="text-lg font-semibold text-[var(--color-ink)]">Your grade</h2>
            <p className="mt-1 text-[30px] font-bold leading-tight text-[var(--color-ink)] ds-num">{formatNumber(grade.score)} / {formatNumber(grade.maxScore)}</p>
          </div>
          <div className="w-full max-w-[220px] sm:w-[220px]" aria-hidden="true">
            <div className="flex justify-between text-xs font-semibold text-[var(--color-ink-muted)]"><span>Score</span><span className="ds-num">{formatNumber(pct)}%</span></div>
            <span className="mt-1 flex"><span className="ds-bar !h-2.5"><i style={{ width: `${Math.min(100, pct)}%`, background: pct >= 80 ? "#6f9a7b" : pct >= 60 ? "#e0a64a" : "#d98a5f" }} /></span></span>
          </div>
        </div>

        {grade.criteria && grade.criteria.length > 0 && (
          <div className="mt-5">
            <h3 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-[var(--color-ink-muted)]">How it was assessed</h3>
            <ul className="mt-2.5 space-y-3">
              {grade.criteria.map((c) => {
                const lv = c.level ? LEVEL[c.level] : null
                const w = c.pointsPossible ? (c.pointsAwarded / c.pointsPossible) * 100 : 0
                return (
                  <li key={c.id}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-[15px] font-semibold" dir="auto">{c.title}</span>
                      <span className="shrink-0 text-sm ds-num"><b>{formatNumber(c.pointsAwarded)}</b><span className="text-[var(--color-ink-muted)]"> / {formatNumber(c.pointsPossible)}</span></span>
                    </div>
                    <div className="mt-1 flex items-center gap-2.5">
                      <span className="ds-bar" role="img" aria-label={`${formatNumber(c.pointsAwarded)} of ${formatNumber(c.pointsPossible)} points${lv ? `, ${lv.label}` : ""}`}>
                        <i style={{ width: `${w}%`, background: lv?.color ?? "#a4a060" }} />
                      </span>
                      {lv && <span className="w-24 shrink-0 text-xs font-semibold" style={{ color: lv.color === "#8fb07f" ? "#3f6b4d" : undefined }}>{lv.label}</span>}
                    </div>
                    {c.comment && <p dir="auto" className="mt-1.5 rounded-[10px] bg-[#fff8f3] px-3 py-2 text-[13px] text-[var(--color-ink)]">{c.comment}</p>}
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {grade.feedback && (
          <div className="mt-5 rounded-[12px] bg-[#fff8f3] px-4 py-3 text-[15px] leading-relaxed text-[var(--color-ink)]">
            <RichText text={grade.feedback} />
          </div>
        )}
        <p className={cn("mt-4 flex items-start gap-2 text-sm", auto ? "text-[var(--color-warning-ink)]" : "text-[var(--color-ink-muted)]")}>
          {auto || assisted ? <Bot className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> : <UserCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
          <span>
            {auto ? `Graded automatically by SocratiQ on ${date}. Your instructor may still review it.`
              : assisted ? `Graded ${date}${grade.gradedBy ? ` by ${grade.gradedBy}` : ""}, with an AI-drafted assessment your instructor reviewed.`
              : `Graded ${date}${grade.gradedBy ? ` by ${grade.gradedBy}` : ""}.`}
          </span>
        </p>
      </div>
    </section>
  )
}
