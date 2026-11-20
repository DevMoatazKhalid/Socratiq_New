import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { cn } from "@/lib/utils"

export const MIN_PCT = 25
export const MAX_PCT = 75
const KEY = "socratiq.workspace.split"
export const clampPct = (n: number) => Math.min(MAX_PCT, Math.max(MIN_PCT, Math.round(n * 10) / 10))

function readStored(fallback: number): number {
  try {
    const v = Number(window.localStorage.getItem(KEY))
    return Number.isFinite(v) && v > 0 ? clampPct(v) : fallback
  } catch { return fallback }                                   // storage can be unavailable: the default width is fine
}

/**
 * Two panes side by side with a draggable, keyboard-operable divider. BOTH panes stay mounted whatever happens (the board keeps its state and undo
 * history, the chat keeps its scroll position): collapsing only hides one with CSS. `left` is the conversation, `right` is the board.
 * The divider follows the WAI-ARIA "window splitter" pattern: role=separator, aria-valuenow = the left pane's width in percent.
 */
export function ResizableSplit({ left, right, collapsed, defaultPct = 40, leftLabel = "Conversation", className }: {
  left: ReactNode; right: ReactNode; collapsed: "left" | "right" | null; defaultPct?: number; leftLabel?: string; className?: string
}) {
  const [pct, setPct] = useState(() => readStored(defaultPct))
  const box = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const commit = useCallback((n: number) => {
    const v = clampPct(n)
    setPct(v)
    try { window.localStorage.setItem(KEY, String(v)) } catch { /* optional */ }
  }, [])

  const fromPointer = (clientX: number) => {
    const r = box.current?.getBoundingClientRect()
    if (!r || r.width <= 0) return
    // In RTL the conversation is on the right, so the fraction is measured from that edge.
    const rtl = getComputedStyle(box.current!).direction === "rtl"
    const x = rtl ? r.right - clientX : clientX - r.left
    commit((x / r.width) * 100)
  }

  useEffect(() => {
    const move = (e: PointerEvent) => { if (dragging.current) fromPointer(e.clientX) }
    const up = () => { dragging.current = false; document.body.style.removeProperty("user-select") }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const showBoth = collapsed === null
  return (
    <div ref={box} className={cn("flex min-h-0 min-w-0 flex-1", className)} data-testid="workspace-split">
      <section aria-label={leftLabel} className={cn("flex min-h-0 min-w-0 flex-col overflow-clip", collapsed === "left" && "hidden")} style={{ flexBasis: showBoth ? `${pct}%` : "100%", flexGrow: showBoth ? 0 : 1, flexShrink: 0 }}>
        {left}
      </section>
      {showBoth && (
        <div
          role="separator" aria-orientation="vertical" aria-label="Resize conversation and board" aria-valuemin={MIN_PCT} aria-valuemax={MAX_PCT} aria-valuenow={pct} tabIndex={0}
          onPointerDown={(e) => { dragging.current = true; document.body.style.userSelect = "none"; (e.target as HTMLElement).setPointerCapture?.(e.pointerId) }}
          onDoubleClick={() => commit(defaultPct)}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 10 : 2
            const rtl = box.current ? getComputedStyle(box.current).direction === "rtl" : false
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); commit(pct + ((e.key === "ArrowRight") !== rtl ? step : -step)) }
            else if (e.key === "Home") { e.preventDefault(); commit(MIN_PCT) }
            else if (e.key === "End") { e.preventDefault(); commit(MAX_PCT) }
            else if (e.key === "Enter") { e.preventDefault(); commit(defaultPct) }
          }}
          className="group relative z-10 w-1.5 shrink-0 cursor-col-resize touch-none bg-[var(--color-border)] transition-colors hover:bg-[var(--color-teal-dark)]/60 focus-visible:bg-[var(--color-teal-dark)] focus-visible:outline-none"
        >
          <span aria-hidden="true" className="absolute inset-y-0 -left-1.5 -right-1.5" />
        </div>
      )}
      <section aria-label="Board" className={cn("relative flex min-h-0 min-w-0 flex-1 flex-col overflow-clip", collapsed === "right" && "hidden")}>{right}</section>
    </div>
  )
}
