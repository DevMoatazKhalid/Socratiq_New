import { useState } from "react"
import { FileSpreadsheet, Loader2 } from "lucide-react"
import { Dialog } from "@/components/ui/Dialog"
import { ApiError } from "@/lib/api"
import { downloadGradesXlsx } from "@/lib/queries"
import { cn } from "@/lib/utils"

/**
 * "Export to Excel": the course gradebook or one assignment, as a formatted workbook (Summary, Gradebook with live formulas, Details,
 * and a sheet per rubric). Options only change what is included; grades are never recomputed differently from the app.
 */
export function ExportGradesButton({ courseId, courseLabel, assignment, className, compact }: {
  courseId: string
  courseLabel?: string
  assignment?: { id: string; title: string }
  className?: string
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState<"assignment" | "course">(assignment ? "assignment" : "course")
  const [feedback, setFeedback] = useState(true)
  const [rubric, setRubric] = useState(true)
  const [inactive, setInactive] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  async function go() {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      const name = await downloadGradesXlsx(scope === "assignment" && assignment ? { assignmentId: assignment.id } : { courseId },
        { includeFeedback: feedback, includeRubric: rubric, includeInactive: inactive })
      setDone(name ?? "the workbook")
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The export couldn't be created. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" className={cn("ds-btn", compact && "ds-btn-sm", className)} onClick={() => { setOpen(true); setDone(null); setError(null) }}>
        <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />Export to Excel
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Export grades to Excel"
        description="A formatted workbook your department can use directly: summary statistics, a gradebook with live formulas, and every grade in detail."
        footer={<>
          <button type="button" className="ds-btn" onClick={() => setOpen(false)}>Close</button>
          <button type="button" className="ds-btn ds-btn-pri" disabled={busy} onClick={go}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <FileSpreadsheet className="h-4 w-4" aria-hidden="true" />}
            {busy ? "Preparing…" : "Download .xlsx"}
          </button>
        </>}>
        {assignment && (
          <fieldset>
            <legend className="ds-label">What to export</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {([["assignment", assignment.title, "This assignment, with its rubric scores"], ["course", courseLabel ?? "Whole course", "Every published assignment in the course"]] as const).map(([v, t, d]) => (
                <label key={v} className={cn("cursor-pointer rounded-[12px] border px-4 py-3", scope === v ? "border-[var(--color-plum)] bg-[var(--color-plum-light)]" : "border-[var(--color-border)]")}>
                  <span className="flex items-start gap-2"><input type="radio" name="export-scope" className="mt-1 shrink-0" checked={scope === v} onChange={() => setScope(v)} /><b className="line-clamp-2 break-words" title={t}>{t}</b></span>
                  <span className="mt-0.5 block pl-6 text-xs text-[var(--color-ink-muted)]">{d}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <fieldset className={cn(assignment && "mt-5")}>
          <legend className="ds-label">Include</legend>
          <div className="space-y-2.5 text-sm">
            <label className="flex items-start gap-2.5"><input type="checkbox" className="mt-0.5" checked={feedback} onChange={(e) => setFeedback(e.target.checked)} />
              <span><b>Written feedback</b><span className="block text-xs text-[var(--color-ink-muted)]">The feedback each student received, in the Details sheet.</span></span></label>
            <label className="flex items-start gap-2.5"><input type="checkbox" className="mt-0.5" checked={rubric} onChange={(e) => setRubric(e.target.checked)} />
              <span><b>Rubric breakdown</b><span className="block text-xs text-[var(--color-ink-muted)]">One sheet per rubric-graded assignment, with points per criterion.</span></span></label>
            <label className="flex items-start gap-2.5"><input type="checkbox" className="mt-0.5" checked={inactive} onChange={(e) => setInactive(e.target.checked)} />
              <span><b>Removed students</b><span className="block text-xs text-[var(--color-ink-muted)]">Students no longer enrolled, marked “Removed”.</span></span></label>
          </div>
        </fieldset>
        <p className="mt-5 rounded-[12px] bg-[var(--color-surface-muted)] px-4 py-3 text-xs leading-relaxed text-[var(--color-ink-muted)]">
          Averages use graded work only — ungraded or missing work is left blank, never counted as zero. Times are in your time zone.
        </p>
        {error && <p role="alert" className="mt-3 text-sm text-[var(--color-danger-ink)]">{error}</p>}
        {done && <p role="status" className="mt-3 text-sm text-[var(--color-success-ink)]">Downloaded {done}.</p>}
      </Dialog>
    </>
  )
}
