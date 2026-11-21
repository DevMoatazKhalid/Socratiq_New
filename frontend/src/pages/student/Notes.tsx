import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { useQuery } from "@tanstack/react-query"
import Markdown from "react-markdown"
import { Pencil, Pin, X } from "lucide-react"
import { AppShell } from "@/components/layout/AppShell"
import { courseColor } from "@/components/socratiq/CourseCard"
import { QueryState, Skeleton } from "@/components/ui/States"
import { notesApi, notesPanel } from "@/lib/notes"
import { importanceLabel, useNoteMeta, useNotesBoard, type BoardNote, type Importance, type NoteGroup } from "@/lib/notesBoard"
import { useStudentHome } from "@/lib/queries"
import { matches } from "@/lib/search"
import { cn } from "@/lib/utils"
import type { Assignment, Course } from "@/types"

type GroupBy = "group" | "course" | "importance" | "date"
const IMPORTANCE: Importance[] = ["high", "medium", "low"]
const DAY = 86_400_000

export const noteDate = (iso: string) => {
  const t = new Date(iso)
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / DAY)
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : t.toLocaleDateString(undefined, { day: "numeric", month: "short" })
}
const stickyClass = (i: Importance | null) => (i ? `ds-sticky-${i}` : "ds-sticky-none")
const origin = (n: BoardNote) => (n.sourceKind === "coach_message" ? "Saved from coach" : "Written by you")

function CourseDot({ course }: { course?: Course }) {
  return <i className="ds-dot" style={{ background: course ? courseColor[course.color] : "#8a8472" }} aria-hidden="true" />
}

export interface NotesContext {
  courses: Course[]
  courseById: Map<string, Course>
  assignmentById: Map<string, Assignment>
  groups: NoteGroup[]
  groupById: Map<string, NoteGroup>
}

function useNotesContext(groups: NoteGroup[]): NotesContext {
  const home = useStudentHome()
  return useMemo(() => {
    const courses = home.data?.courses ?? []
    return { courses, courseById: new Map(courses.map((c) => [c.id, c])), assignmentById: new Map((home.data?.assignments ?? []).map((a) => [a.id, a])),
      groups, groupById: new Map(groups.map((g) => [g.id, g])) }
  }, [home.data, groups])
}

function PinButton({ note, small }: { note: BoardNote; small?: boolean }) {
  const meta = useNoteMeta()
  return (
    <button type="button" aria-pressed={note.pinned} aria-label={note.pinned ? `Unpin ${note.title || "note"}` : `Pin ${note.title || "note"}`}
      title={note.pinned ? "Pinned" : "Pin to board"}
      onClick={(e) => { e.stopPropagation(); meta.mutate({ id: note.id, patch: { pinned: !note.pinned } }) }}
      className={cn("flex shrink-0 items-center justify-center rounded-[8px] transition-colors", small ? "h-7 w-7" : "h-7 w-7",
        note.pinned ? "bg-white/70 text-[#c2410c]" : "text-[#5a5446] hover:bg-white/50")}>
      <Pin className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
    </button>
  )
}

function Sticky({ note, ctx, also, onOpen }: { note: BoardNote; ctx: NotesContext; also?: string[]; onOpen: () => void }) {
  const course = note.courseId ? ctx.courseById.get(note.courseId) : undefined
  return (
    <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
      aria-label={`${note.title || "Untitled note"}${note.importance ? `, ${importanceLabel[note.importance]} importance` : ""}`}
      className={cn("ds-sticky cursor-pointer focus-visible:outline-offset-2", stickyClass(note.importance))}>
      <b className="text-[13.5px] font-bold text-[var(--color-ink)]">{note.title || "Untitled note"}</b>
      <p className="line-clamp-3 flex-1 text-[13.5px] leading-[1.45] text-[#3d3828]">{note.preview}</p>
      {also && also.length > 0 && <p className="text-[11px] text-[#6b5a3a]">Also in {also.join(", ")}</p>}
      <div className="flex items-center justify-between gap-1.5 text-[11px] font-semibold text-[#4a4436]">
        <span className="flex min-w-0 items-center gap-1.5"><CourseDot course={course} /><span className="truncate">{course?.name ?? "No course"} · {noteDate(note.updatedAt)}</span></span>
        <PinButton note={note} />
      </div>
    </div>
  )
}

