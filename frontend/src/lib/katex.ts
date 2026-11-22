import { useSyncExternalStore } from "react"

/**
 * KaTeX for chat formulas: loaded once on first use (it is large, and most pages never show math), then shared by every formula.
 * Rendering is memoised per formula so a streaming reply only re-typesets what changed.
 * `trust: false` + `strict: "ignore"`: model output can produce math only, never links, styles or HTML. Output is HTML + MathML for
 * screen readers.
 */
type Katex = typeof import("katex").default

let katex: Katex | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()
const cache = new Map<string, string | null>()

function load(): void {
  if (katex || loading) return
  loading = import("katex").then((m) => { katex = m.default; listeners.forEach((l) => l()) }).catch(() => { loading = null })
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  load()
  return () => { listeners.delete(cb) }
}

/** The loaded KaTeX, or null while it is still loading. Re-renders the caller once it arrives. */
export function useKatex(): Katex | null {
  return useSyncExternalStore(subscribe, () => katex, () => null)
}

/** HTML for one formula, or null when KaTeX cannot parse it. */
export function renderTex(k: Katex, tex: string, display: boolean): string | null {
  const key = `${display ? "D" : "I"}${tex}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  let html: string | null
  try {
    html = k.renderToString(tex, { displayMode: display, throwOnError: true, trust: false, strict: "ignore", maxSize: 25, maxExpand: 500, output: "htmlAndMathml" })
  } catch {
    html = null
  }
  if (cache.size > 600) cache.delete(cache.keys().next().value as string)
  cache.set(key, html)
  return html
}

/** Tests: provide KaTeX synchronously (or reset with null). */
export function setKatexForTests(k: Katex | null) {
  katex = k
  cache.clear()
  listeners.forEach((l) => l())
}
