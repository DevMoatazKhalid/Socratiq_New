import { launch, signedInContext, session, WEB, API, AUTH, sleep, record, results, fs } from './lib.mjs'
import { execSync } from 'node:child_process'
import http from 'node:http'
const DB = fs.readFileSync('/tmp/e2e_db_url', 'utf8').trim()
const sql = q => execSync(`psql "${DB}" -At -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const reset = () => sql("update attempts set whiteboard='{}'::jsonb where attempt_id='T1'")
const live = () => (JSON.parse(sql("select coalesce(whiteboard->'scene'->'elements','[]'::jsonb) from attempts where attempt_id='T1'") || '[]')).filter(e => !e.isDeleted)
const setProvider = mode => new Promise(r => { const q = http.request({ host: '127.0.0.1', port: 9911, path: '/' + mode, method: 'PUT' }, res => { res.resume(); res.on('end', r) }); q.end() })
const b = await launch()
const openBoard = async (ctx, who = 'S1') => { const p = await ctx.newPage(); await p.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(3500); await p.locator('button:has-text("Whiteboard")').first().click(); await sleep(6000); return p }
const ask = async (p, mode, submit, text) => { await p.locator(`button:has-text("${mode}")`).first().click(); await p.getByLabel(/Ask the AI to draw or explain/).fill(text); await p.locator('button', { hasText: new RegExp('^' + submit + '$') }).last().click() }
const body = p => p.innerText('body')
const stroke = async (p, x, y) => { await p.mouse.click(1000, 600); await p.keyboard.press('p'); await p.mouse.move(x, y); await p.mouse.down(); for (let i = 1; i <= 8; i++) await p.mouse.move(x + i * 12, y + i * 5); await p.mouse.up() }

// ===================================================================== provider failures never look like success
reset(); await setProvider('ok')
{
  const ctx = await signedInContext(b, 'S1'); const p = await openBoard(ctx)
  const gen = []; p.on('response', r => { if (/generate-/.test(r.url())) gen.push(r.status()) })
  await setProvider('fail'); await ask(p, 'Image', 'Generate', 'a cat'); await sleep(5000)
  let t = await body(p)
  record('image provider failure: the user sees an error (not a success)', /couldn.t|could not|failed|try again|unable|error/i.test(t) && !/Added image/i.test(t), (t.match(/[^\n]*(couldn.t|could not|failed|try again|unable|error)[^\n]*/i) || [''])[0].slice(0, 120))
  record('image provider failure: the server answered with an error status, not 200', gen.length > 0 && gen.every(s => s >= 400), JSON.stringify(gen))
  await sleep(2500); record('image provider failure: nothing was inserted or saved', live().length === 0, 'elements=' + live().length)
  await setProvider('svg'); gen.length = 0; await ask(p, 'Image', 'Generate', 'a cat'); await sleep(5000); t = await body(p)
  record('malicious (SVG with script) provider payload is rejected', gen.every(s => s >= 400) && !/Added image/i.test(t), JSON.stringify(gen))
  await sleep(2500); record('malicious payload: nothing inserted or saved', live().length === 0)
  await setProvider('ok')
  // empty / whitespace prompt
  gen.length = 0; await p.locator('button:has-text("Diagram")').first().click(); await p.getByLabel(/Ask the AI to draw or explain/).fill('   ')
  const draw = p.getByRole('button', { name: /^Draw$/ }); const disabled = await draw.isDisabled().catch(() => false); await draw.click({ force: true, timeout: 2000 }).catch(() => {}); await sleep(1200)
  record('empty/whitespace prompt makes no request', gen.length === 0, `disabled=${disabled} requests=${gen.length}`)
  // rapid repeated clicks
  gen.length = 0; await p.getByLabel(/Ask the AI to draw or explain/).fill('login flow')
  for (let i = 0; i < 6; i++) await draw.click({ force: true, timeout: 800, noWaitAfter: true }).catch(() => {})
  await sleep(6000); await sleep(2500)
  const diagrams = live().filter(e => e.type === 'arrow').length
  record('rapid repeated clicks cause exactly one generation request', gen.length === 1, 'requests=' + gen.length)
  record('and exactly one diagram on the board (no duplicates)', diagrams === 3, 'arrows=' + diagrams)
  await ctx.close()
}

// ===================================================================== backend outage while editing -> honest status -> recovery
reset()
{
  const ctx = await signedInContext(b, 'S1'); const p = await openBoard(ctx)
  await p.route('**/api/v1/student/assignments/A1/whiteboard', r => r.request().method() === 'PUT' ? r.abort('connectionrefused') : r.continue())
  await stroke(p, 640, 300); await p.waitForFunction(() => /Not saved|Offline|Retry|error/i.test(document.body.innerText), null, { timeout: 25000 }).catch(() => {})
  let t = await body(p)
  record('backend unreachable: the UI says the work is NOT saved (never "Saved")', /Not saved|Offline|Retry now|couldn.t save|could not save/i.test(t) && !/Saved \d/.test(t), (t.match(/[^\n]*(Not saved|Offline|Retry now|save)[^\n]*/i) || [''])[0].slice(0, 100))
  record('and the database really has nothing yet', live().length === 0)
  await p.screenshot({ path: 'evidence/failure-backend-down.png' })
  await p.unroute('**/api/v1/student/assignments/A1/whiteboard')
  const retry = p.locator('button:has-text("Retry now")').first(); if (await retry.isVisible().catch(() => false)) await retry.click()
  await p.waitForFunction(() => /Saved \d/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {}); await sleep(1500)
  record('after the backend returns, the pending work is saved automatically/with Retry', live().some(e => e.type === 'freedraw'), 'elements=' + live().length)
  record('and the UI now says Saved', /Saved \d/.test(await body(p)))
  await ctx.close()
}

// ===================================================================== two tabs: a stale tab must not overwrite newer work
reset()
{
  const ctxA = await signedInContext(b, 'S1'), ctxB = await signedInContext(b, 'S1')
  const A = await openBoard(ctxA), B = await openBoard(ctxB)                    // both loaded the same (empty) revision
  await stroke(A, 640, 300); await A.waitForFunction(() => /Saved \d/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {}); await sleep(1500)
  const afterA = live().length
  await stroke(B, 700, 450); await B.waitForFunction(() => /changed in another window|Not saved/i.test(document.body.innerText), null, { timeout: 25000 }).catch(() => {})
  const tB = await body(B)
  record('tab B (stale) is told, in visible text, that the board changed elsewhere, offered Reload, and is NOT shown as saved', /changed in another window/i.test(tB) && /Reload/.test(tB) && !/Saved \d/.test(tB), (tB.match(/[^\n]*another window[^\n]*/i) || ['(no message)'])[0].slice(0, 110))
  record("tab A's work survived: tab B did not overwrite it", live().length === afterA && afterA >= 1, `A saved ${afterA}, now ${live().length}`)
  await B.screenshot({ path: 'evidence/failure-two-tab-conflict.png' })
  await ctxA.close(); await ctxB.close()
}

// ===================================================================== authentication & authorization
{
  const call = async (path, who, method = 'GET', payload) => { const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(who ? { Authorization: 'Bearer ' + who } : {}) }, body: payload ? JSON.stringify(payload) : undefined }); return r.status }
  const S1 = 'tok:' + AUTH.S1, S2 = 'tok:' + AUTH.S2, P1 = 'tok:' + AUTH.P1
  const scene = { type: 'excalidraw', version: 2, elements: [], appState: {}, files: {} }
  record('no token: board read is 401', (await call('/student/assignments/A1/whiteboard', null)) === 401)
  record('malformed/forged token: board read is 401', (await call('/student/assignments/A1/whiteboard', 'forged-garbage')) === 401)
  const s2r = await call('/student/assignments/A1/whiteboard', S2); record('a student of ANOTHER course cannot read this board', [403, 404].includes(s2r), 'status ' + s2r)
  const s2w = await call('/student/assignments/A1/whiteboard', S2, 'PUT', { scene }); record('a student of ANOTHER course cannot write this board', [403, 404].includes(s2w), 'status ' + s2w)
  const pw = await call('/student/assignments/A1/whiteboard', P1, 'PUT', { scene }); record('a teacher cannot write through the student endpoint', [401, 403, 404].includes(pw), 'status ' + pw)
  for (const ep of ['generate-image', 'generate-simulation', 'generate-vector', 'chat']) record(`unauthenticated ${ep} is 401 (no open proxy to the provider key)`, (await call('/smartboard/' + ep, null, 'POST', { prompt: 'x', messages: [{ role: 'user', text: 'hi' }] })) === 401)
  // browser: no session -> login; invalid token -> login
  const bare = await b.newContext({ viewport: { width: 1200, height: 800 } }); const p0 = await bare.newPage(); await p0.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(4000)
  record('no session in the browser: the board is not shown, the user is sent to sign in', /login|sign in/i.test(p0.url() + (await body(p0))) && (await p0.$('.excalidraw')) === null, p0.url())
  await bare.close()
  const bad = await signedInContext(b, 'S1'); await bad.addInitScript(([k, v]) => localStorage.setItem(k, v), ['sb-localhost-auth-token', session('S1', 'tok:expired-or-revoked')]); const pb = await bad.newPage()
  await pb.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(5000)
  record('an expired/revoked token never exposes the board (API 401 -> sign-in or error, no editable board)', (await pb.$('.excalidraw')) === null, pb.url())
  await bad.close()
}
await b.close()
fs.writeFileSync('evidence/journey3-results.json', JSON.stringify(results, null, 2))
console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`); process.exit(results.some(r => !r.ok) ? 1 : 0)
