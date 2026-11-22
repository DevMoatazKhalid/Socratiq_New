import { useEffect, useState } from "react"
import { Check, ExternalLink, Image as ImageIcon, RefreshCw, Search, Sparkles, Workflow } from "lucide-react"
import { cn } from "@/lib/utils"
import type { VisualCandidate, VisualResult } from "@/lib/queries"

/**
 * The SmartBoard's ONE image experience: live progress through the real stages, then either the image (clearly marked as a real, sourced
 * image or as AI-generated, with attribution and the other good matches to choose from) or, when nothing was good enough, the closest
 * results and the next steps. The user never has to know whether SocratiQ searched or generated; they can always see which it was.
 */

export type VisualStage = "understanding" | "searching" | "evaluating" | "retrieving" | "generating" | "placing"
export const VISUAL_STAGES: ReadonlySet<string> = new Set(["understanding", "searching", "evaluating", "retrieving", "generating", "placing"])

const STEPS: { id: VisualStage; label: string }[] = [
  { id: "understanding", label: "Understand" },
  { id: "searching", label: "Search" },
  { id: "evaluating", label: "Check" },
  { id: "generating", label: "Create" },
  { id: "placing", label: "Place" },
]
const ORDER: Record<VisualStage, number> = { understanding: 0, searching: 1, evaluating: 2, retrieving: 2.5, generating: 3, placing: 4 }

/** Which steps to draw: "Create" only appears once generation is planned or happening; "Search"/"Check" disappear for a direct creation. */
export function visibleSteps(seen: readonly VisualStage[], mode: "auto" | "search" | "generate") {
  const generating = mode === "generate" || seen.includes("generating")
  const searching = mode !== "generate" && (seen.includes("searching") || !seen.includes("generating"))
  return STEPS.filter((s) => (s.id === "generating" ? generating : s.id === "searching" || s.id === "evaluating" ? searching : true))
}

export function VisualProgress({ stage, label, seen, mode, startedAt }: { stage: VisualStage; label: string; seen: readonly VisualStage[]; mode: "auto" | "search" | "generate"; startedAt: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500)
    return () => window.clearInterval(t)
  }, [])
  const secs = Math.max(0, Math.round((now - startedAt) / 1000))
  const steps = visibleSteps(seen, mode)
  const cur = ORDER[stage]
  return (
    <span className="flex flex-col gap-1.5">
      <ol aria-label="Progress" className="flex flex-wrap items-center gap-1 text-[11px]">
        {steps.map((s, i) => {
          const done = ORDER[s.id] < cur
          const active = ORDER[s.id] === Math.floor(cur) || (s.id === "evaluating" && stage === "retrieving")
          return (
            <li key={s.id} className="flex items-center gap-1" aria-current={active ? "step" : undefined}>
              {i > 0 && <span aria-hidden className={cn("h-px w-3", done || active ? "bg-teal-500" : "bg-slate-200")} />}
              <span className={cn("inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 font-medium",
                done ? "border-teal-200 bg-teal-50 text-teal-800" : active ? "border-teal-500 bg-white text-teal-800 shadow-sm" : "border-slate-200 text-slate-400")}>
                {done ? <Check className="size-3" aria-hidden /> : active ? <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-teal-600" /> : null}
                {s.label}
              </span>
            </li>
          )
        })}
        <li className="ms-auto tabular-nums text-[var(--color-ink-muted)]">{secs}s</li>
      </ol>
      <span className="text-xs">{label}</span>
      <span aria-hidden className="sq-progress-track"><span className="sq-progress-bar" /></span>
    </span>
  )
}

/** The words under the image on the board. Retrieved images keep their source and licence there, so they stay attributed wherever the board goes. */
export function visualCaption(r: Pick<VisualResult, "title" | "source" | "attribution">): string {
  if (r.source === "retrieved" || r.source === "reference") {
    const a = r.attribution
    const credit = a ? [a.author, a.license, a.provider].filter(Boolean).join(", ") : ""
    return [r.title, credit ? `Source: ${credit}` : null].filter(Boolean).join(" — ")
  }
  return [r.title, "AI-generated image"].filter(Boolean).join(" — ")
}

export function SourceBadge({ result }: { result: Pick<VisualResult, "source" | "kind"> }) {
  const real = result.source === "retrieved" || result.source === "reference"
  const kind = result.kind === "diagram" ? "diagram" : result.kind === "map" ? "map" : result.kind === "photo" ? "photo" : "image"
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
      real ? "bg-sky-50 text-sky-800 ring-1 ring-sky-200" : "bg-violet-50 text-violet-800 ring-1 ring-violet-200")}>
      {real ? <ImageIcon className="size-3" aria-hidden /> : <Sparkles className="size-3" aria-hidden />}
      {real ? `Real ${kind}` : "AI-generated"}
    </span>
  )
}

