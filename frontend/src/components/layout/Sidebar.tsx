import { useEffect, useRef, useState } from "react"
import { Link, NavLink, useLocation } from "react-router-dom"
import { BarChart3, BookOpen, CheckSquare, ChevronUp, ClipboardCheck, FileText, Home, LogOut, NotebookText, PenLine, Plus, Settings, Users, X } from "lucide-react"
import { Logo } from "@/components/brand/Logo"
import { useActiveCourse } from "@/lib/activeCourse"
import { useNotesBoard } from "@/lib/notesBoard"
import { useDashboard, useStudentHome, useTeacherInsights } from "@/lib/queries"
import { cn, initials } from "@/lib/utils"
import type { Course, Role } from "@/types"

export interface SidebarProps {
  role: Role
  userName: string
  userEmail: string
  courses: Course[]
  open: boolean
  onClose: () => void
  onSignOut?: () => void
}

type Item = { to: string; label: string; icon: typeof Home; end?: boolean; count?: number | null; tone?: "or" | "neu"; match?: (path: string) => boolean }

/** Counts shown next to nav items come from the same queries the pages use (shared cache), so the badge and the page always agree. */
function useStudentNav(courses: Course[]): { workspace: Item[]; courses: Item[] } {
  const home = useStudentHome()
  const notes = useNotesBoard()
  const open = home.data?.assignments.filter((a) => a.status === "not_started" || a.status === "in_progress").length
  return {
    workspace: [
      { to: "/student", end: true, label: "Home", icon: Home },
      { to: "/student/work", label: "My work", icon: CheckSquare, count: open ?? null, tone: "or",
        match: (p) => p.startsWith("/student/work") || /^\/student\/courses\/[^/]+\/assignments\//.test(p) },
      { to: "/student/notes", label: "Notes", icon: NotebookText, count: notes.data?.notes.length ?? null, tone: "neu" },
    ],
    courses: [
      { to: "/student/courses", label: "My courses", icon: BookOpen, count: courses.length, tone: "neu",
        match: (p) => p === "/student/courses" || (/^\/student\/courses\/[^/]+(\/materials\/.*)?$/.test(p) && !p.endsWith("/join")) },
      { to: "/student/join", label: "Join a course", icon: Plus },
    ],
  }
}

function useTeacherNav(courses: Course[]): { workspace: Item[]; courses: Item[] } {
  const [course] = useActiveCourse(courses)
  const dash = useDashboard(course?.id)
  const insights = useTeacherInsights(course?.id)
  const review = dash.data ? dash.data.attention.length + dash.data.reviewQueue.length : null
  return {
    workspace: [
      { to: "/teacher", end: true, label: "Overview", icon: Home },
      { to: "/teacher/review", label: "Grading & Review", icon: ClipboardCheck, count: review, tone: "or" },
      { to: "/teacher/grade", label: "Grade work", icon: PenLine, count: insights.data?.grades.awaiting ?? null, tone: "or",
        match: (p) => p.startsWith("/teacher/grade") || /\/submissions\//.test(p) },
      { to: "/teacher/students", label: "Students", icon: Users, count: dash.data?.overview.students ?? null, tone: "neu" },
      { to: "/teacher/assignments", label: "Assignments", icon: FileText, count: insights.data?.assignments.length ?? null, tone: "neu",
        match: (p) => p.startsWith("/teacher/assignments") || /^\/teacher\/courses\/[^/]+\/assignments\/(?!.*\/submissions\/)/.test(p) },
      { to: "/teacher/insights", label: "Insights & Activity", icon: BarChart3 },
    ],
    courses: [
      { to: "/teacher/courses", label: "My courses", icon: BookOpen, count: courses.length, tone: "neu",
        match: (p) => p === "/teacher/courses" || (/^\/teacher\/courses\/(?!new$)[^/]+(\/materials\/.*)?$/.test(p)) },
      { to: "/teacher/courses/new", label: "New course", icon: Plus },
    ],
  }
}

function StudentNav(props: { courses: Course[]; onNavigate: () => void }) {
  const nav = useStudentNav(props.courses)
  return <NavSections workspace={nav.workspace} courses={nav.courses} coursesLabel="Courses" onNavigate={props.onNavigate} />
}

function TeacherNav(props: { courses: Course[]; onNavigate: () => void }) {
  const nav = useTeacherNav(props.courses)
  return <NavSections workspace={nav.workspace} courses={nav.courses} coursesLabel="Course management" onNavigate={props.onNavigate} />
}

function NavSections({ workspace, courses, coursesLabel, onNavigate }: { workspace: Item[]; courses: Item[]; coursesLabel: string; onNavigate: () => void }) {
  return (
    <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto thin-scroll">
      <p className="ds-kicker px-3 pb-1 pt-3">Workspace</p>
      {workspace.map((i) => <NavItem key={i.to} item={i} onClick={onNavigate} />)}
      <p className="ds-kicker px-3 pb-1 pt-3">{coursesLabel}</p>
      {courses.map((i) => <NavItem key={i.to} item={i} onClick={onNavigate} />)}
    </nav>
  )
}

function NavItem({ item, onClick }: { item: Item; onClick?: () => void }) {
  const { pathname } = useLocation()
  const Icon = item.icon
  const active = item.match ? item.match(pathname) : item.end ? pathname === item.to : pathname === item.to || pathname.startsWith(item.to + "/")
  return (
    <Link
      to={item.to}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-10 items-center gap-3 rounded-[12px] px-3 text-sm transition-colors",
        active ? "bg-[var(--color-plum-light)] font-[650] text-[var(--color-ink)] [&>svg]:text-[var(--color-plum-dark)]"
          : "font-medium text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-ink)]",
      )}
    >
      <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.8} aria-hidden="true" />
      <span className="flex-1 truncate">{item.label}</span>
      {item.count != null && item.count > 0 && (
        <span className={cn("ds-pill ds-pill-count", item.tone === "or" ? "ds-pill-or" : "ds-pill-neu")}>
          <span className="sr-only">(</span>{item.count}<span className="sr-only">)</span>
        </span>
      )}
    </Link>
  )
}

