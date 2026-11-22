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

const MACROS: Record<string, string> = {
  "\\R": "\\mathbb{R}", "\\N": "\\mathbb{N}", "\\Z": "\\mathbb{Z}", "\\Q": "\\mathbb{Q}", "\\C": "\\mathbb{C}",
  "\\abs": "\\left|#1\\right|", "\\norm": "\\left\\|#1\\right\\|", "\\dd": "\\mathrm{d}", "\\e": "\\mathrm{e}",
}

function attempt(k: Katex, tex: string, display: boolean): string | null {
  try {
    return k.renderToString(tex, {
      displayMode: display, throwOnError: true, trust: false, strict: "ignore", maxSize: 25, maxExpand: 500, output: "htmlAndMathml",
      macros: { ...MACROS },     // a copy: KaTeX writes \gdef results into the object it is given
    })
  } catch {
    return null
  }
}

/**
 * Formulas as models really write them, made acceptable to KaTeX without changing their meaning. Tried only when the original fails.
 * - `\label`, `\nonumber`, `\notag` (numbering is meaningless in a chat) are dropped.
 * - `&` / `\\` rows without an environment ("$$ a &= b \\ &= c $$", the most common multi-line derivation) are wrapped in `aligned`.
 * - `align`/`equation`/`gather` nested inside a display formula become their `-ed` forms; unmatched `\left` / `\right` are completed.
 * - Unicode minus/multiplication signs that the model copied from prose are mapped to their commands.
 */
export function sanitizeTex(tex: string): string {
  let t = tex
    .replace(/\\label\s*\{[^{}]*\}/g, "").replace(/\\(?:nonumber|notag)\b/g, "")
    .replace(/\u2212/g, "-").replace(/\u00d7/g, "\\times ").replace(/\u00f7/g, "\\div ").replace(/\u2264/g, "\\le ").replace(/\u2265/g, "\\ge ")
    .replace(/\\begin\{(align|gather|equation)\*?\}/g, (_m, env: string) => (env === "equation" ? "" : `\\begin{${env}ed}`))
    .replace(/\\end\{(align|gather|equation)\*?\}/g, (_m, env: string) => (env === "equation" ? "" : `\\end{${env}ed}`))
    .replace(/(?:\\\\\s*)+$/, "")                                          // a trailing row break
    .trim()
  if (!/\\begin\{/.test(t) && (/(?<!\\)&/.test(t) || /\\\\/.test(t))) t = `\\begin{aligned}${t}\\end{aligned}`
  const lefts = (t.match(/\\left(?![a-zA-Z])/g) ?? []).length
  const rights = (t.match(/\\right(?![a-zA-Z])/g) ?? []).length
  if (lefts > rights) t += " \\right.".repeat(lefts - rights)
  else if (rights > lefts) t = "\\left. ".repeat(rights - lefts) + t
  return t
}

/** HTML for one formula, or null when KaTeX cannot parse it even after `sanitizeTex`. */
export function renderTex(k: Katex, tex: string, display: boolean): string | null {
  const key = `${display ? "D" : "I"}${tex}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  let html = attempt(k, tex, display)
  if (html === null) {
    const fixed = sanitizeTex(tex)
    if (fixed !== tex) html = attempt(k, fixed, display)
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
