/** Shared helper: find a real Chromium and a bundler, so the browser tests run the REAL TypeScript source (never copies or stubs of it). */
const path = require("path"), fs = require("fs"), cp = require("child_process")
const ROOT = path.resolve(__dirname, "../..")
const FE = path.join(ROOT, "frontend")
const BUILD = process.env.SQ_E2E_BUILD || path.join(require("os").tmpdir(), "sq-e2e-build")

function tryResolve(name) {
  for (const p of [process.env.SQ_TOOLS, FE, ROOT, process.cwd(), "/home/claude/tools"].filter(Boolean)) {
    try { return require.resolve(name, { paths: [p] }) } catch {}
  }
  return null
}

/** Bundle a TS entry (real source, real node_modules) to a single CJS/IIFE file with rolldown (ships with vite 8). */
function bundle(entry, outName, format = "cjs") {
  fs.mkdirSync(BUILD, { recursive: true })
  const out = path.join(BUILD, outName)
  const bin = path.join(FE, "node_modules/.bin/rolldown")
  cp.execFileSync(bin, [entry, "--format", format, "--file", out], { cwd: FE, stdio: "pipe" })
  return out
}

async function launch() {
  const pw = require(tryResolve("playwright-core") || tryResolve("playwright"))
  let executablePath = process.env.CHROME_PATH, args = ["--no-sandbox"]
  if (!executablePath) {
    const sp = tryResolve("@sparticuz/chromium")
    if (sp) { const c = require(sp); const ch = c.default || c; executablePath = await ch.executablePath(); args = ch.args.filter((a) => !/single-process|no-zygote|disable-web-security|site-isolation|IsolateOrigins|site-per-process/.test(a)) }   // keep the browser's real same-origin policy: the sandbox tests are meaningless without it   // single-process mode dies when a page closes
  }
  if (!executablePath) throw new Error("No Chromium found: set CHROME_PATH, or install @sparticuz/chromium + playwright-core (see e2e/sim/README.md)")
  return pw.chromium.launch({ executablePath, args, headless: true })
}

/** Tiny assertion recorder that prints evidence and returns a non-zero exit code on any failure. Nothing is reported as passed unless it ran. */
function recorder(title) {
  const rows = []
  const check = (name, ok, detail = "") => { rows.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  [" + detail + "]" : ""}`) }
  const done = (extra = {}) => {
    const failed = rows.filter((r) => !r.ok).length
    console.log(`\n${title}: ${rows.length - failed}/${rows.length} passed${failed ? `, ${failed} FAILED` : ""}`)
    if (process.env.SQ_E2E_JSON) fs.writeFileSync(process.env.SQ_E2E_JSON, JSON.stringify({ title, at: new Date().toISOString(), results: rows, ...extra }, null, 1))
    return failed ? 1 : 0
  }
  return { check, done, rows }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
module.exports = { ROOT, FE, BUILD, bundle, launch, recorder, sleep }
