import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { ArrowRight, CheckCheck, ChevronUp, Highlighter, LayoutGrid, Lightbulb, ListChecks, ListOrdered, Sparkles, type LucideIcon } from "lucide-react"
import { ASK_ACTIONS, type BoardIntent } from "@/lib/boardAsk"
import { cn } from "@/lib/utils"

/**
 * "Ask SocratiQ" on the SmartBoard: one clearly branded button that opens the board actions (explain, check my work, …).
 *
 * Why this is its own component: the previous `<details>` lived at the END of a horizontally scrolling (`overflow-x-auto`) AI bar. On any board
 * narrower than the full bar it was scrolled out of view, and its menu, positioned above the bar, was clipped by that same overflow container
 * (overflow-x: auto forces overflow-y to clip too), so opening it showed nothing. The button now sits at the START of a wrapping bar and the
 * menu is a sibling of the bar's overflow-free row, so it can never be pushed out or clipped.
 *
 * Accessible menu-button pattern: aria-haspopup/expanded, focus moves into the menu, ↑/↓/Home/End move, Esc / Tab / outside click close and
 * return focus to the button.
 */
const ICONS: Record<BoardIntent, LucideIcon> = {
  explain: Lightbulb, continue: ArrowRight, correct: CheckCheck, summarize: ListChecks, organize: LayoutGrid, highlight_key: Highlighter, steps: ListOrdered,
}
const HINTS: Record<BoardIntent, string> = {
  explain: "Guided explanation of what you drew",
  continue: "Pick up from your last step",
  correct: "Find where to look again",
  summarize: "The key points, briefly",
  organize: "Tidy the layout",
  highlight_key: "Mark the most important part",
  steps: "Rewrite as clear numbered steps",
}

export function AskSocratiqMenu({ disabled, busy, hasSelection, onAsk, compact = false }: {
  disabled?: boolean
  /** SocratiQ is already writing on the board: the menu stays visible but cannot start another turn. */
  busy?: boolean
  hasSelection: () => boolean
  onAsk: (intent: BoardIntent, message: string) => void
  /** Icon-only trigger for very narrow boards (the label stays available to screen readers and as a tooltip). */
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [selection, setSelection] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([])
  const menuId = useId()

  const close = useCallback((refocus = true) => {
    setOpen(false)
    if (refocus) buttonRef.current?.focus()
  }, [])

  const openMenu = () => {
    setSelection(hasSelection())
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => itemsRef.current.find((b) => b && !b.disabled)?.focus(), 0)
    const onDown = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) close(false) }
    document.addEventListener("pointerdown", onDown, true)
    return () => { window.clearTimeout(t); document.removeEventListener("pointerdown", onDown, true) }
  }, [open, close])

  const onMenuKey = (e: ReactKeyboardEvent) => {
    const items = itemsRef.current.filter((b): b is HTMLButtonElement => !!b && !b.disabled)
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const move = (i: number) => { e.preventDefault(); items[(i + items.length) % items.length]?.focus() }
    if (e.key === "ArrowDown") move(at + 1)
    else if (e.key === "ArrowUp") move(at - 1)
    else if (e.key === "Home") move(0)
    else if (e.key === "End") move(items.length - 1)
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close() }
    else if (e.key === "Tab") close(false)
  }

  const label = busy ? "SocratiQ is writing…" : "Ask SocratiQ"
  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Ask SocratiQ about the board"
        title="Ask SocratiQ about your board or your selection"
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(e) => { if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !open) { e.preventDefault(); openMenu() } }}
        className={cn(
          "sq-ask-trigger group inline-flex h-9 items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-white shadow-sm transition-all",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.97]",
          open && "ring-2 ring-teal-300",
          compact && "px-2.5",
        )}
      >
        <Sparkles className={cn("size-4 shrink-0", busy && "animate-pulse")} aria-hidden="true" />
        <span className={cn("whitespace-nowrap", compact && "sr-only")}>{label}</span>
        <ChevronUp className={cn("size-3.5 shrink-0 opacity-80 transition-transform", !open && "rotate-180", compact && "hidden")} aria-hidden="true" />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Ask SocratiQ"
          onKeyDown={onMenuKey}
          className="sq-ask-menu absolute bottom-full start-0 z-30 mb-2 w-[min(18rem,calc(100vw-1.5rem))] rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl"
        >
          <p className="px-2.5 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">
            {selection ? "About your selection" : "About the whole board"}
          </p>
          {ASK_ACTIONS.map((a, i) => {
            const Icon = ICONS[a.intent]
            return (
              <button
                key={a.intent}
                ref={(el) => { itemsRef.current[i] = el }}
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => { close(); onAsk(a.intent, a.message(selection)) }}
                className="flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2 text-start text-sm text-slate-800 outline-none transition-colors hover:bg-teal-50 focus-visible:bg-teal-50 focus-visible:ring-2 focus-visible:ring-teal-600/40 disabled:opacity-50"
              >
                <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-lg bg-teal-50 text-teal-700"><Icon className="size-3.5" aria-hidden="true" /></span>
                <span className="min-w-0">
                  <span className="block font-medium leading-5">{a.label}</span>
                  <span className="block text-xs leading-4 text-slate-500">{HINTS[a.intent]}</span>
                </span>
              </button>
            )
          })}
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] leading-4 text-slate-500">SocratiQ guides you with questions and writes on the board alongside you.</p>
        </div>
      )}
    </div>
  )
}
