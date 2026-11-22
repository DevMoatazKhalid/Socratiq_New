import { useEffect, useState } from "react"
import { Check, Copy } from "lucide-react"
import "katex/dist/katex.min.css"
import { renderTex, useKatex } from "@/lib/katex"
import { cn } from "@/lib/utils"

/**
 * Typesets one formula with KaTeX (the same engine the board's equations use).
 *
 * - KaTeX is loaded once, on first use (lib/katex.ts); until it arrives the TeX source is shown in the same place.
 * - A formula KaTeX cannot parse is shown as its source (monospace, marked), never an error box in the middle of a lesson.
 * - Math is always laid out left-to-right, also inside Arabic paragraphs. Display formulas scroll horizontally inside their own box when
 *   they are wider than the screen, so the conversation never scrolls sideways.
 */
export function MathFormula({ tex, display = false, raw, className }: { tex: string; display?: boolean; raw?: string; className?: string }) {
  const k = useKatex()
  const html = k ? renderTex(k, tex, display) : undefined
  const source = raw ?? (display ? `$$${tex}$$` : `$${tex}$`)

  if (!display) {
    if (!html) {
      return (
        <code dir="ltr" className={cn("sq-math-src", className)} title={html === null ? "This formula couldn't be displayed" : undefined}>{source}</code>
      )
    }
    return <span dir="ltr" className={cn("sq-math-inline", className)} dangerouslySetInnerHTML={{ __html: html }} />
  }
  return (
    <div dir="ltr" className={cn("sq-math-display group", className)}>
      <div className="sq-math-scroll thin-scroll" tabIndex={0} aria-label={html ? undefined : "Formula"}>
        {html ? <div dangerouslySetInnerHTML={{ __html: html }} /> : <code className="sq-math-src block whitespace-pre-wrap">{source}</code>}
      </div>
      <CopyTex source={source} />
    </div>
  )
}

function CopyTex({ source }: { source: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = window.setTimeout(() => setDone(false), 1500)
    return () => window.clearTimeout(t)
  }, [done])
  return (
    <button
      type="button"
      className="sq-math-copy"
      aria-label={done ? "Copied" : "Copy this formula as LaTeX"}
      title={done ? "Copied" : "Copy LaTeX"}
      onClick={() => { void navigator.clipboard?.writeText(source).then(() => setDone(true), () => undefined) }}
    >
      {done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
    </button>
  )
}
