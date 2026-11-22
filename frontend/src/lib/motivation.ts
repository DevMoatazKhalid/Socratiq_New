import { useSyncExternalStore } from "react"

/**
 * Motivational moments: what to say, when, and how often.
 *
 * Sources
 *   server  GET /student/momentum: grade released, streak / submission / verification milestones, welcome back. Each has a stable key and
 *           is shown ONCE on any device (POST /student/momentum/seen).
 *   local   things the student just did on this page: handed in work, finished a verification, a long focused session (break nudge).
 * Rules (the "governor"): the student's preference (all | milestones only | off) is respected everywhere; at most one popup at a time,
 * none within 3 minutes of the previous one (except a grade, which is information), at most 4 a day, and each local nudge kind has a
 * cool-down. Words come from small libraries with several variants, chosen so the same wording does not repeat back to back.
 * Every message is about something real (numbers come from the server); nothing here grades, compares students, or guilt-trips.
 */
export type MotivationPref = "all" | "milestones" | "off"

export interface ServerCelebration {
  key: string
  kind: "grade" | "streak" | "submissions" | "verified" | "comeback"
  value?: number
  band?: "excellent" | "strong" | "solid" | "growing"
  title?: string
  percentage?: number
  improvedBy?: number | null
  assignmentId?: string
  courseId?: string
}

export type LocalMoment =
  | { kind: "submitted"; title: string; courseId?: string; assignmentId?: string }
  | { kind: "verified"; title: string; passed: boolean; courseId?: string; assignmentId?: string }
  | { kind: "break"; minutes: number }

export interface Moment {
  id: string
  serverKey?: string
  presentation: "dialog" | "toast"
  tone: "celebrate" | "encourage" | "calm"
  icon: "trophy" | "flame" | "check" | "sparkles" | "seedling" | "coffee" | "wave" | "shield"
  title: string
  body: string
  stat?: string
  cta?: { label: string; to: string }
  confetti: boolean
}

const PREF_KEY = "sq.motivation.pref"
const LOG_KEY = "sq.motivation.log"
const LAST_VARIANT_KEY = "sq.motivation.variants"
const GAP_MS = 3 * 60_000
const DAILY_MAX = 4
const COOLDOWN_MS: Record<string, number> = { break: 2 * 3600_000, submitted: 0, verified: 0 }

// ------------------------------------------------------------------ storage (per browser; failures fall back to defaults)
function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function write(key: string, value: unknown) {
  try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable: preferences just do not persist */ }
}

const prefListeners = new Set<() => void>()
export function getMotivationPref(): MotivationPref {
  const v = read<string>(PREF_KEY, "all")
  return v === "milestones" || v === "off" ? v : "all"
}
export function setMotivationPref(p: MotivationPref) {
  write(PREF_KEY, p)
  prefListeners.forEach((l) => l())
}
export function useMotivationPref(): MotivationPref {
  return useSyncExternalStore((cb) => { prefListeners.add(cb); return () => { prefListeners.delete(cb) } }, getMotivationPref, () => "all")
}

