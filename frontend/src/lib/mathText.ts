/**
 * Finds mathematics in chat text so it can be typeset (see components/ui/MathFormula.tsx).
 *
 * Recognised, in the forms language models actually write:
 *   display  $$ … $$   \[ … \]   \begin{align|aligned|equation|gather|multline|cases|…matrix} … \end{…}
 *   inline   $ … $     \( … \)
 * Rules that keep ordinary text intact:
 *   - `\$` is a literal dollar sign.
 *   - Inline `$…$` follows Pandoc's rule: the opening $ is followed by a non-space, the closing $ is preceded by a non-space and NOT
 *     followed by a digit, and the content has no unescaped $ and no blank line. So "$5 and $10" and "costs $3.50" stay text.
 *   - Delimiters that are not closed yet stay plain text. While a reply streams in, "$$x^" shows as typed until the closing $$ arrives.
 * Inline code and fenced code are split off BEFORE this runs (RichText), so `$HOME` in code is never math.
 */
export type MathSegment =
  | { kind: "text"; text: string }
  | { kind: "math"; tex: string; display: boolean; raw: string }

const DISPLAY_ENVS = new Set([
  "equation", "equation*", "align", "align*", "aligned", "alignat", "alignat*", "gather", "gather*", "gathered", "multline", "multline*",
  "split", "cases", "matrix", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "smallmatrix", "array", "subarray", "CD",
])

function escaped(s: string, i: number): boolean {
  let n = 0
  for (let k = i - 1; k >= 0 && s[k] === "\\"; k--) n++
  return n % 2 === 1
}

/** Index of the next unescaped `needle` at or after `from`, or -1. */
function findUnescaped(s: string, needle: string, from: number): number {
  let i = s.indexOf(needle, from)
  while (i !== -1 && escaped(s, i)) i = s.indexOf(needle, i + 1)
  return i
}

function inlineDollarEnd(s: string, open: number): number {
  const first = s[open + 1]
  if (first === undefined || /\s/.test(first) || first === "$") return -1
  for (let i = open + 1; i < s.length; i++) {
    const ch = s[i]
    if (ch === "\n" && s[i + 1] === "\n") return -1                 // math never spans a paragraph break
    if (ch !== "$" || escaped(s, i)) continue
    const before = s[i - 1], after = s[i + 1]
    if (/\s/.test(before) || (after !== undefined && /[0-9]/.test(after))) return -1      // "$5 and $10": the second $ is not a closer
    return i
  }
  return -1
}

export function splitMath(input: string): MathSegment[] {
  const out: MathSegment[] = []
  let text = ""
  const flush = () => { if (text) { out.push({ kind: "text", text }); text = "" } }
  const push = (tex: string, display: boolean, raw: string) => {
    if (!tex.trim()) { text += raw; return }
    flush()
    out.push({ kind: "math", tex: tex.trim(), display, raw })
  }
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch === "\\" && input[i + 1] === "$") { text += "$"; i += 2; continue }
    if (ch === "$" && input[i + 1] === "$" && !escaped(input, i)) {
      const end = findUnescaped(input, "$$", i + 2)
      if (end === -1) { text += input.slice(i); break }
      push(input.slice(i + 2, end), true, input.slice(i, end + 2))
      i = end + 2
      continue
    }
    if (ch === "\\" && (input[i + 1] === "[" || input[i + 1] === "(") && !escaped(input, i)) {
      const display = input[i + 1] === "["
      const end = input.indexOf(display ? "\\]" : "\\)", i + 2)
      if (end === -1) { text += input.slice(i, i + 2); i += 2; continue }
      push(input.slice(i + 2, end), display, input.slice(i, end + 2))
      i = end + 2
      continue
    }
    if (ch === "\\" && input.startsWith("\\begin{", i) && !escaped(input, i)) {
      const close = input.indexOf("}", i + 7)
      const env = close === -1 ? "" : input.slice(i + 7, close)
      if (DISPLAY_ENVS.has(env)) {
        const endTag = `\\end{${env}}`
        const end = input.indexOf(endTag, close + 1)
        if (end !== -1) {
          const raw = input.slice(i, end + endTag.length)
          // KaTeX accepts these environments only in display mode; `aligned`/`cases`/matrices inside a bare block are fine there too
          push(raw, true, raw)
          i = end + endTag.length
          continue
        }
      }
    }
    if (ch === "$" && !escaped(input, i)) {
      const end = inlineDollarEnd(input, i)
      if (end !== -1) {
        push(input.slice(i + 1, end), false, input.slice(i, end + 1))
        i = end + 1
        continue
      }
    }
    text += ch
    i++
  }
  flush()
  return out
}

