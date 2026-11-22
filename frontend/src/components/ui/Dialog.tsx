import { useEffect, useId, useRef, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Accessible modal dialog in the design system's style: focus moves into the dialog and is kept there, Esc and the backdrop close it,
 * focus returns to whatever opened it, and the page behind does not scroll. On phones it becomes a full-height sheet whose body scrolls
 * between a fixed header and footer.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = "md", initialFocus }: {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
  size?: "md" | "lg"
  /** CSS selector inside the dialog to focus first (default: the first field, else the dialog) */
  initialFocus?: string
}) {
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    if (!open) return
    const before = document.activeElement as HTMLElement | null
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const el = panel.current
    const first = (initialFocus && el?.querySelector<HTMLElement>(initialFocus)) || el?.querySelector<HTMLElement>("input, textarea, select") || el
    first?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); close.current() }
      if (e.key !== "Tab" || !el) return
      const items = Array.from(el.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])"))
        .filter((n) => n.offsetParent !== null || n === document.activeElement)
      if (!items.length) return
      const a = items[0], z = items[items.length - 1]
      if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus() }
      else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus() }
    }
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.body.style.overflow = prevOverflow
      before?.focus?.()
    }
  }, [open, initialFocus])

  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[rgb(20_17_2/0.38)] sm:items-center sm:p-6" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={description ? `${id}-d` : undefined} tabIndex={-1}
        className={cn("flex max-h-[100dvh] w-full flex-col overflow-hidden rounded-t-[22px] bg-[var(--color-surface)] shadow-[0_24px_60px_rgb(20_17_2/0.25)] outline-none sm:max-h-[min(860px,calc(100dvh-48px))] sm:rounded-[20px]",
          size === "lg" ? "sm:max-w-[860px]" : "sm:max-w-[560px]")}>
        <header className="flex items-start gap-3 border-b border-[var(--color-border)] px-6 pb-4 pt-5">
          <div className="min-w-0 flex-1">
            <h2 id={`${id}-t`} className="text-xl font-bold leading-tight text-[var(--color-ink)]">{title}</h2>
            {description && <p id={`${id}-d`} className="mt-1 text-[13px] text-[var(--color-ink-muted)]">{description}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)]">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 thin-scroll">{children}</div>
        {footer && <footer className="flex flex-wrap items-center justify-end gap-2.5 border-t border-[var(--color-border)] bg-[#fffaf6] px-6 py-4">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}
