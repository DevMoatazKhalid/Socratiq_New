import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import Markdown from "react-markdown"
import { AlertCircle, ArrowLeft, Bold, Check, Code, Eye, Heading2, Italic, List, Loader2, NotebookPen, Pencil, Plus, Search, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/Button"
import { Skeleton } from "@/components/ui/States"
import { ApiError } from "@/lib/api"
import { notesApi, notesPanel, notesSync as defaultSync, useNotesPanel, useNotesSync, type Draft, type NoteSummary, type NotesApi, type NotesSync } from "@/lib/notes"
import { relativeTime } from "@/lib/time"
import { cn } from "@/lib/utils"

/**
 * The student's notes, in a side panel that opens over any page without navigating away. It is not modal: the chat, the board and Live Voice
 * keep working next to it. Edits are saved by the module-level sync engine (lib/notes), so closing the panel never drops a pending save.
 */
export default function NotesDrawer({ client = notesApi, sync = defaultSync, onClose }: { client?: NotesApi; sync?: NotesSync; onClose: () => void }) {
  const { noteId } = useNotesPanel()
  const panelRef = useRef<HTMLElement>(null)

  const close = useCallback(() => {
    void sync.flushAll()                          // closing never loses text: anything pending is sent now and keeps retrying in the background
    onClose()
  }, [sync, onClose])

  // focus moves into the panel when it opens; Escape (while focus is inside) closes it
  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus()
  }, [noteId])
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.stopPropagation()
      close()
    }
  }

  return (
    <aside
      ref={panelRef}
      id="notes-panel"
      aria-label="My notes"
      onKeyDown={onKeyDown}
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-[var(--color-border)] bg-white shadow-[-8px_0_24px_rgba(20,17,2,0.08)] sm:w-[420px]"
    >
      {noteId ? (
        <NoteEditor key={noteId} id={noteId} client={client} sync={sync} onBack={() => { void sync.flush(noteId); notesPanel.set({ noteId: null }) }} onClose={close} />
      ) : (
        <NoteList client={client} sync={sync} onClose={close} />
      )}
    </aside>
  )
}

