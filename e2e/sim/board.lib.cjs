const http = require("http"), fs = require("fs"), path = require("path"), cp = require("child_process")
const { BUILD, ROOT, sleep } = require("./browser.cjs")
const OUT = process.env.SQ_E2E_BOARD_OUT || path.join(BUILD, "board")
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".json": "application/json", ".svg": "image/svg+xml" }

/** Always rebuild the page from the current source, so the test can never run against a stale bundle. */
function build() {
  const r = cp.spawnSync(path.join(ROOT, "frontend/node_modules/.bin/vite"), ["build", "--config", "vite.e2e-board.config.ts"], { cwd: path.join(ROOT, "frontend"), encoding: "utf8", env: { ...process.env, SQ_E2E_BOARD_OUT: OUT } })
  if (r.status !== 0) throw new Error("board test page failed to build:\n" + (r.stdout + r.stderr).split("\n").filter((l) => !/^\s+at /.test(l)).slice(-12).join("\n"))
}

function serve() {
  const srv = http.createServer((req, res) => {
    const f = path.join(OUT, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html")
    if (!f.startsWith(OUT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end() }
    res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res)
  })
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, url: `http://127.0.0.1:${srv.address().port}/index.html` })))
}

/** Open the real board. `gen` maps a prompt (substring) to the model's reply; only the network is stubbed, and only outside the app. */
async function openBoard(browser, url, { gen = {}, init = {}, size = { width: 1280, height: 800 } } = {}) {
  const ctx = await browser.newContext({ viewport: size })
  const page = await ctx.newPage()
  const log = { pageErrors: [], apiCalls: [] }
  page.on("pageerror", (e) => log.pageErrors.push(e.message))
  await page.addInitScript((i) => { window.__init = i }, { width: size.width, height: size.height, ...init })
  await page.route("**/*", async (route) => {
    const u = route.request().url()
    if (u.startsWith("data:") || u.startsWith("blob:")) return route.continue()
    if (u.includes("/api/v1/smartboard/generate-simulation")) {
      const body = JSON.parse(route.request().postData() || "{}"); log.apiCalls.push(body.prompt)
      const hit = Object.entries(gen).find(([k]) => body.prompt.includes(k))
      if (!hit) return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ detail: "The model returned an empty simulation." }) })
      const v = hit[1]
      return typeof v === "string" ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: v }) }) : route.fulfill({ status: v.status, contentType: "application/json", body: JSON.stringify(v.body) })
    }
    if (u.includes("/api/")) return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    if (u.startsWith("http://127.0.0.1")) return route.continue()                       // the test page itself (checked AFTER /api/: same origin)
    if (u.startsWith("https://cdn.tailwindcss.com") || u.startsWith("https://cdn.jsdelivr.net")) return route.fulfill({ status: 200, contentType: "text/javascript", body: "/*stub*/" })
    return route.abort()
  })
  await page.goto(url)
  await page.waitForSelector("[data-testid=smartboard] canvas", { timeout: 20000 })
  return { ctx, page, log }
}

const generate = async (page, prompt) => {
  await page.click('button[title="AI creates interactive HTML/JS simulations"]')
  await page.fill('input[placeholder^="Describe a physics"]', prompt)
  await page.click('button:has-text("Simulate"):not([title])')
}
const cards = (page) => page.$$("[data-sim-card]")
async function simFrame(page, cardId) {
  const h = await page.$(cardId ? `[data-sim-frame="${cardId}"]` : "[data-sim-frame]")
  return h ? h.contentFrame() : null
}
const cardIds = (page) => page.$$eval("[data-sim-card]", (els) => els.map((e) => e.getAttribute("data-sim-card")))
const readout = (fr, sel) => fr.evaluate((s) => parseFloat(document.querySelector(s).textContent), sel)
const waitSaves = async (page, n, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if ((await page.evaluate(() => window.__t.saves.length)) >= n) return true; await sleep(100) } return false }
const lastSave = (page) => page.evaluate(() => window.__t.saves[window.__t.saves.length - 1])

/** Run a saved scene through the REAL server-side validator (ai/whiteboard/scene.py) exactly as the PUT route does, in a child Python process. */
function serverSanitize(scene) {
  const py = process.env.SQ_PYTHON || (fs.existsSync("/home/claude/venv/bin/python") ? "/home/claude/venv/bin/python" : "python3")
  const r = cp.spawnSync(py, ["-c", "import sys,json;sys.path.insert(0,'.');from backend.app.schemas import WhiteboardIn;b=WhiteboardIn(scene=json.load(sys.stdin));print(json.dumps(b.scene))"], { cwd: ROOT, input: JSON.stringify(scene), encoding: "utf8" })
  if (r.status !== 0) return { rejected: true, error: (r.stderr || "").trim() }
  return { rejected: false, scene: JSON.parse(r.stdout) }
}
module.exports = { build, serve, openBoard, generate, cards, simFrame, cardIds, readout, waitSaves, lastSave, serverSanitize, sleep }
