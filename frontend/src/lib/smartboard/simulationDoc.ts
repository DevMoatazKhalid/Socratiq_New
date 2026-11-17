/**
 * The ONE place that decides how generated simulation code is validated and executed.
 * The on-board BoardSimulationLayer (native board) and SimulationNode (legacy read-only board) both render through this module.
 *
 * Security model (in order of importance):
 *  1. `sandbox="allow-scripts"` WITHOUT `allow-same-origin`: the frame gets an opaque origin, so it cannot reach the parent,
 *     cookies, localStorage, IndexedDB or the app's network credentials. This is the real boundary.
 *  2. A CSP <meta> placed before the untrusted code: no network (`connect-src 'none'`), no images from the network, no nested frames,
 *     no forms, no <base>. Scripts may only come from the pinned/allow-listed CDNs below.
 *  3. A loop guard (see loopGuard.ts): every loop in the generated scripts gets a time check, because a sandbox does not stop an infinite
 *     loop from freezing the tab.
 *  4. A deny-list of primitives the sandbox forbids anyway. This is defence in depth and a clear message for the user; it is trivially
 *     bypassable by string concatenation and must never be relied on alone.
 * Not covered here: a sandboxed frame may navigate ITSELF (it has nothing sensitive to leak), and catastrophic regex backtracking or a huge
 * single allocation can still stall the tab.
 */

import { LOOP_GUARD_RUNTIME, guardSimulationLoops } from "./loopGuard"
import { SIM_HOST_RUNTIME } from "./simulationRuntime"

export const MAX_SIMULATION_CHARS = 120_000

/** No allow-same-origin, no allow-top-navigation, no allow-popups, no allow-modals (alert() spam), no allow-forms (form-action is 'none' anyway). */
export const SIMULATION_SANDBOX = "allow-scripts"

export const TAILWIND_SRC = "https://cdn.tailwindcss.com/3.4.17"
export const MATHJAX_SRC = "https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-mml-chtml.js"

export const BLOCKED_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /window\s*\.\s*parent/i, label: "window.parent access" },
  { pattern: /window\s*\.\s*top/i, label: "window.top access" },
  { pattern: /parent\s*\.\s*postMessage/i, label: "parent.postMessage" },
  { pattern: /document\s*\.\s*cookie/i, label: "document.cookie access" },
  { pattern: /localStorage/i, label: "localStorage access" },
  { pattern: /sessionStorage/i, label: "sessionStorage access" },
  { pattern: /indexedDB/i, label: "indexedDB access" },
  { pattern: /<meta\s+http-equiv\s*=\s*["']?refresh/i, label: "meta refresh redirect" },
  { pattern: /<base\s/i, label: "base tag injection" },
  { pattern: /window\s*\.\s*opener/i, label: "window.opener access" },
  { pattern: /navigator\s*\.\s*sendBeacon/i, label: "sendBeacon exfiltration" },
  { pattern: /<iframe/i, label: "nested frames" },
  { pattern: /<object|<embed/i, label: "embedded objects" },
]

export function validateSimulationCode(code: string): { safe: boolean; violations: string[] } {
  const violations: string[] = []
  if (typeof code !== "string") return { safe: false, violations: ["invalid code"] }
  if (code.length > MAX_SIMULATION_CHARS) violations.push("code too large")
  for (const { pattern, label } of BLOCKED_PATTERNS) if (pattern.test(code)) violations.push(label)
  return { safe: violations.length === 0, violations }
}

export const SIMULATION_CSP =
  "default-src 'none'; " +
  `script-src 'unsafe-inline' ${TAILWIND_SRC} https://cdn.jsdelivr.net; ` +
  "style-src 'unsafe-inline' https://cdn.jsdelivr.net; img-src data: blob:; font-src https://cdn.jsdelivr.net; " +
  "connect-src 'none'; frame-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

/** The complete document placed in the iframe's `srcDoc`. The CSP precedes every byte of untrusted code. */
export function buildSimulationSrcDoc(code: string): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="${SIMULATION_CSP}">
    ${LOOP_GUARD_RUNTIME}
    ${SIM_HOST_RUNTIME}
    <script async src="${TAILWIND_SRC}"></script>
    <script>window.MathJax = { tex: { inlineMath: [['$', '$'], ['\\\\(', '\\\\)']] }, svg: { fontCache: 'global' } };</script>
    <script id="MathJax-script" async src="${MATHJAX_SRC}"></script>
    <style>
      html, body { height: 100%; }
      body { background-color: #ffffff; margin: 0; padding: 0.5rem; box-sizing: border-box; overflow: auto;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #0f172a; }
      ::-webkit-scrollbar { width: 6px; height: 6px; }
      ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
    </style>
  </head>
  <body>
${guardSimulationLoops(code)}
  </body>
</html>`
}
