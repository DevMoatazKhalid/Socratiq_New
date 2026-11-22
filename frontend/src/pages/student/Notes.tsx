import { useEffect, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { AppShell } from "@/components/layout/AppShell"
import { NoteDialog } from "@/components/notes/NoteDialog"
import { NotesBoardView, useNotesContext } from "@/components/notes/NotesBoardView"
import { useNotesBoard } from "@/lib/notesBoard"

export { noteDate } from "@/components/notes/NotesBoardView"

/** Notes board (approved "Notes board v2"): sticky notes coloured by importance, grouped by group / course / importance / date, plus a list view. */
export default function Notes() {
  const navigate = useNavigate()
  const board = useNotesBoard()
  const ctx = useNotesContext(board.data?.groups ?? [])
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState("")
  const view = params.get("view") === "list" ? "list" : "board"
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => { if (params.get("new") === "1") navigate("/student/notes/new", { replace: true }) }, [params, navigate])

  const openNote = open ? (board.data?.notes ?? []).find((n) => n.id === open) : undefined
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

      <NotesBoardView query={query} onQuery={setQuery} view={view} onView={setView} onOpen={setOpen} />
      {openNote && <NoteDialog note={openNote} ctx={ctx} onClose={() => setOpen(null)} />}
    </AppShell>
  )
}
