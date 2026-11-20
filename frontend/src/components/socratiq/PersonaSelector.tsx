import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react"
import { Check, ChevronDown, RefreshCw, Sparkles } from "lucide-react"
import { usePersonas, useSetPersona, type PersonaInfo } from "@/lib/queries"
import { cn } from "@/lib/utils"

const cap = (s?: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "")

/** The one-line "how it teaches" summary, built only from fields the server sends (no second source of truth for persona copy). */
function approach(p: PersonaInfo): string {
  const parts = [p.tone ? `Tone: ${p.tone}` : "", p.socratic ? `Questioning: ${cap(p.socratic)}` : ""].filter(Boolean)
  return parts.join(" · ")
}

/** The student's teaching-style picker. Changing it never starts a new conversation: the choice is stored server-side and the very next reply uses it,
 *  in Chat, on the Board and in Live Voice. The application UI is English-only; Arabic is reserved for learning content. */
export function PersonaSelector({ assignmentId, disabled, compact }: { assignmentId?: string; disabled?: boolean; compact?: boolean }) {
  const q = usePersonas()
  const set = useSetPersona()
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState("")
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const radios = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()

  const close = (restoreFocus: boolean) => { setOpen(false); if (restoreFocus) trigger.current?.focus() }

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); trigger.current?.focus() } }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey) }
  }, [open])

  // Move focus into the panel when it opens, onto the active style, so keyboard and screen-reader users land on the current choice.
  const selectedId = q.data?.selected.id
  useEffect(() => {
    if (!open || !q.data) return
    const i = Math.max(0, q.data.personas.findIndex((p) => p.id === selectedId))
    radios.current[i]?.focus()
  }, [open, q.data, selectedId])

  const data = q.data
  if (!data) {
    // The selector is an enhancement, so a loading or failed fetch never blocks the page; a failure just offers a retry.
    if (!q.isError) return null
    return (
      <button type="button" onClick={() => void q.refetch()} className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-[var(--color-control-border)] bg-white px-3 text-sm font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-teal-dark)]">
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        <span className={cn(compact && "max-sm:sr-only")}>Teaching styles unavailable. Retry</span>
      </button>
    )
  }
  const current = data.personas.find((p) => p.id === data.selected.id) ?? data.personas[0]

  const choose = (pid: string) => {
    close(true)
    if (pid === data.selected.id) return
    const next = data.personas.find((p) => p.id === pid)
    set.mutate({ personaId: pid, assignmentId }, {
      onSuccess: () => setNotice(`Teaching style changed to ${next?.name.en}. Your conversation continues from here.`),
      onError: () => setNotice("Couldn't change the teaching style. Your previous style is still active."),
    })
  }

  const onRadioKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = data.personas.length
    const to = e.key === "ArrowDown" || e.key === "ArrowRight" ? (i + 1) % n : e.key === "ArrowUp" || e.key === "ArrowLeft" ? (i - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1
    if (to < 0) return
    e.preventDefault()
    radios.current[to]?.focus()          // focus moves; Enter / Space chooses, so browsing never fires a save request
  }

  return (
    <div ref={root} className="relative">
      <button
        ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-panel`} disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-full border border-[var(--color-control-border)] bg-white px-3 text-sm font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-teal-dark)] disabled:opacity-60", compact && "px-2.5")}
      >
        <Sparkles className="h-4 w-4 text-[var(--color-teal-dark)]" aria-hidden="true" />
        <span className={cn("max-w-[10rem] truncate", compact && "max-sm:sr-only")}>Teaching style: {current.name.en}</span>
        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <div role="status" aria-live="polite" className="sr-only">{notice}</div>
      {open && (
        <div id={`${id}-panel`} role="dialog" aria-label="Choose a teaching style" className="absolute right-0 z-30 mt-2 max-h-[min(75vh,34rem)] w-[min(23rem,calc(100vw-2rem))] overflow-y-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white p-2 shadow-lg">
          <p className="px-2 pb-1 pt-1 text-xs text-[var(--color-ink-muted)]">Changes how SocratiQ talks to you. It never changes what help is allowed on this assignment.</p>
          <p className="px-2 pb-2 text-xs text-[var(--color-ink-muted)]">Switching keeps your conversation, board and progress exactly as they are.</p>
          <div role="radiogroup" aria-label="Teaching style" className="space-y-1">
            {data.personas.map((p, i) => {
              const on = p.id === data.selected.id
              const how = approach(p)
              return (
                <button
                  key={p.id} ref={(el) => { radios.current[i] = el }} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1}
                  onClick={() => choose(p.id)} onKeyDown={(e) => onRadioKey(e, i)}
                  className={cn("flex min-h-11 w-full items-start gap-2.5 rounded-[var(--radius-md)] border px-2.5 py-2.5 text-left hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-teal-dark)]", on ? "border-[var(--color-teal-dark)] bg-[var(--color-teal-light)]" : "border-transparent")}
                >
                  <span className={cn("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", on ? "border-[var(--color-teal-dark)] bg-[var(--color-teal-dark)] text-white" : "border-[var(--color-control-border)]")}>{on && <Check className="h-3 w-3" aria-hidden="true" />}</span>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-sm font-semibold text-[var(--color-ink)]">{p.name.en}</span>
                      {on && <span className="rounded-full bg-[var(--color-teal-dark)] px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-white">Selected</span>}
                    </span>
                    <span className="block text-xs font-medium text-[var(--color-ink-soft)]">{p.tagline.en}</span>
                    <span className="mt-1 block text-xs leading-relaxed text-[var(--color-ink-soft)]">{p.description.en}</span>
                    {how && <span className="mt-1 block text-[11px] text-[var(--color-ink-muted)]">{how}</span>}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
