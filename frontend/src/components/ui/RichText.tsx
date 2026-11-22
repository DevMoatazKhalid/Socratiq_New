import { Fragment, type ReactNode } from "react"
import { looksLikeCode } from "@/lib/richText"
import { isMostlyTex, parseMath } from "@/lib/mathText"
import { MathFormula, MathPending } from "./MathFormula"

/**
 * The ONE renderer for learning content written by SocratiQ (Coach chat, the board strip, the SmartBoard assistant, note previews).
 *
 * Pipeline for each prose run (between ``` fences):
 *   1. `inline code` is taken out first, so `$HOME` or `a_b` in code is never maths or emphasis;
 *   2. maths is found (lib/mathText.parseMath: repairs JSON-mangled LaTeX, normalises \\[ … \\] / [ … ] forms, recognises $…$, $$…$$, \(…\),
 *      \[…\], \begin{aligned}… and lines that are nothing but LaTeX) and replaced by placeholders; a display formula always gets its own line;
 *   3. a small, safe Markdown subset is parsed: paragraphs, headings, bullet / numbered lists (one level of nesting), quotes, rules, tables,
 *      **bold**, *italic*, ~~strike~~ and https links;
 *   4. placeholders become KaTeX formulas (MathFormula) and code spans.
 * It builds React elements only (KaTeX runs with trust off), so model output cannot inject markup.
 *
 * Direction: every block has dir="auto", so an Arabic paragraph is RTL and an English one LTR inside the LTR app shell. Formulas and code are
 * always LTR and bidi-isolated, so "إذن $x^2 = 4$ ومنه" keeps the formula intact and in the right place.
 * ```latex / ```math / ```tex fences that contain formulas (not a whole LaTeX document) are typeset instead of shown as code.
 */
export type CodeBlockRenderer = (code: string, lang: string, index: number) => ReactNode

type MathItem = { tex: string; raw: string; display: boolean } | { pending: string }

const CODE_OPEN = "", CODE_CLOSE = "", INL_OPEN = "", INL_CLOSE = "", BLK_OPEN = "", BLK_CLOSE = ""
const MATH_LANGS = new Set(["latex", "tex", "math", "katex"])

interface Ctx { codes: string[]; maths: MathItem[]; compact: boolean; key: string }

/** Prose -> a string with placeholders for code spans and formulas (see the pipeline above). */
function protect(prose: string, ctx: Ctx, streaming: boolean): string {
  const withCode = prose.replace(/`([^`\n]+)`/g, (_m, code: string) => `${CODE_OPEN}${ctx.codes.push(code) - 1}${CODE_CLOSE}`)
  let out = ""
  for (const s of parseMath(withCode, { streaming })) {
    if (s.kind === "text") { out += s.text; continue }
    const j = ctx.maths.push(s.kind === "pending" ? { pending: s.raw } : { tex: s.tex, raw: s.raw, display: s.display }) - 1
    if (s.kind === "math" && !s.display) out += `${INL_OPEN}${j}${INL_CLOSE}`
    else out += `\n${BLK_OPEN}${j}${BLK_CLOSE}\n`
  }
  return out
}

// ------------------------------------------------------------------------------------------------------------------------------ inline
const INLINE_RE = new RegExp(
  [
    `${CODE_OPEN}(\\d+)${CODE_CLOSE}`,                                  // 1 code
    `${INL_OPEN}(\\d+)${INL_CLOSE}`,                                    // 2 inline maths
    `${BLK_OPEN}(\\d+)${BLK_CLOSE}`,                                    // 3 display maths that ended up inside a line (table cell, list item)
    `\\*\\*(?=\\S)([\\s\\S]+?)(?<=\\S)\\*\\*`,                            // 4 **bold**
    `(?<![A-Za-z0-9_])__(?=\\S)([\\s\\S]+?)(?<=\\S)__(?![A-Za-z0-9_])`,    // 5 __bold__
    `~~(?=\\S)([\\s\\S]+?)(?<=\\S)~~`,                                    // 6 ~~strike~~
    `(?<![*\\w])\\*(?=[^\\s*])([^*\\n]+?)(?<=[^\\s*])\\*(?![*\\w])`,       // 7 *italic*
    `(?<![A-Za-z0-9_])_(?=[^\\s_])([^_\\n]+?)(?<=[^\\s_])_(?![A-Za-z0-9_])`, // 8 _italic_
    `\\[([^\\]\\n]{1,200})\\]\\((https?:\\/\\/[^\\s)]{1,500})\\)`,          // 9,10 [text](https://…)
    `\\\\([*_~\\[\\]#\`>|-])`,                                           // 11 \* escapes
  ].join("|"),
  "g",
)