function CandidateStrip({ items, busyToken, onPick, label }: { items: VisualCandidate[]; busyToken?: string | null; onPick: (c: VisualCandidate) => void; label: string }) {
  if (!items.length) return null
  return (
    <div className="mt-1.5">
      <p className="mb-1 text-[11px] font-medium text-[var(--color-ink-muted)]">{label}</p>
      <ul className="flex gap-1.5 overflow-x-auto pb-0.5">
        {items.map((c) => (
          <li key={c.token ?? c.title} className="shrink-0">
            <button
              type="button"
              disabled={!c.token || c.selected || !!busyToken}
              onClick={() => onPick(c)}
              aria-pressed={c.selected}
              title={`${c.title}\n${c.provider} · ${c.license}${c.author ? ` · ${c.author}` : ""}${c.suitable ? "" : `\nNot recommended: ${c.note || "may not match the request"}`}`}
              className={cn("relative block size-14 overflow-hidden rounded-md border bg-slate-50 transition", c.selected ? "border-teal-600 ring-2 ring-teal-600/30" : "border-slate-200 hover:border-teal-400",
                !c.suitable && !c.selected && "opacity-60 hover:opacity-100")}
            >
              {c.thumbUrl ? <img src={c.thumbUrl} alt={c.title} className="size-full object-cover" /> : <ImageIcon className="m-auto size-5 text-slate-400" aria-hidden />}
              {c.selected && <span className="absolute inset-x-0 bottom-0 bg-teal-700/85 text-center text-[9px] font-semibold text-white">On board</span>}
              {busyToken === c.token && <span className="absolute inset-0 grid place-items-center bg-white/70"><RefreshCw className="size-4 animate-spin text-teal-700" aria-hidden /></span>}
              {!c.suitable && !c.selected && <span className="absolute end-0.5 top-0.5 rounded bg-amber-100 px-0.5 text-[9px] font-semibold text-amber-800">?</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

const linkBtn = "inline-flex items-center gap-1 underline decoration-slate-300 underline-offset-2 hover:decoration-teal-600 disabled:opacity-50"

export function VisualResultCard({ result, busy, busyToken, onShow, onRemove, onPick, onGenerate, onSearch, onRegenerate }: {
  result: VisualResult
  busy: boolean
  busyToken?: string | null
  onShow: () => void
  onRemove: () => void
  onPick: (c: VisualCandidate) => void
  onGenerate: () => void
  onSearch: () => void
  onRegenerate: () => void
}) {
  const real = result.source === "retrieved" || result.source === "reference"
  const a = result.attribution
  const others = result.candidates.filter((c) => c.suitable || c.selected)
  const near = result.candidates.filter((c) => !c.suitable && !c.selected)
  const d = result.decision
  const why = real
    ? d.evaluation === "vision" ? "Found in an open library and checked by SocratiQ for accuracy and relevance." : "Found in an open library; title and source match your request."
    : d.searched ? "No existing image was accurate enough, so SocratiQ created this one. It is not a real photograph." : d.reason || "Created by SocratiQ for your request."
  return (
    <div className="flex flex-col">
      <div className="flex items-start gap-2">
        {result.imageUrl && <img src={result.imageUrl} alt="" className="size-12 shrink-0 rounded-md border border-slate-200 object-cover" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <SourceBadge result={result} />
            <span className="min-w-0 truncate font-medium text-slate-800">{result.title}</span>
          </div>
          {real && a && (
            <p className="mt-0.5 text-[11px] text-[var(--color-ink-muted)]">
              {[a.author, a.license, a.provider].filter(Boolean).join(" · ")}
              {a.url && <> · <a href={a.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 underline">Source<ExternalLink className="size-3" aria-hidden /></a></>}
            </p>
          )}
          <p className="mt-0.5 text-[11px] text-[var(--color-ink-muted)]">{why}</p>
        </div>
      </div>
      {others.length > 1 && <CandidateStrip items={others} busyToken={busyToken} onPick={onPick} label="Other good matches: pick one to swap it in" />}
      {!others.length && near.length > 0 && !real && <CandidateStrip items={near} busyToken={busyToken} onPick={onPick} label="Existing images SocratiQ found but didn't trust (use with care)" />}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button type="button" className={linkBtn} onClick={onShow}>Show</button>
        {real && <button type="button" className={linkBtn} disabled={busy} onClick={onGenerate}><Sparkles className="size-3" aria-hidden />Create an AI image instead</button>}
        {!real && <button type="button" className={linkBtn} disabled={busy} onClick={onRegenerate}><RefreshCw className="size-3" aria-hidden />Regenerate</button>}
        {!real && !d.searched && <button type="button" className={linkBtn} disabled={busy} onClick={onSearch}><Search className="size-3" aria-hidden />Find real images</button>}
        <button type="button" className={linkBtn} onClick={onRemove}>Remove</button>
      </div>
    </div>
  )
}

export function VisualNoMatchCard({ result, busy, busyToken, onPick, onGenerate, onSearch, onRephrase, onDiagram, onDismiss }: {
  result: VisualResult
  busy: boolean
  busyToken?: string | null
  onPick: (c: VisualCandidate) => void
  onGenerate: () => void
  onSearch: () => void
  onRephrase: () => void
  onDiagram: () => void
  onDismiss: () => void
}) {
  const alt = new Set(result.alternatives)
  return (
    <div className="flex flex-col">
      <p className="text-slate-800">{result.message || "SocratiQ couldn't find an image that is accurate enough."}</p>
      {result.candidates.length > 0 && <CandidateStrip items={result.candidates} busyToken={busyToken} onPick={onPick} label="Closest results (not verified as accurate)" />}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        {alt.has("generate") && <button type="button" className={linkBtn} disabled={busy} onClick={onGenerate}><Sparkles className="size-3" aria-hidden />Create an AI image</button>}
        {alt.has("search") && <button type="button" className={linkBtn} disabled={busy} onClick={onSearch}><Search className="size-3" aria-hidden />Find real images</button>}
        {alt.has("diagram") && <button type="button" className={linkBtn} disabled={busy} onClick={onDiagram}><Workflow className="size-3" aria-hidden />Draw it as a diagram</button>}
        {alt.has("rephrase") && <button type="button" className={linkBtn} onClick={onRephrase}>Rephrase</button>}
        <button type="button" className={linkBtn} onClick={onDismiss}>Dismiss</button>
      </div>
    </div>
  )
}
