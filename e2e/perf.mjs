import { launch, signedInContext, WEB, API, AUTH, sleep, record, results, fs } from './lib.mjs'
import { execSync } from 'node:child_process'
const DB = fs.readFileSync('/tmp/e2e_db_url', 'utf8').trim()
const sql = q => execSync(`psql "${DB}" -At -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
sql("update attempts set whiteboard='{}'::jsonb where attempt_id='T1'")
let baselineMs = 0
{
  const bb = await launch(); const cc = await signedInContext(bb, 'S1'); const pp = await cc.newPage()
  await pp.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(2500); await pp.locator('button:has-text("Whiteboard")').first().click(); await sleep(6500)
  await pp.mouse.click(1100, 650); await pp.keyboard.press('p'); const s0 = Date.now(); await pp.mouse.move(700, 400); await pp.mouse.down()
  for (let i = 1; i <= 30; i++) await pp.mouse.move(700 + i * 8, 400 + Math.sin(i / 3) * 40)
  await pp.mouse.up(); baselineMs = Date.now() - s0; await bb.close()
  sql("update attempts set whiteboard='{}'::jsonb where attempt_id='T1'")
}
const el = (i, type, x, y, extra = {}) => ({ id: 'p' + i, type, x, y, width: 90, height: 50, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: i + 1, version: 1, versionNonce: i + 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, index: 'a' + String(i).padStart(5, '0'), ...extra })
const els = []; for (let i = 0; i < 1500; i++) els.push(el(i, i % 3 ? 'rectangle' : 'ellipse', (i % 50) * 110, Math.floor(i / 50) * 70))
for (let i = 0; i < 300; i++) els.push(el(2000 + i, 'text', (i % 30) * 170, 2300 + Math.floor(i / 30) * 40, { text: 'note ' + i, originalText: 'note ' + i, fontSize: 16, fontFamily: 1, textAlign: 'left', verticalAlign: 'top', containerId: null, lineHeight: 1.25, autoResize: true, width: 80, height: 20 }))
const body = JSON.stringify({ scene: { type: 'excalidraw', version: 2, elements: els, appState: {}, files: {} }, base_rev: 0 })
const t0 = Date.now(); const r = await fetch(API + '/student/assignments/A1/whiteboard', { method: 'PUT', headers: { 'content-type': 'application/json', Authorization: 'Bearer tok:' + AUTH.S1 }, body }); const putMs = Date.now() - t0
record('server accepts a large board (1,800 elements)', r.status === 200, `HTTP ${r.status}, request ${(body.length / 1024).toFixed(0)} KB, ${putMs} ms`)
const g0 = Date.now(); const got = await (await fetch(API + '/student/assignments/A1/whiteboard', { headers: { Authorization: 'Bearer tok:' + AUTH.S1 } })).json(); const getMs = Date.now() - g0
record('server returns it quickly', getMs < 1500 && got.scene.elements.length === 1800, `${getMs} ms, ${got.scene.elements.length} elements`)

const b = await launch(); const ctx = await signedInContext(b, 'S1'); const page = await ctx.newPage()
const errs = []; page.on('pageerror', e => errs.push(e.message))
const heap = () => page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1)
const heaps = []
for (let cycle = 1; cycle <= 4; cycle++) {
  const t = Date.now()
  await page.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(2500)
  await page.locator('button:has-text("Whiteboard")').first().click()
  await page.waitForFunction(() => { const cs = [...document.querySelectorAll('canvas')]; return cs.some(c => { if (!c.width) return false; const d = c.getContext('2d').getImageData(0, 0, Math.min(c.width, 400), Math.min(c.height, 300)).data; for (let i = 3; i < d.length; i += 400) if (d[i] > 0) return true; return false }) }, null, { timeout: 60000 }).catch(() => {})
  const paintMs = Date.now() - t - 2500
  await sleep(1500); const h = await heap(); heaps.push(h)
  console.log(`cycle ${cycle}: content painted after ~${paintMs} ms, heap ${h} MB`)
  if (cycle === 1) {
    await page.mouse.click(1100, 650); await page.keyboard.press('p'); const s0 = Date.now(); await page.mouse.move(700, 400); await page.mouse.down(); for (let i = 1; i <= 30; i++) await page.mouse.move(700 + i * 8, 400 + Math.sin(i / 3) * 40); await page.mouse.up()
    const strokeMs = Date.now() - s0
    record('drawing on a 1,800-element board is not disproportionately slower than on an empty board (same 30-move stroke)', strokeMs < baselineMs * 2 + 500, `large ${strokeMs} ms vs empty ${baselineMs} ms (+${Math.round((strokeMs / baselineMs - 1) * 100)}%); absolute numbers are inflated by software-rendered headless Chromium`)
    const t1 = Date.now(); await page.waitForFunction(() => /Saved \d/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {}); const saveMs = Date.now() - t1
    record('autosave of the large board completes and is confirmed', /Saved \d/.test(await page.innerText('body')), `~${saveMs} ms after the stroke`)
    await sleep(1500)
    record('the new stroke is in the database next to the 1,800 existing elements', parseInt(sql("select jsonb_array_length(whiteboard->'scene'->'elements') from attempts where attempt_id='T1'")) === 1801)
    record('only a bounded number of saves were sent for one stroke (no save storm)', parseInt(sql("select coalesce(whiteboard->>'scene_rev','0') from attempts where attempt_id='T1'")) <= 4, 'scene_rev=' + sql("select whiteboard->>'scene_rev' from attempts where attempt_id='T1'"))
  }
  record(`reload cycle ${cycle}: the large board renders`, paintMs < 60000, paintMs + ' ms')
}
const valid = heaps.filter(h => h > 0)
record('JS heap does not grow without bound across 4 reload cycles', valid.length === 0 || valid[valid.length - 1] < valid[0] * 2.2 + 30, 'heap MB per cycle: ' + heaps.join(' -> '))
record('no uncaught page errors on the large board', errs.length === 0, errs.slice(0, 2).join(' | '))
await b.close()
fs.writeFileSync('evidence/perf-results.json', JSON.stringify(results, null, 2))
console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`); process.exit(results.some(r => !r.ok) ? 1 : 0)
