import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { SlidersHorizontal } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Options for AI images on the SmartBoard: what kind of picture, its shape, and its quality. "Auto" lets SocratiQ's image planner decide
 * from the request (a "labelled diagram of the heart" becomes a clean textbook diagram, "a Roman market at dawn" an illustration).
 * The choice is remembered on this device.
 */
export type ImageStyle = "auto" | "diagram" | "illustration" | "realistic" | "infographic" | "sketch"
export type ImageAspect = "auto" | "1:1" | "4:3" | "3:4" | "16:9" | "9:16"
export type ImageQuality = "standard" | "high"
export interface ImageOptions { style: ImageStyle; aspect: ImageAspect; quality: ImageQuality }

export const DEFAULT_IMAGE_OPTIONS: ImageOptions = { style: "auto", aspect: "auto", quality: "standard" }

const STYLES: { id: ImageStyle; label: string; hint: string }[] = [
  { id: "auto", label: "Auto", hint: "SocratiQ picks the best style" },
  { id: "diagram", label: "Diagram", hint: "Clean, labelled, textbook style" },
  { id: "illustration", label: "Illustration", hint: "Explanatory artwork" },
  { id: "realistic", label: "Realistic", hint: "Photo-like, true to life" },
  { id: "infographic", label: "Infographic", hint: "Concept explained in panels" },
  { id: "sketch", label: "Sketch", hint: "Hand-drawn whiteboard look" },
]
const ASPECTS: { id: ImageAspect; label: string }[] = [
  { id: "auto", label: "Auto" }, { id: "1:1", label: "Square" }, { id: "4:3", label: "Landscape" }, { id: "16:9", label: "Wide" },
  { id: "3:4", label: "Portrait" }, { id: "9:16", label: "Tall" },
]
const QUALITIES: { id: ImageQuality; label: string; hint: string }[] = [
  { id: "standard", label: "Standard", hint: "Faster (about 10 s)" },
  { id: "high", label: "High detail", hint: "Sharper text and labels, 2K (about 30 s)" },
]

const KEY = "socratiq.smartboard.imageOptions"
export function loadImageOptions(): ImageOptions {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<ImageOptions> | null
    if (v && STYLES.some((s) => s.id === v.style) && ASPECTS.some((a) => a.id === v.aspect) && QUALITIES.some((q) => q.id === v.quality)) return v as ImageOptions
  } catch { /* storage unavailable: defaults */ }
  return DEFAULT_IMAGE_OPTIONS
}
function saveImageOptions(v: ImageOptions) {
  try { localStorage.setItem(KEY, JSON.stringify(v)) } catch { /* non-essential */ }
}

export function summarizeImageOptions(v: ImageOptions): string {
  const s = STYLES.find((x) => x.id === v.style)?.label ?? "Auto"
  const a = v.aspect === "auto" ? null : ASPECTS.find((x) => x.id === v.aspect)?.label
  return [s, a, v.quality === "high" ? "HD" : null].filter(Boolean).join(" · ")
}

export function ImageOptionsPicker({ value, onChange, disabled }: { value: ImageOptions; onChange: (v: ImageOptions) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const set = (patch: Partial<ImageOptions>) => { const next = { ...value, ...patch }; saveImageOptions(next); onChange(next) }

  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    document.addEventListener("pointerdown", down, true)
    document.addEventListener("keydown", key)
    return () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key) }
  }, [open])

  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        title="Image style, shape and quality"
        className={cn("inline-flex h-7 items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 text-xs font-medium text-slate-700 shadow-sm transition-colors hover:border-teal-300 hover:bg-teal-50/70 disabled:opacity-50", open && "border-teal-400 bg-teal-50")}
      >
        <SlidersHorizontal className="size-3 text-teal-700" aria-hidden="true" />
        <span className="max-w-[9rem] truncate">{summarizeImageOptions(value)}</span>
      </button>
      {open && (
        <div id={panelId} role="dialog" aria-label="Image options"
          className="absolute bottom-full start-0 z-30 mb-2 w-[min(20rem,calc(100vw-1.5rem))] rounded-2xl border border-slate-200 bg-white p-3 text-xs shadow-xl">
          <Group label="Style">
            {STYLES.map((s) => <Chip key={s.id} on={value.style === s.id} title={s.hint} onClick={() => set({ style: s.id })}>{s.label}</Chip>)}
          </Group>
          <Group label="Shape">
            {ASPECTS.map((a) => <Chip key={a.id} on={value.aspect === a.id} title={a.id === "auto" ? "Chosen to fit the subject" : a.id} onClick={() => set({ aspect: a.id })}>{a.label}</Chip>)}
          </Group>
          <Group label="Quality">
            {QUALITIES.map((q) => <Chip key={q.id} on={value.quality === q.id} title={q.hint} onClick={() => set({ quality: q.id })}>{q.label}</Chip>)}
          </Group>
          <p className="mt-1 text-[11px] leading-4 text-slate-500">{QUALITIES.find((q) => q.id === value.quality)?.hint}. Labels are written in the language of your request.</p>
        </div>
      )}
    </div>
  )
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <fieldset className="mb-2.5">
      <legend className="mb-1 font-semibold text-slate-600">{label}</legend>
      <div className="flex flex-wrap gap-1">{children}</div>
    </fieldset>
  )
}

function Chip({ on, title, onClick, children }: { on: boolean; title?: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} title={title} onClick={onClick}
      className={cn("rounded-full border px-2.5 py-1 font-medium transition-colors", on ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-teal-300 hover:bg-teal-50")}>
      {children}
    </button>
  )
}
