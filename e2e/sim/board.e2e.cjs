/**
 * Real-browser end-to-end tests of simulations on the native SmartBoard: real SmartBoardWorkspace, real Excalidraw, real iframe sandbox, real
 * autosave payloads, and the REAL server validator for the persistence round trip. Only the network is stubbed (outside the app).
 * Evidence is behavioural: positions are measured, state is sampled over time, mouse input changes the model's output.
 */
const { launch, recorder } = require("./browser.cjs")
const L = require("./board.lib.cjs")
const S = require("./sims.cjs")
const { sleep } = L

const CATEGORIES = [
  { name: "physics: projectile motion (requestAnimationFrame)", code: S.PROJECTILE, prompt: "projectile", slider: "#angle", out: "#hmax", moves: "readout" },
  { name: "mathematics: sine function plotter", code: S.SINE, prompt: "sine", slider: "#freq", out: "#per", moves: "readout" },
  { name: "science: Brownian particles (setInterval)", code: S.PARTICLES, prompt: "brownian", slider: "#temp", out: "#ms", moves: "readout" },
  { name: "interactive model: logistic growth (input-driven)", code: S.LOGISTIC, prompt: "logistic", button: "#step", out: "#pop", moves: "readout", still: true },
]
const only = process.env.SQ_ONLY
/** Excalidraw handles pointer moves on animation frames; releasing instantly can drop the last move. Give every step a frame, like a human hand does. */
const dragTo = async (page, from, to, steps = 10) => { await page.mouse.move(from[0], from[1]); await page.mouse.down(); for (let i = 1; i <= steps; i++) { await page.mouse.move(from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps); await sleep(24) } await sleep(60); await page.mouse.up() }

/** Walk up from an element: any position:fixed ancestor means it is a page-level panel, not part of the board. */
const insideBoardNotFixed = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s), board = document.querySelector("[data-testid=smartboard]")
  if (!el || !board || !board.contains(el)) return { ok: false, why: "not inside the board container" }
  for (let n = el; n && n !== board; n = n.parentElement) if (getComputedStyle(n).position === "fixed") return { ok: false, why: "ancestor is position:fixed" }
  const r = el.getBoundingClientRect(), b = board.getBoundingClientRect()
  const within = r.left >= b.left - 1 && r.top >= b.top - 1 && r.right <= b.right + 1 && r.bottom <= b.bottom + 1
  return { ok: within, why: within ? "" : `frame ${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)} outside board ${Math.round(b.left)},${Math.round(b.top)}-${Math.round(b.right)},${Math.round(b.bottom)}` }
}, sel)

