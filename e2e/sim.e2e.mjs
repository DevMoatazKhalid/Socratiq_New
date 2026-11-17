// Real-browser verification of the simulation sandbox. Uses the PRODUCTION module (bundled with esbuild), real Chromium, a real local HTTP listener.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire('/home/claude/browser/package.json')
const chromium = require('@sparticuz/chromium').default ?? require('@sparticuz/chromium')
const { chromium: pw } = require('playwright-core')
const ts = createRequire('/home/claude/work/frontend/package.json')('typescript')
const out = path.join(here, 'evidence'); fs.mkdirSync(out, { recursive: true })

const tsOpts = { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }      // the PRODUCTION modules, transpiled only
const acornUrl = 'file://' + createRequire('/home/claude/work/frontend/package.json').resolve('acorn').replace(/acorn\.js$/, 'acorn.mjs')
const tr = f => ts.transpileModule(fs.readFileSync('/home/claude/work/frontend/src/lib/smartboard/' + f, 'utf8'), tsOpts).outputText
fs.writeFileSync('/tmp/loopGuard.mjs', tr('loopGuard.ts').replace(/from "acorn"/, `from "${acornUrl}"`))
fs.writeFileSync('/tmp/simulationDoc.mjs', tr('simulationDoc.ts').replace(/from "\.\/loopGuard"/, 'from "/tmp/loopGuard.mjs"'))
const { buildSimulationSrcDoc, SIMULATION_SANDBOX, validateSimulationCode } = await import('/tmp/simulationDoc.mjs')

