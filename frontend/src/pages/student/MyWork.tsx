import { useMemo, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { CircleCheck, MessageCircle, PenLine, ShieldCheck, Search } from "lucide-react"
import { AppShell } from "@/components/layout/AppShell"
import { PageTitle, Select, StatTile } from "@/components/ds"
import { GradedTable, UpcomingTable } from "@/components/student/WorkTables"
import { NoMatches, QueryState, Skeleton } from "@/components/ui/States"
import { useFallbackGrades, useStudentHome, useStudentOverview } from "@/lib/queries"
import { matches } from "@/lib/search"
import { byWhatNeedsYou, workRows, type WorkRow } from "@/lib/studentWork"

type Bucket = "all" | WorkRow["bucket"]
const BUCKETS: { key: Bucket; label: string }[] = [
  { key: "all", label: "All" }, { key: "todo", label: "To do" }, { key: "coach", label: "With coach" }, { key: "verify", label: "Verify" }, { key: "done", label: "Done" },
]

/** My work (approved design): every assignment across the student's courses, with the one next step for each. */
export default function MyWork() {
  const home = useStudentHome()
  const overview = useStudentOverview()
  const [params, setParams] = useSearchParams()
  const bucket = (params.get("show") as Bucket) || "all"
  const setBucket = (b: Bucket) => setParams((p) => { if (b === "all") p.delete("show"); else p.set("show", b); return p }, { replace: true })
  const [query, setQuery] = useState("")
  const [courseId, setCourseId] = useState("all")
  const [status, setStatus] = useState<"open" | "all" | "done">("all")
  const [sort, setSort] = useState<"due" | "late" | "course">("due")

  const fb = useFallbackGrades(home.data?.assignments, overview.data)
  const rows = useMemo(() => (home.data ? workRows(home.data.assignments, home.data.courses, overview.data, fb.map) : []), [home.data, overview.data, fb.map])
  const counts = useMemo(() => {
    const c: Record<Bucket, number> = { all: rows.length, todo: 0, coach: 0, verify: 0, done: 0 }
    rows.forEach((r) => c[r.bucket]++)
    return c
  }, [rows])

  const shown = rows
    .filter((r) => bucket === "all" || r.bucket === bucket)
    .filter((r) => courseId === "all" || r.a.courseId === courseId)
    .filter((r) => status === "all" || (status === "done" ? r.done : !r.done))
    .filter((r) => matches(query, r.a.title, r.a.topic, r.course?.name, r.course?.code))
  const sorter = (a: WorkRow, b: WorkRow) =>
    sort === "course" ? (a.course?.name ?? "").localeCompare(b.course?.name ?? "") || byWhatNeedsYou(a, b)
      : sort === "late" ? (b.due.time ?? 0) - (a.due.time ?? 0) : byWhatNeedsYou(a, b)
  const upcoming = shown.filter((r) => !r.done).sort(sorter)
  const finished = shown.filter((r) => r.done).sort((a, b) => ((b.grade?.gradedAt ?? "") > (a.grade?.gradedAt ?? "") ? 1 : -1))

  return (
    <AppShell role="student" crumbs={[{ label: "My work" }]} search={{ value: query, onChange: setQuery, placeholder: "Search assignments, courses and notes" }}>
      <PageTitle title="My work" subtitle="Every assignment across your courses, with the one next step for each." />
      <QueryState query={home} what="My work" skeleton={<div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[88px] rounded-2xl" />)}</div>}>
        {(d) => (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatTile icon={<PenLine className="h-5 w-5" />} tone="or" value={counts.todo} label="To do or in progress" active={bucket === "todo"} onClick={() => setBucket(bucket === "todo" ? "all" : "todo")} />
              <StatTile icon={<MessageCircle className="h-5 w-5" />} tone="bad" value={counts.coach} label="With the coach" active={bucket === "coach"} onClick={() => setBucket(bucket === "coach" ? "all" : "coach")} />
              <StatTile icon={<ShieldCheck className="h-5 w-5" />} tone="info" value={counts.verify} label="Ready to verify" active={bucket === "verify"} onClick={() => setBucket(bucket === "verify" ? "all" : "verify")} />
              <StatTile icon={<CircleCheck className="h-5 w-5" />} tone="ok" value={counts.done} label="Done" active={bucket === "done"} onClick={() => setBucket(bucket === "done" ? "all" : "done")} />
            </div>

            <div role="group" aria-label="Show" className="mt-5 flex flex-wrap gap-2">
              {BUCKETS.map((b) => (
                <button key={b.key} type="button" className="ds-chip" aria-pressed={bucket === b.key} onClick={() => setBucket(b.key)}>{b.label} · {counts[b.key]}</button>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <label className="ds-search w-full sm:w-[280px]">
                <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
                <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search assignment or topic" aria-label="Search assignment or topic" />
              </label>
              <Select label="Course" value={courseId} onChange={setCourseId}>
                <option value="all">Course: All</option>
                {d.courses.map((c) => <option key={c.id} value={c.id}>Course: {c.name}</option>)}
              </Select>
              <Select label="Status" value={status} onChange={(v) => setStatus(v as typeof status)}>
                <option value="all">Status: All</option><option value="open">Status: Open</option><option value="done">Status: Done</option>
              </Select>
              <Select label="Sort" value={sort} onChange={(v) => setSort(v as typeof sort)}>
                <option value="due">Sort: Due soonest</option><option value="late">Sort: Due latest</option><option value="course">Sort: Course</option>
              </Select>
            </div>

            {query.trim() && shown.length === 0 ? (
              <div className="mt-5"><NoMatches query={query} onClear={() => setQuery("")} /></div>
            ) : (
              <>
                {(bucket !== "done" && status !== "done") && <div className="mt-5"><UpcomingTable rows={upcoming} empty={rows.length ? "Nothing here with these filters." : undefined} /></div>}
                {(bucket === "all" || bucket === "done") && status !== "open" && <div className="mt-5"><GradedTable rows={finished} /></div>}
              </>
            )}
          </>
        )}
      </QueryState>
    </AppShell>
  )
}
