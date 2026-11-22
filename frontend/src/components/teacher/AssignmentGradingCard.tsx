import { useState } from "react"
import { Link } from "react-router-dom"
import { ClipboardCheck, Settings2 } from "lucide-react"
import { formatNumber } from "@/lib/grades"
import { useGradingOverview } from "@/lib/queries"
import { ExportGradesButton } from "./ExportGradesButton"
import { GradingSetup } from "./GradingSetup"

const MODE = { off: "You grade everything yourself", review: "SocratiQ drafts grades; you release them", auto_release: "Confident AI grades are released automatically" } as const

/** On the instructor's assignment page: how this assignment is graded, where grading stands, and the way into the grading workspace. */
export function AssignmentGradingCard({ assignmentId, assignmentTitle, courseId, courseLabel }: { assignmentId: string; assignmentTitle: string; courseId: string; courseLabel: string }) {
  const q = useGradingOverview(assignmentId)
  const [setup, setSetup] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const o = q.data
  if (!o) return null
  const { settings, counts } = o
  return (
    <section className="ds-card mt-6 max-w-2xl p-6" aria-labelledby="grading-h">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="grading-h" className="text-lg font-bold">Grading</h2>
          <p className="text-[13px] text-[var(--color-ink-muted)]">{MODE[settings.aiGrading]}</p>
        </div>
        <p className="text-sm ds-num"><b>{counts.graded}</b> of {counts.submitted} graded{counts.draftsReady ? ` · ${counts.draftsReady} draft${counts.draftsReady === 1 ? "" : "s"} ready` : ""}</p>
      </div>
      {settings.rubric.length > 0 ? (
        <ul className="mt-4 divide-y divide-[#eeeee0] rounded-[12px] border border-[var(--color-border)] text-sm">
          {settings.rubric.map((c) => (
            <li key={c.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
              <span className="min-w-0"><b dir="auto">{c.title}</b>{c.description && <span dir="auto" className="block text-xs text-[var(--color-ink-muted)]">{c.description}</span>}</span>
              <span className="shrink-0 ds-num">{formatNumber(c.points)} pts</span>
            </li>
          ))}
          <li className="flex justify-between bg-[var(--color-surface-muted)] px-4 py-2 font-semibold"><span>Total</span><span className="ds-num">{formatNumber(settings.pointsPossible)} pts</span></li>
        </ul>
      ) : (
        <p className="mt-4 rounded-[12px] border border-dashed border-[var(--color-border-strong)] px-4 py-3 text-sm text-[var(--color-ink-muted)]">
          No rubric yet — graded out of {formatNumber(settings.pointsPossible)}. Add criteria (or let SocratiQ suggest them) for consistent, explainable grades.
        </p>
      )}
      {settings.rubricSource === "ai" && settings.rubric.length > 0 && <p className="mt-2 text-xs text-[var(--color-warning-ink)]">This rubric was drafted by SocratiQ from your instructions. Open the setup to review it.</p>}
      {note && <p role="status" className="mt-3 text-sm text-[var(--color-success-ink)]">{note}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Link to={`/teacher/grade?course=${encodeURIComponent(courseId)}&assignment=${encodeURIComponent(assignmentId)}`} className="ds-btn ds-btn-pri ds-btn-sm">
          <ClipboardCheck className="h-3.5 w-3.5" aria-hidden="true" />Open grading
        </Link>
        <button type="button" className="ds-btn ds-btn-sm" onClick={() => setSetup(true)}><Settings2 className="h-3.5 w-3.5" aria-hidden="true" />Grading setup</button>
        <ExportGradesButton compact courseId={courseId} courseLabel={courseLabel} assignment={{ id: assignmentId, title: assignmentTitle }} />
      </div>
      <GradingSetup assignmentId={assignmentId} settings={settings} open={setup} onClose={() => setSetup(false)} onSaved={setNote} />
    </section>
  )
}
