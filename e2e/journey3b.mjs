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

// ===================================================================== leaving the page with unsaved work
reset()
{
  const ctx = await signedInContext(b, 'S1'); const p = await openBoard(ctx)
  const vetoes = () => p.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented })
  const badge = async () => ((await body(p)).match(/Unsaved changes|Saving…|Saved \d[^\n]*|Not saved|Save failed[^\n]*|Offline[^\n]*/) || ['(none)'])[0]
  await stroke(p, 640, 300)                                                       // still inside the 1.5 s debounce window
  const b1 = await badge(), v1 = await vetoes()
  record('with unsaved work the page vetoes leaving (the browser will ask the user)', v1 === true && /Unsaved|Saving/.test(b1), `badge="${b1}" vetoed=${v1}`)
  await p.waitForFunction(() => /Saved \d/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {}); await sleep(4000)   // let it settle
  const b2 = await badge(), v2 = await vetoes()
  record('once everything is saved the page does NOT nag', v2 === false && /Saved/.test(b2), `badge="${b2}" vetoed=${v2}`)
  record('the saved stroke is in the database', live().some(e => e.type === 'freedraw'), 'elements=' + live().length)
  await ctx.close()
}

await b.close()
fs.writeFileSync('evidence/journey3b-results.json', JSON.stringify(results, null, 2))
console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`); process.exit(results.some(r => !r.ok) ? 1 : 0)
