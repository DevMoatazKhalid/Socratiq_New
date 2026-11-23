import { useEffect, useRef, useState } from "react"
import { Check, Copy, Eraser, Loader2, Pencil, Play, RotateCcw, Square, Terminal } from "lucide-react"
import { ApiError } from "@/lib/api"
import { cancelRun, codeBlockStore, describeStatus, fenceLanguage, guessFenceLanguage, newRunId, runCode, runnableLanguage, useCodeRuntime, type BlockState, type RunResult } from "@/lib/codeRunner"
import { cn } from "@/lib/utils"
import { CodeEditor } from "./CodeEditor"

type Phase = "idle" | "running" | "done"

const toolBtn = "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-xs font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-plum)]"

/**
 * A code block in a Coach reply. Every block can be copied; blocks in a language the server can run also get Run (and Edit). The Coach's
 * original reply is never changed: editing works on a copy that Reset restores, and the result stays with this block (keyed by message + index).
 */
export function RunnableCodeBlock({ code, lang, blockKey }: { code: string; lang: string; blockKey: string }) {
  // The fence tag names the language; an untagged fence is runnable only when its code is unmistakably Python (lib/codeRunner).
  const tag = fenceLanguage(lang) || guessFenceLanguage(code)
  const runtime = useCodeRuntime(!!tag)
  const language = runnableLanguage(runtime, tag)
  const saved = codeBlockStore.get(blockKey)
  const [state, setState] = useState<BlockState>(() => saved ?? { source: code, edited: false, stdin: "", result: null, error: null })
  const [editing, setEditing] = useState(false)
  const [showStdin, setShowStdin] = useState(!!saved?.stdin)
  const [phase, setPhase] = useState<Phase>(saved?.result || saved?.error ? "done" : "idle")
  const [copied, setCopied] = useState(false)
  const running = useRef<{ runId: string; ctl: AbortController } | null>(null)     // the one run in flight: a second Run is ignored, never queued

  useEffect(() => { codeBlockStore.set(blockKey, state) }, [blockKey, state])
  useEffect(() => () => {                                                          // leaving the chat stops a run that is still going
    const r = running.current
    if (r) { r.ctl.abort(); void cancelRun(r.runId).catch(() => undefined) }
  }, [])

  const update = (patch: Partial<BlockState>) => setState((s) => ({ ...s, ...patch }))

  async function run() {
    if (!language || running.current) return
    const runId = newRunId()
    const ctl = new AbortController()
    running.current = { runId, ctl }
    setPhase("running")
    update({ error: null })
    try {
      const result: RunResult = await runCode({ runId, language: language.id, source: state.source, stdin: state.stdin }, ctl.signal)
      update({ result, error: null })
    } catch (e) {
      if (ctl.signal.aborted) {
        update({ error: null })
      } else {
        const msg = e instanceof ApiError
          ? e.code === "rate_limited" ? "You're running code very quickly. Wait a moment and try again."
            : e.code === "run_in_progress" ? "Another of your programs is still running. Stop it or wait for it to finish."
            : e.code === "runner_busy" ? "Many students are running code right now. Try again in a moment."
            : e.code === "code_runner_unavailable" ? "Running code is unavailable right now."
            : e.message
          : "Couldn't run the code."
        update({ error: msg })
      }
    } finally {
      running.current = null
      setPhase("done")
    }
  }

  async function stop() {
    const r = running.current
    if (!r) return
    try {
      await cancelRun(r.runId)                // the server stops the job and answers the open request with "cancelled"
    } catch {
      r.ctl.abort()                           // couldn't reach the server: at least stop waiting (closing the request also stops the job)
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(state.source)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  const result = state.result
  const status = result ? describeStatus(result) : null
  const isRunning = phase === "running"

  return (
    <div className="my-2 overflow-hidden rounded-[var(--radius-md)] border border-black/[0.08] bg-white/60" data-testid="code-block">
      <div className="flex flex-wrap items-center gap-1 border-b border-black/[0.06] px-2 py-1">
        <span className="mr-auto pl-1 font-mono text-[11px] uppercase tracking-wide text-[var(--color-ink-muted)]">{language?.label ?? (tag || "code")}{state.edited ? " · edited" : ""}</span>
        <button type="button" className={cn(toolBtn, "text-[var(--color-ink-muted)] hover:bg-black/[0.05] hover:text-[var(--color-ink)]")} onClick={() => void copy()} aria-label="Copy code">
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}{copied ? "Copied" : "Copy"}
        </button>
        {language && (
          <>
            {state.edited ? (
              <button type="button" className={cn(toolBtn, "text-[var(--color-ink-muted)] hover:bg-black/[0.05] hover:text-[var(--color-ink)]")} disabled={isRunning}
                onClick={() => { update({ source: code, edited: false }) }} aria-label="Reset to the original code">
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />Reset
              </button>
            ) : null}
            <button type="button" className={cn(toolBtn, "text-[var(--color-ink-muted)] hover:bg-black/[0.05] hover:text-[var(--color-ink)]")} disabled={isRunning}
              aria-pressed={editing} onClick={() => setEditing((v) => !v)}>
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />{editing ? "Done" : "Edit"}
            </button>
            {isRunning ? (
              <button key="stop" type="button" className={cn(toolBtn, "bg-[var(--color-ink)] text-white hover:opacity-90")} onClick={() => void stop()} aria-label="Stop running">
                <Square className="h-3 w-3" aria-hidden="true" />Stop
              </button>
            ) : (
              <button key="run" type="button" className={cn(toolBtn, "bg-[var(--color-plum)] text-[var(--color-on-plum)] hover:bg-[var(--color-plum-dark)]")} onClick={() => void run()}
                aria-label={result || state.error ? "Run again" : "Run code"}>
                <Play className="h-3 w-3" aria-hidden="true" />{result || state.error ? "Run again" : "Run"}
              </button>
            )}
          </>
        )}
      </div>

      <CodeEditor
        value={state.source}
        language={tag}
        label="Code editor"
        readOnly={!language || !editing || isRunning}
        onChange={(source) => update({ source, edited: source !== code })}
        onRun={() => void run()}
        className="rounded-none bg-transparent"
      />

      {language && editing && (
        <div className="border-t border-black/[0.06] px-3 py-1.5">
          {showStdin ? (
            <label className="block text-xs text-[var(--color-ink-muted)]">
              Input (stdin)
              <textarea value={state.stdin} onChange={(e) => update({ stdin: e.target.value })} rows={2} maxLength={16000} spellCheck={false}
                className="mt-1 block w-full resize-y rounded-[var(--radius-sm)] border border-[var(--color-control-border)] bg-white p-2 font-mono text-[12px] text-[var(--color-ink)]" />
            </label>
          ) : (
            <button type="button" className="text-xs font-medium text-[var(--color-ink-muted)] underline underline-offset-2 hover:text-[var(--color-ink)]" onClick={() => setShowStdin(true)}>Add input for input()</button>
          )}
        </div>
      )}

      {(isRunning || result || state.error) && (
        <div className="border-t border-black/[0.08] bg-[var(--color-ink)]/[0.03]" aria-live="polite">
          <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
            <Terminal className="h-3.5 w-3.5 text-[var(--color-ink-muted)]" aria-hidden="true" />
            {isRunning ? (
              <span role="status" className="inline-flex items-center gap-1.5 text-[var(--color-ink-muted)]"><Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />Running…</span>
            ) : state.error ? (
              <span role="alert" className="text-[var(--color-danger-ink)]">{state.error}</span>
            ) : status ? (
              <span role="status" className={cn(status.tone === "ok" ? "text-[var(--color-success-ink)]" : status.tone === "error" ? "text-[var(--color-danger-ink)]" : "text-[var(--color-ink-muted)]")}>{status.label}</span>
            ) : null}
            {!isRunning && (result || state.error) && (
              <button type="button" className={cn(toolBtn, "ml-auto h-6 text-[var(--color-ink-muted)] hover:bg-black/[0.05] hover:text-[var(--color-ink)]")}
                onClick={() => { update({ result: null, error: null }); setPhase("idle") }} aria-label="Clear output">
                <Eraser className="h-3.5 w-3.5" aria-hidden="true" />Clear
              </button>
            )}
          </div>
          {result && !isRunning && (result.stdout || result.stderr) ? (
            <pre dir="ltr" tabIndex={0} aria-label="Program output" className="m-0 max-h-72 overflow-auto thin-scroll whitespace-pre-wrap break-words px-3 pb-2 font-mono text-[12.5px] leading-relaxed">
              {result.stdout && <span>{result.stdout}</span>}
              {result.stdout && result.stderr && !result.stdout.endsWith("\n") ? "\n" : null}
              {result.stderr && <span className="text-[var(--color-danger-ink)]" data-stream="stderr">{result.stderr}</span>}
              {(result.stdoutTruncated || result.stderrTruncated) && <span className="block pt-1 text-[var(--color-ink-muted)]">… output truncated</span>}
            </pre>
          ) : result && !isRunning ? (
            <p className="px-3 pb-2 text-xs text-[var(--color-ink-muted)]">No output.</p>
          ) : null}
        </div>
      )}
    </div>
  )
}
