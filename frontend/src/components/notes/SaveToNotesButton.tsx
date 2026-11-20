import { useState } from "react"
import { BookmarkCheck, BookmarkPlus, Loader2 } from "lucide-react"
import { notesPanel, saveCoachReply, titleFrom } from "@/lib/notes"
import { cn } from "@/lib/utils"

/** "Save to Notes" under a Coach reply. Formatting (Markdown, code fences) is kept as-is. Saving the same reply twice returns the same note. */
export function SaveToNotesButton({ messageId, content, topic }: { messageId: string; content: string; topic?: string }) {
  const [state, setState] = useState<{ phase: "idle" | "saving" | "saved" | "error"; noteId?: string }>({ phase: "idle" })
  const ref = messageId.replace(/[^A-Za-z0-9_:.-]/g, "_").slice(0, 200)

  async function save() {
    if (state.phase === "saving") return
    setState({ phase: "saving" })
    try {
      const title = topic ? `${titleFrom(content)} · ${topic}`.slice(0, 200) : titleFrom(content)
      const note = await saveCoachReply(ref, title, content)
      setState({ phase: "saved", noteId: note.id })
      notesPanel.set({ rev: notesPanel.get().rev + 1 })                // an open notes list shows it right away
    } catch {
      setState({ phase: "error" })
    }
  }

  const cls = "mt-2 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-plum)]"
  if (state.phase === "saved") {
    return (
      <span className="mt-2 inline-flex items-center gap-2 text-xs" role="status">
        <span className="inline-flex items-center gap-1 text-[var(--color-success-ink)]"><BookmarkCheck className="h-3.5 w-3.5" aria-hidden="true" />Saved to notes</span>
        <button type="button" className="font-medium text-[var(--color-ink-muted)] underline underline-offset-2 hover:text-[var(--color-ink)]"
          onClick={() => notesPanel.set({ open: true, noteId: state.noteId ?? null })}>Open</button>
      </span>
    )
  }
  return (
    <button type="button" onClick={() => void save()} disabled={state.phase === "saving"}
      className={cn(cls, state.phase === "error" ? "text-[var(--color-danger-ink)] hover:bg-[var(--color-danger-light)]" : "text-[var(--color-ink-muted)] hover:bg-white hover:text-[var(--color-ink)]")}>
      {state.phase === "saving" ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <BookmarkPlus className="h-3.5 w-3.5" aria-hidden="true" />}
      {state.phase === "saving" ? "Saving…" : state.phase === "error" ? "Couldn't save · Try again" : "Save to notes"}
    </button>
  )
}
