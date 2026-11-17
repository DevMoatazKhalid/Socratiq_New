import { launch, signedInContext, WEB, sleep, fs } from './lib.mjs'
import { execSync } from 'node:child_process'
const DB = fs.readFileSync('/tmp/e2e_db_url', 'utf8').trim()
const sql = q => execSync(`psql "${DB}" -At -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
sql("update attempts set whiteboard='{}'::jsonb where attempt_id='T1'")
const b = await launch(); const ctx = await signedInContext(b, 'S1'); const page = await ctx.newPage()
const puts = []; page.on('response', r => { if (r.request().method() === 'PUT') puts.push(r.status() + ' ' + r.url().split('/api/v1')[1]) })
await page.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(3500)
await page.locator('button:has-text("Whiteboard")').first().click(); await sleep(5500)
await page.mouse.click(1000, 650); await page.keyboard.press('r'); await page.mouse.move(700, 300); await page.mouse.down(); await page.mouse.move(800, 360, { steps: 5 }); await page.mouse.up()
await sleep(5000)
console.log('puts', JSON.stringify(puts), '| badge', ((await page.innerText('body')).match(/Unsaved changes|Saving…|Saved \d[^\n]*|Not saved|Save failed[^\n]*/) || ['none'])[0], '| db', sql("select jsonb_array_length(coalesce(whiteboard->'scene'->'elements','[]'::jsonb)) from attempts where attempt_id='T1'"))
await page.screenshot({ path: 'evidence/debug-rect.png' }); await b.close()