// ------------------------------------------------------------------ words
const pick = (kind: string, variants: string[], seed: number): string => {
  const last = read<Record<string, number>>(LAST_VARIANT_KEY, {})
  let i = Math.abs(seed) % variants.length
  if (variants.length > 1 && last[kind] === i) i = (i + 1) % variants.length          // never the same wording twice in a row
  write(LAST_VARIANT_KEY, { ...last, [kind]: i })
  return variants[i]
}
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function fromServer(c: ServerCelebration, seed = Date.now()): Moment {
  const base = { id: c.key, serverKey: c.key, presentation: "dialog" as const }
  switch (c.kind) {
    case "grade": {
      const link = c.courseId && c.assignmentId ? { label: "See your feedback", to: `/student/courses/${c.courseId}/assignments/${c.assignmentId}#grade` } : undefined
      const improved = c.improvedBy ? ` That's ${Math.round(c.improvedBy)} points above your average before this one.` : ""
      const bodies: Record<string, string[]> = {
        excellent: ["Outstanding work — your effort shows in every part of this.", "This is excellent. Take a moment to enjoy it.", "Top marks territory. Your understanding is really solid here."],
        strong: ["Strong work. Your feedback has a few ideas to push it even further.", "Really good result — you clearly put the work in.", "Well done. A couple of details and this becomes excellent."],
        solid: ["A solid result. The feedback shows exactly where your next points are.", "Good progress. Read the feedback — it's your roadmap for the next one.", "Nice work getting this done. There's clear room to grow, and you know where."],
        growing: ["Every grade is information, not a verdict. Your feedback shows the next step.", "This one was tough — and that's where learning happens. Start with the feedback.", "Not where you want it yet, and that's okay. The feedback points to what to practise next."],
      }
      return { ...base, tone: c.band === "growing" ? "encourage" : "celebrate", icon: c.band === "growing" ? "seedling" : "trophy", confetti: c.band === "excellent" || c.band === "strong",
        title: `Your grade for “${c.title ?? "your assignment"}” is in`, body: pick(`grade-${c.band}`, bodies[c.band ?? "solid"], seed) + improved,
        stat: c.percentage !== undefined ? `${Math.round(c.percentage)}%` : undefined, cta: link }
    }
    case "streak":
      return { ...base, tone: "celebrate", icon: "flame", confetti: (c.value ?? 0) >= 7, stat: `${c.value}-day streak`,
        title: pick("streak-t", ["You're on a roll!", "Consistency unlocked", "Look at that streak"], seed),
        body: pick("streak", [`You've studied ${plural(c.value ?? 0, "day", "days")} in a row. Small daily steps add up to real understanding.`,
          `${c.value} days in a row. Showing up regularly is the habit that matters most — keep it going.`,
          `Day ${c.value}! Your brain loves this rhythm: short, regular practice beats last-minute cramming.`], seed) }
    case "submissions":
      return { ...base, tone: "celebrate", icon: c.value === 1 ? "sparkles" : "trophy", confetti: true, stat: plural(c.value ?? 0, "assignment", "assignments") + " handed in",
        title: c.value === 1 ? "Your first assignment is in!" : `${c.value} assignments handed in`,
        body: c.value === 1 ? "That first step is the hardest one. Everything from here builds on it." :
          pick("subs", ["Look how far you've come. Each one made the next one easier.", "That's real, steady progress. Be proud of the work behind each one.",
            "Milestone reached. You're building a track record of finishing what you start."], seed) }
    case "verified":
      return { ...base, tone: "celebrate", icon: "shield", confetti: true, stat: plural(c.value ?? 0, "verified understanding", "verified understandings"),
        title: c.value === 1 ? "You proved you understand it" : `${c.value} verifications passed`,
        body: pick("ver", ["Explaining your own work is the real test of learning — and you passed it.", "Not just a right answer: you showed you understand why it works.",
          "That's understanding you own now. It will carry into the next topic."], seed) }
    case "comeback":
      return { ...base, presentation: "toast", tone: "calm", icon: "wave", confetti: false, title: "Welcome back!",
        body: pick("back", ["Great to see you again. Pick up where you left off — one small step is enough.", "Glad you're back. Start with something short to get the momentum going.",
          "Welcome back. No pressure — every session counts, however short."], seed) }
  }
}

export function fromLocal(m: LocalMoment, seed = Date.now()): Moment {
  switch (m.kind) {
    case "submitted":
      return { id: `local:submitted:${seed}`, presentation: "dialog", tone: "celebrate", icon: "check", confetti: true, title: "Handed in — well done!",
        body: pick("submitted", [`“${m.title}” is submitted. Next, a short verification lets you show what you understand.`,
          `You finished “${m.title}”. Take a breath — then lock it in with the quick verification.`,
          `Great job getting “${m.title}” done. A quick understanding check is ready when you are.`], seed),
        cta: m.courseId && m.assignmentId ? { label: "Start verification", to: `/student/courses/${m.courseId}/assignments/${m.assignmentId}/verify` } : undefined }
    case "verified":
      return m.passed
        ? { id: `local:verified:${seed}`, presentation: "dialog", tone: "celebrate", icon: "shield", confetti: true, title: "Understanding verified",
            body: pick("verified-pass", [`You explained your reasoning on “${m.title}” clearly. That's how real learning sticks.`,
              `Verification passed for “${m.title}”. You don't just have the answer — you understand it.`], seed) }
        : { id: `local:verified:${seed}`, presentation: "dialog", tone: "encourage", icon: "seedling", confetti: false, title: "Verification complete",
            body: pick("verified-partial", [`Thanks for working through “${m.title}”. The feedback shows what to revisit — that's exactly how understanding grows.`,
              `You finished the check for “${m.title}”. A few ideas need another look; the Coach can help you with them.`], seed) }
    case "break":
      return { id: `local:break:${seed}`, presentation: "toast", tone: "calm", icon: "coffee", confetti: false, title: "Time for a short break?",
        body: pick("break", [`You've been focused for ${m.minutes} minutes. A 5-minute pause helps your brain consolidate what you just learned.`,
          `${m.minutes} minutes of solid focus! Stretch, grab some water, and come back fresh.`], seed) }
  }
}

