import { Fragment, type ReactNode } from "react"
import { looksLikeCode } from "@/lib/richText"

/**
 * Minimal, safe renderer for chat text: ```fenced``` blocks and `inline code`. Everything else stays plain text with
 * line breaks preserved. Each paragraph uses dir="auto" so Arabic (RTL) and English (LTR) learning content each get the correct base direction while the
 * application shell stays LTR; code blocks are always LTR. It builds React elements only (never HTML), so model output cannot inject markup.
 */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`)/g).map((part, i) =>
    part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
      <code key={i} className="rounded bg-black/[0.06] px-1 py-0.5 font-mono text-[0.92em] [overflow-wrap:anywhere]">{part.slice(1, -1)}</code>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    )
  )
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
    if (prose) out.push(<p key={`p${i}`} dir="auto" className="whitespace-pre-wrap [overflow-wrap:anywhere]">{inline(prose)}</p>)
    if (i + 2 < parts.length) {
      const lang = (parts[i + 1] ?? "").trim().toLowerCase()
      const code = (parts[i + 2] ?? "").replace(/\n$/, "")
      const block = i / 3
      out.push(<Fragment key={`c${i}`}>{renderCodeBlock ? renderCodeBlock(code, lang, block) : <CodeBlock code={code} />}</Fragment>)
    }
  }
  return <>{out}</>
}
