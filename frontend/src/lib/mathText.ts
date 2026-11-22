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
  /** Only with `{ streaming: true }`: a display formula whose closing delimiter has not arrived yet (rendered as a placeholder, not as half-typed TeX). */
  | { kind: "pending"; raw: string }

export interface SplitOptions { streaming?: boolean }

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

export function splitMath(input: string, opts: SplitOptions = {}): MathSegment[] {
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
      if (end === -1) {
        if (opts.streaming) { flush(); out.push({ kind: "pending", raw: input.slice(i) }) } else text += input.slice(i)
        break
      }
      push(input.slice(i + 2, end), true, input.slice(i, end + 2))
      i = end + 2
      continue
    }
    if (ch === "\\" && (input[i + 1] === "[" || input[i + 1] === "(") && !escaped(input, i)) {
      const display = input[i + 1] === "["
      const end = input.indexOf(display ? "\\]" : "\\)", i + 2)
      if (end === -1) {
        if (display && opts.streaming) { flush(); out.push({ kind: "pending", raw: input.slice(i) }); i = input.length; break }
        text += input.slice(i, i + 2); i += 2; continue
      }
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
        if (opts.streaming) { flush(); out.push({ kind: "pending", raw: input.slice(i) }); i = input.length; break }
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
  return /[$\\\f\x08\t\r]/.test(text) && parseMath(text).some((s) => s.kind === "math")
}

// ------------------------------------------------------------------ repair & normalisation
/*
 * Model output reaches the chat in more shapes than the delimiters above. These run BEFORE splitMath, on prose only (code is split off first):
 *
 * 1. repairLatexEscapes: LaTeX written with ONE backslash inside the Coach's JSON reply is decoded into control characters
 *    (\frac -> FORM FEED + "rac", \right -> CR + "ight", \theta -> TAB + "heta", \beta -> BACKSPACE + "eta", \neq -> LF + "eq").
 *    KaTeX cannot parse that, so the student saw broken source. The server repairs new replies (ai/guardrails/latex_repair.py); this is the
 *    same rule set for replies that were stored before the fix.
 * 2. normalizeMath: double-escaped delimiters (\\[ … \\]), and the bracket form left behind when a Markdown renderer ate the backslashes:
 *        [                                   ( \frac{a}{b} )
 *        \left(\frac{d^2y}{dx^2}\right)^4 = y
 *        ]
 * 3. promoteBareTex (after splitMath): a line that is nothing but LaTeX, with no delimiters at all, is typeset as a display formula.
 */
const T_SUFFIX = "(?:heta|imes|extbf|extit|extrm|extsf|exttt|extstyle|ext|anh|an|au|o|ilde|op|riangle|frac|binom|herefore|ag)(?![A-Za-z])"
const R_SUFFIX = "(?:ightarrow|ightleftharpoons|ight|ho|angle|ceil|floor|m|Vert|vert|estriction)(?![A-Za-z])"
// \nabla, \neq … are unambiguous; \ne, \ni, \nu, \not, \neg are short, so they are only repaired after a space/operator (as in "a \neq b"),
// never at the start of a line where "e^{i\pi}" or "u = 2" may legitimately begin
const N_LONG = "(?:abla|eq|otin|ewline|exists|mid|leq|geq|parallel|subseteq|Rightarrow|onumber|otag|leftarrow|rightarrow)(?![A-Za-z])"
const N_SHORT = "(?:e|ot|eg|u|i)(?![A-Za-z])"
const TAB_RE = new RegExp(`\t(?=${T_SUFFIX})`, "g")
const CR_RE = new RegExp(`\r(?=${R_SUFFIX})`, "g")
const LF_RE = new RegExp(`\n(?=${N_LONG})|(?<=[ (\\{=&,+\\-])\n(?=${N_SHORT})`, "g")
const SPAN_RE = /(\$\$[\s\S]+?\$\$|\\\\?\[[\s\S]+?\\\\?\]|\\\\?\([\s\S]+?\\\\?\)|\\begin\{[A-Za-z*]+\}[\s\S]+?\\end\{[A-Za-z*]+\}|(?<![\\$])\$(?=\S)[^$\n]+?(?<=\S)\$)/g

/** Restore LaTeX that a JSON decoder turned into control characters. Text without those characters is returned unchanged. Prose only. */
export function repairLatexEscapes(s: string): string {
  if (!/[\f\b\t\r\n]/.test(s)) return s
  let t = s.replace(/\f/g, "\\f").replace(/\x08/g, "\\b").replace(TAB_RE, "\\t").replace(CR_RE, "\\r")
  if (t.includes("\n")) t = t.replace(SPAN_RE, (m) => m.replace(LF_RE, "\\n"))
  return t
}

const TEX_CMD = /\\(?:[dt]?frac|sqrt|i?i?int|oint|sum|prod|lim|limsup|liminf|left|right|cdot|times|div|pm|mp|partial|nabla|infty|leq?|geq?|neq?|approx|equiv|sim|propto|alpha|beta|gamma|Gamma|delta|Delta|epsilon|varepsilon|theta|Theta|lambda|Lambda|mu|nu|xi|pi|Pi|rho|sigma|Sigma|tau|phi|Phi|varphi|chi|psi|Psi|omega|Omega|vec|hat|bar|dot|ddot|overline|underline|mathbf|mathrm|mathbb|mathcal|boldsymbol|text|operatorname|begin|log|ln|exp|sin|cos|tan|sec|csc|cot|arcsin|arccos|arctan|sinh|cosh|tanh|to|rightarrow|Rightarrow|leftrightarrow|iff|implies|binom|cdots|ldots|forall|exists|in|notin|subset|subseteq|cup|cap|emptyset|angle|circ|degree|perp|parallel|displaystyle)(?![A-Za-z])/
const MATH_WORDS = new Set(["max", "min", "det", "lim", "log", "exp", "mod", "gcd", "sup", "inf", "arg", "deg", "dim", "ker"])