function renderInline(s: string, ctx: Ctx, kp: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let n = 0
  const re = new RegExp(INLINE_RE.source, "g")              // a fresh instance: this function recurses
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const k = `${kp}.${n++}`
    if (m[1] !== undefined) {
      out.push(<code key={k} dir="ltr" className="sq-code-inline">{ctx.codes[+m[1]]}</code>)
    } else if (m[2] !== undefined || m[3] !== undefined) {
      const item = ctx.maths[+(m[2] ?? m[3])]
      if ("pending" in item) out.push(<MathPending key={k} inline />)
      else out.push(<MathFormula key={k} tex={item.tex} raw={item.raw} />)
    } else if (m[4] !== undefined || m[5] !== undefined) {
      out.push(<strong key={k} className="font-semibold">{renderInline(m[4] ?? m[5], ctx, k)}</strong>)
    } else if (m[6] !== undefined) {
      out.push(<del key={k}>{renderInline(m[6], ctx, k)}</del>)
    } else if (m[7] !== undefined || m[8] !== undefined) {
      out.push(<em key={k}>{renderInline(m[7] ?? m[8], ctx, k)}</em>)
    } else if (m[9] !== undefined) {
      out.push(<a key={k} href={m[10]} target="_blank" rel="noopener noreferrer nofollow" className="text-[var(--color-teal-dark)] underline underline-offset-2">{renderInline(m[9], ctx, k)}</a>)
    } else if (m[11] !== undefined) {
      out.push(m[11])
    }
    last = re.lastIndex
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}

// ------------------------------------------------------------------------------------------------------------------------------ blocks
type ListItem = { text: string; children: ListBlock | null }
type ListBlock = { ordered: boolean; start: number; items: ListItem[] }
type Block =
  | { t: "p"; text: string }
  | { t: "h"; level: number; text: string }
  | { t: "list"; list: ListBlock }
  | { t: "quote"; text: string }
  | { t: "hr" }
  | { t: "math"; j: number }
  | { t: "table"; head: string[]; align: ("left" | "center" | "right" | undefined)[]; rows: string[][] }

const BLOCK_MATH_LINE = new RegExp(`^${BLK_OPEN}(\\d+)${BLK_CLOSE}$`)
const LIST_RE = /^(\s*)(?:([-*+•])|(\d{1,3})[.)])\s+(.*)$/
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/
const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim())

function parseBlocks(src: string): Block[] {
  const lines = src.split("\n")
  const blocks: Block[] = []
  let para: string[] = []
  const endPara = () => {
    if (para.length) { blocks.push({ t: "p", text: para.join("\n").replace(/^[ \t]+/, "").replace(/\s+$/, "") }); para = [] }
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed) { endPara(); i++; continue }
    const mm = BLOCK_MATH_LINE.exec(trimmed)
    if (mm) { endPara(); blocks.push({ t: "math", j: +mm[1] }); i++; continue }
    const h = /^(#{1,6})\s+(.+?)\s*#*$/.exec(trimmed)
    if (h) { endPara(); blocks.push({ t: "h", level: h[1].length, text: h[2] }); i++; continue }
    if (/^(?:[-*_][ \t]*){3,}$/.test(trimmed)) { endPara(); blocks.push({ t: "hr" }); i++; continue }
    if (trimmed.startsWith(">")) {
      endPara()
      const q: string[] = []
      while (i < lines.length && lines[i].trim().startsWith(">")) { q.push(lines[i].trim().replace(/^>\s?/, "")); i++ }
      blocks.push({ t: "quote", text: q.join("\n") })
      continue
    }
    if (trimmed.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      endPara()
      const head = cells(line)
      const align: ("left" | "center" | "right" | undefined)[] = cells(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : undefined))
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) { rows.push(cells(lines[i])); i++ }
      blocks.push({ t: "table", head, align, rows })
      continue
    }
    if (LIST_RE.test(line)) {
      endPara()
      const raw: { indent: number; ordered: boolean; num: number; text: string }[] = []
      while (i < lines.length) {
        const l = lines[i]
        const lm = LIST_RE.exec(l)
        if (lm) { raw.push({ indent: lm[1].replace(/\t/g, "    ").length, ordered: !!lm[3], num: lm[3] ? +lm[3] : 1, text: lm[4] }); i++; continue }
        // a continuation line (indented, not blank, not another block) belongs to the item above
        if (l.trim() && /^\s{2,}/.test(l) && raw.length && !BLOCK_MATH_LINE.test(l.trim())) { raw[raw.length - 1].text += "\n" + l.trim(); i++; continue }
        break
      }
      blocks.push({ t: "list", list: buildList(raw) })
      continue
    }
    para.push(line)
    i++
  }
  endPara()
  return blocks
}

