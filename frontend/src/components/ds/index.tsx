/**
 * React building blocks for the approved SocratiQ UI/UX (see src/styles/design-system.css).
 * Every screen in the approved designs is composed from these; new screens and states use them too, so nothing invents its own look.
 */
import { useId, type ReactNode } from "react"
import { Link } from "react-router-dom"
import { ArrowRight, ArrowDownRight, ArrowUpRight, Check } from "lucide-react"
import { cn, initials } from "@/lib/utils"

export type Tone = "ok" | "warn" | "bad" | "neu" | "or" | "info"

export const palette = {
  orange: "#fa9500",
  olive: "#7c690a",
  sage: "#6f9a7b",
  red: "#eb6424",
  rose: "#b96b64",
  track: "#edecdf",
  grid: "#eeeee0",
} as const

export function PageTitle({ title, subtitle, actions, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3", className)}>
      <div className="min-w-0">
        <h1 className="ds-h1">{title}</h1>
        {subtitle && <div className="ds-soft mt-1.5 text-sm">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Card({ className, pad = true, children, ...rest }: { className?: string; pad?: boolean; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ds-card", pad && "ds-card-pad", className)} {...rest}>{children}</div>
}

export function Pill({ tone = "neu", className, children, title }: { tone?: Tone; className?: string; children: ReactNode; title?: string }) {
  return <span title={title} className={cn("ds-pill", `ds-pill-${tone}`, className)}>{children}</span>
}

export function CountPill({ n, tone = "or" }: { n: number; tone?: Tone }) {
  return <Pill tone={tone} className="ds-pill-count">{n}</Pill>
}

/** Card with the reference section header: title (+count), helper line, and an action on the right. `flush` lets a table run edge to edge. */
export function Section({ title, count, countTone = "or", sub, right, flush, children, className, id }: {
  title: ReactNode; count?: number | null; countTone?: Tone; sub?: ReactNode; right?: ReactNode; flush?: boolean; children: ReactNode; className?: string; id?: string
}) {
  const hid = useId()
  return (
    <section aria-labelledby={hid} id={id} className={cn("ds-card overflow-hidden", className)}>
      <div className={cn("flex flex-wrap items-start justify-between gap-3", flush ? "px-5 pb-3 pt-4" : "px-5 pt-5")}>
        <div className="min-w-0">
          <h2 id={hid} className="ds-h2 flex items-center gap-2 text-base">{title}{count != null && <CountPill n={count} tone={countTone} />}</h2>
          {sub && <div className="ds-sub text-[13px]">{sub}</div>}
        </div>
        {right && <div className="flex items-center gap-3 text-xs text-[var(--color-ink-muted)]">{right}</div>}
      </div>
      <div className={flush ? "" : "px-5 pb-5 pt-4"}>{children}</div>
    </section>
  )
}

export function ArrowLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return <Link to={to} className={cn("ds-link", className)}>{children}<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
}

/** "+2% vs last month" pill. Hidden when there is nothing to compare with. */
export function Delta({ value, unit = "%", label = "vs last month", invert }: { value: number | null | undefined; unit?: string; label?: string; invert?: boolean }) {
  if (value == null || !Number.isFinite(value)) return null
  const up = value >= 0
  const good = invert ? !up : up
  const Icon = up ? ArrowUpRight : ArrowDownRight
  const n = Math.abs(value)
  const text = `${up ? "+" : "−"}${Number.isInteger(n) ? n : n.toFixed(1)}${unit}`
  return <Pill tone={value === 0 ? "neu" : good ? "ok" : "bad"} className="!px-2 !py-0.5"><Icon className="h-3.5 w-3.5" aria-hidden="true" />{text} {label}</Pill>
}

export function Sparkline({ values, color = palette.orange, width = 64, height = 22 }: { values: (number | null)[]; color?: string; width?: number; height?: number }) {
  const pts = values.map((v, i) => [i, v] as const).filter((p): p is readonly [number, number] => p[1] != null)
  if (pts.length < 2) return null
  const ys = pts.map((p) => p[1])
  const min = Math.min(...ys), max = Math.max(...ys)
  const span = max - min || 1
  const x = (i: number) => (i / (values.length - 1)) * (width - 6) + 3
  const y = (v: number) => height - 4 - ((v - min) / span) * (height - 8)
  const d = pts.map(([i, v], k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")
  const last = pts[pts.length - 1]
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="shrink-0">
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last[0])} cy={y(last[1])} r="2.6" fill={color} />
    </svg>
  )
}

export function Kpi({ label, value, hint, footer, spark, sparkColor, highlight, icon }: {
  label: ReactNode; value: ReactNode; hint?: ReactNode; footer?: ReactNode; spark?: (number | null)[]; sparkColor?: string; highlight?: boolean; icon?: ReactNode
}) {
  return (
    <div className={cn("ds-card ds-card-pad flex flex-col", highlight && "!border-[var(--color-plum)]")}>
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-2 text-[13px] font-semibold leading-snug text-[var(--color-ink-muted)]">{icon}{label}</span>
        {spark && <Sparkline values={spark} color={sparkColor} />}
      </div>
      <div className="ds-kpi-value text-[var(--color-ink)]">{value}</div>
      {hint && <div className="min-h-[30px] text-xs text-[var(--color-ink-muted)]">{hint}</div>}
      {footer && <div className="mt-2">{footer}</div>}
    </div>
  )
}

/** Compact KPI used on My work: icon tile + big number + label. */
export function StatTile({ icon, value, label, active, onClick, tone = "or" }: { icon: ReactNode; value: ReactNode; label: string; active?: boolean; onClick?: () => void; tone?: "or" | "bad" | "info" | "ok" }) {
  const bg = { or: "bg-[var(--color-plum-light)] text-[var(--color-plum-dark)]", bad: "bg-[var(--color-clay-light)] text-[var(--color-clay)]", info: "bg-[var(--color-slate-light)] text-[var(--color-teal-dark)]", ok: "bg-[var(--color-success-light)] text-[var(--color-success-ink)]" }[tone]
  const Tag = onClick ? "button" : "div"
  return (
    <Tag type={onClick ? "button" : undefined} onClick={onClick} aria-pressed={onClick ? !!active : undefined}
      className={cn("ds-card flex items-center gap-3.5 px-5 py-4 text-left transition-colors", active && "!border-[var(--color-plum)] bg-[#fffaf5]", onClick && "hover:border-[var(--color-border-strong)]")}>
      <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px]", bg)} aria-hidden="true">{icon}</span>
      <span className="min-w-0">
        <span className="block font-serif text-[28px] font-bold leading-none text-[var(--color-ink)] ds-num">{value}</span>
        <span className="mt-1 block truncate text-sm text-[var(--color-ink-muted)]">{label}</span>
      </span>
    </Tag>
  )
}

export function Avatar({ name, className, color }: { name: string; className?: string; color?: string }) {
  return <span className={cn("ds-av", className)} style={color ? { background: color } : undefined} aria-hidden="true">{initials(name)}</span>
}

export function gradeColor(pct: number) {
  return pct >= 90 ? palette.sage : pct >= 70 ? palette.orange : pct >= 50 ? palette.red : palette.rose
}

export function GradeValue({ pct, bold = true }: { pct: number | null | undefined; bold?: boolean }) {
  if (pct == null) return <Pill tone="neu">Not graded</Pill>
  const v = Math.round(pct * 10) / 10
  return (
    <span className={cn("inline-flex items-center gap-1.5 ds-num", bold && "font-bold")}>
      <i className="ds-dot !h-1.5 !w-1.5" style={{ background: gradeColor(pct) }} aria-hidden="true" />{v}%
    </span>
  )
}

export function Bar({ value, color = palette.orange, label }: { value: number; color?: string; label?: string }) {
  const v = Math.max(0, Math.min(100, value))
  return (
    <span className="ds-bar" role="img" aria-label={label ?? `${Math.round(v)}%`}>
      <i style={{ width: `${v}%`, background: color }} />
    </span>
  )
}

/** The project's learning loop as four steps: Attempt › Coach › Submit › Verify. `current` is the 1-based step in progress; earlier steps are done. */
export const STEP_NAMES = ["Attempt", "Coach", "Submit", "Verify"] as const
export function Steps({ current, done, showLabel = true }: { current: number; done?: boolean; showLabel?: boolean }) {
  return (
    <div className="inline-flex flex-col gap-0.5">
      <span className="ds-steps" role="img" aria-label={done ? "All four steps done" : `Step ${current} of 4: ${STEP_NAMES[current - 1]}`}>
        {[1, 2, 3, 4].map((n) => {
          const isDone = done || n < current
          const isCur = !done && n === current
          return (
            <span key={n} className="inline-flex items-center">
              {n > 1 && <span className={cn("ds-step-line", (done || n <= current) && "is-done")} />}
              <span className={cn("ds-step", isDone && "is-done", isCur && "is-current")}>{isDone ? <Check className="h-3 w-3" strokeWidth={3} aria-hidden="true" /> : n}</span>
            </span>
          )
        })}
      </span>
      {showLabel && <span className="text-xs text-[var(--color-ink-muted)]">{done ? "Done" : STEP_NAMES[current - 1]}</span>}
    </div>
  )
}

/** Multi-series weekly line chart (approved "performance trend" chart). Values are percentages; nulls leave a gap. */
export function LineChart({ labels, series, height = 260, yMin = 60, yMax = 100, fill }: {
  labels: string[]; series: { name: string; color: string; values: (number | null)[] }[]; height?: number; yMin?: number; yMax?: number; fill?: string
}) {
  const W = 720, H = height, L = 44, R = 26, T = 10, B = 28
  const x = (i: number) => L + (labels.length <= 1 ? 0 : (i / (labels.length - 1)) * (W - L - R))
  const y = (v: number) => T + (1 - (Math.min(Math.max(v, yMin), yMax) - yMin) / (yMax - yMin)) * (H - T - B)
  const ticks = Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) / 4) * i)
  const label = series.map((s) => `${s.name}: ${s.values.map((v, i) => `${labels[i]} ${v == null ? "no data" : Math.round(v) + "%"}`).join(", ")}`).join(". ")
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mx-auto block h-auto w-full" style={{ maxWidth: Math.round(W * 1.3) }} role="img" aria-label={label}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={palette.grid} />
          <text x={L - 10} y={y(t) + 4} textAnchor="end" fontSize="12" fill="#5f5d53">{Math.round(t)}%</text>
        </g>
      ))}
      {labels.map((l, i) => <text key={l + i} x={x(i)} y={H - 6} textAnchor="middle" fontSize="12" fill="#5f5d53">{l}</text>)}
      {series.map((s, si) => {
        const segs: string[] = []
        let cur = ""
        s.values.forEach((v, i) => {
          if (v == null) { if (cur) segs.push(cur); cur = ""; return }
          cur += `${cur ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `
        })
        if (cur) segs.push(cur)
        const first = s.values.findIndex((v) => v != null)
        const lastI = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v != null)
        return (
          <g key={s.name}>
            {si === 0 && fill && first >= 0 && segs.length === 1 && <path d={`${segs[0]} L${x(lastI)},${y(yMin)} L${x(first)},${y(yMin)} Z`} fill={fill} />}
            {segs.map((d, k) => <path key={k} d={d} fill="none" stroke={s.color} strokeWidth="2.2" strokeLinejoin="round" />)}
            {s.values.map((v, i) => v != null && <circle key={i} cx={x(i)} cy={y(v)} r="3.2" fill={s.color} />)}
          </g>
        )
      })}
    </svg>
  )
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-ink-muted)]">
      {items.map((i) => <span key={i.label} className="inline-flex items-center gap-2"><i className="ds-dot" style={{ background: i.color }} />{i.label}</span>)}
    </div>
  )
}