function ListRowNote({ note, ctx, onOpen }: { note: BoardNote; ctx: NotesContext; onOpen: () => void }) {
  const course = note.courseId ? ctx.courseById.get(note.courseId) : undefined
  const asg = note.assignmentId ? ctx.assignmentById.get(note.assignmentId) : undefined
  return (
    <li className="flex cursor-pointer items-start gap-3 border-b border-[#f0e6da] px-1 py-3 last:border-0 hover:bg-[#fff8f3]" onClick={onOpen}>
      <PinButton note={note} small />
      <div className="min-w-0 flex-1">
        <button type="button" className="text-left text-[14px] font-bold text-[var(--color-ink)] hover:underline" onClick={(e) => { e.stopPropagation(); onOpen() }}>{note.title || "Untitled note"}</button>
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-[#5a5446]">
          <CourseDot course={course} />{[course?.name ?? "No course", asg?.title, origin(note), noteDate(note.updatedAt)].filter(Boolean).join(" · ")}
        </p>
        <p className="my-1 text-sm text-[var(--color-ink)]">{note.preview}</p>
        <div className="flex flex-wrap gap-1.5">
          {note.groupIds.map((g) => ctx.groupById.get(g)).filter(Boolean).map((g) => <span key={g!.id} className="rounded-full bg-[#eeeadc] px-2.5 py-px text-[11px] font-semibold text-[#5c5a2a]">{g!.name}</span>)}
        </div>
      </div>
      {note.importance && <span className={cn("ds-imp", `ds-imp-${note.importance}`)}>{importanceLabel[note.importance]}</span>}
    </li>
  )
}

interface Bucket { key: string; label: string; loose?: boolean; notes: BoardNote[]; group?: NoteGroup }

function bucketsFor(notes: BoardNote[], by: GroupBy, ctx: NotesContext): Bucket[] {
  if (by === "group") {
    const out: Bucket[] = ctx.groups.map((g) => ({ key: g.id, label: g.name, group: g, notes: notes.filter((n) => n.groupIds.includes(g.id)) })).filter((b) => b.notes.length)
    const loose = notes.filter((n) => !n.groupIds.some((g) => ctx.groupById.has(g)))
    if (loose.length) out.push({ key: "none", label: "Not in a group", loose: true, notes: loose })
    return out
  }
  if (by === "course") {
    const out: Bucket[] = ctx.courses.map((c) => ({ key: c.id, label: c.name, notes: notes.filter((n) => n.courseId === c.id) })).filter((b) => b.notes.length)
    const none = notes.filter((n) => !n.courseId || !ctx.courseById.has(n.courseId))
    if (none.length) out.push({ key: "none", label: "No course", loose: true, notes: none })
    return out
  }
  if (by === "importance") {
    const out: Bucket[] = IMPORTANCE.map((i) => ({ key: i, label: importanceLabel[i], notes: notes.filter((n) => n.importance === i) })).filter((b) => b.notes.length)
    const none = notes.filter((n) => !n.importance)
    if (none.length) out.push({ key: "none", label: "No importance", loose: true, notes: none })
    return out
  }
  const now = Date.now()
  const age = (n: BoardNote) => (now - Date.parse(n.updatedAt)) / DAY
  return [
    { key: "today", label: "Today", notes: notes.filter((n) => noteDate(n.updatedAt) === "Today") },
    { key: "week", label: "This week", notes: notes.filter((n) => noteDate(n.updatedAt) !== "Today" && age(n) < 7) },
    { key: "month", label: "This month", notes: notes.filter((n) => age(n) >= 7 && age(n) < 31) },
    { key: "older", label: "Older", loose: true, notes: notes.filter((n) => age(n) >= 31) },
  ].filter((b) => b.notes.length)
}

function BucketMeta({ b, ctx }: { b: Bucket; ctx: NotesContext }) {
  const courseIds = [...new Set(b.notes.map((n) => n.courseId ?? "none"))]
  const asg = b.group?.assignmentId ? ctx.assignmentById.get(b.group.assignmentId) : undefined
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {courseIds.map((id) => {
        const c = id === "none" ? undefined : ctx.courseById.get(id)
        return <span key={id} className="ds-group-meta"><CourseDot course={c} />{c?.name ?? "No course"}</span>
      })}
      <span className="ds-group-meta">{b.group ? (asg ? `Attached to ${asg.title} · ${b.notes.length}` : `Board only · ${b.notes.length}`) : b.notes.length}</span>
    </div>
  )
}

