import { useEffect, useMemo, useState } from "react"
import { AlertTriangle, Bot, CheckCircle2, ChevronDown, History, Loader2, RefreshCw, ShieldAlert, Sparkles, Wand2 } from "lucide-react"
import { Pill } from "@/components/ds"
import { RichText } from "@/components/ui/RichText"
import { ApiError } from "@/lib/api"
import { formatNumber } from "@/lib/grades"
import { shortDate } from "@/lib/studentWork"
import { formatDateTime } from "@/lib/time"
import { useGradingActions, useSetGrade, type Grade, type GradeEvaluation, type GradeHistoryEntry, type GradingSettings } from "@/lib/queries"
import { cn } from "@/lib/utils"

export const LEVEL_LABEL = { excellent: "Excellent", proficient: "Proficient", developing: "Developing", beginning: "Beginning", missing: "Not shown" } as const
const LEVEL_TONE = { excellent: "ok", proficient: "ok", developing: "or", beginning: "warn", missing: "bad" } as const
const SOURCE_LABEL = { manual: "Graded by you", ai: "AI draft released unchanged", ai_edited: "AI draft, edited by you" } as const
const ACTION_LABEL = { released: "Released", edited: "Changed", auto_released: "Released automatically", cleared: "Removed" } as const

const level = (p: number, max: number) => {
  const r = max ? p / max : 0
  return r >= 0.9 ? "excellent" : r >= 0.7 ? "proficient" : r >= 0.4 ? "developing" : r > 0 ? "beginning" : "missing"
}
const num = (s: string) => (s.trim() === "" ? NaN : Number(s))
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`)

/**
 * Grade & feedback for one submission, with the AI draft beside the decision.
 * The instructor always decides: a draft fills the form (marked as such), every number stays editable, and saving records whether the
 * released grade is the draft as is ("ai"), an edited draft ("ai_edited") or the instructor's own ("manual").
 */
export function GradePanel({ assignmentId, studentId, firstName, grade, hasSubmission, settings, evaluation, history, onNext }: {
  assignmentId: string
  studentId: string
  firstName: string
  grade: Grade | null
  hasSubmission: boolean
  /** null when the server has no assessment features (classic holistic grading) */
  settings: GradingSettings | null
  evaluation: GradeEvaluation | null
  history: GradeHistoryEntry[]
  onNext: () => void
}) {
  const { save, clear } = useSetGrade(assignmentId, studentId)
  const actions = useGradingActions(assignmentId)
  const rubric = settings?.rubric ?? []
  const draft = evaluation?.status === "COMPLETED" && !evaluation.stale ? evaluation : null
  const rubricMode = rubric.length > 0
  const fromDraft = !grade && !!draft

  // initial form: the released grade, else the up-to-date AI draft, else empty
  const init = useMemo(() => {
    const pts: Record<string, string> = {}, notes: Record<string, string> = {}
    for (const c of rubric) {
      const g = grade?.criteria?.find((x) => x.id === c.id)
      const d = draft?.criteria.find((x) => x.id === c.id)
      pts[c.id] = g ? formatNumber(g.pointsAwarded) : !grade && d ? formatNumber(d.pointsAwarded) : ""
      notes[c.id] = g?.comment ?? ""
    }
    return {
      pts, notes,
      score: grade ? formatNumber(grade.score) : draft && !rubricMode ? formatNumber(draft.score ?? 0) : "",
      max: grade ? formatNumber(grade.maxScore) : formatNumber(settings?.pointsPossible ?? 100),
      feedback: grade?.feedback ?? (draft?.feedback ?? ""),
      basedOn: grade ? null : draft?.id ?? null,
    }
  }, [grade, draft, rubric, rubricMode, settings?.pointsPossible])

  const [pts, setPts] = useState(init.pts)
  const [notes, setNotes] = useState(init.notes)
  const [openNote, setOpenNote] = useState<string | null>(null)
  const [score, setScore] = useState(init.score)
  const [max, setMax] = useState(init.max)
  const [feedback, setFeedback] = useState(init.feedback)
  const [basedOn, setBasedOn] = useState<string | null>(init.basedOn)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)
  const touch = () => { setSaved(false); setDirty(true) }

  const total = rubric.reduce((t, c) => t + (Number.isFinite(num(pts[c.id] ?? "")) ? num(pts[c.id]) : 0), 0)
  const maxTotal = rubric.reduce((t, c) => t + c.points, 0)
  const shownPct = rubricMode ? (maxTotal ? (total / maxTotal) * 100 : 0) : num(score) / num(max) * 100

  function applyDraft(d: GradeEvaluation) {
    if (rubricMode) setPts(Object.fromEntries(rubric.map((c) => [c.id, formatNumber(d.criteria.find((x) => x.id === c.id)?.pointsAwarded ?? 0)])))
    else { setScore(formatNumber(d.score ?? 0)); setMax(formatNumber(d.maxScore ?? 100)) }
    setFeedback(d.feedback ?? "")
    setBasedOn(d.id)
    setSaved(false)
  }

  // A draft that arrives while the form is untouched (the AI was still grading when the page opened) fills it in; typed work is never overwritten.
  const draftId = draft?.id
  useEffect(() => {
    if (draft && !grade && !dirty && basedOn !== draft.id) applyDraft(draft)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId])

  function validate(): string | null {
    if (rubricMode) {
      for (const c of rubric) {
        const v = num(pts[c.id] ?? "")
        if (!Number.isFinite(v)) return `Enter points for “${c.title}”.`
        if (v < 0 || v > c.points) return `“${c.title}” is worth 0–${formatNumber(c.points)} points.`
      }
      return null
    }
    const s = num(score), m = num(max)
    if (!Number.isFinite(s) || s < 0) return "Enter a score of 0 or more."
    if (!Number.isFinite(m) || m <= 0) return "The maximum score must be greater than 0."
    if (s > m) return "The score can't be higher than the maximum."
    return null
  }

  function onSave(next: boolean) {
    const problem = validate()
    if (problem) return setError(problem)
    setError(null)
    const body = rubricMode
      ? { criteria: rubric.map((c) => ({ id: c.id, points: num(pts[c.id]), comment: notes[c.id] })), feedback: feedback.trim(), evaluationId: basedOn }
      : { score: num(score), maxScore: num(max), feedback: feedback.trim(), evaluationId: basedOn }
    save.mutate(body, {
      onSuccess: () => { setSaved(true); if (next) onNext() },
      onError: (e) => setError(e instanceof ApiError ? e.message : "The grade couldn't be saved. Please try again."),
    })
  }

  const busy = evaluation && (evaluation.status === "QUEUED" || evaluation.status === "RUNNING")
  const aiOn = !!settings && settings.aiGrading !== "off"
  const blocked = draft?.flags.some((f) => f.severity === "block")

  return (
    <section className="ds-card !border-[var(--color-plum)] p-5 sm:p-6" aria-labelledby="gf-h">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="gf-h" className="text-lg font-bold">Grade & feedback</h2>
          <p className="text-[13px] text-[var(--color-ink-muted)]">
            {rubricMode ? `Rubric · ${rubric.length} criteria · ${formatNumber(maxTotal)} pts` : `Out of ${max || "—"}`}
            {grade && ` · ${grade.source ? SOURCE_LABEL[grade.source] : "graded"} ${shortDate(grade.gradedAt)}`}
          </p>
        </div>
        <Pill tone={grade ? (grade.reviewed === false ? "warn" : "ok") : fromDraft && basedOn ? "info" : "neu"}>
          {grade ? (grade.reviewed === false ? "Auto-released" : "Released") : fromDraft && basedOn ? "Draft" : "Not graded"}
        </Pill>
      </div>

      {/* ------------------------------------------------ the AI draft */}
      {settings && hasSubmission && (aiOn || evaluation) && (
        <div className="mt-4 rounded-[14px] border border-[var(--color-border)] bg-[#fbf8f1] p-4">
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-[var(--color-teal-dark)]" aria-hidden="true" />
            <b className="text-sm">AI draft</b>
            {draft && <span className="ml-auto text-sm font-bold ds-num">{formatNumber(draft.score ?? 0)} / {formatNumber(draft.maxScore ?? 0)}</span>}
          </div>
          {busy ? (
            <p role="status" className="mt-2 flex items-center gap-2 text-[13px] text-[var(--color-ink-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              {evaluation!.status === "QUEUED" ? "Waiting to be graded…" : "Reading the submission against the rubric…"}</p>
          ) : evaluation?.status === "FAILED" ? (
            <div className="mt-2">
              <p className="text-[13px] text-[var(--color-danger-ink)]">{evaluation.error ?? "The AI couldn't grade this submission."}</p>
              <RegradeButton onClick={() => actions.gradeOne.mutate(studentId)} pending={actions.gradeOne.isPending} label="Try again" />
            </div>
          ) : evaluation?.status === "COMPLETED" && evaluation.stale ? (
            <div className="mt-2">
              <p className="text-[13px] text-[var(--color-warning-ink)]">
                {evaluation.staleReasons.includes("resubmitted") ? "The student submitted a newer version since this draft." : "You changed the grading setup since this draft."}
              </p>
              <RegradeButton onClick={() => actions.gradeOne.mutate(studentId)} pending={actions.gradeOne.isPending} label="Draft again" />
            </div>
          ) : draft ? (
            <>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-[var(--color-ink-muted)]">Confidence</span>
                <span className="ds-bar !min-w-[70px] max-w-[110px]"><i style={{ width: `${(draft.confidence ?? 0) * 100}%`, background: (draft.confidence ?? 0) >= 0.75 ? "#6f9a7b" : (draft.confidence ?? 0) >= 0.6 ? "#c98a4b" : "#b96b64" }} /></span>
                <b className="ds-num">{pct(draft.confidence)}</b>
                {!draft.needsReview && <Pill tone="ok"><CheckCircle2 className="h-3 w-3" aria-hidden="true" />No concerns</Pill>}
              </div>
              {draft.flags.filter((f) => f.severity !== "info").length > 0 && (
                <ul className="mt-2.5 space-y-1.5">
                  {draft.flags.filter((f) => f.severity !== "info").map((f) => (
                    <li key={f.code} className={cn("flex gap-2 rounded-[10px] px-3 py-2 text-xs leading-snug", f.severity === "block" ? "bg-[var(--color-danger-light)] text-[var(--color-danger-ink)]" : "bg-[var(--color-warning-light)] text-[var(--color-warning-ink)]")}>
                      {f.severity === "block" ? <ShieldAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />}{f.message}
                    </li>
                  ))}
                </ul>
              )}
              {draft.rationale && (
                <details className="mt-2.5 text-[13px]">
                  <summary className="cursor-pointer font-semibold text-[var(--color-teal-dark)]">Why this grade</summary>
                  <p className="mt-1.5 text-[var(--color-ink-muted)]" dir="auto">{draft.rationale}</p>
                  {draft.flags.filter((f) => f.severity === "info").map((f) => <p key={f.code} className="mt-1 text-xs text-[var(--color-ink-muted)]">· {f.message}</p>)}
                </details>
              )}
              {(grade || basedOn !== draft.id) && (
                <button type="button" className="ds-btn ds-btn-sm mt-3" onClick={() => applyDraft(draft)}><Wand2 className="h-3.5 w-3.5" aria-hidden="true" />Use this draft</button>
              )}
            </>
          ) : aiOn ? (
            <div className="mt-1.5">
              <p className="text-[13px] text-[var(--color-ink-muted)]">No draft for this submission yet.</p>
              <RegradeButton onClick={() => actions.gradeOne.mutate(studentId)} pending={actions.gradeOne.isPending} label="Grade with AI" primary />
            </div>
          ) : null}
          {actions.gradeOne.isError && <p role="alert" className="mt-2 text-xs text-[var(--color-danger-ink)]">{actions.gradeOne.error instanceof ApiError ? actions.gradeOne.error.message : "Couldn't start the AI grader."}</p>}
        </div>
      )}

      {/* ------------------------------------------------ the decision */}
      {rubricMode ? (
        <ol className="mt-4 space-y-2.5" aria-label="Rubric">
          {rubric.map((c) => {
            const d = draft?.criteria.find((x) => x.id === c.id)
            const v = num(pts[c.id] ?? "")
            const lv = Number.isFinite(v) ? level(v, c.points) : null
            return (
              <li key={c.id} className="rounded-[12px] border border-[var(--color-border)] px-3.5 py-3">
                <div className="flex items-start gap-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold leading-snug" dir="auto">{c.title}</p>
                    {lv && <span className={cn("ds-pill mt-1", `ds-pill-${LEVEL_TONE[lv]}`)}>{LEVEL_LABEL[lv]}</span>}
                  </div>
                  <label className="flex h-10 shrink-0 items-center gap-1 rounded-[10px] border border-[var(--color-control-border)] px-2.5">
                    <input inputMode="decimal" value={pts[c.id] ?? ""} disabled={!hasSubmission} placeholder="—"
                      onChange={(e) => { setPts((p) => ({ ...p, [c.id]: e.target.value })); touch() }}
                      className="w-9 bg-transparent text-right text-[15px] font-bold outline-none ds-num" aria-label={`Points for ${c.title}, out of ${formatNumber(c.points)}`} />
                    <span className="text-sm text-[var(--color-ink-muted)] ds-num">/ {formatNumber(c.points)}</span>
                  </label>
                </div>
                {d && (
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-[var(--color-ink-muted)]">AI: {formatNumber(d.pointsAwarded)} / {formatNumber(d.pointsPossible)} — {LEVEL_LABEL[d.level]}</summary>
                    <p className="mt-1 text-[var(--color-ink)]" dir="auto">{d.rationale}</p>
                    {d.evidence && <blockquote dir="auto" className="mt-1.5 border-l-2 border-[var(--color-plum)] pl-2 italic text-[var(--color-ink-muted)]">“{d.evidence}”</blockquote>}
                  </details>
                )}
                {openNote === c.id || notes[c.id] ? (
                  <textarea dir="auto" rows={2} maxLength={1000} className="ds-input mt-2 !py-1.5 text-[13px]" placeholder={`A note for ${firstName} on this criterion`}
                    value={notes[c.id] ?? ""} onChange={(e) => { setNotes((n) => ({ ...n, [c.id]: e.target.value })); touch() }} aria-label={`Comment on ${c.title}`} />
                ) : hasSubmission ? (
                  <button type="button" className="mt-1.5 text-xs font-semibold text-[var(--color-teal-dark)] hover:underline" onClick={() => setOpenNote(c.id)}>Add a comment</button>
                ) : null}
              </li>
            )
          })}
        </ol>
      ) : (
        <div className="mt-4 flex items-center gap-2.5">
          <label className="flex h-[56px] items-center gap-1.5 rounded-[12px] border border-[var(--color-control-border)] px-4 text-[15px]">
            <input inputMode="decimal" value={score} disabled={!hasSubmission} onChange={(e) => { setScore(e.target.value); touch() }} placeholder="—"
              className="w-14 bg-transparent text-right text-lg font-bold outline-none" aria-label="Score" />
            <span className="text-[var(--color-ink-muted)]">/</span>
            <input inputMode="decimal" value={max} disabled={!hasSubmission} onChange={(e) => { setMax(e.target.value); touch() }} className="w-12 bg-transparent outline-none" aria-label="Out of" />
          </label>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between rounded-[12px] bg-[var(--color-surface-muted)] px-4 py-2.5">
        <span className="text-sm font-semibold">Total</span>
        <span className="text-lg font-bold ds-num">
          {rubricMode ? `${formatNumber(total)} / ${formatNumber(maxTotal)}` : `${score || "—"} / ${max || "—"}`}
          <span className="ml-2 text-sm font-semibold text-[var(--color-ink-muted)]">{Number.isFinite(shownPct) ? `${formatNumber(Math.round(shownPct * 10) / 10)}%` : ""}</span>
        </span>
      </div>

      <label htmlFor="gf-feedback" className="mt-4 flex items-center justify-between text-[13px] font-semibold">
        Feedback for {firstName}
        {basedOn && !grade && <span className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-teal-dark)]"><Sparkles className="h-3 w-3" aria-hidden="true" />From the AI draft — edit freely</span>}
      </label>
      <textarea id="gf-feedback" dir="auto" rows={5} maxLength={4000} value={feedback} disabled={!hasSubmission} onChange={(e) => { setFeedback(e.target.value); touch() }}
        placeholder={hasSubmission ? `Write feedback for ${firstName}…` : "You can grade once the student has submitted."} className="ds-input mt-1.5 min-h-[130px] resize-y" />
      {feedback.includes("$") && <div className="mt-2 rounded-[10px] border border-[var(--color-border)] px-3 py-2 text-[13px]"><p className="mb-1 text-xs font-semibold text-[var(--color-ink-muted)]">Preview</p><RichText text={feedback} /></div>}

      {blocked && basedOn === draft?.id && !grade && <p className="mt-2 text-xs text-[var(--color-danger-ink)]">Check the flagged concern above before releasing this draft.</p>}
      {error && <p role="alert" className="mt-2 text-sm text-[var(--color-danger-ink)]">{error}</p>}
      {saved && !error && <p role="status" className="mt-2 text-sm text-[var(--color-success-ink)]">Saved. {firstName} now sees this grade and feedback.</p>}

      <button type="button" className="ds-btn ds-btn-pri mt-4 w-full !py-3 !text-[15px]" disabled={!hasSubmission || save.isPending} onClick={() => onSave(true)}>
        {save.isPending ? "Saving…" : grade ? "Update grade & next ›" : basedOn ? "Release grade & next ›" : "Save grade & next ›"}
      </button>
      <div className="mt-2.5 grid grid-cols-2 gap-2.5">
        <button type="button" className="ds-btn !py-2.5" disabled={!hasSubmission || save.isPending} onClick={() => onSave(false)}>{grade ? "Update grade" : basedOn ? "Release grade" : "Save grade"}</button>
        {grade ? <button type="button" className="ds-btn ds-btn-danger !py-2.5" disabled={clear.isPending}
          onClick={() => clear.mutate(undefined, { onSuccess: () => { setScore(""); setFeedback(""); setPts(Object.fromEntries(rubric.map((c) => [c.id, ""]))) },
            onError: (e) => setError(e instanceof ApiError ? e.message : "The grade couldn't be removed.") })}>Remove grade</button>
          : <button type="button" className="ds-btn !py-2.5" onClick={onNext}>Skip ›</button>}
      </div>

      {history.length > 0 && (
        <details className="group mt-4 border-t border-[#eeeee0] pt-3">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-[13px] font-semibold text-[var(--color-ink-muted)]">
            <History className="h-3.5 w-3.5" aria-hidden="true" />Grade history ({history.length})<ChevronDown className="ml-auto h-4 w-4 transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <ol className="mt-2 space-y-1.5">
            {history.map((h) => (
              <li key={h.id} className="flex items-start justify-between gap-3 text-xs">
                <span><b>{ACTION_LABEL[h.action]}</b> by {h.actor}
                  {h.score !== null && <> · {formatNumber(h.score)}/{formatNumber(h.maxScore ?? 0)}</>}
                  {h.previousScore !== null && h.action !== "released" && <span className="text-[var(--color-ink-muted)]"> (was {formatNumber(h.previousScore)}/{formatNumber(h.previousMax ?? 0)})</span>}
                </span>
                <span className="shrink-0 text-[var(--color-ink-muted)]">{formatDateTime(h.at)}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  )
}

function RegradeButton({ onClick, pending, label, primary }: { onClick: () => void; pending: boolean; label: string; primary?: boolean }) {
  return (
    <button type="button" className={cn("ds-btn ds-btn-sm mt-2", primary && "ds-btn-soft")} onClick={onClick} disabled={pending}>
      {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : label === "Grade with AI" ? <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
      {label}
    </button>
  )
}