/** Vertical bar chart with value labels (grade distribution, grade by course). */
export function BarChart({ bars, height = 170, max, unit = "", yTicks, width = 340 }: { bars: { label: string; value: number; color: string }[]; height?: number; max?: number; unit?: string; yTicks?: number[]; width?: number }) {
  const W = width, H = height, L = yTicks ? 26 : 8, R = 8, T = 18, B = 24
  const top = max ?? Math.max(1, ...bars.map((b) => b.value))
  const bw = (W - L - R) / Math.max(1, bars.length)
  const y = (v: number) => T + (1 - v / top) * (H - T - B)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mx-auto block h-auto w-full" style={{ maxWidth: Math.round(W * 1.3) }} role="img" aria-label={bars.map((b) => `${b.label}: ${b.value}${unit}`).join(", ")}>
      {yTicks?.map((t) => (
        <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke={palette.grid} /><text x={L - 6} y={y(t) + 3} textAnchor="end" fontSize="9" fill="#5f5d53">{t}</text></g>
      ))}
      {bars.map((b, i) => {
        const x = L + i * bw + bw * 0.12
        const w = bw * 0.76
        return (
          <g key={b.label}>
            <rect x={x} y={y(b.value)} width={w} height={Math.max(0, H - B - y(b.value))} rx="4" fill={b.color} />
            {b.value > 0 && <text x={x + w / 2} y={y(b.value) - 5} textAnchor="middle" fontSize="11" fontWeight="700" fill="#141102">{b.value}{unit}</text>}
            <text x={x + w / 2} y={H - 7} textAnchor="middle" fontSize="10" fill="#5f5d53">{b.label}</text>
          </g>
        )
      })}
    </svg>
  )
}

/** Shown in place of a chart or table when the data does not exist yet. Honest: never a placeholder number. */
export function NoData({ title = "Not enough data yet", children, className }: { title?: string; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-[140px] flex-col items-center justify-center rounded-[12px] border border-dashed border-[var(--color-border-strong)] bg-[#fffaf6] px-6 py-8 text-center", className)}>
      <p className="text-sm font-semibold text-[var(--color-ink)]">{title}</p>
      {children && <p className="mt-1 max-w-sm text-[13px] text-[var(--color-ink-muted)]">{children}</p>}
    </div>
  )
}

/** Week labels for trend charts ("Sep 29"). */
export function weekLabel(iso: string) {
  return new Date(iso + (iso.length === 10 ? "T00:00:00" : "")).toLocaleDateString(undefined, { month: "short", day: "2-digit" })
}

export function Select({ value, onChange, children, label, className, small }: { value: string; onChange: (v: string) => void; children: ReactNode; label: string; className?: string; small?: boolean }) {
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className={cn("ds-sel", small && "ds-sel-sm", className)}>
      {children}
    </select>
  )
}

export function Td({ children, className, ...rest }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={className} {...rest}>{children}</td>
}