;(async () => {
  const R = recorder("Native SmartBoard simulations (real Chromium)")
  L.build()
  const browser = await launch(); const { srv, url } = await L.serve()
  R.check("browser launched, board test page served", true, browser.version())
  try {
    // ============================================================ A. every category: generated via the UI, inserted inside the board, alive, interactive
    for (const cat of CATEGORIES) {
      if (only && only !== "A") break
      const { ctx, page, log } = await L.openBoard(browser, url, { gen: { [cat.prompt]: cat.code } })
      await L.generate(page, cat.prompt)
      await page.waitForSelector("[data-sim-card]", { timeout: 10000 })
      await page.waitForSelector("[data-sim-card][data-status=running]", { timeout: 10000 })
      const where = await insideBoardNotFixed(page, "[data-sim-frame]")
      R.check(`[${cat.name}] inserted INSIDE the board, no position:fixed ancestor, within board bounds`, where.ok, where.why)
      const parts = await page.evaluate(() => ({ cards: document.querySelectorAll("[data-sim-card]").length, frames: document.querySelectorAll("iframe").length,
        fixedWithSim: [...document.querySelectorAll("*")].filter((e) => getComputedStyle(e).position === "fixed" && (e.querySelector("iframe") || e.hasAttribute("data-sim-card"))).length }))
      R.check(`[${cat.name}] exactly one card and one frame exist, and nothing position:fixed holds a simulation`, parts.cards === 1 && parts.frames === 1 && parts.fixedWithSim === 0, JSON.stringify(parts))
      const fr = await L.simFrame(page)
      await sleep(300)
      const t1 = await L.readout(fr, "#t"); await sleep(600); const t2 = await L.readout(fr, "#t")
      if (cat.still) R.check(`[${cat.name}] idle model is stable until the user acts`, t1 === t2, `generation ${t1} -> ${t2}`)
      else {
        let why = `#t ${t1} -> ${t2}`
        if (!(t2 > t1)) why += " | runtime=" + JSON.stringify(await fr.evaluate(() => ({ frames: window.__sq.frames, paused: window.__sq.paused, speed: window.__sq.speed, pending: window.__sq.pending, hidden: document.hidden }))) + " card=" + JSON.stringify(await page.$eval("[data-sim-card]", (e) => ({ display: e.style.display, paused: e.getAttribute("data-paused"), status: e.getAttribute("data-status") })))
        R.check(`[${cat.name}] state ADVANCES over wall-clock time`, t2 > t1, why)
      }
      // real mouse input on the control, in page coordinates
      const before = await L.readout(fr, cat.out)
      const el = await fr.$(cat.slider || cat.button); const bb = await el.boundingBox()
      if (cat.slider) await page.mouse.click(bb.x + bb.width * 0.92, bb.y + bb.height / 2); else for (let i = 0; i < 3; i++) await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2)
      await sleep(250)
      const after = await L.readout(fr, cat.out)
      R.check(`[${cat.name}] a REAL mouse interaction changes the model's output`, after !== before, `${cat.out}: ${before} -> ${after}`)
      R.check(`[${cat.name}] no page errors`, log.pageErrors.length === 0, log.pageErrors.join(" | ").slice(0, 160))
      await ctx.close()
    }

    // ============================================================ B. geometry: the card tracks the board's pan / zoom / drag / resize, checked against EXCALIDRAW'S OWN canvas pixels
    if (!only || only === "B") {
      const { ctx, page } = await L.openBoard(browser, url, { gen: { projectile: S.PROJECTILE } })
      await L.generate(page, "projectile"); await page.waitForSelector("[data-sim-card][data-status=running]")
      /** Where does Excalidraw itself draw the card's teal border? Scan every board canvas near the overlay's edges. */
      const edges = () => page.evaluate(() => {
        const card = document.querySelector("[data-sim-card]").getBoundingClientRect()
        const isTeal = (d, i) => Math.abs(d[i] - 15) < 40 && Math.abs(d[i + 1] - 118) < 40 && Math.abs(d[i + 2] - 110) < 40 && d[i + 3] > 200
        const found = { left: null, top: null, right: null, bottom: null }
        for (const c of document.querySelectorAll(".excalidraw canvas")) {
          const cr = c.getBoundingClientRect(), g = c.getContext("2d"); if (!g || !c.width) continue
          const k = c.width / cr.width, row = Math.round(card.top + card.height * 0.6), col = Math.round(card.left + card.width * 0.6)
          const scan = (axis, lo, hi, fixed) => { for (let v = lo; v <= hi; v++) { const x = axis === "x" ? v : fixed, y = axis === "x" ? fixed : v
            const d = g.getImageData(Math.round((x - cr.left) * k), Math.round((y - cr.top) * k), 1, 1).data; if (isTeal(d, 0)) return v } return null }
          found.left = found.left ?? scan("x", Math.round(card.left - 12), Math.round(card.left + 12), row)
          found.right = found.right ?? scan("x", Math.round(card.right - 12), Math.round(card.right + 12), row)
          found.top = found.top ?? scan("y", Math.round(card.top - 12), Math.round(card.top + 12), col)
          found.bottom = found.bottom ?? scan("y", Math.round(card.bottom - 12), Math.round(card.bottom + 12), col)
        }
        return { card: { l: card.left, t: card.top, r: card.right, b: card.bottom }, found }
      })
      const aligned = async (label) => {
        await sleep(350); const { card, found } = await edges()
        const k = (card.r - card.l) / 520, tol = 2 * k + 2.5
        const ok = found.left !== null && found.right !== null && found.top !== null && found.bottom !== null &&
          Math.abs(found.left - card.l) <= tol && Math.abs(found.right - card.r) <= tol && Math.abs(found.top - card.t) <= tol && Math.abs(found.bottom - card.b) <= tol
        R.check(`geometry: ${label} - overlay edges coincide with the border Excalidraw drew`, ok, `overlay L${card.l.toFixed(0)} T${card.t.toFixed(0)} R${card.r.toFixed(0)} B${card.b.toFixed(0)} | canvas border ${JSON.stringify(found)} | zoom~${k.toFixed(2)}`)
        return card
      }
      const c0 = await aligned("initial")
      await page.mouse.move(1180, 740); await page.mouse.wheel(60, 90); const c1 = await aligned("after panning with the wheel")
      R.check("geometry: the card actually moved when the board panned", Math.abs(c1.l - c0.l) > 20 || Math.abs(c1.t - c0.t) > 20, `dx=${(c1.l - c0.l).toFixed(0)} dy=${(c1.t - c0.t).toFixed(0)}`)
      await page.keyboard.down("Control"); await page.mouse.wheel(0, -300); await page.keyboard.up("Control"); const c2 = await aligned("after zooming IN (ctrl+wheel)")
      R.check("geometry: zooming in made the card bigger", (c2.r - c2.l) > (c1.r - c1.l) * 1.05, `${(c1.r - c1.l).toFixed(0)}px -> ${(c2.r - c2.l).toFixed(0)}px`)
      await page.keyboard.down("Control"); await page.mouse.wheel(0, 700); await page.keyboard.up("Control"); const c3 = await aligned("after zooming OUT")
      R.check("geometry: zooming out made it smaller again", (c3.r - c3.l) < (c2.r - c2.l), `${(c2.r - c2.l).toFixed(0)}px -> ${(c3.r - c3.l).toFixed(0)}px`)
      const fr = await L.simFrame(page); const f1 = await L.readout(fr, "#t"); await sleep(400); const f2 = await L.readout(fr, "#t")
      R.check("geometry: the simulation kept running through pan and zoom", f2 > f1, `${f1} -> ${f2}`)
      // drag by the title bar (the same gesture as any element), then resize by the corner handle
      await page.keyboard.down("Control"); await page.mouse.move(1180, 740); await page.mouse.wheel(0, -250); await page.keyboard.up("Control"); await sleep(500)     // let the zoom settle BEFORE measuring (measuring mid-zoom gave a stale reading)
      const b0 = (await edges()).card, hx = b0.l + (b0.r - b0.l) * 0.3, hy = b0.t + 14
      await dragTo(page, [hx, hy], [hx + 90, hy + 60]); await sleep(300)
      const b1 = (await edges()).card
      R.check("drag: dragging the title bar moves the card with the board's own gesture", Math.abs((b1.l - b0.l) - 90) < 4 && Math.abs((b1.t - b0.t) - 60) < 4, `moved ${(b1.l - b0.l).toFixed(0)},${(b1.t - b0.t).toFixed(0)} (asked 90,60)`)
      const fr2 = await L.simFrame(page); const g1 = await L.readout(fr2, "#t"); await sleep(300)
      R.check("drag: simulation state survives being moved", (await L.readout(fr2, "#t")) > g1)
      await dragTo(page, [b1.r + 3, b1.b + 3], [b1.r + 83, b1.b + 53]); await sleep(350)
      const b2 = (await edges()).card
      R.check("resize: dragging the corner handle resizes the card (frame follows)", (b2.r - b2.l) > (b1.r - b1.l) + 50, `${(b1.r - b1.l).toFixed(0)}px -> ${(b2.r - b2.l).toFixed(0)}px wide`)
      await aligned("after being dragged AND resized (regression: the overlay once stayed behind when the card moved)")
      await ctx.close()
    }

    // ============================================================ C. transport controls with real clicks
    if (!only || only === "C") {
      const { ctx, page } = await L.openBoard(browser, url, { gen: { projectile: S.PROJECTILE } })
      await L.generate(page, "projectile"); await page.waitForSelector("[data-sim-card][data-status=running]")
      const fr = await L.simFrame(page); await sleep(600)
      await page.click("[data-sim-action=toggle]"); await sleep(150)
      const p1 = await L.readout(fr, "#t"); await sleep(700); const p2 = await L.readout(fr, "#t")
      R.check("controls: Pause freezes the simulation", p1 === p2 && (await page.getAttribute("[data-sim-card]", "data-paused")) === "true", `#t ${p1} -> ${p2} over 700ms`)
      await page.click("[data-sim-action=toggle]"); await sleep(700); const p3 = await L.readout(fr, "#t")
      R.check("controls: Play resumes from where it stopped (no jump)", p3 > p2 && p3 - p2 < 1.4, `${p2} -> ${p3}`)
      const fps = async () => { const a = await fr.evaluate(() => window.__sq.frames); await sleep(1000); return (await fr.evaluate(() => window.__sq.frames)) - a }
      const base = await fps()
      for (let i = 0; i < 6; i++) await page.click("[data-sim-action=toggle]")
      const after = await fps()
      R.check("controls: 6 rapid Pause/Play clicks do not duplicate the animation loop", after < base * 1.4, `frames/s ${base} -> ${after}`)
      await page.selectOption("[data-sim-action=speed]", "2"); await sleep(200)
      const s1 = await L.readout(fr, "#t"); await sleep(1000); const s2 = await L.readout(fr, "#t")
      R.check("controls: 2x speed advances the simulation ~2x faster", s2 - s1 > 1.6 && s2 - s1 < 2.5, `${(s2 - s1).toFixed(2)} sim-seconds in 1 real second`)
      await page.selectOption("[data-sim-action=speed]", "0.5"); await sleep(200)
      const h1 = await L.readout(fr, "#t"); await sleep(1000); const h2 = await L.readout(fr, "#t")
      R.check("controls: 0.5x speed advances ~half as fast", h2 - h1 > 0.35 && h2 - h1 < 0.7, `${(h2 - h1).toFixed(2)}`)
      const before = await page.$("[data-sim-frame]"); const old = await before.contentFrame()
      await page.click("[data-sim-action=reset]"); await page.waitForSelector("[data-sim-card][data-status=running]"); await sleep(350)
      const fresh = await L.simFrame(page)
      R.check("controls: Reset restarts the simulation from zero in a NEW frame, and the old one is destroyed", (await L.readout(fresh, "#t")) < 1 && old.isDetached() && (await page.$$("iframe")).length === 1, `#t=${await L.readout(fresh, "#t")}, old detached=${old.isDetached()}`)
      R.check("controls: Reset also restores play and 1x", (await page.getAttribute("[data-sim-card]", "data-paused")) === "false" && (await page.$eval("[data-sim-action=speed]", (e) => e.value)) === "1")
      await ctx.close()
    }

    // ============================================================ D. removal cleans up; undo restores a live simulation
    if (!only || only === "D") {
      const { ctx, page } = await L.openBoard(browser, url, { gen: { projectile: S.PROJECTILE } })
      await L.generate(page, "projectile"); await page.waitForSelector("[data-sim-card][data-status=running]")
      const fr = await L.simFrame(page); await sleep(300)
      await page.click("[data-sim-action=remove]"); await sleep(400)
      R.check("removal: the card and its frame are gone and the frame's document is destroyed", (await L.cards(page)).length === 0 && (await page.$$("iframe")).length === 0 && fr.isDetached(), `detached=${fr.isDetached()}`)
      await L.waitSaves(page, 1); await sleep(1800)
      const sv = await L.lastSave(page)
      R.check("removal: the saved scene no longer carries the simulation's code", !sv.simulations && !JSON.stringify(sv).includes("requestAnimationFrame"), `keys=${Object.keys(sv).join(",")}`)
      await page.mouse.click(1150, 700); await page.keyboard.press("Control+z"); await sleep(600)
      const back = await L.simFrame(page)
      R.check("undo: Ctrl+Z brings the simulation back, running (its code was kept in memory)", !!back && (await page.$("[data-sim-card][data-status=running]")) !== null, "")
      if (back) { const u1 = await L.readout(back, "#t"); await sleep(400); R.check("undo: the restored simulation animates", (await L.readout(back, "#t")) > u1) }
      await ctx.close()
    }

    // ============================================================ E. several simulations never interfere
    if (!only || only === "E") {
      const { ctx, page } = await L.openBoard(browser, url, { gen: { projectile: S.PROJECTILE, sine: S.SINE }, size: { width: 1500, height: 900 } })
      await L.generate(page, "projectile"); await page.waitForSelector("[data-sim-card][data-status=running]")
      await L.generate(page, "sine"); await page.waitForFunction(() => document.querySelectorAll("[data-sim-card]").length === 2)
      await page.waitForFunction(() => [...document.querySelectorAll("[data-sim-card]")].every((c) => c.getAttribute("data-status") === "running"), null, { timeout: 8000 })
      const ids = await L.cardIds(page); const [A, B] = ids
      const fa = await L.simFrame(page, A), fb = await L.simFrame(page, B)
      R.check("multi: two cards, two distinct frames, distinct ids", ids.length === 2 && A !== B && fa !== fb && (await page.$$("iframe")).length === 2)
      const r = async () => [await L.readout(fa, "#t"), await L.readout(fb, "#t")]
      const [a1, b1] = await r(); await sleep(500); const [a2, b2] = await r()
      R.check("multi: both animate at the same time", a2 > a1 && b2 > b1, `A ${a1}->${a2}  B ${b1}->${b2}`)
      await page.click(`[data-sim-card="${A}"] [data-sim-action=toggle]`); await sleep(200)
      const [a3, b3] = await r(); await sleep(600); const [a4, b4] = await r()
      R.check("multi: pausing A leaves B running", a3 === a4 && b4 > b3, `A ${a3}->${a4}  B ${b3}->${b4}`)
      const fbox = await (await fb.frameElement()).boundingBox(); const slider = await fb.$("#freq"); const sb = await slider.boundingBox()
      const perBefore = await L.readout(fb, "#per"); await page.mouse.click(sb.x + sb.width * 0.95, sb.y + sb.height / 2); await sleep(200)
      R.check("multi: moving B's slider changes B only (A is paused and untouched)", (await L.readout(fb, "#per")) !== perBefore && (await L.readout(fa, "#t")) === a4)
      await page.click(`[data-sim-card="${A}"] [data-sim-action=remove]`); await sleep(400)
      const b5 = await L.readout(fb, "#t"); await sleep(400)
      R.check("multi: removing A destroys A's frame and B keeps running", fa.isDetached() && (await L.readout(fb, "#t")) > b5 && (await L.cards(page)).length === 1)
      await ctx.close()
    }

    // ============================================================ F. persistence: saved payload, REAL server validator, reopen
    if (!only || only === "F") {
      const { ctx, page } = await L.openBoard(browser, url, { gen: { projectile: S.PROJECTILE, sine: S.SINE }, size: { width: 1500, height: 900 } })
      await L.generate(page, "projectile"); await page.waitForSelector("[data-sim-card][data-status=running]")
      await L.generate(page, "sine"); await page.waitForFunction(() => document.querySelectorAll("[data-sim-card]").length === 2)
      await L.waitSaves(page, 1); await sleep(2200)
      const sv = await L.lastSave(page)
      const simEls = sv.elements.filter((e) => e.customData?.socratiq?.role === "simulation")
      R.check("persistence: the saved scene has two simulation cards of the right artifact type", simEls.length === 2 && simEls.every((e) => e.type === "rectangle" && e.customData.socratiq.author === "ai" && e.customData.simulationRef?.id), `${simEls.length} cards`)
      R.check("persistence: source code is in the scene's `simulations` map, never inside elements", Object.keys(sv.simulations || {}).length === 2 && !JSON.stringify(sv.elements).includes("requestAnimationFrame"), `map keys=${Object.keys(sv.simulations || {}).length}`)
      R.check("persistence: every card's reference resolves in the map", simEls.every((e) => sv.simulations[e.customData.simulationRef.id]?.code.includes("requestAnimationFrame")))
      const srv1 = L.serverSanitize(sv)
      R.check("persistence: the REAL server validator (WhiteboardIn / sanitize_scene) ACCEPTS the saved board", !srv1.rejected, srv1.error || `${Object.keys(srv1.scene.simulations || {}).length} simulations kept`)
      R.check("persistence: nothing was lost or altered by the server (code identical)", !srv1.rejected && simEls.every((e) => srv1.scene.simulations[e.customData.simulationRef.id].code === sv.simulations[e.customData.simulationRef.id].code))
      // negative control: the ORIGINAL storage format (code inline in customData) is what used to get a whole board rejected
      const legacyBig = JSON.parse(JSON.stringify(sv)); delete legacyBig.simulations
      for (const e of legacyBig.elements) if (e.customData?.simulationRef) { const rec = sv.simulations[e.customData.simulationRef.id]; e.customData = { socratiq: e.customData.socratiq, simulation: { id: rec.id, title: rec.title, code: rec.code + "<!--" + "x".repeat(6000) + "-->" } } }
      const old = L.serverSanitize(legacyBig)
      R.check("persistence (control): the ORIGINAL inline format is rejected by the same validator (this was the root cause)", old.rejected === true && /oversized custom data/.test(old.error), (old.error.match(/oversized custom data[^\n]*/) || [old.error.slice(-120)])[0])
      await ctx.close()
      // reopen: a brand-new browser context loads the server-sanitized scene
      const re = await L.openBoard(browser, url, { init: { board: { scene: srv1.scene, sceneRev: 3 } }, size: { width: 1500, height: 900 } })
      await re.page.waitForFunction(() => document.querySelectorAll("[data-sim-card][data-status=running]").length >= 1, null, { timeout: 12000 })
      const ids = await L.cardIds(re.page)
      R.check("reopen: both simulations are restored from the saved board", ids.length === 2, `${ids.length} cards`)
      const frs = await Promise.all(ids.map((i) => L.simFrame(re.page, i)))
      const t1 = await Promise.all(frs.map((f) => L.readout(f, "#t"))); await sleep(600); const t2 = await Promise.all(frs.map((f) => L.readout(f, "#t")))
      R.check("reopen: both restored simulations are ALIVE and animating (not static pictures)", t2.every((v, i) => v > t1[i]), `${t1.join("/")} -> ${t2.join("/")}`)
      const proj = (await Promise.all(frs.map(async (f) => (await f.$("#angle")) ? f : null))).find(Boolean)
      const sl = await (await proj.$("#angle")).boundingBox(); const h0 = await L.readout(proj, "#hmax"); await re.page.mouse.click(sl.x + sl.width * 0.92, sl.y + sl.height / 2); await sleep(250)
      R.check("reopen: a restored simulation still responds to user input", (await L.readout(proj, "#hmax")) !== h0, `${h0} -> ${await L.readout(proj, "#hmax")}`)
      R.check("reopen: no page errors", re.log.pageErrors.length === 0, re.log.pageErrors.join("|").slice(0, 150))
      await re.ctx.close()
      // read-only view (a teacher reviewing a submission, or a locked board)
      const ro = await L.openBoard(browser, url, { init: { board: { scene: srv1.scene, sceneRev: 3 }, readOnly: true }, size: { width: 1500, height: 900 } })
      await ro.page.waitForSelector("[data-sim-card][data-status=running]", { timeout: 12000 })
      R.check("read-only: simulations still run and have transport controls, but cannot be removed", (await ro.page.$$("[data-sim-action=toggle]")).length >= 1 && (await ro.page.$$("[data-sim-action=remove]")).length === 0)
      await ro.ctx.close()
    }

    // ============================================================ G. failures are visible and honest
    if (!only || only === "G") {
      let { ctx, page } = await L.openBoard(browser, url, { gen: { nothing: { status: 502, body: { detail: "The generated simulation does not animate or respond to input, so it is not an interactive simulation. Please try again." } } } })
      await L.generate(page, "nothing"); await page.waitForSelector("[role=alert]", { timeout: 8000 })
      const msg = await page.$eval("[role=alert]", (e) => e.textContent)
      R.check("failure: a rejected generation shows an error and adds NO card (no fake success). NOTE: wording is generic, the server's specific reason is not surfaced", (await L.cards(page)).length === 0 && msg.trim().length > 10, msg.slice(0, 110))
      await ctx.close()
      ;({ ctx, page } = await L.openBoard(browser, url, { gen: { broken: S.BROKEN } }))
      await L.generate(page, "broken"); await page.waitForSelector("[data-sim-error]", { timeout: 8000 })
      const em = await page.$eval("[data-sim-error]", (e) => e.textContent)
      R.check("failure: a runtime error inside the simulation is shown on the card, not swallowed", /undefinedFunction/.test(em), em.slice(0, 110))
      R.check("failure: the card stays on the board and its controls still work", (await page.$("[data-sim-action=reset]")) !== null)
      await page.click("[data-sim-error] button"); await sleep(300)
      R.check("failure: Reload restarts it in a fresh frame", (await page.$$("iframe")).length === 1)
      await ctx.close()
    }

    // ============================================================ H. Live Voice tool path, tool interplay, toolbar, safety
    if (!only || only === "H") {
      const { ctx, page } = await L.openBoard(browser, url, { init: {} })
      const fire = (d) => page.evaluate((x) => window.dispatchEvent(new CustomEvent("socratiq-open-simulation", { detail: x })), d)
      await fire({ id: "voice-1", title: "Voice sine", code: S.SINE }); await page.waitForSelector("[data-sim-card][data-status=running]")
      await fire({ id: "voice-1", title: "Voice sine", code: S.SINE }); await sleep(400)
      R.check("voice: a Live Voice simulation lands on the board as a live card; a duplicate event is idempotent", (await L.cards(page)).length === 1 && (await page.$$("iframe")).length === 1)
      await fire({ id: "evil", title: "x", code: "<script>window.parent.document.body.remove()</script>" }); await sleep(500)
      R.check("voice: unsafe code is refused before it can enter the scene, and the user is told", (await L.cards(page)).length === 1 && /not added/.test((await page.textContent("[data-testid=smartboard]")) || ""))
      await L.waitSaves(page, 1); await sleep(2000)
      const sv = await L.lastSave(page); const srvr = L.serverSanitize(sv)
      R.check("voice: the board still saves (the server accepted it) after the refused request", !srvr.rejected, srvr.error || "")
      // tool interplay: drawing across a simulation must draw, not click into the frame
      await page.mouse.click(1220, 760); await page.keyboard.press("p"); await sleep(200)
      R.check("tools: with the pen selected the simulation body does not capture the pointer", (await page.$eval("[data-sim-frame]", (e) => getComputedStyle(e).pointerEvents)) === "none")
      await page.keyboard.press("v"); await sleep(200)
      R.check("tools: back on the select tool it is interactive again", (await page.$eval("[data-sim-frame]", (e) => getComputedStyle(e).pointerEvents)) === "auto")
      // the toolbar must stay usable even when a card is panned underneath it
      const tb = await page.evaluate(() => { const b = document.querySelector(".App-toolbar button, .Island button"); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
      const cb = await page.$eval("[data-sim-card]", (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width } })
      await dragTo(page, [cb.l + cb.w * 0.3, cb.t + 14], [cb.l + cb.w * 0.3 + (tb.x - 120 - cb.l), cb.t + 14 + (tb.y - 100 - cb.t)]); await sleep(400)
      const covered = await page.evaluate(({ x, y }) => { const c = document.querySelector("[data-sim-card]").getBoundingClientRect(); return c.left < x && c.right > x && c.top < y && c.bottom > y }, tb)
      const top = await page.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return { tag: e?.tagName, inToolbar: !!e?.closest(".Island, .App-toolbar, .App-menu, .layer-ui__wrapper"), inFrame: e?.tagName === "IFRAME" } }, tb)
      R.check("toolbar: a card panned underneath the toolbar does NOT block it (and the card really was under it)", covered && top.inToolbar && !top.inFrame, JSON.stringify({ covered, ...top }))
      await ctx.close()
    }
  } catch (e) { R.check("test run completed without an unexpected exception", false, e.stack.split("\n").slice(0, 4).join(" | ")) }
  await browser.close(); srv.close()
  process.exit(R.done())
})()
