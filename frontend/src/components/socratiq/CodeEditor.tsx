import { useId, useMemo, useRef, type KeyboardEvent } from "react"
import { tokenize } from "@/lib/syntax"
import { cn } from "@/lib/utils"

const LINE_PX = 21          // 13px font * 1.6 line height, rounded: textarea and highlight layer must share it exactly
const PAD_PX = 12

/** Highlighted code as React text nodes (never HTML). */
export function Highlighted({ code, language }: { code: string; language: string }) {
  const tokens = useMemo(() => tokenize(code, language), [code, language])
  return <>{tokens.map((t, i) => (t.kind === "plain" ? t.text : <span key={i} className={`tok-${t.kind}`}>{t.text}</span>))}</>
}

function Gutter({ lines }: { lines: number }) {
  return (
    <div aria-hidden="true" className="select-none border-r border-black/[0.08] pr-2 text-right text-[var(--color-ink-muted)]" style={{ paddingTop: PAD_PX, paddingBottom: PAD_PX, lineHeight: `${LINE_PX}px` }}>
      {Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}
    </div>
  )
}

/**
 * Lightweight code editor: a transparent <textarea> exactly over a highlighted <pre>, plus line numbers. No editor library: the chat only needs
 * small snippets. The textarea is sized to its content so the shared container scrolls both layers together (they can never drift apart).
 *
 * Keyboard: Tab indents (4 spaces), Shift+Tab outdents; press Escape first to make Tab leave the editor; Ctrl/Cmd+Enter runs.
 */
export function CodeEditor({ value, onChange, language, label, readOnly, onRun, className }: {
  value: string
  onChange?: (v: string) => void
  language: string
  label: string
  readOnly?: boolean
  onRun?: () => void
  className?: string
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const escaped = useRef(false)
  const hintId = useId()
  const lines = Math.max(1, value.split("\n").length)
  const cols = Math.max(20, ...value.split("\n").map((l) => l.length))

  const replace = (next: string, start: number, end: number) => {
    onChange?.(next)
    requestAnimationFrame(() => { ref.current?.setSelectionRange(start, end) })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault()
      onRun?.()
      return
    }
    if (e.key === "Escape") { escaped.current = true; e.preventDefault(); return }   // the next Tab moves focus out instead of indenting
    if (e.key !== "Tab" || readOnly) { escaped.current = false; return }
    if (escaped.current) { escaped.current = false; return }
    e.preventDefault()
    const el = e.currentTarget
    const { selectionStart: a, selectionEnd: b } = el
    const lineStart = value.lastIndexOf("\n", a - 1) + 1
    if (e.shiftKey) {
      const block = value.slice(lineStart, b)
      const out = block.replace(/^ {1,4}/gm, "")
      const removedFirst = (block.match(/^ {1,4}/)?.[0].length) ?? 0
      replace(value.slice(0, lineStart) + out + value.slice(b), Math.max(lineStart, a - removedFirst), b - (block.length - out.length))
    } else if (a !== b && value.slice(a, b).includes("\n")) {
      const block = value.slice(lineStart, b)
      const out = block.replace(/^/gm, "    ")
      replace(value.slice(0, lineStart) + out + value.slice(b), a + 4, b + (out.length - block.length))
    } else {
      replace(value.slice(0, a) + "    " + value.slice(b), a + 4, a + 4)
    }
  }

  return (
    <div dir="ltr" className={cn("max-h-[26rem] overflow-auto thin-scroll rounded-[var(--radius-md)] bg-black/[0.05] font-mono text-[13px]", className)}>
      <div className="flex min-w-full w-max">
        <Gutter lines={lines} />
        <div className="relative flex-1" style={{ minWidth: `${cols + 4}ch` }}>
          <pre aria-hidden={!readOnly} className="m-0 whitespace-pre" style={{ padding: PAD_PX, lineHeight: `${LINE_PX}px` }}>
            <code><Highlighted code={value} language={language} />{"\n"}</code>
          </pre>
          {!readOnly && (
            <>
              <textarea
                ref={ref}
                value={value}
                aria-label={label}
                aria-describedby={hintId}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                wrap="off"
                onChange={(e) => onChange?.(e.target.value)}
                onKeyDown={onKeyDown}
                className="absolute inset-0 m-0 h-full w-full resize-none overflow-hidden whitespace-pre border-0 bg-transparent text-transparent caret-[var(--color-ink)] outline-none selection:bg-[var(--color-plum)]/25 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-plum)]"
                style={{ padding: PAD_PX, lineHeight: `${LINE_PX}px`, font: "inherit" }}
              />
              <span id={hintId} className="sr-only">Tab indents. Press Escape, then Tab, to leave the editor. Control+Enter runs the code.</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
