import { useEffect, useState } from "react"
import { Loader2, Plus, Sparkles, Trash2 } from "lucide-react"
import { Dialog } from "@/components/ui/Dialog"
import { ApiError } from "@/lib/api"
import { formatNumber } from "@/lib/grades"
import { useGradingActions, type AiGradingMode, type GradingSettings, type RubricCriterion } from "@/lib/queries"
import { cn } from "@/lib/utils"

type Row = RubricCriterion & { key: string; pointsText: string }

const MODES: { value: AiGradingMode; title: string; body: string; badge?: string }[] = [
  { value: "review", title: "AI drafts, I release", badge: "Recommended",
    body: "SocratiQ drafts a grade and feedback for every submission. Nothing reaches students until you release it — as is, or after editing." },
  { value: "auto_release", title: "Release confident grades automatically",
    body: "Drafts that are confident and raise no concerns are released right away (students see “not yet reviewed”). Everything else waits for you." },
  { value: "off", title: "I grade everything myself", body: "No AI drafts. You still get the rubric, the grade history and the Excel export." },
]

let seq = 0
const keyed = (c: RubricCriterion): Row => ({ ...c, key: `k${++seq}`, pointsText: formatNumber(c.points) })

function slugId(title: string, used: Set<string>): string {
  const base = title.normalize("NFKD").replace(/[^\x00-\x7F]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "criterion"
  let id = base, n = 2
  while (used.has(id)) id = `${base.slice(0, 27)}-${n++}`
  used.add(id)
  return id
}

/** Rubric, reference answer, grading notes and the AI grading mode for one assignment. Saving a rubric makes it the instructor's own. */
export function GradingSetup({ assignmentId, settings, open, onClose, onSaved }: {
  assignmentId: string
  settings: GradingSettings
  open: boolean
  onClose: () => void
  onSaved?: (message: string) => void
}) {
  const { saveSettings, suggestRubric } = useGradingActions(assignmentId)
  const [mode, setMode] = useState<AiGradingMode>(settings.aiGrading)
  const [rows, setRows] = useState<Row[]>(() => settings.rubric.map(keyed))
  const [holistic, setHolistic] = useState(formatNumber(settings.pointsPossible))
  const [reference, setReference] = useState(settings.referenceAnswer ?? "")
  const [notes, setNotes] = useState(settings.gradingNotes ?? "")
  const [error, setError] = useState<string | null>(null)
  const [suggested, setSuggested] = useState(false)

  useEffect(() => {                                   // reopened after the settings changed elsewhere: start from the saved state
    if (!open) return
    setMode(settings.aiGrading); setRows(settings.rubric.map(keyed)); setHolistic(formatNumber(settings.pointsPossible))
    setReference(settings.referenceAnswer ?? ""); setNotes(settings.gradingNotes ?? ""); setError(null); setSuggested(false)
  }, [open, settings])

  const total = rows.reduce((t, r) => t + (Number(r.pointsText) || 0), 0)
  const update = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))

  async function suggest() {
    setError(null)
    if (rows.length && !window.confirm("Replace the current criteria with a suggested rubric?")) return
    try {
      const target = rows.length ? total : Number(holistic) || settings.pointsPossible
      const r = await suggestRubric.mutateAsync(target > 0 ? target : undefined)
      setRows(r.criteria.map(keyed))
      setSuggested(true)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "A rubric couldn't be suggested right now. Try again or write one yourself.")
    }
  }

  async function save() {
    setError(null)
    const clean = rows.map((r) => ({ ...r, title: r.title.trim(), description: r.description.trim(), points: Number(r.pointsText) }))
    const bad = clean.find((r) => !r.title || !Number.isFinite(r.points) || r.points <= 0)
    if (bad) return setError("Every criterion needs a name and a number of points greater than 0.")
    const used = new Set(clean.filter((r) => settings.rubric.some((s) => s.id === r.id)).map((r) => r.id))
    const rubric = clean.map((r) => ({ id: r.id && settings.rubric.some((s) => s.id === r.id) ? r.id : slugId(r.title, used), title: r.title, description: r.description, points: r.points }))
    const points = Number(holistic)
    if (!rubric.length && (!Number.isFinite(points) || points <= 0)) return setError("The maximum score must be greater than 0.")
    try {
      await saveSettings.mutateAsync({ aiGrading: mode, rubric, referenceAnswer: reference, gradingNotes: notes, ...(rubric.length ? {} : { pointsPossible: points }) })
      const changed = JSON.stringify(rubric) !== JSON.stringify(settings.rubric) || reference.trim() !== (settings.referenceAnswer ?? "").trim() || notes.trim() !== (settings.gradingNotes ?? "").trim()
      onSaved?.(changed ? "Grading setup saved. Drafts made with the previous setup are marked out of date." : "Grading setup saved.")
      onClose()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The grading setup couldn't be saved. Please try again.")
    }
  }

  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Grading setup" initialFocus="[data-autofocus]"
      description="How this assignment is graded. Students never see the reference answer or your grading notes."
      footer={<>
        {error && <p role="alert" className="mr-auto text-sm text-[var(--color-danger-ink)]">{error}</p>}
        <button type="button" className="ds-btn" onClick={onClose}>Cancel</button>
        <button type="button" className="ds-btn ds-btn-pri" onClick={save} disabled={saveSettings.isPending}>{saveSettings.isPending ? "Saving…" : "Save setup"}</button>
      </>}>
      <fieldset>
        <legend className="ds-label">AI grading</legend>
        <div className="grid gap-2.5 md:grid-cols-3">
          {MODES.map((m, i) => (
            <label key={m.value} className={cn("flex cursor-pointer flex-col rounded-[14px] border p-4 transition-colors", mode === m.value ? "border-[var(--color-plum)] bg-[var(--color-plum-light)]" : "border-[var(--color-border)] hover:bg-[#fffaf6]")}>
              <span className="flex items-center gap-2">
                <input type="radio" name="ai-grading" value={m.value} checked={mode === m.value} onChange={() => setMode(m.value)} data-autofocus={i === 0 ? "" : undefined} />
                <b className="text-[14px]">{m.title}</b>
              </span>
              {m.badge && <span className="ds-pill ds-pill-ok mt-2 self-start">{m.badge}</span>}
              <span className="mt-2 text-xs leading-relaxed text-[var(--color-ink-muted)]">{m.body}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <section className="mt-7" aria-labelledby="rubric-h">
        <div className="flex flex-wrap items-center gap-3">
          <h3 id="rubric-h" className="text-[15px] font-bold">Rubric</h3>
          <span className="ds-pill ds-pill-neu ds-num">{rows.length ? `${formatNumber(total)} points` : "No rubric"}</span>
          <button type="button" className="ds-btn ds-btn-sm ml-auto" onClick={suggest} disabled={suggestRubric.isPending}>
            {suggestRubric.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
            {suggestRubric.isPending ? "Drafting…" : rows.length ? "Suggest a new rubric" : "Suggest a rubric"}
          </button>
        </div>
        {(settings.rubricSource === "ai" || suggested) && rows.length > 0 && (
          <p className="mt-3 rounded-[12px] border border-[#f3c98c] bg-[var(--color-plum-light)] px-4 py-2.5 text-[13px]">
            SocratiQ drafted these criteria from your instructions. Check the wording and the points — saving makes the rubric yours.
          </p>
        )}
        {rows.length === 0 ? (
          <div className="mt-3 rounded-[14px] border border-dashed border-[var(--color-border-strong)] p-5">
            <p className="text-sm text-[var(--color-ink-muted)]">
              Without a rubric the work gets one overall score. For consistent AI drafts, add criteria — or let SocratiQ suggest them; it also drafts one
              automatically the first time it grades this assignment.
            </p>
            <label className="mt-3 flex items-center gap-2 text-sm">Maximum score
              <input inputMode="decimal" className="ds-input !w-24 !py-1.5" value={holistic} onChange={(e) => setHolistic(e.target.value)} aria-label="Maximum score" />
            </label>
          </div>
        ) : (
          <ol className="mt-3 space-y-2.5">
            {rows.map((r, i) => (
              <li key={r.key} className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 rounded-[14px] border border-[var(--color-border)] p-3.5 sm:grid-cols-[28px_1fr_110px_auto]">
                <span className="hidden h-7 w-7 items-center justify-center rounded-full bg-[var(--color-surface-muted)] text-xs font-bold sm:flex" aria-hidden="true">{i + 1}</span>
                <div className="min-w-0 space-y-2">
                  <input className="ds-input !py-2 font-semibold" dir="auto" value={r.title} maxLength={120} placeholder="Criterion, e.g. Correct method"
                    aria-label={`Criterion ${i + 1} name`} onChange={(e) => update(r.key, { title: e.target.value })} />
                  <textarea className="ds-input !py-2 text-[13px]" dir="auto" rows={2} value={r.description} maxLength={1000}
                    placeholder="What full credit looks like (the AI grades against this)" aria-label={`Criterion ${i + 1} description`}
                    onChange={(e) => update(r.key, { description: e.target.value })} />
                </div>
                <label className="col-start-1 flex items-center gap-2 text-sm sm:col-start-auto sm:flex-col sm:items-stretch sm:gap-1">
                  <span className="text-xs font-semibold text-[var(--color-ink-muted)]">Points</span>
                  <input inputMode="decimal" className="ds-input !py-2 ds-num" value={r.pointsText} aria-label={`Criterion ${i + 1} points`}
                    onChange={(e) => update(r.key, { pointsText: e.target.value })} />
                </label>
                <button type="button" className="ds-btn ds-btn-ghost ds-btn-icon self-start" aria-label={`Remove criterion ${i + 1}`}
                  onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
              </li>
            ))}
          </ol>
        )}
        <button type="button" className="ds-btn ds-btn-sm mt-3" disabled={rows.length >= 25}
          onClick={() => setRows((rs) => [...rs, keyed({ id: "", title: "", description: "", points: rs.length ? 0 : Number(holistic) || 10 })])}>
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />Add criterion
        </button>
      </section>

      <section className="mt-7 grid gap-5 md:grid-cols-2">
        <label className="block">
          <span className="ds-label">Reference answer <span className="font-normal text-[var(--color-ink-muted)]">(optional)</span></span>
          <textarea className="ds-input min-h-[140px] text-[13px]" dir="auto" maxLength={50000} value={reference} onChange={(e) => setReference(e.target.value)}
            placeholder="A model solution. The AI uses it to judge correctness, accepts other valid approaches, and never quotes it to students." />
        </label>
        <label className="block">
          <span className="ds-label">Notes for grading <span className="font-normal text-[var(--color-ink-muted)]">(optional)</span></span>
          <textarea className="ds-input min-h-[140px] text-[13px]" dir="auto" maxLength={8000} value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder="What matters to you, e.g. “Units are required”, “Accept any correct method”, “Be strict about the explanation”." />
        </label>
      </section>
    </Dialog>
  )
}