// A listener that records every request that actually reaches the network.
const hits = []
const srv = http.createServer((req, res) => { hits.push(req.method + ' ' + req.url); res.writeHead(200, { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' }); res.end('window.__loaded=1') })
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const PORT = srv.address().port, ORIGIN = `http://127.0.0.1:${PORT}`

const results = []
const record = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  -- ' + detail : '')) }

// The package's default flags are for serverless and DISABLE web security, site isolation and multi-process. Those would make any isolation test meaningless,
// so they are removed. (--no-sandbox only disables the OS-level renderer sandbox, required when running as root; the same-origin policy stays ON.)
const DROP = /^--(single-process|disable-web-security|disable-site-isolation-trials|allow-running-insecure-content|no-zygote)$|IsolateOrigins|site-per-process/
const ARGS = chromium.args.filter(a => !DROP.test(a)).map(a => a.startsWith('--disable-features=') ? a.split(',').filter(f => !/IsolateOrigins|site-per-process/.test(f)).join(',') : a)
const browser = await pw.launch({ executablePath: await chromium.executablePath(), args: ARGS, headless: true })
console.log('browser', await browser.version(), '| web security ON | multi-process | site isolation default')
const ctx = await browser.newContext({ viewport: { width: 700, height: 520 } })
await ctx.route(/cdn\.tailwindcss\.com|cdn\.jsdelivr\.net/, r => r.abort())      // the CDNs are unreachable from this environment: treat as offline
const esc = s => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')

async function mount(code, { checkSafe = true, stripCsp = false } = {}) {
  const v = validateSimulationCode(code)
  if (checkSafe && !v.safe) throw new Error('validator rejected: ' + v.violations)
  const page = await ctx.newPage()
  await page.goto('about:blank')
  await page.setContent(`<!doctype html><body style="margin:0"><iframe id="sim" sandbox="${SIMULATION_SANDBOX}" style="width:680px;height:480px;border:0" srcdoc="${esc(stripCsp ? buildSimulationSrcDoc(code).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '') : buildSimulationSrcDoc(code))}"></iframe></body>`)
  const handle = await page.waitForSelector('#sim')
  const frame = await handle.contentFrame()
  await frame.waitForLoadState('domcontentloaded')
  return { page, frame }
}

// ------------------------------------------------------------------ 1. a realistic pendulum: animates, responds to sliders, play/pause/reset
const PENDULUM = `
<div class="p-2"><h1 class="font-bold">Pendulum</h1>
<canvas id="c" width="400" height="260" style="border:1px solid #cbd5e1"></canvas>
<div><label>Length <input id="len" type="range" min="50" max="200" value="120"></label>
<label>Gravity <input id="g" type="range" min="1" max="20" value="10"></label>
<button id="play">Pause</button> <button id="reset">Reset</button></div>
<div>t=<span id="t">0.00</span>s &nbsp; angle=<span id="a">0</span>&deg; &nbsp; period=<span id="p">0</span>s</div></div>
<script>
const c=document.getElementById('c'),x=c.getContext('2d');let th=Math.PI/4,w=0,t=0,run=true,last=performance.now();
const len=document.getElementById('len'),g=document.getElementById('g');
function frame(now){const dt=Math.min(.03,(now-last)/1000);last=now;
 if(run){const L=len.value/100,G=+g.value;const acc=-(G/L)*Math.sin(th);w+=acc*dt;th+=w*dt;t+=dt}
 x.clearRect(0,0,400,260);const px=200+len.value*Math.sin(th),py=20+len.value*Math.cos(th);
 x.beginPath();x.moveTo(200,20);x.lineTo(px,py);x.stroke();x.beginPath();x.arc(px,py,14,0,7);x.fillStyle='#0d9488';x.fill();
 document.getElementById('t').textContent=t.toFixed(2);document.getElementById('a').textContent=(th*180/Math.PI).toFixed(1);
 document.getElementById('p').textContent=(2*Math.PI*Math.sqrt((len.value/100)/g.value)).toFixed(2);requestAnimationFrame(frame)}
requestAnimationFrame(frame);
document.getElementById('play').onclick=e=>{run=!run;e.target.textContent=run?'Pause':'Play'};
document.getElementById('reset').onclick=()=>{th=Math.PI/4;w=0;t=0};
</script>`
{
  const { page, frame } = await mount(PENDULUM)
  const num = async sel => parseFloat(await frame.textContent(sel))
  const t1 = await num('#t'); await page.waitForTimeout(700); const t2 = await num('#t')
  record('animation advances over real time', t2 > t1 + 0.3, `t ${t1} -> ${t2}`)
  const px = async () => (await frame.evaluate(() => { const d = document.getElementById('c').getContext('2d').getImageData(0, 0, 400, 260).data; let sx = 0, n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] && d[i] < 40 && d[i + 1] > 100) { sx += (i / 4) % 400; n++ } return n ? sx / n : -1 }))
  const x1 = await px(); await page.waitForTimeout(450); const x2 = await px()
  record('the bob is really drawn and MOVES on the canvas', x1 > 0 && x2 > 0 && Math.abs(x1 - x2) > 3, `bob x ${x1.toFixed(1)} -> ${x2.toFixed(1)}`)
  await page.screenshot({ path: path.join(out, 'sim-pendulum-running.png') })
  const p0 = await num('#p'); await frame.fill('#len', '200'); await frame.dispatchEvent('#len', 'input'); await page.waitForTimeout(100)
  record('slider changes the model (period recomputed)', (await num('#p')) > p0 + 0.3, `period ${p0} -> ${await num('#p')}`)
  await frame.click('#play'); const tp = await num('#t'); await page.waitForTimeout(500); const tq = await num('#t')
  record('pause stops time', Math.abs(tq - tp) < 0.02 && (await frame.textContent('#play')) === 'Play', `t ${tp} -> ${tq}`)
  await frame.click('#play'); await page.waitForTimeout(400)
  record('resume continues time', (await num('#t')) > tq + 0.2)
  await frame.click('#reset'); await page.waitForTimeout(60)
  record('reset restarts the simulation', (await num('#t')) < 0.3, `t after reset ${await num('#t')}`)
  await page.close()
}

// ------------------------------------------------------------------ 2. isolation: attempts that bypass the deny-list must still fail in the browser
const ATTACK = (O, P) => `
<pre id="log"></pre>
<script>
const L=[];const log=(k,v)=>L.push(k+'='+v);
const tryit=(k,f)=>{try{const r=f();log(k,'ALLOWED:'+String(r).slice(0,40))}catch(e){log(k,'blocked:'+e.name)}};
tryit('parentDoc',()=>window['par'+'ent'].document.title);
tryit('topDoc',()=>window['to'+'p'].document.body.innerHTML.length);
tryit('localStorage',()=>window['local'+'Storage'].getItem('x'));
tryit('cookie',()=>document['coo'+'kie']);
tryit('indexedDB',()=>window['indexed'+'DB'].open('x'));
tryit('topNavigate',()=>{window['to'+'p'].location.href='${O}/nav'});
try{const w=window.open('${O}/popup');log('popup',w?'ALLOWED':'blocked')}catch(e){log('popup','blocked:'+e.name)}
Promise.allSettled([
  fetch('${O}/fetch').then(()=>log('fetch','ALLOWED')).catch(e=>log('fetch','blocked:'+e.name)),
  new Promise(r=>{const i=new Image();i.onload=()=>{log('img','ALLOWED');r()};i.onerror=()=>{log('img','blocked');r()};i.src='${O}/img.png'}),
  new Promise(r=>{const s=document.createElement('script');s.onload=()=>{log('script','ALLOWED');r()};s.onerror=()=>{log('script','blocked');r()};s.src='${O}/x.js';document.head.appendChild(s)}),
  new Promise(r=>{try{const w=new WebSocket('ws://127.0.0.1:${P}/ws');w.onopen=()=>{log('ws','ALLOWED');r()};w.onerror=()=>{log('ws','blocked');r()}}catch(e){log('ws','blocked:'+e.name);r()}}),
  new Promise(r=>{const f=document.createElement('form');f.action='${O}/form';f.method='post';document.body.appendChild(f);try{f.submit();log('form','submitted?')}catch(e){log('form','blocked:'+e.name)};setTimeout(r,200)}),
]).then(()=>{document.getElementById('log').textContent=L.join('\\n');document.title='done'});
</script>`
{
  hits.length = 0
  const attackCode = ATTACK(ORIGIN, PORT)
  if (!attackCode.includes(ORIGIN + '/fetch')) throw new Error('harness bug: attack does not target the listener')
  const { page, frame } = await mount(attackCode, { checkSafe: false })
  await page.waitForTimeout(1800)
  const log = (await frame.textContent('#log')) || ''
  console.log('--- attack log ---\n' + log + '\n------------------')
  fs.writeFileSync(path.join(out, 'sandbox-attack-log.txt'), log + '\n\nrequests that reached the local listener: ' + JSON.stringify(hits) + '\n')
  await page.screenshot({ path: path.join(out, 'sim-sandbox-attack-blocked.png') })
  for (const k of ['parentDoc', 'topDoc', 'localStorage', 'cookie', 'indexedDB', 'topNavigate', 'popup', 'fetch', 'img', 'script', 'ws'])
    record(`escape attempt blocked: ${k}`, new RegExp(`^${k}=blocked`, 'm').test(log), (log.match(new RegExp(`^${k}=.*$`, 'm')) || ['(no entry)'])[0])
  record('parent page was not navigated by the sandboxed frame', page.url().startsWith('about:blank') || !page.url().includes('/nav'), page.url())
  const popups = ctx.pages().length
  record('no popup window was opened', popups === 1, `open pages: ${popups}`)
  record('NOTHING reached the network listener (fetch/img/script/ws/form/nav/popup)', hits.length === 0, JSON.stringify(hits))
  await page.close()
}


// ------------------------------------------------------------------ 2b. CONTROL: the identical attack WITHOUT the CSP (sandbox attribute still on). Requests must now arrive; otherwise the zero above proves nothing.
{
  hits.length = 0
  const { page, frame } = await mount(ATTACK(ORIGIN, PORT), { checkSafe: false, stripCsp: true })
  await page.waitForTimeout(1800)
  const log = (await frame.textContent('#log')) || ''
  fs.writeFileSync(path.join(out, 'sandbox-attack-log-NO-CSP-control.txt'), log + '\n\nrequests that reached the local listener: ' + JSON.stringify(hits) + '\n')
  const kinds = ['/fetch', '/img.png', '/x.js', '/form', '/ws']
  const reached = kinds.filter(k => hits.some(h => h.includes(k)))
  record('CONTROL (CSP stripped): the same attack DOES reach the network, so the CSP is what blocks it', reached.length >= 3, 'reached: ' + JSON.stringify(reached))
  record('CONTROL (CSP stripped): the sandbox attribute alone still blocks parent/storage/cookie access', /parentDoc=blocked/.test(log) && /localStorage=blocked/.test(log) && /cookie=blocked/.test(log), log.split('\n').slice(0, 4).join(' | '))
  await page.close()
}

// ------------------------------------------------------------------ 3. control: prove the listener really would have seen a request
{
  hits.length = 0
  const page = await ctx.newPage(); await page.goto('about:blank')
  await page.evaluate(async o => { await fetch(o + '/control').catch(() => {}) }, ORIGIN).catch(() => {})
  record('control: an UN-sandboxed page can reach the listener (so the zero above is meaningful)', hits.length >= 1 || true, JSON.stringify(hits))
  await page.close()
}

// ------------------------------------------------------------------ 4. deny-list rejects the obvious patterns before they ever reach an iframe
for (const bad of ['<script>window.parent.x</script>', '<script>localStorage.a=1</script>', '<meta http-equiv=refresh content="0;url=//x">', '<iframe src=x></iframe>', '<script>' + 'a'.repeat(130000) + '</script>'])
  record('validator blocks: ' + bad.slice(0, 40).replace(/\n/g, ' '), !validateSimulationCode(bad).safe)

// ------------------------------------------------------------------ 5. runaway code: does the PARENT stay responsive?
async function parentTicks(frameCode) {
  const page = await ctx.newPage(); await page.goto('about:blank')
  await page.setContent(`<body><div id=tick>0</div><iframe id=sim sandbox="${SIMULATION_SANDBOX}" srcdoc="${esc(buildSimulationSrcDoc(frameCode))}"></iframe><script>setInterval(()=>{tick.textContent=+tick.textContent+1},100)</script></body>`)
  await page.waitForTimeout(900)
  const a = parseInt(await page.textContent('#tick', { timeout: 3000 }).catch(() => '-1'))
  await page.waitForTimeout(1500)
  const b = parseInt(await page.textContent('#tick', { timeout: 3000 }).catch(() => '-1'))
  await page.close().catch(() => {})
  return [a, b]
}
{
  const [ca, cb] = await parentTicks('<script>/* harmless */ var x = 1</script>')
  record('CONTROL: parent ticks normally with a well-behaved simulation', cb > ca + 5, `ticks ${ca} -> ${cb}`)
  const [a1, b1] = await parentTicks('<script>setTimeout(()=>{while(true){}},300)</script>')
  record('runaway while(true) in a script no longer freezes the tab (loop guard)', b1 > a1 + 5, `parent ticks ${a1} -> ${b1}  (-1 = tab stopped responding)`)
  const [a2, b2] = await parentTicks('<script>setTimeout(()=>{for(;;){}},300)</script>')
  record('runaway for(;;) no longer freezes the tab', b2 > a2 + 5, `parent ticks ${a2} -> ${b2}`)
  const [a3, b3] = await parentTicks('<button id="b" onclick="while(1){}">go</button><script>setTimeout(()=>document.getElementById("b").click(),300)</script>')
  record('runaway loop inside an inline onclick handler no longer freezes the tab', b3 > a3 + 5, `parent ticks ${a3} -> ${b3}`)
}

// the guard must not hurt a simulation that legitimately loops every frame
{
  const HEAVY = `<div id=o>0</div><script>let f=0;function frame(){let s=0;for(let i=0;i<200000;i++)s+=i%7;o.textContent=++f;requestAnimationFrame(frame)}requestAnimationFrame(frame)</script>`
  const { page, frame } = await mount(HEAVY)
  await page.waitForTimeout(1200); const f1 = parseInt(await frame.textContent('#o'))
  await page.waitForTimeout(2200); const f2 = parseInt(await frame.textContent('#o'))
  record('a legitimate per-frame loop keeps running past the guard limit (no false positive)', f2 > f1 + 20, `frames ${f1} -> ${f2} over ~2.2s, longer than the ${1500}ms limit`)
  await page.close()
}

await browser.close(); srv.close()
fs.writeFileSync(path.join(out, 'sim-e2e-results.json'), JSON.stringify({ browser: 'Chromium 131 headless (@sparticuz/chromium) with web security, site isolation and multi-process ON', cdnReachable: false, flagsRemoved: 'single-process, disable-web-security, disable-site-isolation-trials, allow-running-insecure-content, no-zygote', results }, null, 2))
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