/** True when the text contains at least one complete formula (cheap pre-check for renderers). */
export function hasMath(text: string): boolean {
  return /[$\\]/.test(text) && splitMath(text).some((s) => s.kind === "math")
}

// ------------------------------------------------------------------ read-aloud
const GREEK = ["alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta", "iota", "kappa", "lambda", "mu", "nu", "xi",
  "pi", "rho", "sigma", "tau", "upsilon", "phi", "varphi", "chi", "psi", "omega", "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Phi", "Psi", "Omega"]
const WORDS: [RegExp, string][] = [
  [/\\(?:cdot|times)/g, " times "], [/\\div/g, " divided by "], [/\\pm/g, " plus or minus "], [/\\leq?/g, " less than or equal to "],
  [/\\geq?/g, " greater than or equal to "], [/\\neq?/g, " not equal to "], [/\\approx/g, " approximately "], [/\\infty/g, " infinity "],
  [/\\to|\\rightarrow/g, " goes to "], [/\\Rightarrow|\\implies/g, " implies "], [/\\sum/g, " the sum of "], [/\\int/g, " the integral of "],
  [/\\lim/g, " the limit "], [/\\partial/g, " partial "], [/\\nabla/g, " nabla "], [/\\in\b/g, " in "], [/\\log/g, " log "], [/\\ln/g, " natural log "],
  [/\\(sin|cos|tan)/g, " $1 "], [/</g, " less than "], [/>/g, " greater than "], [/=/g, " equals "], [/\+/g, " plus "], [/(?<=\s|^)-(?=\s|\w)/g, " minus "],
]

/** A spoken form of a TeX formula for text-to-speech ("x squared plus 1 over 2"), so read-aloud never says "dollar backslash frac". */
export function mathToSpeech(tex: string): string {
  let s = tex
  for (let k = 0; k < 6; k++) {
    const before = s
    s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, " $1 over $2 ")
      .replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, " the $1 root of $2 ")
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, " the square root of $1 ")
      .replace(/\^\s*\{?\s*2\s*\}?/g, " squared ").replace(/\^\s*\{?\s*3\s*\}?/g, " cubed ")
      .replace(/\^\s*\{([^{}]*)\}/g, " to the power $1 ").replace(/\^\s*(\w)/g, " to the power $1 ")
      .replace(/_\s*\{([^{}]*)\}/g, " sub $1 ").replace(/_\s*(\w)/g, " sub $1 ")
    if (s === before) break
  }
  for (const g of GREEK) s = s.replace(new RegExp(`\\\\${g}(?![a-zA-Z])`, "g"), ` ${g.replace(/^var/, "")} `)
  for (const [re, w] of WORDS) s = s.replace(re, w)
  s = s.replace(/\\begin\{[^}]*\}|\\end\{[^}]*\}|\\\\|&/g, ", ").replace(/\\(?:left|right|mathrm|mathbf|text|operatorname|displaystyle|quad|,|;|!)/g, " ")
  return s.replace(/[{}\\]/g, " ").replace(/\s+/g, " ").trim()
}

/** The whole message with every formula replaced by its spoken form. */
export function speakMath(text: string): string {
  return splitMath(text).map((s) => (s.kind === "text" ? s.text : ` ${mathToSpeech(s.tex)} `)).join("")
}
