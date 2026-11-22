import { Fragment, type ReactNode } from "react"
import { looksLikeCode } from "@/lib/richText"
import { splitMath } from "@/lib/mathText"
import { MathFormula } from "./MathFormula"

/**
 * Safe renderer for chat text: ```fenced``` blocks, `inline code`, and mathematics ($…$, $$…$$, \(…\), \[…\], \begin{aligned}…), typeset
 * with KaTeX. Everything else stays plain text with line breaks preserved. Each paragraph uses dir="auto" so Arabic (RTL) and English (LTR)
 * learning content each get the correct base direction while the application shell stays LTR; code and formulas are always LTR.
 * It builds React elements only (formulas come from KaTeX with trust off), so model output cannot inject markup.
 * Order matters: code is split off first, so a `$` inside code is never math.
 */
type Piece = { kind: "text"; text: string } | { kind: "code"; text: string } | { kind: "math"; tex: string; raw: string; display: boolean }

function pieces(prose: string): Piece[] {
  const out: Piece[] = []
  for (const part of prose.split(/(`[^`\n]+`)/g)) {
    if (!part) continue
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      out.push({ kind: "code", text: part.slice(1, -1) })
      continue
    }
    for (const s of splitMath(part)) out.push(s.kind === "text" ? s : { kind: "math", tex: s.tex, raw: s.raw, display: s.display })
  }
  return out
}

function renderInline(p: Piece, key: number): ReactNode {
  if (p.kind === "code") return <code key={key} className="rounded bg-black/[0.06] px-1 py-0.5 font-mono text-[0.92em] [overflow-wrap:anywhere]">{p.text}</code>
  if (p.kind === "math") return <MathFormula key={key} tex={p.tex} raw={p.raw} />
  return <Fragment key={key}>{p.text}</Fragment>
}

/** Prose -> paragraphs, with display formulas as their own blocks between them (a block can't live inside a <p>). */
function Prose({ text, keyBase }: { text: string; keyBase: string }) {
  const blocks: ReactNode[] = []
  let run: Piece[] = []
  const flush = (k: number) => {
    // newlines that only separated the paragraph from a display formula would show as blank lines
    while (run.length && run[0].kind === "text" && !run[0].text.trim()) run.shift()
    while (run.length && run[run.length - 1].kind === "text" && !(run[run.length - 1] as { text: string }).text.trim()) run.pop()
    if (run.length) {
      const first = run[0], last = run[run.length - 1]
      if (first.kind === "text") run[0] = { ...first, text: first.text.replace(/^\n+/, "") }
      if (last.kind === "text") run[run.length - 1] = { ...last, text: last.text.replace(/\n+$/, "") }
      blocks.push(<p key={`${keyBase}p${k}`} dir="auto" className="whitespace-pre-wrap [overflow-wrap:anywhere]">{run.map(renderInline)}</p>)
    }
    run = []
  }
  const all = pieces(text)
  all.forEach((p, i) => {
    if (p.kind === "math" && p.display) {
      flush(i)
      blocks.push(<MathFormula key={`${keyBase}m${i}`} tex={p.tex} raw={p.raw} display />)
    } else run.push(p)
  })
  flush(all.length)
  return <>{blocks}</>
}

function CodeBlock({ code }: { code: string }) {
  return (
    <pre dir="ltr" className="my-2 max-w-full overflow-x-auto rounded-[var(--radius-md)] bg-black/[0.06] p-3 font-mono text-[13px] leading-relaxed" tabIndex={0}>
      <code>{code}</code>
    </pre>
  )
}


/** Renders one fenced block instead of the default <pre>. `lang` is the fence tag ("py", "python", "" when none); `index` counts blocks from 0. */
export type CodeBlockRenderer = (code: string, lang: string, index: number) => ReactNode

export function RichText({ text, detectCode = false, renderCodeBlock }: { text: string; detectCode?: boolean; renderCodeBlock?: CodeBlockRenderer }) {
  if (detectCode && looksLikeCode(text)) return <CodeBlock code={text} />
  const parts = text.split(/```([^\n`]*)\n?([\s\S]*?)```/g)
  // split with two capture groups cycles: prose, fence tag, code, prose, fence tag, code, ..., prose
  const out: ReactNode[] = []
  for (let i = 0; i < parts.length; i += 3) {
    const prose = parts[i]
    if (prose) out.push(<Prose key={`p${i}`} keyBase={`p${i}`} text={prose} />)
    if (i + 2 < parts.length) {
      const lang = (parts[i + 1] ?? "").trim().toLowerCase()
      const code = (parts[i + 2] ?? "").replace(/\n$/, "")
      const block = i / 3
      out.push(<Fragment key={`c${i}`}>{renderCodeBlock ? renderCodeBlock(code, lang, block) : <CodeBlock code={code} />}</Fragment>)
    }
  }
  return <>{out}</>
}
