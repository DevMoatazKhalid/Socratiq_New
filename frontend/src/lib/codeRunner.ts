import { useEffect, useState } from "react"
import { api, ApiError } from "./api"

/**
 * In-chat code runner client. Code is executed by the server's isolated runner service, never in the browser and never in the API process.
 * Limits are decided by the server; the browser only sends the code, the language and optional stdin.
 */

export interface CodeLanguage { id: string; label: string; aliases: string[] }
export interface CodeRuntime { enabled: boolean; languages: CodeLanguage[]; limits: { timeoutMs: number; memoryMb: number; outputBytes: number } }

export type RunStatus = "completed" | "failed" | "timeout" | "memory_limit" | "output_limit" | "cancelled"
export interface RunResult {
  runId: string
  language: string
  status: RunStatus
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  durationMs: number
  limits: CodeRuntime["limits"]
}

const DISABLED: CodeRuntime = { enabled: false, languages: [], limits: { timeoutMs: 0, memoryMb: 0, outputBytes: 0 } }

// One shared lookup per page load (the chat can hold many code blocks). A working runtime is kept for 5 minutes. A failed lookup or an
// "off" answer is kept for only 30 s: the runner may still be starting or briefly unreachable, and a stale "off" used to hide every Run
// button for 5 minutes (one of the reasons Run appeared only some of the time).
const RUNTIME_TTL_MS = 5 * 60_000
export const RUNTIME_RETRY_MS = 30_000
let cached: { at: number; value: Promise<CodeRuntime> } | null = null
export function fetchCodeRuntime(): Promise<CodeRuntime> {
  const now = Date.now()
  if (!cached || now - cached.at > RUNTIME_TTL_MS) {
    const entry = { at: now, value: Promise.resolve(DISABLED) }
    entry.value = api<CodeRuntime>("/student/code/runtime")
      .catch(() => DISABLED)
      .then((rt) => {
        if (!rt?.enabled) entry.at = Date.now() - RUNTIME_TTL_MS + RUNTIME_RETRY_MS
        return rt ?? DISABLED
      })
    cached = entry
  }
  return cached.value
}
export function resetCodeRuntimeCache() {
  cached = null
}

/** The runtime, or null while it is being looked up. Works without a react-query provider (chat bubbles are rendered in many places).
 *  While the answer is "off", it is looked up again a few times (shared cache, so one request for all blocks), so a runner that was still
 *  starting when the chat opened gives the blocks already on screen their Run button without a reload. */
export function useCodeRuntime(enabled = true): CodeRuntime | null {
  const [rt, setRt] = useState<CodeRuntime | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    let tries = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      void fetchCodeRuntime().then((v) => {
        if (!live) return
        setRt(v)
        if (!v.enabled && tries++ < 3) timer = setTimeout(load, RUNTIME_RETRY_MS + 50)
      })
    }
    load()
    return () => { live = false; if (timer) clearTimeout(timer) }
  }, [enabled])
  return rt
}

/** The language named by a fence's info string: "Python", "python title=x", "{python}", ".py", "language-python" all give "python"/"py". */
export function fenceLanguage(info: string): string {
  const first = info.trim().toLowerCase().split(/[\s{},:;]+/).find(Boolean) ?? ""
  return first.replace(/^language-/, "").replace(/^\./, "")
}

const PY_STRONG = [
  /^\s*print\s*\(/m,                                              // print(...)
  /^\s*def\s+[A-Za-z_]\w*\s*\(.*\)\s*(?:->\s*[^:]+)?:\s*(?:#.*)?$/m,  // def f(x):
  /^\s*class\s+[A-Za-z_]\w*\s*(?:\(.*\))?\s*:\s*(?:#.*)?$/m,       // class A:
  /^\s*(?:import\s+[A-Za-z_][\w.]*(?:\s+as\s+\w+)?|from\s+[A-Za-z_.][\w.]*\s+import\s+.+)\s*$/m,
  /^\s*for\s+[A-Za-z_][\w, ]*\s+in\s+.+:\s*(?:#.*)?$/m,             // for x in y:
  /^\s*(?:if|elif|while|with)\s+.+:\s*(?:#.*)?$/m,                 // if x:
]
const NOT_PY = [
  /[;{]\s*$/m,                                                     // C-family line endings
  /^\s*}/m,
  /\b(?:const|let|var|function|console\.|System\.out|public\s+static|#include|std::|fn\s+main|=>)/,
  /^\s*(?:\$|>>>|\.\.\.)\s/m,                                      // a shell / REPL transcript, not a program
  /^\s*</m,                                                        // markup
]

/** For a fence with NO language tag: "python" when the code is unmistakably Python, otherwise "" (no guess). Deliberately conservative: a
 *  wrong guess would offer Run on code that is not Python, so anything ambiguous stays copy-only. */
export function guessFenceLanguage(code: string): string {
  const src = code.trim()
  if (!src || src.length > 20_000) return ""
  if (NOT_PY.some((re) => re.test(src))) return ""
  return PY_STRONG.some((re) => re.test(src)) ? "python" : ""
}

/** The runnable language for a fence tag such as "py" or "python", or null (unsupported, unknown, or the runner is off). For an untagged
 *  fence, pass the code: it is used only to recognise unmistakable Python (see guessFenceLanguage). */
export function runnableLanguage(runtime: CodeRuntime | null, fence: string, code?: string): CodeLanguage | null {
  if (!runtime?.enabled) return null
  const tag = fenceLanguage(fence) || (code !== undefined ? guessFenceLanguage(code) : "")
  if (!tag) return null
  return runtime.languages.find((l) => l.id === tag || l.aliases.includes(tag)) ?? null
}

export function newRunId(): string {
  const r = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2) + Date.now().toString(36)
  return `run_${r.slice(0, 32)}`
}

export function runCode(body: { runId: string; language: string; source: string; stdin?: string }, signal?: AbortSignal): Promise<RunResult> {
  return api<RunResult>("/student/code/executions", { method: "POST", body: { run_id: body.runId, language: body.language, source: body.source, stdin: body.stdin ?? "" }, signal })
}

export async function cancelRun(runId: string): Promise<void> {
  try {
    await api(`/student/code/executions/${encodeURIComponent(runId)}`, { method: "DELETE" })
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) throw e      // already finished
  }
}

export function describeStatus(r: Pick<RunResult, "status" | "exitCode" | "durationMs" | "limits">): { label: string; tone: "ok" | "error" | "neutral" } {
  switch (r.status) {
    case "completed":
      return { label: `Completed in ${formatMs(r.durationMs)}`, tone: "ok" }
    case "failed":
      return { label: `Failed · exit code ${r.exitCode ?? "?"}`, tone: "error" }
    case "timeout":
      return { label: `Stopped: took longer than ${formatMs(r.limits.timeoutMs)}`, tone: "error" }
    case "memory_limit":
      return { label: `Stopped: used more than ${r.limits.memoryMb} MB of memory`, tone: "error" }
    case "output_limit":
      return { label: "Stopped: printed too much output", tone: "error" }
    case "cancelled":
      return { label: "Stopped", tone: "neutral" }
  }
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
}

// ---------------------------------------------------------------- per-block state (survives re-renders, chat/board switches and remounts)
export interface BlockState { source: string; edited: boolean; stdin: string; result: RunResult | null; error: string | null }
const blocks = new Map<string, BlockState>()
export const codeBlockStore = {
  get: (key: string): BlockState | undefined => blocks.get(key),
  set: (key: string, value: BlockState) => { blocks.set(key, value) },
  clear: () => blocks.clear(),
}