// ================================================================== list
function NoteList({ client, sync, onClose }: { client: NotesApi; sync: NotesSync; onClose: () => void }) {
  useNotesSync(sync)
  const { rev } = useNotesPanel()
  const [q, setQ] = useState("")
  const [debounced, setDebounced] = useState("")
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; notes: NoteSummary[]; error?: string }>({ status: "loading", notes: [] })
  const [reload, setReload] = useState(0)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    const ctl = new AbortController()
    setState((s) => ({ ...s, status: s.notes.length ? "ready" : "loading" }))
    client.list(debounced, ctl.signal).then(
      (notes) => setState({ status: "ready", notes }),
      (e) => { if (!ctl.signal.aborted) setState((s) => ({ ...s, status: "error", error: e instanceof ApiError ? e.message : "Couldn't load your notes." })) },
    )
    return () => ctl.abort()
  }, [client, debounced, reload, rev])

  // what the server listed, overlaid with what is being edited here right now (unsaved text and brand-new notes included)
  const items = useMemo(() => {
    const drafts = new Map(sync.drafts().map((d) => [d.id, d]))
    const needle = debounced.trim().toLowerCase()
    const matches = (d: Draft) => !needle || d.title.toLowerCase().includes(needle) || d.content.toLowerCase().includes(needle)
    const rows = state.notes.map((n) => {
      const d = drafts.get(n.id)
      drafts.delete(n.id)
      return d ? { id: n.id, title: d.title, preview: d.content.slice(0, 240), updatedAt: d.updatedAt, draft: d } : { ...n, draft: undefined as Draft | undefined }
    })
    for (const d of drafts.values()) {
      if (d.version === null && (d.title || d.content) && matches(d)) rows.push({ id: d.id, title: d.title, preview: d.content.slice(0, 240), updatedAt: d.updatedAt, draft: d })
    }
    return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.notes, debounced, sync.getVersion()])

  const create = () => {
    const d = sync.createLocal()
    notesPanel.set({ noteId: d.id })
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <h2 className="flex items-center gap-2 text-base font-semibold text-[var(--color-ink)]"><NotebookPen className="h-4 w-4" aria-hidden="true" />My notes</h2>
        <div className="flex items-center gap-1">
          <Button size="sm" onClick={create} data-autofocus><Plus className="h-4 w-4" aria-hidden="true" />New note</Button>
          <CloseButton onClose={onClose} />
        </div>
      </div>
      <div className="border-b border-[var(--color-border)] px-4 py-2.5">
        <label className="relative block">
          <span className="sr-only">Search notes</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-ink-muted)]" aria-hidden="true" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search notes"
            maxLength={100}
            className="h-9 w-full rounded-full border border-[var(--color-control-border)] bg-white pl-9 pr-3 text-sm text-[var(--color-ink)] placeholder:text-[var(--color-ink-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-plum)]"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto thin-scroll px-2 py-2">
        {state.status === "loading" && items.length === 0 ? (
          <div className="space-y-2 p-2" aria-busy="true" aria-label="Loading notes">
            <Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" />
          </div>
        ) : state.status === "error" && items.length === 0 ? (
          <div role="alert" className="m-2 rounded-[var(--radius-md)] border border-[var(--color-border)] p-4 text-center text-sm">
            <p className="text-[var(--color-ink)]">{state.error}</p>
            <Button className="mt-3" size="sm" variant="outline" onClick={() => setReload((n) => n + 1)}>Try again</Button>
          </div>
        ) : items.length === 0 ? (
          <div className="m-2 rounded-[var(--radius-lg)] border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface-muted)] px-5 py-10 text-center">
            <NotebookPen className="mx-auto mb-2 h-6 w-6 text-[var(--color-ink-muted)]" aria-hidden="true" />
            <p className="text-sm font-semibold text-[var(--color-ink)]">{debounced ? "No notes match your search" : "No notes yet"}</p>
            <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
              {debounced ? "Try other words." : "Write down ideas, explanations and code you want to keep. They're here on every page."}
            </p>
            {!debounced && <Button className="mt-4" size="sm" onClick={create}><Plus className="h-4 w-4" aria-hidden="true" />New note</Button>}
          </div>
        ) : (
          <ul className="space-y-1" aria-label="Notes">
            {items.map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => notesPanel.set({ noteId: n.id })}
                  className="w-full rounded-[var(--radius-md)] px-3 py-2.5 text-left transition-colors hover:bg-[var(--color-surface-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-plum)]"
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <span dir="auto" className="min-w-0 truncate text-sm font-semibold text-[var(--color-ink)]">{n.title || "Untitled note"}</span>
                    <span className="shrink-0 text-xs text-[var(--color-ink-muted)]">{n.draft && n.draft.state !== "saved" ? <SaveBadge draft={n.draft} compact /> : relativeTime(n.updatedAt)}</span>
                  </span>
                  {n.preview && <span dir="auto" className="mt-0.5 line-clamp-2 block text-xs text-[var(--color-ink-muted)]">{n.preview}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

// ================================================================== editor
function NoteEditor({ id, client, sync, onBack, onClose }: { id: string; client: NotesApi; sync: NotesSync; onBack: () => void; onClose: () => void }) {
  useNotesSync(sync)
  const draft = sync.draft(id)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [preview, setPreview] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState<"idle" | "busy" | "error">("idle")
  const area = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (sync.draft(id)) return
    let live = true
    client.get(id).then((n) => { if (live) sync.adopt(n) }, (e) => { if (live) setLoadError(e instanceof ApiError && e.status === 404 ? "This note no longer exists." : "Couldn't open this note.") })
    return () => { live = false }
  }, [id, client, sync])

  if (!draft) {
    return (
      <>
        <EditorHeader onBack={onBack} onClose={onClose} />
        <div className="p-4">
          {loadError ? <p role="alert" className="text-sm text-[var(--color-danger-ink)]">{loadError}</p> : <div className="space-y-3" aria-busy="true"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-40 w-full" /></div>}
        </div>
      </>
    )
  }

  const format = (kind: "bold" | "italic" | "heading" | "list" | "code") => {
    const el = area.current
    if (!el) return
    const { selectionStart: a, selectionEnd: b, value } = el
    const sel = value.slice(a, b)
    const lineStart = value.lastIndexOf("\n", a - 1) + 1
    let next = value
    let caret: [number, number] = [a, b]
    if (kind === "bold" || kind === "italic" || kind === "code") {
      const mark = kind === "bold" ? "**" : kind === "italic" ? "_" : sel.includes("\n") ? "```\n" : "`"
      const end = mark === "```\n" ? "\n```" : mark
      next = value.slice(0, a) + mark + sel + end + value.slice(b)
      caret = [a + mark.length, b + mark.length]
    } else {
      const prefix = kind === "heading" ? "## " : "- "
      next = value.slice(0, lineStart) + prefix + value.slice(lineStart)
      caret = [a + prefix.length, b + prefix.length]
    }
    sync.edit(id, { content: next })
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(caret[0], caret[1]) })
  }

  const doDelete = async () => {
    setDeleting("busy")
    try {
      await sync.remove(id)
      notesPanel.set({ noteId: null })
    } catch {
      setDeleting("error")
    }
  }

  return (
    <>
      <EditorHeader onBack={onBack} onClose={onClose} status={<SaveBadge draft={draft} />} />
      {(draft.state === "conflict" || draft.state === "deleted_elsewhere") && (
        <div role="alert" className="mx-4 mt-3 rounded-[var(--radius-md)] border border-[var(--color-warning)] bg-[var(--color-warning-light)] p-3 text-sm text-[var(--color-warning-ink)]">
          <p className="font-medium">{draft.error}</p>
          <p className="mt-0.5 text-xs">Your text here is kept until you choose.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {draft.state === "conflict" ? (
              <>
                <Button size="sm" onClick={() => void sync.keepMine(id)}>Keep my version</Button>
                <Button size="sm" variant="outline" onClick={() => void sync.useSaved(id)}>Use the saved version</Button>
              </>
            ) : (
              <Button size="sm" onClick={() => { const d = sync.saveAsNew(id); if (d) notesPanel.set({ noteId: d.id }) }}>Save as a new note</Button>
            )}
          </div>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-4 pt-3">
        <label className="sr-only" htmlFor={`note-title-${id}`}>Title</label>
        <input
          id={`note-title-${id}`}
          data-autofocus
          dir="auto"
          value={draft.title}
          maxLength={200}
          placeholder="Title"
          onChange={(e) => sync.edit(id, { title: e.target.value })}
          className="w-full rounded-[var(--radius-sm)] border-none bg-transparent px-0 text-lg font-semibold text-[var(--color-ink)] placeholder:text-[var(--color-ink-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-plum)]"
        />
        <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 border-y border-[var(--color-border)] py-1">
          {([["bold", Bold, "Bold"], ["italic", Italic, "Italic"], ["heading", Heading2, "Heading"], ["list", List, "Bulleted list"], ["code", Code, "Code"]] as const).map(([k, Icon, label]) => (
            <button key={k} type="button" aria-label={label} title={label} disabled={preview} onClick={() => format(k)}
              className="rounded-[var(--radius-sm)] p-1.5 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)] disabled:opacity-40">
              <Icon className="h-4 w-4" aria-hidden="true" />
            </button>
          ))}
          <span className="flex-1" />
          <button type="button" aria-pressed={preview} onClick={() => setPreview((p) => !p)}
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]">
            {preview ? <><Pencil className="h-3.5 w-3.5" aria-hidden="true" />Edit</> : <><Eye className="h-3.5 w-3.5" aria-hidden="true" />Preview</>}
          </button>
        </div>
        {preview ? (
          <div dir="auto" className="notes-markdown min-h-0 flex-1 overflow-y-auto thin-scroll text-sm leading-relaxed text-[var(--color-ink)]">
            {draft.content.trim() ? <Markdown skipHtml>{draft.content}</Markdown> : <p className="text-[var(--color-ink-muted)]">Nothing to preview yet.</p>}
          </div>
        ) : (
          <>
            <label className="sr-only" htmlFor={`note-body-${id}`}>Note</label>
            <textarea
              id={`note-body-${id}`}
              ref={area}
              dir="auto"
              value={draft.content}
              maxLength={100000}
              placeholder="Write your note… Markdown works: **bold**, _italic_, ## headings, - lists, `code`."
              onChange={(e) => sync.edit(id, { content: e.target.value })}
              className="min-h-0 w-full flex-1 resize-none rounded-[var(--radius-sm)] border-none bg-transparent px-0 text-sm leading-relaxed text-[var(--color-ink)] placeholder:text-[var(--color-ink-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-plum)]"
            />
          </>
        )}
        <div className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] pt-2">
          {confirmDelete ? (
            <div role="alertdialog" aria-label="Delete this note?" className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-[var(--color-ink)]">Delete this note? This can't be undone.</span>
              <Button size="sm" variant="danger" onClick={() => void doDelete()} disabled={deleting === "busy"} autoFocus>{deleting === "busy" ? "Deleting…" : "Delete"}</Button>
              <Button size="sm" variant="ghost" onClick={() => { setConfirmDelete(false); setDeleting("idle") }}>Cancel</Button>
              {deleting === "error" && <span role="alert" className="text-xs text-[var(--color-danger-ink)]">Couldn't delete. Try again.</span>}
            </div>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}><Trash2 className="h-4 w-4" aria-hidden="true" />Delete</Button>
          )}
          {!confirmDelete && <span className="text-xs text-[var(--color-ink-muted)]">{draft.content.length.toLocaleString()} characters</span>}
        </div>
      </div>
    </>
  )
}

