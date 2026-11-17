import { useEffect, useId, useRef, useState } from "react"
import { Check, ChevronDown, Sparkles } from "lucide-react"
import { usePersonas, useSetPersona } from "@/lib/queries"
import { cn } from "@/lib/utils"

/** The student's teaching-style picker. Changing it never starts a new conversation: the choice is stored server-side and the very next reply uses it,
 *  in Chat, on the Board and in Live Voice. Names are shown in English and Arabic because the app has no global locale. */
export function PersonaSelector({ assignmentId, disabled, compact }: { assignmentId?: string; disabled?: boolean; compact?: boolean }) {
  const q = usePersonas()
  const set = useSetPersona()
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState("")
  const root = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (root.current && !root.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey) }
  }, [open])

  const data = q.data
  if (!data) return null                                         // the selector is an enhancement: no data, no control, never a blocking error
  const current = data.personas.find((p) => p.id === data.selected.id) ?? data.personas[0]

  const choose = (pid: string) => {
    setOpen(false)
    if (pid === data.selected.id) return
    const next = data.personas.find((p) => p.id === pid)
    set.mutate({ personaId: pid, assignmentId }, {
      onSuccess: () => setNotice(`Teaching style changed to ${next?.name.en}. Your conversation continues from here.`),
      onError: () => setNotice("Couldn't change the teaching style. Your previous style is still active."),
    })
  }

  return (
    <div ref={root} className="relative">
      <button
        type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-panel`} disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-full border border-[var(--color-control-border)] bg-white px-3 text-sm font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-muted)] disabled:opacity-60", compact && "px-2.5")}
      >
        <Sparkles className="h-4 w-4 text-[var(--color-teal-dark)]" aria-hidden="true" />
        <span className={cn("max-w-[10rem] truncate", compact && "max-sm:sr-only")}>Teaching style: {current.name.en}</span>
        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <div role="status" aria-live="polite" className="sr-only">{notice}</div>
      {open && (
        <div id={`${id}-panel`} role="dialog" aria-label="Choose a teaching style" className="absolute right-0 z-30 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white p-2 shadow-lg">
          <p className="px-2 pb-1.5 pt-1 text-xs text-[var(--color-ink-muted)]">Changes how SocratiQ talks to you. It never changes what help is allowed on this assignment.</p>
          <div role="radiogroup" aria-label="Teaching style" className="space-y-1">
            {data.personas.map((p) => {
              const on = p.id === data.selected.id
              return (
                <button
                  key={p.id} type="button" role="radio" aria-checked={on} onClick={() => choose(p.id)}
                  className={cn("flex w-full items-start gap-2 rounded-[var(--radius-md)] px-2.5 py-2 text-left hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-teal-dark)]", on && "bg-[var(--color-teal-light)]")}
                >
                  <span className={cn("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", on ? "border-[var(--color-teal-dark)] bg-[var(--color-teal-dark)] text-white" : "border-[var(--color-control-border)]")}>{on && <Check className="h-3 w-3" aria-hidden="true" />}</span>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-baseline gap-x-2"><span className="text-sm font-semibold text-[var(--color-ink)]">{p.name.en}</span><span dir="rtl" lang="ar" className="text-xs text-[var(--color-ink-muted)]">{p.name.ar}</span></span>
                    <span className="block text-xs text-[var(--color-ink-soft)]">{p.description.en}</span>
                    <span dir="rtl" lang="ar" className="mt-0.5 block text-xs text-[var(--color-ink-muted)]">{p.description.ar}</span>
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
