/**
 * Real-browser tests of the simulation runtime: the REAL buildSimulationSrcDoc output, in a REAL sandboxed iframe, in Chromium.
 * What is measured is the simulation's own state changing over wall-clock time, not that an element exists.
 */
const path = require("path")
const { FE, bundle, launch, recorder, sleep } = require("./browser.cjs")
const lib = require(bundle(path.join(FE, "src/lib/smartboard/simulationDoc.ts"), "simdoc.cjs"))
const rt = require(bundle(path.join(FE, "src/lib/smartboard/simulationRuntime.ts"), "simrt.cjs"))
const { buildSimulationSrcDoc, SIMULATION_SANDBOX } = lib
const { controlMessage } = rt

const RAF_SIM = `<div class="p-2"><canvas id="c" width="300" height="100"></canvas><div>t=<span id="t">0</span></div></div><script>
let t=0,last=null;const g=document.getElementById('c').getContext('2d');
window.forge=function(){ window.postMessage({__sq:1,type:'control',paused:true},'*') };
function f(ts){ if(last!==null) t+=(ts-last)/1000; last=ts; g.clearRect(0,0,300,100); g.fillRect(10+(t*60)%260,40,20,20);
 document.getElementById('t').textContent=t.toFixed(3); requestAnimationFrame(f)} requestAnimationFrame(f);
window.calib=function(){const s=performance.now();let x=0;for(let i=0;i<2000000;i++)x+=Math.sqrt(i);return performance.now()-s};
window.burn=function(n){let x=0;for(let i=0;i<n;i++)x+=Math.sqrt(i);return x};
</script>`
const INTERVAL_SIM = `<span id="n">0</span><script>let n=0;setInterval(()=>{n++;document.getElementById('n').textContent=n},20)</script>`
const THROWS = `<div id="a">x</div><script>setTimeout(()=>{ nope.missing() },50); requestAnimationFrame(function f(){requestAnimationFrame(f)})</script>`
const CSP_VIOLATION = `<div>x</div><script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script><script>requestAnimationFrame(function f(){requestAnimationFrame(f)})</script>`
const FORGER = `<div id="t">0</div><script>
let t=0,last=null;function f(ts){ if(last!==null)t+=(ts-last)/1000; last=ts; document.getElementById('t').textContent=t.toFixed(3); requestAnimationFrame(f)} requestAnimationFrame(f);
window.forge=function(){ window.postMessage({__sq:1,type:'control',paused:true},'*') };
</script>`
const ESCAPES = `<div>e</div><script>
window.results={};
for (const [k,fn] of Object.entries({
  parentDoc:()=>window['par'+'ent'].document.title, cookie:()=>document['coo'+'kie'], ls:()=>window['local'+'Storage'].x,
  fetch:()=>fetch('https://example.com'), nav:()=>{window['to'+'p'].location='https://example.com'}
})) { try{ const r=fn(); if(r&&r.then){ r.then(()=>window.results[k]='ESCAPED',e=>window.results[k]='blocked:'+e.name) } else window.results[k]='ESCAPED' }catch(e){ window.results[k]='blocked:'+e.name } }
requestAnimationFrame(function f(){requestAnimationFrame(f)})
</script>`