/** Expanded sticky note: organise it (importance, course, groups, pin) and read it. Text editing happens in the notes editor. */
function NoteDialog({ note, ctx, onClose }: { note: BoardNote; ctx: NotesContext; onClose: () => void }) {
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
        <h2 id="note-dialog-title" className="mt-3 font-serif text-[28px] font-bold leading-tight text-[var(--color-ink)]">{note.title || "Untitled note"}</h2>
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
        {meta.isError && <p role="alert" className="mt-2 text-sm text-[var(--color-danger-ink)]">That change wasn't saved. Try again.</p>}
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

/** Notes board (approved "Notes board v2"): sticky notes coloured by importance, grouped by group / course / importance / date, plus a list view. */
export default function Notes() {
  const navigate = useNavigate()
  const board = useNotesBoard()
  const ctx = useNotesContext(board.data?.groups ?? [])
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState("")
  const [pinnedOnly, setPinnedOnly] = useState(false)
  const view = params.get("view") === "list" ? "list" : "board"
  const [groupBy, setGroupBy] = useState<GroupBy>("group")
  const [sort, setSort] = useState<"new" | "old" | "title">("new")
  const [courses, setCourses] = useState<string[]>([])
  const [imps, setImps] = useState<Importance[]>([])
  const [groupF, setGroupF] = useState("")
  const [source, setSource] = useState("")
  const [date, setDate] = useState("")
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => { if (params.get("new") === "1") navigate("/student/notes/new", { replace: true }) }, [params, navigate])

  const all = board.data?.notes ?? []
  const filtered = all
    .filter((n) => !pinnedOnly || n.pinned)
    .filter((n) => matches(query, n.title, n.preview, n.assignmentId ? ctx.assignmentById.get(n.assignmentId)?.topic : undefined))
    .filter((n) => courses.length === 0 || courses.includes(n.courseId ?? "none"))
    .filter((n) => imps.length === 0 || (n.importance && imps.includes(n.importance)))
    .filter((n) => !groupF || (groupF === "none" ? n.groupIds.length === 0 : n.groupIds.includes(groupF)))
    .filter((n) => !source || (source === "coach" ? n.sourceKind === "coach_message" : n.sourceKind !== "coach_message"))
    .filter((n) => { const age = (Date.now() - Date.parse(n.updatedAt)) / DAY; return !date || (date === "today" ? noteDate(n.updatedAt) === "Today" : date === "week" ? age < 7 : age < 31) })
    .sort((a, b) => sort === "title" ? (a.title || "").localeCompare(b.title || "") : sort === "old" ? a.updatedAt.localeCompare(b.updatedAt) : b.updatedAt.localeCompare(a.updatedAt))
  const buckets = bucketsFor(filtered, groupBy, ctx)
  const anyFilter = query || pinnedOnly || courses.length || imps.length || groupF || source || date
  const clear = () => { setQuery(""); setPinnedOnly(false); setCourses([]); setImps([]); setGroupF(""); setSource(""); setDate("") }
  const countBy = (id: string) => all.filter((n) => (n.courseId ?? "none") === id).length
  const openNote = open ? all.find((n) => n.id === open) : undefined
  const setView = (v: "board" | "list") => setParams((p) => { if (v === "list") p.set("view", "list"); else p.delete("view"); return p }, { replace: true })

  return (
    <AppShell role="student" crumbs={[{ label: "Notes", to: "/student/notes" }, { label: view === "list" ? "List" : "Board" }]}
      search={{ value: query, onChange: setQuery, placeholder: "Search your notes" }}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="ds-h1">Notes</h1>
          <p className="mt-1.5 max-w-[640px] text-sm text-[#5a5446]">Pinned notes become sticky notes. Colour shows importance. A note sits in one course (or none) and in as many groups as you like.</p>
        </div>
        <div className="flex gap-2">
          <Link to="/student/notes/groups/new" className="ds-btn !rounded-full">New group</Link>
          <Link to="/student/notes/new" className="ds-btn ds-btn-pri !rounded-full">New note</Link>
        </div>
      </div>

      <QueryState query={board} what="Notes" skeleton={<div className="ds-sticky-grid">{[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-[124px]" />)}</div>}>
        {() => (
          <>
            <div className="flex flex-wrap items-center gap-2.5">
              <label className="ds-search ds-search-pill w-full sm:w-[300px]"><span className="sr-only">Search title, text or topic</span>
                <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search title, text or topic" /></label>
              <div className="ds-seg" role="group" aria-label="Show">
                <button type="button" aria-pressed={!pinnedOnly} onClick={() => setPinnedOnly(false)}>All · {all.length}</button>
                <button type="button" aria-pressed={pinnedOnly} onClick={() => setPinnedOnly(true)}>Pinned · {all.filter((n) => n.pinned).length}</button>
              </div>
              <div className="ds-seg" role="group" aria-label="View">
                <button type="button" aria-pressed={view === "board"} onClick={() => setView("board")}>Board</button>
                <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>List</button>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2">
              <span className="text-xs font-semibold text-[#5a5446]">Group by</span>
              <div className="ds-seg" role="group" aria-label="Group by">
                {(["group", "course", "importance", "date"] as const).map((g) => <button key={g} type="button" aria-pressed={groupBy === g} onClick={() => setGroupBy(g)}>{g[0].toUpperCase() + g.slice(1)}</button>)}
              </div>
              <label className="text-xs font-semibold text-[#5a5446]" htmlFor="notes-sort">Sort</label>
              <select id="notes-sort" className="ds-sel ds-sel-sm" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
                <option value="new">Newest first</option><option value="old">Oldest first</option><option value="title">Title A–Z</option>
              </select>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-[#5a5446]">Course</span>
              {[...ctx.courses.map((c) => ({ id: c.id, name: c.name, c })), { id: "none", name: "No course", c: undefined }].filter((x) => countBy(x.id) > 0 || x.id !== "none").map((x) => (
                <button key={x.id} type="button" className="ds-chip !text-[13px] !font-semibold !text-[var(--color-ink)]" aria-pressed={courses.includes(x.id)}
                  onClick={() => setCourses((s) => (s.includes(x.id) ? s.filter((y) => y !== x.id) : [...s, x.id]))}>
                  <CourseDot course={x.c} />{x.name} · {countBy(x.id)}
                </button>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2">
              <span className="text-xs font-semibold text-[#5a5446]">Importance</span>
              {IMPORTANCE.map((i) => (
                <button key={i} type="button" aria-pressed={imps.includes(i)} onClick={() => setImps((s) => (s.includes(i) ? s.filter((y) => y !== i) : [...s, i]))}
                  className={cn("ds-imp", `ds-imp-${i}`, imps.length > 0 && !imps.includes(i) && "opacity-40")}>{importanceLabel[i]}</button>
              ))}
              <label className="text-xs font-semibold text-[#5a5446]" htmlFor="nf-group">Group</label>
              <select id="nf-group" className="ds-sel ds-sel-sm min-w-[160px]" value={groupF} onChange={(e) => setGroupF(e.target.value)}>
                <option value="">Any group</option>{ctx.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}<option value="none">Not in a group</option>
              </select>
              <label className="text-xs font-semibold text-[#5a5446]" htmlFor="nf-source">Source</label>
              <select id="nf-source" className="ds-sel ds-sel-sm min-w-[140px]" value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">Any source</option><option value="coach">Saved from coach</option><option value="me">Written by you</option>
              </select>
              <label className="text-xs font-semibold text-[#5a5446]" htmlFor="nf-date">Date</label>
              <select id="nf-date" className="ds-sel ds-sel-sm min-w-[130px]" value={date} onChange={(e) => setDate(e.target.value)}>
                <option value="">Any date</option><option value="today">Today</option><option value="week">This week</option><option value="month">This month</option>
              </select>
              {anyFilter ? <button type="button" onClick={clear} className="text-[13px] font-semibold text-[#5c5a2a] underline">Clear filters</button> : null}
            </div>

            <p className="mt-4 text-xs text-[#5a5446]" role="status">{filtered.length} of {all.length} notes · tap a note to open it</p>

            {all.length === 0 ? (
              <div className="mt-6 rounded-[18px] border border-dashed border-[#c9c28a] bg-[#f2efdc] px-6 py-12 text-center">
                <p className="font-serif text-xl font-bold">No notes yet</p>
                <p className="mx-auto mt-1 max-w-md text-sm text-[#5a5446]">Save a reply from the coach with “Save to notes”, or write your own. Notes you pin become sticky notes on this board.</p>
                <Link to="/student/notes/new" className="ds-btn ds-btn-pri mt-4 !rounded-full">New note</Link>
              </div>
            ) : filtered.length === 0 ? (
              <div className="mt-6 rounded-[18px] border border-dashed border-[#c9c28a] bg-white px-6 py-10 text-center text-sm text-[#5a5446]">
                No notes match these filters. <button type="button" onClick={clear} className="font-semibold underline">Clear filters</button>
              </div>
            ) : buckets.map((b) => (
              <section key={b.key} className={cn("ds-group", view === "list" && "is-loose")} aria-label={b.label}>
                <div className="ds-group-head">
                  <span className={cn("ds-group-tag", b.loose && "is-loose")}>{b.label}</span>
                  <BucketMeta b={b} ctx={ctx} />
                </div>
                {view === "board" ? (
                  <div className="ds-sticky-grid">
                    {b.notes.map((n) => (
                      <Sticky key={n.id} note={n} ctx={ctx} onOpen={() => setOpen(n.id)}
                        also={groupBy === "group" ? n.groupIds.filter((g) => g !== b.key).map((g) => ctx.groupById.get(g)?.name).filter((x): x is string => !!x) : undefined} />
                    ))}
                  </div>
                ) : (
                  <ul>{b.notes.map((n) => <ListRowNote key={n.id} note={n} ctx={ctx} onOpen={() => setOpen(n.id)} />)}</ul>
                )}
              </section>
            ))}
          </>
        )}
      </QueryState>
      {openNote && <NoteDialog note={openNote} ctx={ctx} onClose={() => setOpen(null)} />}
    </AppShell>
  )
}
