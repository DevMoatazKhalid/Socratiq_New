import { useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { Check, Minus, X } from "lucide-react"
import { AppShell } from "@/components/layout/AppShell"
import { courseColor } from "@/components/socratiq/CourseCard"
import { importanceLabel, organiseErrorText, useCreateGroup, useNotesBoard, type BoardNote } from "@/lib/notesBoard"
import { useStudentHome } from "@/lib/queries"
import { matches } from "@/lib/search"
import { cn } from "@/lib/utils"
import { noteDate } from "@/components/notes/NotesBoardView"

function Box({ state }: { state: "on" | "off" | "some" }) {
  return (
    <span aria-hidden="true" className={cn("mt-0.5 inline-grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border-[1.5px]", state === "off" ? "border-[#8a8472] bg-white" : "border-[#f59300] bg-[#f59300]")}>
      {state === "on" ? <Check className="h-3 w-3" strokeWidth={3} /> : state === "some" ? <Minus className="h-3 w-3" strokeWidth={3} /> : null}
    </span>
  )
}

/** New group (approved design): name it, optionally attach it to an assignment, and pick notes from any course. */
export default function NoteGroupNew() {
  const navigate = useNavigate()
  const home = useStudentHome()
  const board = useNotesBoard()
  const create = useCreateGroup()
  const [name, setName] = useState("")
  const [assignmentId, setAssignmentId] = useState("")
  const [courseF, setCourseF] = useState("all")
  const [query, setQuery] = useState("")
  const [fromGroup, setFromGroup] = useState("")
  const [sort, setSort] = useState<"new" | "old" | "title">("new")
  const [picked, setPicked] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  const courses = home.data?.courses ?? []
  const notes = board.data?.notes ?? []
  const groups = board.data?.groups ?? []
  const asgById = useMemo(() => new Map((home.data?.assignments ?? []).map((a) => [a.id, a])), [home.data])
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name
  const sections = [...courses.map((c) => ({ id: c.id, name: c.name, color: courseColor[c.color] })), { id: "none", name: "No course", color: "#8a8472" }]
  const inCourse = (n: BoardNote, id: string) => (n.courseId ?? "none") === id
  const visible = notes
    .filter((n) => courseF === "all" || inCourse(n, courseF))
    .filter((n) => matches(query, n.title, n.preview))
    .filter((n) => !fromGroup || n.groupIds.includes(fromGroup))
    .sort((a, b) => sort === "title" ? (a.title || "").localeCompare(b.title || "") : sort === "old" ? a.updatedAt.localeCompare(b.updatedAt) : b.updatedAt.localeCompare(a.updatedAt))
  const toggle = (id: string) => setPicked((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const pickedNotes = notes.filter((n) => picked.includes(n.id))
  const pickedCourses = sections.filter((s) => pickedNotes.some((n) => inCourse(n, s.id)))

  async function submit() {
    if (!name.trim()) return setError("Give the group a name.")
    setError(null)
    try {
      await create.mutateAsync({ name: name.trim(), assignment_id: assignmentId || null, note_ids: picked })
      navigate("/student/notes")
    } catch (e) {
      setError(`The group couldn't be created. ${organiseErrorText(e)}`)
    }
  }

  return (
    <AppShell role="student" crumbs={[{ label: "Notes", to: "/student/notes" }, { label: "New group" }]} search={{ value: query, onChange: setQuery, placeholder: "Search your notes" }}>
      <h1 className="ds-h1">New group</h1>
      <p className="mt-1.5 max-w-[640px] text-sm text-[#5a5446]">Collect notes from any course under one name. A note stays in one course (or none) but can sit in as many groups as you like.</p>

      <div className="mt-5 grid max-w-[1040px] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        <form className="ds-card p-6" onSubmit={(e) => { e.preventDefault(); void submit() }} noValidate>
          <label htmlFor="ng-name" className="mb-1.5 block text-sm font-bold">Name</label>
          <input id="ng-name" className="ds-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Finals review" maxLength={80} />

          <label htmlFor="ng-asg" className="mb-1.5 mt-5 block text-sm"><b>Attach to an assignment</b> <span className="text-[#5a5446]">(optional, otherwise it stays on the board only)</span></label>
          <select id="ng-asg" className="ds-input" value={assignmentId} onChange={(e) => setAssignmentId(e.target.value)}>
            <option value="">No assignment</option>
            {courses.map((c) => (
              <optgroup key={c.id} label={c.name}>{(home.data?.assignments ?? []).filter((a) => a.courseId === c.id).map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}</optgroup>
            ))}
          </select>

          <p className="mb-1.5 mt-5 text-sm font-bold">Choose notes by course</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="ds-chip !text-[13px] !font-semibold !text-[var(--color-ink)]" aria-pressed={courseF === "all"} onClick={() => setCourseF("all")}>All courses · {picked.length}/{notes.length}</button>
            {sections.map((s) => {
              const total = notes.filter((n) => inCourse(n, s.id)).length
              if (!total) return null
              return (
                <button key={s.id} type="button" className="ds-chip !text-[13px] !font-semibold !text-[var(--color-ink)]" aria-pressed={courseF === s.id} onClick={() => setCourseF(s.id)}>
                  <i className="ds-dot" style={{ background: s.color }} aria-hidden="true" />{s.name} · {pickedNotes.filter((n) => inCourse(n, s.id)).length ? `${pickedNotes.filter((n) => inCourse(n, s.id)).length}/` : ""}{total}
                </button>
              )
            })}
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-2.5">
            <label className="ds-search ds-search-pill w-full sm:w-[300px]"><span className="sr-only">Search notes</span>
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search notes" /></label>
            <label className="flex flex-col text-xs font-semibold text-[#5a5446]">From group
              <select className="ds-input mt-1 !w-[250px] !py-2 text-[13px]" value={fromGroup} onChange={(e) => setFromGroup(e.target.value)}>
                <option value="">Any group</option>{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
            <label className="flex flex-col text-xs font-semibold text-[#5a5446]">Sort
              <select className="ds-input mt-1 !w-[140px] !py-2 text-[13px]" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
                <option value="new">Newest</option><option value="old">Oldest</option><option value="title">Title A–Z</option>
              </select>
            </label>
          </div>

          <div className="mt-3 max-h-[420px] overflow-auto rounded-[12px] border border-[#ecdfd2]">
            {sections.map((s) => {
              const rows = visible.filter((n) => inCourse(n, s.id))
              if (!rows.length) return null
              const n = rows.filter((r) => picked.includes(r.id)).length
              const state = n === 0 ? "off" : n === rows.length ? "on" : "some"
              const all = () => setPicked((p) => (state === "on" ? p.filter((x) => !rows.some((r) => r.id === x)) : [...new Set([...p, ...rows.map((r) => r.id)])]))
              return (
                <div key={s.id} role="group" aria-label={s.name}>
                  <button type="button" onClick={all} aria-pressed={state === "on" ? true : state === "some" ? "mixed" : false}
                    className="sticky top-0 z-[1] flex w-full items-center gap-2.5 border-b border-[#e3dcc0] bg-[#f2efdc] px-3.5 py-2 text-left text-sm font-bold">
                    <Box state={state} /><i className="ds-dot" style={{ background: s.color }} aria-hidden="true" />{s.name}
                    <small className="ml-auto text-xs font-medium text-[#5a5446]">{n} of {rows.length} selected · select all</small>
                  </button>
                  {rows.map((r) => {
                    const asg = r.assignmentId ? asgById.get(r.assignmentId)?.title : undefined
                    const inGroups = r.groupIds.map(groupName).filter(Boolean)
                    return (
                      <button key={r.id} type="button" role="checkbox" aria-checked={picked.includes(r.id)} onClick={() => toggle(r.id)}
                        className="flex w-full items-start gap-2.5 border-b border-[#f0e6da] px-3.5 py-2.5 text-left last:border-0 hover:bg-[#fff8f3]">
                        <Box state={picked.includes(r.id) ? "on" : "off"} />
                        <span className="min-w-0 flex-1">
                          <b className="block text-sm">{r.title || "Untitled note"}</b>
                          <small className="text-xs text-[#5a5446]">{[asg, noteDate(r.updatedAt), inGroups.length ? `In ${inGroups.join(", ")}` : "Not in a group"].filter(Boolean).join(" · ")}</small>
                        </span>
                        {r.importance && <span className={cn("ds-imp", `ds-imp-${r.importance}`)}>{importanceLabel[r.importance]}</span>}
                      </button>
                    )
                  })}
                </div>
              )
            })}
            {visible.length === 0 && <p className="px-4 py-8 text-center text-sm text-[#5a5446]">{notes.length ? "No notes match." : "You have no notes yet. Create the group now and add notes later."}</p>}
          </div>

          {error && <p role="alert" className="mt-3 text-sm text-[var(--color-danger-ink)]">{error}</p>}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-[#5a5446]">{picked.length} note{picked.length === 1 ? "" : "s"} from {pickedCourses.length} course{pickedCourses.length === 1 ? "" : "s"}</p>
            <div className="flex gap-2">
              <Link to="/student/notes" className="ds-btn !rounded-full">Cancel</Link>
              <button type="submit" className="ds-btn ds-btn-pri !rounded-full" disabled={!name.trim() || create.isPending}>{create.isPending ? "Creating…" : "Create group"}</button>
            </div>
          </div>
        </form>

        <aside className="ds-card p-6 lg:sticky lg:top-24" aria-label="In this group">
          <h2 className="text-sm font-bold">In this group · {picked.length}</h2>
          <p className="text-[13px] text-[#5a5446]">{pickedCourses.length > 1 ? `Mixed: ${pickedCourses.length} courses` : pickedCourses.length === 1 ? pickedCourses[0].name : "Nothing picked yet"}</p>
          {pickedCourses.map((s) => (
            <div key={s.id} className="mt-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-[#4a4436]"><i className="ds-dot" style={{ background: s.color }} />{s.name} · {pickedNotes.filter((n) => inCourse(n, s.id)).length}</p>
              {pickedNotes.filter((n) => inCourse(n, s.id)).map((n) => (
                <div key={n.id} className="flex items-center justify-between gap-1.5 py-1 text-sm">
                  <span className="truncate">{n.title || "Untitled note"}</span>
                  <button type="button" onClick={() => toggle(n.id)} aria-label={`Remove ${n.title || "note"}`} className="text-[#8a8472] hover:text-[var(--color-ink)]"><X className="h-3.5 w-3.5" /></button>
                </div>
              ))}
            </div>
          ))}
        </aside>
      </div>
    </AppShell>
  )
}
