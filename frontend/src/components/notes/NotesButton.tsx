import { lazy, Suspense, useCallback, useRef } from "react"
import { NotebookPen } from "lucide-react"
import { notesPanel, useNotesPanel } from "@/lib/notes"
import { cn } from "@/lib/utils"

// The panel (and its Markdown renderer) is loaded on first open, so pages that never open notes don't pay for it.
const NotesDrawer = lazy(() => import("./NotesDrawer"))

/** Global "My Notes" action for students. It lives in the page header of every student page; the panel opens over the page without navigating,
 *  and stays open (on the same note) when the student moves to another page. */
export function NotesButton({ className }: { className?: string }) {
  const { open } = useNotesPanel()
  const trigger = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => {
    notesPanel.set({ open: false })
    trigger.current?.focus()
  }, [])
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls="notes-panel"
        onClick={() => (open ? close() : notesPanel.set({ open: true }))}
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-plum)]",
          open ? "border-[var(--color-plum)] bg-[var(--color-plum-light)] text-[var(--color-ink)]" : "border-[var(--color-border-strong)] bg-white text-[var(--color-ink-soft)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]",
          className,
        )}
      >
        <NotebookPen className="h-4 w-4" aria-hidden="true" />
        <span className="max-sm:sr-only">My Notes</span>
      </button>
      {open && (
        <Suspense fallback={<div id="notes-panel" role="status" className="fixed inset-y-0 right-0 z-40 w-full border-l border-[var(--color-border)] bg-white p-4 text-sm text-[var(--color-ink-muted)] sm:w-[420px]">Opening your notes…</div>}>
          <NotesDrawer onClose={close} />
        </Suspense>
      )}
    </>
  )
}
