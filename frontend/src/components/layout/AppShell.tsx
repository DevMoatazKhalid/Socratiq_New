import { useEffect, useState, type ReactNode } from "react"
import { Sidebar } from "./Sidebar"
import { PageHeader, type HeaderSearch } from "./PageHeader"
import { useAuth } from "@/lib/auth"
import { useCourses } from "@/lib/queries"
import type { Role } from "@/types"
import { cn } from "@/lib/utils"
import { NotesButton } from "@/components/notes/NotesButton"

/** Height of the visual viewport (shrinks when a phone keyboard opens, which `100dvh` alone does not on iOS Safari). Null until measured / unsupported. */
function useVisualViewportHeight(enabled: boolean): number | null {
  const [h, setH] = useState<number | null>(null)
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null
    if (!enabled || !vv) return
    const update = () => setH(Math.round(vv.height))
    update()
    vv.addEventListener("resize", update)
    return () => vv.removeEventListener("resize", update)
  }, [enabled])
  return enabled ? h : null
}

/** The signed-in user and their course list come from the session and the API; pages only describe their own content.
 *  `fitViewport` turns the shell into exactly one viewport tall (workspace pages such as the Coach): the header keeps its natural height, `main`
 *  takes the rest, and the page itself never scrolls, so nothing (like a chat composer) can be pushed below the fold. Sizes come from the layout,
 *  not from hard-coded header heights. */
export function AppShell({
  role,
  crumbs,
  search,
  headerRight,
  mainClassName,
  fitViewport,
  children,
}: {
  role: Role
  crumbs: { label: string; to?: string }[]
  /** Pass a controlled value to show a working search box in the header; omit it on pages with nothing to search. */
  search?: HeaderSearch
  headerRight?: ReactNode
  mainClassName?: string
  fitViewport?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const { me, signOut } = useAuth()
  const { data: courses = [] } = useCourses(role)
  const vvHeight = useVisualViewportHeight(!!fitViewport)

  return (
    <div className={cn("flex bg-[var(--color-canvas)]", fitViewport ? "h-[100dvh] overflow-hidden" : "min-h-[100dvh]")} style={fitViewport && vvHeight ? { height: vvHeight } : undefined}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-full focus:bg-[var(--color-ink)] focus:px-4 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to main content
      </a>
      <Sidebar role={role} userName={me?.name ?? ""} userEmail={me?.email ?? ""} courses={courses} open={open} onClose={() => setOpen(false)} onSignOut={signOut} />
      <div className={cn("flex min-w-0 flex-1 flex-col", fitViewport && "min-h-0")}>
        <PageHeader crumbs={crumbs} search={search} onMenuClick={() => setOpen(true)}
          right={role === "student" ? <>{headerRight}<NotesButton /></> : headerRight} />
        <main id="main" className={cn("flex-1", fitViewport && "flex min-h-0 flex-col overflow-hidden", mainClassName ?? "p-4 lg:p-8")}>{children}</main>
      </div>
    </div>
  )
}
