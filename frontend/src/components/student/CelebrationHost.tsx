import { useEffect, useRef } from "react"
import { Link } from "react-router-dom"
import { Check, Coffee, Flame, Hand, ShieldCheck, Sparkles, Sprout, Trophy, X } from "lucide-react"
import { api } from "@/lib/api"
import { dismissMoment, useCurrentMoment, type Moment } from "@/lib/motivation"
import { cn } from "@/lib/utils"

const ICONS = { trophy: Trophy, flame: Flame, check: Check, sparkles: Sparkles, seedling: Sprout, coffee: Coffee, wave: Hand, shield: ShieldCheck }
const PIECES = 26

/**
 * Renders the current motivational moment (lib/motivation.ts) for students: a small dialog for real milestones, a quiet toast for nudges.
 * Mounted once by AppShell. A server moment is reported as seen as soon as it is shown, so it never repeats on another page or device.
 * Accessible: the dialog is modal (focus moves in, Esc closes, focus returns), the toast is a polite live region that never steals focus,
 * and the confetti is decorative and switched off for reduced motion.
 */
export function CelebrationHost() {
  const m = useCurrentMoment()
  useEffect(() => {
    if (m?.serverKey) void api("/student/momentum/seen", { method: "POST", body: { keys: [m.serverKey] } }).catch(() => undefined)
  }, [m?.serverKey])
  if (!m) return null
  return m.presentation === "dialog" ? <CelebrationDialog key={m.id} m={m} /> : <CelebrationToast key={m.id} m={m} />
}

function Badge({ m, size = "lg" }: { m: Moment; size?: "lg" | "sm" }) {
  const Icon = ICONS[m.icon]
  return (
    <span aria-hidden="true" className={cn("sq-cele-badge", `sq-cele-${m.tone}`, size === "lg" ? "h-16 w-16" : "h-10 w-10")}>
      <Icon className={size === "lg" ? "h-8 w-8" : "h-5 w-5"} />
    </span>
  )
}

function CelebrationDialog({ m }: { m: Moment }) {
  const close = () => dismissMoment(m.id)
  const panel = useRef<HTMLDivElement>(null)
  const primary = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    ;(primary.current ?? panel.current)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); dismissMoment(m.id) }
      if (e.key === "Tab" && panel.current) {                                     // keep focus inside the dialog
        const f = panel.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")
        if (!f.length) return
        const first = f[0], last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener("keydown", onKey)
    return () => { document.removeEventListener("keydown", onKey); before?.focus?.() }
  }, [m.id])
  return (
    <div className="sq-cele-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="cele-title" aria-describedby="cele-body" tabIndex={-1} className="sq-cele-card">
        {m.confetti && (
          <div className="sq-confetti" aria-hidden="true">
            {Array.from({ length: PIECES }, (_, i) => <i key={i} style={{ "--i": i, "--x": `${(i * 37) % 100}%` } as React.CSSProperties} />)}
          </div>
        )}
        <button type="button" onClick={close} className="absolute right-3 top-3 inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)]" aria-label="Close">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
        <Badge m={m} />
        {m.stat && <p className="mt-4 text-[13px] font-semibold uppercase tracking-[0.08em] text-[var(--color-teal-dark)]">{m.stat}</p>}
        <h2 id="cele-title" className="mt-1.5 font-[family-name:var(--font-serif)] text-[26px] font-bold leading-tight text-[var(--color-ink)]">{m.title}</h2>
        <p id="cele-body" dir="auto" className="mx-auto mt-2.5 max-w-[34ch] text-[15px] leading-relaxed text-[var(--color-ink-muted)]">{m.body}</p>
        <div className="mt-6 flex flex-col-reverse justify-center gap-2.5 sm:flex-row">
          <button type="button" className={cn("ds-btn !px-5 !py-2.5 !text-[14px]", !m.cta && "ds-btn-pri")} onClick={close}
            ref={(el) => { if (!m.cta) primary.current = el }}>{m.cta ? "Not now" : "Keep going"}</button>
          {m.cta && (
            <Link to={m.cta.to} className="ds-btn ds-btn-pri !px-5 !py-2.5 !text-[14px]" onClick={close} ref={(el) => { primary.current = el }}>{m.cta.label}</Link>
          )}
        </div>
        <Link to="/student/settings#motivation" onClick={close} className="mt-4 inline-block text-xs text-[var(--color-ink-muted)] underline-offset-2 hover:underline">
          Fewer popups
        </Link>
      </div>
    </div>
  )
}

function CelebrationToast({ m }: { m: Moment }) {
  useEffect(() => {
    const t = window.setTimeout(() => dismissMoment(m.id), 9000)
    return () => window.clearTimeout(t)
  }, [m.id])
  return (
    <div role="status" aria-live="polite" className="sq-cele-toast">
      <Badge m={m} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold text-[var(--color-ink)]">{m.title}</p>
        <p dir="auto" className="mt-0.5 text-[13px] leading-snug text-[var(--color-ink-muted)]">{m.body}</p>
      </div>
      <button type="button" onClick={() => dismissMoment(m.id)} className="-mr-1 -mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-muted)]" aria-label="Dismiss">
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  )
}