/** True when `s` contains LaTeX commands and nothing that reads as prose (no Arabic, no ordinary words). */
export function isMostlyTex(s: string): boolean {
  if (!TEX_CMD.test(s) && !/[\^_]\{/.test(s)) return false
  if (/[؀-ۿ]/.test(s)) return false
  const rest = s
    .replace(/\\(?:text|mathrm|operatorname|mathbf|mathit|textbf)\s*\{[^{}]*\}/g, " ")    // \text{…} is allowed to hold words
    .replace(/\\[A-Za-z]+/g, " ").replace(/\\./g, " ")
  const words = rest.match(/[A-Za-z]{3,}/g) ?? []
  return words.every((w) => MATH_WORDS.has(w.toLowerCase()))
}

/** Rewrites the other ways maths arrives into delimiters splitMath understands. Prose only: code must be split off before. */
export function normalizeMath(s: string): string {
  let t = s
  if (t.includes("\\\\[") || t.includes("\\\\(")) {
    // double-escaped delimiters (the whole reply was escaped twice); `\\[2pt]` row spacing never has a matching `\\]`, so it is left alone
    t = t.replace(/\\\\\[([\s\S]+?)\\\\\]/g, (_m, inner: string) => `\\[${halveBackslashes(inner)}\\]`)
      .replace(/\\\\\(([\s\S]+?)\\\\\)/g, (_m, inner: string) => `\\(${halveBackslashes(inner)}\\)`)
  }
  if (t.includes("[")) {
    // "[" and "]" alone on their own lines around LaTeX, or "[ … ]" filling one line: a display formula whose backslashes were stripped
    t = t.replace(/^([ \t]*)\[[ \t]*\n([\s\S]+?)\n[ \t]*\][ \t]*$/gm, (m, _ind, inner: string) => (isMostlyTex(inner) ? `$$\n${inner.trim()}\n$$` : m))
      .replace(/^[ \t]*\[[ \t]+([^\n]+?)[ \t]+\][ \t]*$/gm, (m, inner: string) => (isMostlyTex(inner) ? `$$${inner.trim()}$$` : m))
  }
  if (t.includes("( ")) {
    // "( \frac{a}{b} )" inside a sentence: the inline form of the same damage. Only when the content is unmistakably LaTeX.
    t = t.replace(/(?<![\\A-Za-z])\(\s+((?:[^()\n]|\([^()\n]*\)){1,160}?)\s+\)/g, (m, inner: string) => (/\\[A-Za-z]/.test(inner) && isMostlyTex(inner) ? `\\(${inner.trim()}\\)` : m))
  }
  return t
}

/** `\\frac` -> `\frac` when the formula was escaped twice (no single-backslash command in it at all). Row breaks `\\\\` become `\\`. */
function halveBackslashes(tex: string): string {
  const hasSingle = /(?<!\\)\\[A-Za-z]/.test(tex.replace(/\\\\/g, ""))
  return hasSingle ? tex : tex.replace(/\\\\/g, "\\")
}

/** After splitMath: a text line that is nothing but LaTeX (no delimiters) becomes a display formula. */
export function promoteBareTex(segments: MathSegment[]): MathSegment[] {
  const out: MathSegment[] = []
  for (const seg of segments) {
    if (seg.kind !== "text" || !seg.text.includes("\\")) { out.push(seg); continue }
    const lines = seg.text.split("\n")
    let buf: string[] = []
    const flushText = () => { if (buf.length) { out.push({ kind: "text", text: buf.join("\n") }); buf = [] } }
    lines.forEach((line, idx) => {
      const trimmed = line.trim()
      const last = idx === lines.length - 1
      if (trimmed.length >= 3 && trimmed.length <= 600 && /\\[A-Za-z]/.test(trimmed) && isMostlyTex(trimmed) && balanced(trimmed)) {
        if (buf.length) { buf.push(""); flushText() }               // keep the newline that ended the previous text line
        out.push({ kind: "math", tex: trimmed, display: true, raw: line })
        if (!last) buf.push("")                                      // ...and the one after the formula (joined back as "\n")
      } else {
        buf.push(line)
      }
    })
    flushText()
  }
  // merge adjacent text pieces produced above
  return out.reduce<MathSegment[]>((acc, s) => {
    const prev = acc[acc.length - 1]
    if (s.kind === "text" && prev && prev.kind === "text") acc[acc.length - 1] = { kind: "text", text: prev.text + s.text }
    else acc.push(s)
    return acc
  }, [])
}

function balanced(s: string): boolean {
  let d = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue }
    if (s[i] === "{") d++
    else if (s[i] === "}" && --d < 0) return false
  }
  return d === 0
}

/** The full pipeline the chat uses: repair, normalise, split, promote bare LaTeX lines. */
export function parseMath(prose: string, opts: SplitOptions = {}): MathSegment[] {
  return promoteBareTex(splitMath(normalizeMath(repairLatexEscapes(prose)), opts))
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
  return parseMath(text).map((s) => (s.kind === "math" ? ` ${mathToSpeech(s.tex)} ` : s.kind === "text" ? s.text : "")).join("")
}