/** The user card at the foot of the sidebar (approved design). It opens a small menu with the account actions the design does not show. */
function UserCard({ role, userName, userEmail, onSignOut }: { role: Role; userName: string; userEmail: string; onSignOut?: () => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey) }
  }, [open])
  return (
    <div ref={box} className="relative mt-2">
      {open && (
        <div role="menu" aria-label="Account" className="absolute inset-x-0 bottom-full mb-2 overflow-hidden rounded-[12px] border border-[var(--color-border)] bg-white p-1 shadow-[0_8px_24px_-12px_rgb(20_17_2/0.35)]">
          <p className="truncate px-3 pb-1 pt-2 text-xs text-[var(--color-ink-muted)]">{userEmail}</p>
          {onSignOut && (
            <button role="menuitem" type="button" onClick={onSignOut}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-muted)]">
              <LogOut className="h-4 w-4" aria-hidden="true" /> Log out
            </button>
          )}
        </div>
      )}
      <button type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 rounded-[12px] bg-[var(--color-slate-light)] p-2.5 text-left transition-colors hover:bg-[#e4e2d2]">
        <span className="ds-av !h-9 !w-9 !bg-[var(--color-teal)]" aria-hidden="true">{initials(userName.split(" ").filter((w) => !w.endsWith(".")).join(" "))}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-[650] text-[var(--color-ink)]">{userName}</span>
          <span className="block text-xs text-[var(--color-ink-muted)]">{role === "teacher" ? "Instructor" : "Student"}</span>
        </span>
        <ChevronUp className={cn("h-4 w-4 shrink-0 text-[var(--color-ink-muted)] transition-transform", !open && "rotate-180")} aria-hidden="true" />
      </button>
    </div>
  )
}

export function Sidebar({ role, userName, userEmail, courses, open, onClose, onSignOut }: SidebarProps) {
  const base = role === "student" ? "/student" : "/teacher"
  const drawer = useRef<HTMLElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)

  // Mobile drawer behaviour: Escape closes it, focus moves in when it opens and stays inside, and returns to the menu button on close.
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement as HTMLElement | null
    // The drawer is still visibility:hidden on the first frame of its open transition, and hidden elements cannot take focus, so retry for a few frames.
    let frames = 0
    let raf = 0
    const focusClose = () => {
      closeButton.current?.focus()
      if (document.activeElement !== closeButton.current && frames++ < 12) raf = requestAnimationFrame(focusClose)
    }
    focusClose()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose()
      if (e.key !== "Tab" || !drawer.current) return
      const items = Array.from(drawer.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")).filter((el) => el.offsetParent !== null)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
    }
    window.addEventListener("keydown", onKey)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("keydown", onKey)
      opener?.focus?.()
    }
  }, [open, onClose])

  return (
    <>
      {open && <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={onClose} aria-hidden />}
      <aside
        ref={drawer}
        // Closed on a phone the drawer is off-screen: `invisible` also takes its links out of the tab order.
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-[248px] shrink-0 flex-col gap-1.5 border-r border-[var(--color-border)] bg-white px-4 py-5 transition-[transform,visibility] duration-200 motion-reduce:transition-none lg:sticky lg:top-0 lg:z-auto lg:h-dvh lg:translate-x-0 lg:self-start",
          open ? "translate-x-0" : "-translate-x-full max-lg:invisible",
        )}
        aria-label="Sidebar"
        role={open ? "dialog" : undefined}
        aria-modal={open ? true : undefined}
      >
        <div className="flex items-center justify-between px-2 pb-2.5 pt-0.5">
          <NavLink to={base} aria-label="SocratiQ home" className="rounded-[var(--radius-sm)]">
            <Logo size="sidebar" />
          </NavLink>
          <button ref={closeButton} className="rounded-[var(--radius-sm)] p-2.5 text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)] lg:hidden" onClick={onClose} aria-label="Close menu">
            <X className="h-5 w-5" />
          </button>
        </div>

        {role === "student" ? <StudentNav courses={courses} onNavigate={onClose} /> : <TeacherNav courses={courses} onNavigate={onClose} />}

        <div className="mt-auto flex shrink-0 flex-col gap-1 border-t border-[var(--color-border)] pt-3.5">
          <NavItem item={{ to: `${base}/settings`, label: "Settings", icon: Settings }} onClick={onClose} />
          <UserCard role={role} userName={userName} userEmail={userEmail} onSignOut={onSignOut} />
        </div>
      </aside>
    </>
  )
}