function EditorHeader({ onBack, onClose, status }: { onBack: () => void; onClose: () => void; status?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-2 py-2">
      <Button size="sm" variant="ghost" onClick={onBack}><ArrowLeft className="h-4 w-4" aria-hidden="true" />All notes</Button>
      <div className="flex items-center gap-2">
        {status}
        <CloseButton onClose={onClose} />
      </div>
    </div>
  )
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" onClick={onClose} aria-label="Close notes"
      className="rounded-[var(--radius-sm)] p-2 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-plum)]">
      <X className="h-4 w-4" aria-hidden="true" />
    </button>
  )
}

/** Saving… / Saved / Save failed. "Saved" only after the server confirmed this exact text. */
export function SaveBadge({ draft, compact }: { draft: Draft; compact?: boolean }) {
  const s = draft.state
  if (s === "saved" && !draft.saved) return null                          // a brand-new empty note: nothing to save yet
  const base = "inline-flex items-center gap-1 text-xs"
  const body =
    s === "saved" ? <span className={cn(base, "text-[var(--color-success-ink)]")}><Check className="h-3.5 w-3.5" aria-hidden="true" />Saved</span>
    : s === "pending" || s === "saving" ? <span className={cn(base, "text-[var(--color-ink-muted)]")}><Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />Saving…</span>
    : <span className={cn(base, "text-[var(--color-danger-ink)]")}><AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />{s === "error" ? "Save failed" : s === "conflict" ? "Changed elsewhere" : "Deleted elsewhere"}</span>
  return (
    <span role="status" aria-live="polite" title={draft.error ?? undefined}>
      {body}
      {!compact && s === "error" && draft.error && <span className="sr-only"> {draft.error}</span>}
    </span>
  )
}
