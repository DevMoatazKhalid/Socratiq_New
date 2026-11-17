/**
 * Runaway-loop protection for generated simulations.
 *
 * An iframe sandbox gives isolation, NOT CPU limits: in a real browser an infinite loop inside a sandboxed frame freezes the whole tab
 * (verified in Chromium; see e2e/sim.e2e.mjs). So every loop in the generated code is instrumented:
 *
 *     while (c) { body }   ->   { __lgEnter(7); while (c) { __lgTick(7); body } }
 *
 * `__lgEnter` records when the loop was entered; `__lgTick` throws once the SAME run of the loop has been going for LOOP_LIMIT_MS.
 * Re-entering a loop (for example once per animation frame) restarts its clock, so legitimate per-frame loops are never penalised.
 *
 * Covered: inline <script> blocks (classic and module) and inline on*="" handlers.
 * `eval` / `new Function` / string timers cannot be used to dodge this: the CSP has no 'unsafe-eval'.
 * NOT covered (documented limitation): catastrophic regex backtracking, huge single allocations, and code that cannot be parsed.
 */
import { parse } from "acorn"

export const LOOP_LIMIT_MS = 1500

/** Inlined into the document head before any generated code. */
export const LOOP_GUARD_RUNTIME =
  `<script>(function(){var s={},n={},L=${LOOP_LIMIT_MS},now=Date.now.bind(Date);` +                       // the NATIVE clock: simulationRuntime replaces Date.now with pausable virtual time
  `window.__lgEnter=function(i){s[i]=now();n[i]=0};` +
  `window.__lgTick=function(i){if((n[i]=(n[i]|0)+1)%128===0&&now()-s[i]>L)` +
  `throw new Error("SocratiQ stopped this simulation: a loop ran for more than "+L+" ms without finishing.")}})()</script>`

interface Edit { pos: number; text: string; order: number }
type Node = { type: string; start: number; end: number; body?: Node; [k: string]: unknown }

const LOOPS = new Set(["WhileStatement", "DoWhileStatement", "ForStatement", "ForInStatement", "ForOfStatement"])

function collect(root: unknown, startId: number): { edits: Edit[]; nextId: number } {
  const edits: Edit[] = []
  let id = startId, order = 0
  const add = (pos: number, text: string) => edits.push({ pos, text, order: order++ })

  const visit = (node: unknown, labelRoot: Node | null): void => {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) { for (const n of node) visit(n, null); return }
    const n = node as Node
    if (typeof n.type !== "string") return
    if (n.type === "LabeledStatement") { visit(n.body, labelRoot ?? n); return }
    if (LOOPS.has(n.type) && n.body) {
      const me = id++
      const unit = labelRoot ?? n                       // a label must stay glued to its loop, so the label is wrapped with it
      add(unit.start, `{__lgEnter(${me});`)
      if (n.body.type === "BlockStatement") add(n.body.start + 1, `__lgTick(${me});`)
      else { add(n.body.start, `{__lgTick(${me});`); add(n.body.end, "}") }
      for (const key of Object.keys(n)) if (key !== "type" && key !== "start" && key !== "end") visit((n as Record<string, unknown>)[key], null)
      add(unit.end, "}")
      return
    }
    for (const key of Object.keys(n)) {
      if (key === "type" || key === "start" || key === "end") continue
      visit((n as Record<string, unknown>)[key], null)
    }
  }
  visit(root, null)
  return { edits, nextId: id }
}

function apply(src: string, edits: Edit[]): string {
  // Apply from the end so earlier offsets stay valid; at equal positions later-collected edits go first so the final order is collection order.
  const sorted = [...edits].sort((a, b) => b.pos - a.pos || b.order - a.order)
  let out = src
  for (const e of sorted) out = out.slice(0, e.pos) + e.text + out.slice(e.pos)
  return out
}

/** Returns the instrumented JS, or the original if it cannot be parsed (a script that does not parse does not run either). */
export function guardJs(js: string, opts: { module?: boolean; startId?: number } = {}): { code: string; nextId: number } {
  try {
    const ast = parse(js, { ecmaVersion: "latest", sourceType: opts.module ? "module" : "script", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: !!opts.module })
    const { edits, nextId } = collect(ast, opts.startId ?? 0)
    return { code: apply(js, edits), nextId }
  } catch {
    return { code: js, nextId: opts.startId ?? 0 }
  }
}

const decodeAttr = (v: string) => v.replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
const encodeAttr = (v: string, q: string) => v.replace(/&/g, "&amp;").replace(q === '"' ? /"/g : /'/g, q === '"' ? "&quot;" : "&#39;")
const JS_TYPE = /^(?:|module|(?:text|application)\/(?:x-)?(?:javascript|ecmascript))$/i

/** Instrument every executable inline script and inline event handler in an HTML fragment. */
export function guardSimulationLoops(html: string): string {
  let id = 0
  // split() with a capture group alternates: markup, <script> block, markup, ... so attributes are only rewritten in markup.
  const parts = html.split(/(<script\b[^>]*>[\s\S]*?<\/script\s*>)/gi)
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      const m = /^<script\b([^>]*)>([\s\S]*?)<\/script\s*>$/i.exec(part)
      if (!m) return part
      const [, attrs, body] = m
      if (/\bsrc\s*=/i.test(attrs)) return part
      const type = /\btype\s*=\s*["']?([^"'\s>]*)/i.exec(attrs)?.[1] ?? ""
      if (!JS_TYPE.test(type)) return part
      const r = guardJs(body, { module: type.toLowerCase() === "module", startId: id })
      id = r.nextId
      return `<script${attrs}>${r.code}</script>`
    }
    return part.replace(/(\son[a-z]+\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, (whole, pre: string, dq: string | undefined, sq: string | undefined) => {
      const q = dq !== undefined ? '"' : "'"
      const r = guardJs(decodeAttr(dq ?? sq ?? ""), { startId: id })
      id = r.nextId
      return `${pre}${q}${encodeAttr(r.code, q)}${q}`
    })
  }).join("")
}