const DAILY = [
  "Small steps every day beat a big push once a week.",
  "Confusion is the feeling of your brain getting ready to learn something.",
  "Try explaining today's topic in your own words — it's the fastest way to find the gaps.",
  "Mistakes are data. Every one tells you exactly what to practise next.",
  "Asking a good question is half of understanding the answer.",
  "Fifteen focused minutes beats an hour of half-attention.",
  "You don't have to be great to start, but you have to start to be great.",
  "Revisit yesterday's notes for two minutes — memory loves a quick replay.",
  "Progress, not perfection.",
  "The best time to review is just before you forget. Today is a good day for it.",
]
/** One encouraging line per day (stable through the day, different tomorrow). */
export function dailyEncouragement(d = new Date()): string {
  const day = Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000)
  return DAILY[day % DAILY.length]
}

// ------------------------------------------------------------------ governor
type LogEntry = { k: string; t: number }

/** Whether `m` may be shown now; records it when it is. Grades always pass the gap (they are information), never the "off" preference. */
export function admit(m: Moment, now = Date.now()): boolean {
  const pref = getMotivationPref()
  if (pref === "off") return false
  const kind = m.id.split(":")[m.serverKey ? 0 : 1] ?? m.id
  const milestone = !!m.serverKey && kind !== "comeback"
  if (pref === "milestones" && !milestone) return false
  const log = read<LogEntry[]>(LOG_KEY, []).filter((e) => now - e.t < 86_400_000)
  if (kind !== "grade") {
    if (log.length >= DAILY_MAX) return false
    const ownAction = !m.serverKey && (kind === "submitted" || kind === "verified")       // what the student just did is always acknowledged
    if (log.length && now - log[log.length - 1].t < GAP_MS && !ownAction) return false
    const cool = COOLDOWN_MS[kind]
    if (cool && log.some((e) => e.k === kind && now - e.t < cool)) return false
  }
  write(LOG_KEY, [...log, { k: kind, t: now }].slice(-20))
  return true
}

// ------------------------------------------------------------------ focus sessions (break nudge)
const SESSION_IDLE_MS = 20 * 60_000
const BREAK_AFTER_MS = 45 * 60_000
let session: { start: number; last: number } | null = null

/** Call when the student does focused work (a Coach turn). After ~45 minutes of continuous work, suggest a short break (once per 2 h). */
export function noteStudyActivity(now = Date.now()) {
  if (!session || now - session.last > SESSION_IDLE_MS) session = { start: now, last: now }
  session.last = now
  const minutes = Math.round((now - session.start) / 60_000)
  if (now - session.start >= BREAK_AFTER_MS && showMoment(fromLocal({ kind: "break", minutes }, now), now)) session = { start: now, last: now }
}

// ------------------------------------------------------------------ the queue the host renders (no React Query: the host lives in AppShell)
let queue: Moment[] = []
const queueListeners = new Set<() => void>()
const emit = () => queueListeners.forEach((l) => l())

export function showMoment(m: Moment, now = Date.now()): boolean {
  if (queue.some((q) => q.id === m.id) || !admit(m, now)) return false
  queue = [...queue, m]
  emit()
  return true
}
export function dismissMoment(id: string) {
  queue = queue.filter((m) => m.id !== id)
  emit()
}
export function useCurrentMoment(): Moment | null {
  return useSyncExternalStore((cb) => { queueListeners.add(cb); return () => { queueListeners.delete(cb) } }, () => queue[0] ?? null, () => null)
}
/** Tests only. */
export function resetMotivation() {
  queue = []
  session = null
  emit()
  try { [LOG_KEY, LAST_VARIANT_KEY, PREF_KEY].forEach((k) => window.localStorage.removeItem(k)) } catch { /* ignore */ }
}
