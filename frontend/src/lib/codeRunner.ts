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

// One shared lookup per page load (the chat can hold many code blocks). A failure is retried after a minute, not on every render.
let cached: { at: number; value: Promise<CodeRuntime> } | null = null
export function fetchCodeRuntime(): Promise<CodeRuntime> {
  const now = Date.now()
  if (!cached || now - cached.at > 5 * 60_000) {
    const value = api<CodeRuntime>("/student/code/runtime").catch(() => {
      if (cached) cached.at = Date.now() - 4 * 60_000
      return DISABLED
    })
    cached = { at: now, value }
  }
  return cached.value
}
export function resetCodeRuntimeCache() {
  cached = null
}

/** The runtime, or null while it is being looked up. Works without a react-query provider (chat bubbles are rendered in many places). */
export function useCodeRuntime(enabled = true): CodeRuntime | null {
  const [rt, setRt] = useState<CodeRuntime | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    void fetchCodeRuntime().then((v) => { if (live) setRt(v) })
    return () => { live = false }
  }, [enabled])
  return rt
}

/** The runnable language for a fence tag such as "py" or "python", or null (unsupported, unknown, or the runner is off). */
export function runnableLanguage(runtime: CodeRuntime | null, fence: string): CodeLanguage | null {
  if (!runtime?.enabled) return null
  const tag = fence.trim().toLowerCase()
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