async function open(browser, code, { tailwind = "fast" } = {}) {
  const page = await browser.newPage()
  const msgs = []
  await page.exposeFunction("__push", (m) => msgs.push(m))
  await page.route("**/*", async (route) => {
    const u = route.request().url()
    if (u.startsWith("https://cdn.tailwindcss.com")) { if (tailwind === "stall") await sleep(8000); return route.fulfill({ status: 200, contentType: "text/javascript", body: "/*tw*/" }) }
    if (u.startsWith("https://cdn.jsdelivr.net")) return route.fulfill({ status: 200, contentType: "text/javascript", body: "/*mj*/" })
    if (u.startsWith("http")) return route.abort()
    return route.continue()
  })
  const srcdoc = buildSimulationSrcDoc(code).replace(/&/g, "&amp;").replace(/"/g, "&quot;")
  await page.setContent(`<body><script>window.addEventListener('message',e=>{ if(e.data&&e.data.__sq) window.__push({type:e.data.type,message:e.data.message}) })</script>
    <iframe id="f" sandbox="${SIMULATION_SANDBOX}" style="width:420px;height:320px" srcdoc="${srcdoc}"></iframe></body>`, { waitUntil: "commit" })
  const frame = () => page.frames().find((f) => f !== page.mainFrame())
  const send = (c) => page.evaluate((m) => document.getElementById("f").contentWindow.postMessage(m, "*"), controlMessage(c))
  const q = (fn, arg) => frame().evaluate(fn, arg)
  const sq = () => q(() => ({ frames: window.__sq.frames, clock: window.__sq.clock, paused: window.__sq.paused, speed: window.__sq.speed, pending: window.__sq.pending }))
  return { page, msgs, frame, send, q, sq }
}
const ticking = async (s, ms = 400) => { const a = await s.sq(); await sleep(ms); const b = await s.sq(); return { dClock: b.clock - a.clock, dFrames: b.frames - a.frames, a, b } }

;(async () => {
  const R = recorder("Simulation runtime (real Chromium)")
  const browser = await launch()
  R.check("browser launched", true, browser.version())
  try {
    // 1. ROOT CAUSE B: a slow Tailwind CDN used to delay the whole simulation by the full stall (measured 8153 ms before the fix).
    { const t0 = Date.now(); const s = await open(browser, RAF_SIM, { tailwind: "stall" }); let ms = null
      for (let i = 0; i < 100; i++) { await sleep(50); const f = s.frame(); if (!f) continue; const v = await f.evaluate(() => window.__sq && window.__sq.frames).catch(() => 0); if (v > 3) { ms = Date.now() - t0; break } }
      R.check("starts animating while the Tailwind CDN is stalled for 8 s (was ~8153 ms before the fix)", ms !== null && ms < 2000, `started after ${ms} ms`); await s.page.close() }

    // 2. animation really advances, canvas really painted
    const s = await open(browser, RAF_SIM)
    await sleep(500)
    const m1 = await ticking(s)
    R.check("animation clock advances in real time", m1.dClock > 300 && m1.dFrames > 5, `dClock=${m1.dClock.toFixed(0)}ms dFrames=${m1.dFrames}`)
    const px = await s.q(() => { const d = document.getElementById("c").getContext("2d").getImageData(0, 0, 300, 100).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n })
    R.check("canvas actually has painted pixels", px > 100, `${px} px`)
    const sim = await s.q(() => parseFloat(document.getElementById("t").textContent))
    R.check("simulation's own DOM state advanced (not only the host clock)", sim > 0.3, `t=${sim}`)
    R.check("'loaded' and 'ready' lifecycle messages reached the host", s.msgs.some((m) => m.type === "loaded") && s.msgs.some((m) => m.type === "ready"), JSON.stringify(s.msgs.map((m) => m.type)))

    // 3. pause really stops time, frames and the simulation's own state
    const fpsBefore = m1.dFrames / 0.4
    await s.send({ paused: true }); await sleep(80)
    const simP1 = await s.q(() => document.getElementById("t").textContent)
    const p = await ticking(s, 600)
    const simP2 = await s.q(() => document.getElementById("t").textContent)
    R.check("pause: clock and frame count stand still", p.dClock === 0 && p.dFrames === 0, `dClock=${p.dClock} dFrames=${p.dFrames}`)
    R.check("pause: the simulation's own state is frozen", simP1 === simP2, `${simP1} -> ${simP2}`)
    { const a2 = await s.sq(); await sleep(300); const b2 = await s.sq(); R.check("pause: still idle 300 ms later (one callback held, none running)", b2.frames === a2.frames && b2.pending <= 1, `frames ${a2.frames}->${b2.frames}, held=${b2.pending}`) }

    // 4. resume continues, exactly one loop
    await s.send({ paused: false })
    const r = await ticking(s, 500)
    const simAfter = await s.q(() => parseFloat(document.getElementById("t").textContent))
    R.check("resume: time and frames advance again", r.dClock > 300 && r.dFrames > 5, `dClock=${r.dClock.toFixed(0)} dFrames=${r.dFrames}`)
    R.check("resume: no time jump (paused interval is excluded)", simAfter - parseFloat(simP2) < 1.2, `sim t advanced ${(simAfter - parseFloat(simP2)).toFixed(2)}s across 0.6s paused + 0.5s running`)
    const fpsAfter = r.dFrames / 0.5
    R.check("resume: loop NOT duplicated (frame rate unchanged, one pending callback)", fpsAfter < fpsBefore * 1.4 && (await s.sq()).pending <= 1, `fps ${fpsBefore.toFixed(0)} -> ${fpsAfter.toFixed(0)}, pending=${(await s.sq()).pending}`)
    for (let i = 0; i < 5; i++) { await s.send({ paused: true }); await s.send({ paused: false }) }
    const burst = await ticking(s, 500)
    R.check("10 rapid pause/resume toggles do not stack loops", burst.dFrames / 0.5 < fpsBefore * 1.4 && (await s.sq()).pending <= 1, `fps ${(burst.dFrames / 0.5).toFixed(0)}`)

    // 5. speed
    await s.send({ speed: 2 }); await sleep(100)
    const sp = await ticking(s, 600)
    R.check("speed 2x: virtual time runs ~2x faster", sp.dClock > 900 && sp.dClock < 1500, `${sp.dClock.toFixed(0)}ms virtual in ~600ms real`)
    await s.send({ speed: 0.5 }); await sleep(100)
    const sl = await ticking(s, 800)
    R.check("speed 0.5x: virtual time runs ~half as fast", sl.dClock > 300 && sl.dClock < 520, `${sl.dClock.toFixed(0)}ms virtual in ~800ms real`)
    await s.send({ speed: 99 }); await sleep(50)
    R.check("out-of-range speed is rejected", (await s.sq()).speed === 0.5, `speed=${(await s.sq()).speed}`)

    // 6. loop guard must use REAL time (regression: virtual time at 4x would have killed a legitimate 0.9 s computation)
    await s.send({ speed: 1 }); await sleep(100)
    await s.q(() => { window.burn(3000000); window.burn(3000000) })                     // warm the JIT so calibration matches the real run
    const msPer3M = await s.q(() => { const t = performance.now(); window.burn(3000000); return performance.now() - t }); const n = Math.round(3000000 * (900 / msPer3M))
    await s.send({ speed: 4 }); await sleep(100)
    const t0 = Date.now(); let threw = null
    try { await s.q((n) => window.burn(n), n) } catch (e) { threw = e.message.split("\n")[0] }
    const realMs = Date.now() - t0
    R.check("loop guard: a ~0.9 s legitimate computation at speed 4x is NOT killed (valid only if it ran >450 ms real)", realMs > 450 && !threw, `took ${realMs} ms real${threw ? ", threw: " + threw : ""}`)
    R.check("loop guard: no error was reported for it", !s.msgs.some((m) => m.type === "error"), JSON.stringify(s.msgs.filter((m) => m.type === "error")))
    await s.send({ speed: 1 })

    // 7. hidden (off-screen) stops it too, and resumes
    await s.send({ hidden: true }); await sleep(80)
    const h = await ticking(s, 400)
    R.check("hidden (off-screen): frames stop", h.dFrames === 0 && h.dClock === 0, `dFrames=${h.dFrames}`)
    await s.send({ hidden: false }); const h2 = await ticking(s, 400)
    R.check("hidden -> visible: animation resumes", h2.dFrames > 3, `dFrames=${h2.dFrames}`)

    // 8. forged control from generated code is ignored (source is the frame itself, not the parent)
    await s.q(() => window.forge()); await sleep(100)
    const f1 = await ticking(s, 400)
    R.check("generated code cannot pause itself by forging a host control message", f1.dFrames > 3 && !(await s.sq()).paused, `dFrames=${f1.dFrames}`)
    await s.page.close()

    // 9. timers: setInterval-driven simulation pauses/resumes
    const iv = await open(browser, INTERVAL_SIM); await sleep(300)
    const n1 = await iv.q(() => +document.getElementById("n").textContent)
    await iv.send({ paused: true }); await sleep(100)
    const a = await iv.q(() => +document.getElementById("n").textContent); await sleep(500)
    const b = await iv.q(() => +document.getElementById("n").textContent)
    R.check("setInterval simulation: ticks, then pause stops it", n1 > 5 && a === b, `ticks ${n1}; paused ${a} -> ${b}`)
    await iv.send({ paused: false }); await sleep(400)
    const c = await iv.q(() => +document.getElementById("n").textContent)
    R.check("setInterval simulation: resume continues from where it stopped", c > b + 5 && c < b + 60, `${b} -> ${c}`); await iv.page.close()

    // 10. failures are reported, not silent
    const th = await open(browser, THROWS); await sleep(500)
    R.check("a runtime exception is reported to the host", th.msgs.some((m) => m.type === "error" && /nope/.test(m.message)), JSON.stringify(th.msgs.filter((m) => m.type === "error")))
    R.check("the animation loop survives an exception in another callback", (await th.sq()).frames > 5, `frames=${(await th.sq()).frames}`); await th.page.close()
    const cv = await open(browser, CSP_VIOLATION); await sleep(600)
    R.check("a CSP-blocked library is reported to the host (was silent)", cv.msgs.some((m) => m.type === "violation" || (m.type === "error" && /three/.test(m.message))), JSON.stringify(cv.msgs.filter((m) => m.type !== "loaded" && m.type !== "ready"))); await cv.page.close()

    // 11. sandbox still holds
    const es = await open(browser, ESCAPES); await sleep(700)
    const res = await es.q(() => window.results)
    const bad = Object.entries(res).filter(([, v]) => !String(v).startsWith("blocked"))
    R.check("sandbox: parent DOM, cookies, localStorage, fetch and top navigation are all blocked", Object.keys(res).length === 5 && bad.length === 0, JSON.stringify(res)); await es.page.close()
  } catch (e) { R.check("test run completed without an unexpected exception", false, e.stack.split("\n").slice(0, 3).join(" | ")) }
  await browser.close()
  process.exit(R.done())
})()