function buildList(raw: { indent: number; ordered: boolean; num: number; text: string }[]): ListBlock {
  const base = raw[0].indent
  const top: ListBlock = { ordered: raw[0].ordered, start: raw[0].num, items: [] }
  for (const r of raw) {
    const parent = top.items[top.items.length - 1]
    if (r.indent >= base + 2 && parent) {
      parent.children ??= { ordered: r.ordered, start: r.num, items: [] }
      parent.children.items.push({ text: r.text, children: null })
    } else {
      top.items.push({ text: r.text, children: null })
    }
  }
  return top
}

function renderList(list: ListBlock, ctx: Ctx, k: string): ReactNode {
  const items = list.items.map((it, idx) => (
    <li key={`${k}i${idx}`} className="ps-1">
      <span className="whitespace-pre-wrap">{renderInline(it.text, ctx, `${k}i${idx}`)}</span>
      {it.children && renderList(it.children, ctx, `${k}i${idx}c`)}
    </li>
  ))
  return list.ordered
    ? <ol key={k} dir="auto" start={list.start !== 1 ? list.start : undefined} className="sq-list list-decimal">{items}</ol>
    : <ul key={k} dir="auto" className="sq-list list-disc">{items}</ul>
}

function renderBlock(b: Block, ctx: Ctx, k: string): ReactNode {
  switch (b.t) {
    case "p":
      return <p key={k} dir="auto" className="whitespace-pre-wrap [overflow-wrap:anywhere]">{renderInline(b.text, ctx, k)}</p>
    case "h": {
      // # and ## are section titles inside a message (h2), ### a sub-heading (h3), deeper ones h4: the page's own h1 stays unique
      const Tag = (b.level <= 2 ? "h2" : b.level === 3 ? "h3" : "h4") as "h2" | "h3" | "h4"
      return <Tag key={k} dir="auto" className={b.level <= 2 ? "sq-h sq-h-lg" : "sq-h"}>{renderInline(b.text, ctx, k)}</Tag>
    }
    case "list":
      return renderList(b.list, ctx, k)
    case "quote":
      return <blockquote key={k} dir="auto" className="sq-quote whitespace-pre-wrap">{renderInline(b.text, ctx, k)}</blockquote>
    case "hr":
      return <hr key={k} className="sq-hr" />
    case "math": {
      const item = ctx.maths[b.j]
      if ("pending" in item) return <MathPending key={k} />
      return <MathFormula key={k} tex={item.tex} raw={item.raw} display />
    }
    case "table":
      return (
        <div key={k} className="sq-table-wrap thin-scroll" tabIndex={0}>
          <table dir="auto" className="sq-table">
            <thead><tr>{b.head.map((c, ci) => <th key={ci} style={{ textAlign: b.align[ci] }}>{renderInline(c, ctx, `${k}h${ci}`)}</th>)}</tr></thead>
            <tbody>{b.rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci} style={{ textAlign: b.align[ci] }}>{renderInline(c, ctx, `${k}r${ri}c${ci}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )
  }
}

/** Compact (one-line preview) form: blocks run together, display formulas are set inline. */
function renderCompact(blocks: Block[], ctx: Ctx): ReactNode[] {
  const out: ReactNode[] = []
  blocks.forEach((b, i) => {
    if (i) out.push(" ")
    const k = `${ctx.key}c${i}`
    if (b.t === "math") {
      const item = ctx.maths[b.j]
      out.push("pending" in item ? <MathPending key={k} inline /> : <MathFormula key={k} tex={item.tex} raw={item.raw} />)
    } else if (b.t === "list") {
      out.push(<Fragment key={k}>{b.list.items.map((it, j) => <Fragment key={j}>{j ? " · " : ""}{renderInline(it.text, ctx, `${k}.${j}`)}</Fragment>)}</Fragment>)
    } else if (b.t === "table") {
      out.push(<Fragment key={k}>{b.head.join(" · ")}</Fragment>)
    } else if (b.t !== "hr") {
      out.push(<Fragment key={k}>{renderInline(b.text, ctx, k)}</Fragment>)
    }
  })
  return out
}

function Prose({ text, keyBase, streaming, compact }: { text: string; keyBase: string; streaming: boolean; compact: boolean }) {
  const ctx: Ctx = { codes: [], maths: [], compact, key: keyBase }
  const blocks = parseBlocks(protect(text, ctx, streaming))
  if (compact) return <>{renderCompact(blocks, ctx)}</>
  return <>{blocks.map((b, i) => renderBlock(b, ctx, `${keyBase}b${i}`))}</>
}

function CodeBlock({ code }: { code: string }) {
  return (
    <pre dir="ltr" className="my-2 max-w-full overflow-x-auto rounded-[var(--radius-md)] bg-black/[0.06] p-3 font-mono text-[13px] leading-relaxed" tabIndex={0}>
      <code>{code}</code>
    </pre>
  )
}

/** ```latex / ```math fences: typeset the formulas they hold. A whole LaTeX document (\documentclass …) stays a code block. */
function MathFence({ code, lang, keyBase, streaming }: { code: string; lang: string; keyBase: string; streaming: boolean }) {
  if (/\\(?:documentclass|usepackage)\b/.test(code)) return <CodeBlock code={code} />
  const src = code.trim()
  if (/\$|\\\[|\\\(/.test(src)) return <Prose text={src} keyBase={keyBase} streaming={streaming} compact={false} />
  // one formula, or one per line when the lines are separate equations (no row breaks / environments joining them)
  const parts = /\\\\|\\begin\{|&/.test(src) ? [src] : src.split(/\n\s*\n|\n/).map((l) => l.trim()).filter(Boolean)
  return <>{parts.map((p, i) => <MathFormula key={`${keyBase}f${i}`} tex={p} raw={"```" + lang + "\n" + p + "\n```"} display />)}</>
}

export function RichText({ text, detectCode = false, renderCodeBlock, streaming = false, compact = false }: {
  text: string
  detectCode?: boolean
  renderCodeBlock?: CodeBlockRenderer
  /** The text is still arriving: an unfinished display formula shows a placeholder instead of half-typed TeX. */
  streaming?: boolean
  /** One-line preview (e.g. the board's "last reply" strip): no block layout, formulas inline. */
  compact?: boolean
}) {
  if (detectCode && looksLikeCode(text)) return <CodeBlock code={text} />
  const parts = text.split(/```([^\n`]*)\n?([\s\S]*?)```/g)
  // split with two capture groups cycles: prose, fence tag, code, prose, fence tag, code, ..., prose
  const out: ReactNode[] = []
  for (let i = 0; i < parts.length; i += 3) {
    const prose = parts[i]
    if (prose) out.push(<Prose key={`p${i}`} keyBase={`p${i}`} text={prose} streaming={streaming && i + 3 >= parts.length} compact={compact} />)
    if (i + 2 < parts.length) {
      const lang = (parts[i + 1] ?? "").trim().toLowerCase()
      const code = (parts[i + 2] ?? "").replace(/\n$/, "")
      if (MATH_LANGS.has(lang) && code.trim() && (isMostlyTex(code) || /\$|\\\[|\\begin\{/.test(code))) {
        out.push(<MathFence key={`c${i}`} keyBase={`c${i}`} code={code} lang={lang} streaming={false} />)
        continue
      }
      if (compact) { out.push(<code key={`c${i}`} dir="ltr" className="sq-code-inline">{code.split("\n")[0]}</code>); continue }
      const idx = i / 3                                         // stable per fence position (run results are stored under this key)
      out.push(<Fragment key={`c${i}`}>{renderCodeBlock ? renderCodeBlock(code, lang, idx) : <CodeBlock code={code} />}</Fragment>)
    }
  }
  if (compact) return <span className="sq-rich-compact">{out}</span>
  return <div className="sq-rich">{out}</div>
}
