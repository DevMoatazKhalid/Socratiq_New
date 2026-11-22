import { useEffect, useRef } from "react"
import { Link } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import Markdown from "react-markdown"
import { Pencil, X } from "lucide-react"
import { CourseDot, IMPORTANCE, PinButton, origin, stickyClass, type NotesContext } from "@/components/notes/NotesBoardView"
import { Skeleton } from "@/components/ui/States"
import { notesApi, notesPanel } from "@/lib/notes"
import { importanceLabel, organiseErrorText, useNoteMeta, type BoardNote } from "@/lib/notesBoard"
import { cn } from "@/lib/utils"

/** Expanded sticky note: organise it (importance, course, groups, pin) and read it. Text editing happens in the notes editor. */
export function NoteDialog({ note, ctx, onClose }: { note: BoardNote; ctx: NotesContext; onClose: () => void }) {
  const meta = useNoteMeta()
  const full = useQuery({ queryKey: ["notes", "one", note.id, note.version], queryFn: () => notesApi.get(note.id) })
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    box.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
      if (e.key !== "Tab" || !box.current) return
      const f = Array.from(box.current.querySelectorAll<HTMLElement>("button:not([disabled]), select, a[href]"))
      if (!f.length) return
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus() }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus() }
    }
    document.addEventListener("keydown", onKey)
    return () => { document.removeEventListener("keydown", onKey); prev?.focus?.() }
  }, [onClose])
  const course = note.courseId ? ctx.courseById.get(note.courseId) : undefined
  const asg = note.assignmentId ? ctx.assignmentById.get(note.assignmentId) : undefined
  const patch = (p: Parameters<typeof meta.mutate>[0]["patch"]) => meta.mutate({ id: note.id, patch: p })
  const toggleGroup = (id: string) => patch({ group_ids: note.groupIds.includes(id) ? note.groupIds.filter((g) => g !== id) : [...note.groupIds, id] })
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-4">
      <div className="absolute inset-0 bg-[rgb(28_22_8/0.5)]" onClick={onClose} aria-hidden="true" />
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby="note-dialog-title"
        className={cn("relative max-h-[90vh] w-[min(680px,100%)] overflow-auto rounded-[14px] px-7 pb-6 pt-6 shadow-[0_24px_60px_rgb(60_40_10/0.4)]", stickyClass(note.importance))}>
        <div className="flex items-center justify-between gap-2.5">
          <div className="flex flex-wrap gap-1.5">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/65 px-2.5 py-0.5 text-xs font-semibold"><CourseDot course={course} />{course?.name ?? "No course"}</span>
            {asg && <span className="rounded-full bg-white/65 px-2.5 py-0.5 text-xs font-semibold">{asg.title}</span>}
            <span className="rounded-full bg-white/65 px-2.5 py-0.5 text-xs font-semibold">{origin(note)}</span>
          </div>
          <div className="flex items-center gap-2">
            <PinButton note={note} />
            <button type="button" data-autofocus onClick={onClose} aria-label="Close" className="flex h-10 w-10 items-center justify-center rounded-full border border-[#a3a060] bg-white"><X className="h-4 w-4" aria-hidden="true" /></button>
          </div>
        </div>
        <h2 id="note-dialog-title" dir="auto" className="mt-3 font-serif text-[28px] font-bold leading-tight text-[var(--color-ink)]">{note.title || "Untitled note"}</h2>
        <dl className="my-4 grid grid-cols-[110px_1fr] items-center gap-x-3.5 gap-y-2.5 text-sm">
          <dt className="font-semibold text-[#4a4436]">Importance</dt>
          <dd>
            <div className="ds-seg !bg-white/70" role="group" aria-label="Importance">
              {IMPORTANCE.map((i) => <button key={i} type="button" aria-pressed={note.importance === i} onClick={() => patch({ importance: note.importance === i ? null : i })}>{importanceLabel[i]}</button>)}
            </div>
          </dd>
          <dt className="font-semibold text-[#4a4436]"><label htmlFor="note-course">Course</label></dt>
          <dd className="flex flex-wrap items-center gap-2">
            <select id="note-course" className="ds-sel" value={note.courseId ?? ""} onChange={(e) => patch({ course_id: e.target.value || null, assignment_id: null })}>
              <option value="">No course</option>
              {ctx.courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <span className="text-xs text-[#4a4436]">One course or none</span>
          </dd>
          <dt className="font-semibold text-[#4a4436]">Groups</dt>
          <dd className="flex flex-wrap gap-1.5">
            {ctx.groups.length === 0 ? <span className="text-xs text-[#4a4436]">No groups yet. <Link to="/student/notes/groups/new" className="underline">Create one</Link></span>
              : ctx.groups.map((g) => {
                const on = note.groupIds.includes(g.id)
                return <button key={g.id} type="button" aria-pressed={on} onClick={() => toggleGroup(g.id)}
                  className={cn("rounded-full border px-3 py-1 text-[13px] font-semibold", on ? "border-[var(--color-ink)] bg-white" : "border-[#a3a060] bg-white/70")}>{on ? "✓" : "+"} {g.name}</button>
              })}
          </dd>
          <dt className="font-semibold text-[#4a4436]">Created</dt>
          <dd>{new Date(note.createdAt).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}</dd>
        </dl>
        <div className="notes-markdown rounded-[10px] bg-white/60 px-4 py-3.5 text-sm leading-relaxed" dir="auto">
          {full.isPending ? <Skeleton className="h-16 w-full" /> : full.isError ? <p role="alert">This note couldn't be loaded.</p>
            : full.data.content.trim() ? <Markdown skipHtml>{full.data.content}</Markdown> : <p className="text-[var(--color-ink-muted)]">This note has no text yet.</p>}
        </div>
        {meta.isError && <p role="alert" className="mt-2 text-sm text-[var(--color-danger-ink)]">{organiseErrorText(meta.error)}</p>}
        <div className="mt-3.5 flex items-center justify-between gap-3 text-xs text-[#4a4436]">
          <span>{asg ? `Linked to ${asg.title}` : "Not linked to an assignment"} · {note.groupIds.length} group{note.groupIds.length === 1 ? "" : "s"}</span>
          <button type="button" className="ds-btn ds-btn-sm !rounded-full" onClick={() => { onClose(); notesPanel.set({ open: true, noteId: note.id }) }}>
            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />Edit text
          </button>
        </div>
      </div>
    </div>
  )
}

