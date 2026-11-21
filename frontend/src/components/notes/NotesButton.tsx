import { lazy, Suspense, useCallback, useRef } from "react"
import { NotebookText } from "lucide-react"
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
        title="My Notes"
        className={cn(
          // approved design: a 40px round icon button at the end of the header
          "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-plum)]",
          open ? "border-[var(--color-plum)] bg-[var(--color-plum-light)] text-[var(--color-ink)]" : "border-[var(--color-control-border)] bg-white text-[var(--color-ink)] hover:bg-[var(--color-surface-muted)]",
          className,
        )}
      >
        <NotebookText className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden="true" />
        <span className="sr-only">My Notes</span>
      </button>
      {open && (
        <Suspense fallback={<div id="notes-panel" role="status" className="fixed inset-y-0 right-0 z-40 w-full border-l border-[var(--color-border)] bg-white p-4 text-sm text-[var(--color-ink-muted)] sm:w-[420px]">Opening your notes…</div>}>
          <NotesDrawer onClose={close} />
        </Suspense>
      )}
    </>
  )
}
