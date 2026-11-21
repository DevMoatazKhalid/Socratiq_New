import { useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { Pin } from "lucide-react"
import { AppShell } from "@/components/layout/AppShell"
import { courseColor } from "@/components/socratiq/CourseCard"
import { ApiError } from "@/lib/api"
import { newNoteId, notesPanel } from "@/lib/notes"
import { createBoardNote, importanceLabel, NOTES_BOARD_KEY, useCreateGroup, useNotesBoard, type Importance } from "@/lib/notesBoard"
import { useStudentHome } from "@/lib/queries"
import { cn } from "@/lib/utils"

const FORMATS = [
  { k: "b", label: "B", title: "Bold", wrap: ["**", "**"] },
  { k: "i", label: "I", title: "Italic", wrap: ["_", "_"] },
  { k: "h", label: "H", title: "Heading", line: "## " },
  { k: "ul", label: "•", title: "Bulleted list", line: "- " },
  { k: "ol", label: "1.", title: "Numbered list", line: "1. " },
] as const

/** New note (approved design): title, importance (sticky colour), pin, one course or none, optional assignment, groups, and the text. */
export default function NoteNew() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const home = useStudentHome()
  const board = useNotesBoard()
  const createGroup = useCreateGroup()
  const [id] = useState(newNoteId)          // fixed for this form: a retried save can never create a second note
  const [title, setTitle] = useState("")
  const [content, setContent] = useState("")
  const [importance, setImportance] = useState<Importance | null>("medium")
  const [pinned, setPinned] = useState(false)
  const [courseId, setCourseId] = useState<string | null>(null)
  const [assignmentId, setAssignmentId] = useState("")
  const [groupIds, setGroupIds] = useState<string[]>([])
  const [newGroup, setNewGroup] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)

  const courses = home.data?.courses ?? []
  const assignments = (home.data?.assignments ?? []).filter((a) => a.courseId === courseId)
  const groups = board.data?.groups ?? []
  const ready = title.trim() !== "" && content.trim() !== ""

  function format(f: (typeof FORMATS)[number]) {
    const el = area.current
    if (!el) return
    const { selectionStart: a, selectionEnd: b } = el
    let next: string
    if ("wrap" in f) next = content.slice(0, a) + f.wrap[0] + content.slice(a, b) + f.wrap[1] + content.slice(b)
    else {
      const start = content.lastIndexOf("\n", a - 1) + 1
      next = content.slice(0, start) + f.line + content.slice(start)
    }
    setContent(next)
    requestAnimationFrame(() => el.focus())
  }

  async function addGroup() {
    const name = newGroup.trim()
    if (!name) return
    try {
      const g = await createGroup.mutateAsync({ name, assignment_id: null, note_ids: [] })
      setGroupIds((s) => [...s, g.id])
      setNewGroup("")
    } catch {
      setError("That group couldn't be created. Try again.")
    }
  }

  async function save() {
    if (!ready || saving) return
    setSaving(true)
    setError(null)
    try {
      await createBoardNote({ id, title: title.trim(), content, meta: { importance, pinned, course_id: courseId, assignment_id: assignmentId || null, group_ids: groupIds } })
      await qc.invalidateQueries({ queryKey: NOTES_BOARD_KEY })
      notesPanel.set({ rev: notesPanel.get().rev + 1 })
      navigate("/student/notes")
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Your note couldn't be saved. Check your connection and try again.")
      setSaving(false)
    }
  }

  const firstLine = content.split("\n").find((l) => l.trim())?.replace(/^[#>*\-\d.\s]+/, "") ?? ""
  const course = courseId ? courses.find((c) => c.id === courseId) : undefined

  return (
    <AppShell role="student" crumbs={[{ label: "Notes", to: "/student/notes" }, { label: "New note" }]}>
      <h1 className="ds-h1">New note</h1>
      <p className="mt-1.5 text-sm text-[#5a5446]">Write it once. It belongs to one course (or none) and can sit in as many groups as you like.</p>

      <div className="mt-5 grid max-w-[1040px] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <form className="ds-card p-6" onSubmit={(e) => { e.preventDefault(); void save() }} noValidate>
          <label htmlFor="nn-title" className="mb-1.5 block text-sm font-bold">Title</label>
          <input id="nn-title" className="ds-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. AVL rotation cases" maxLength={200} />

          <p className="mb-1.5 mt-5 text-sm"><b>Importance</b> <span className="text-[#5a5446]">· sets the sticky note colour</span></p>
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="ds-seg" role="group" aria-label="Importance">
              {(["high", "medium", "low"] as const).map((i) => <button key={i} type="button" aria-pressed={importance === i} onClick={() => setImportance(importance === i ? null : i)}>{importanceLabel[i]}</button>)}
            </div>
            <button type="button" aria-pressed={pinned} onClick={() => setPinned((p) => !p)} className={cn("ds-chip !text-[13px] !font-semibold !text-[var(--color-ink)]", pinned && "is-on")}>
              <Pin className="h-3.5 w-3.5" aria-hidden="true" />{pinned ? "Pinned to board" : "Pin to board"}
            </button>
          </div>

          <p className="mb-1.5 mt-5 text-sm"><b>Course</b> <span className="text-[#5a5446]">· one, or none</span></p>
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Course">
            {[...courses.map((c) => ({ id: c.id as string | null, name: c.name, color: courseColor[c.color] })), { id: null, name: "No course", color: "#8a8472" }].map((c) => (
              <button key={c.id ?? "none"} type="button" role="radio" aria-checked={courseId === c.id} onClick={() => { setCourseId(c.id); setAssignmentId("") }}
                className={cn("ds-chip !text-[13px] !font-semibold !text-[var(--color-ink)]", courseId === c.id && "is-on")}>
                <i className="ds-dot" style={{ background: c.color }} aria-hidden="true" />{c.name}
              </button>
            ))}
          </div>

          <label htmlFor="nn-link" className="mb-1.5 mt-5 block text-sm"><b>Linked to</b> <span className="text-[#5a5446]">(assignment, optional)</span></label>
          <select id="nn-link" className="ds-input" value={assignmentId} onChange={(e) => setAssignmentId(e.target.value)} disabled={!courseId}>
            <option value="">{courseId ? "No assignment" : "Choose a course first"}</option>
            {assignments.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
          </select>

          <p className="mb-1.5 mt-5 text-sm"><b>Groups</b> <span className="text-[#5a5446]">· pick several, from any course</span></p>
          <div className="flex flex-wrap gap-2">
            {groups.map((g) => {
              const on = groupIds.includes(g.id)
              return <button key={g.id} type="button" aria-pressed={on} onClick={() => setGroupIds((s) => (on ? s.filter((x) => x !== g.id) : [...s, g.id]))}
                className={cn("ds-chip !text-[13px] !font-semibold !text-[var(--color-ink)]", on && "is-on")}>{on ? "✓" : "+"} {g.name}</button>
            })}
          </div>
          <div className="mt-2.5 flex items-center gap-2.5">
            <label htmlFor="nn-group" className="sr-only">New group name</label>
            <input id="nn-group" className="ds-input !w-[180px] !rounded-full !py-1.5 text-[13px]" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="New group name"
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void addGroup() } }} />
            <button type="button" onClick={() => void addGroup()} disabled={!newGroup.trim() || createGroup.isPending} className="text-[13px] font-semibold text-[#5c5a2a] underline disabled:opacity-50">Add</button>
          </div>

          <label htmlFor="nn-body" className="mb-1.5 mt-5 block text-sm font-bold">Note</label>
          <div role="toolbar" aria-label="Formatting" className="ds-seg !gap-1 !rounded-full">
            {FORMATS.map((f) => <button key={f.k} type="button" title={f.title} aria-label={f.title} onClick={() => format(f)} className={cn("!px-3 font-bold", f.k === "i" && "italic")}>{f.label}</button>)}
          </div>
          <textarea id="nn-body" ref={area} rows={8} dir="auto" value={content} onChange={(e) => setContent(e.target.value)} maxLength={100000}
            placeholder="Start with the key idea in one line, then add detail." className="ds-input mt-3 min-h-[190px] resize-y leading-relaxed" />

          {error && <p role="alert" className="mt-3 text-sm text-[var(--color-danger-ink)]">{error}</p>}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-[#5a5446]">{ready ? "Ready to save." : "Add a title and some text to save."}</p>
            <div className="flex gap-2">
              <Link to="/student/notes" className="ds-btn !rounded-full">Cancel</Link>
              <button type="submit" className="ds-btn ds-btn-pri !rounded-full" disabled={!ready || saving}>{saving ? "Saving…" : "Save note"}</button>
            </div>
          </div>
        </form>

        <aside className="lg:sticky lg:top-24" aria-label="Preview on the board">
          <h2 className="mb-2 text-sm font-bold">Preview on the board</h2>
          <div className={cn("ds-sticky", importance ? `ds-sticky-${importance}` : "ds-sticky-none")} aria-hidden="true">
            <b className="text-[13.5px]">{title.trim() || "Untitled note"}</b>
            <p className="line-clamp-3 flex-1 text-[13.5px] text-[#3d3828]">{firstLine || "Your note text appears here."}</p>
            <div className="flex items-center justify-between text-[11px] font-semibold text-[#4a4436]">
              <span className="flex items-center gap-1.5"><i className="ds-dot" style={{ background: course ? courseColor[course.color] : "#8a8472" }} />{course?.name ?? "No course"} · Today</span>
              <Pin className={cn("h-4 w-4", pinned && "text-[#c2410c]")} strokeWidth={1.8} />
            </div>
          </div>
          <p className="mt-3 text-[13px] text-[#5a5446]">The first line becomes the sticky note text. The rest shows when you open the note.</p>
        </aside>
      </div>
    </AppShell>
  )
}
