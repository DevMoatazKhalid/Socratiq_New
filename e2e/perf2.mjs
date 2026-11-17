import { launch, signedInContext, WEB, sleep, fs } from './lib.mjs'
import { execSync } from 'node:child_process'
const DB = fs.readFileSync('/tmp/e2e_db_url', 'utf8').trim()
const run = async (label) => {
  const b = await launch(); const ctx = await signedInContext(b, 'S1'); const page = await ctx.newPage()
  await page.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(2500)
  await page.locator('button:has-text("Whiteboard")').first().click(); await sleep(7000)
  await page.mouse.click(1100, 650); await page.keyboard.press('p')
  const cpu0 = await page.evaluate(() => performance.now())
  const s0 = Date.now(); await page.mouse.move(700, 400); await page.mouse.down(); for (let i = 1; i <= 30; i++) await page.mouse.move(700 + i * 8, 400 + Math.sin(i / 3) * 40); await page.mouse.up(); const ms = Date.now() - s0
  // time spent inside the board's own change handling, via the long-task API sampled during a second stroke
  const longTasks = await page.evaluate(async () => { const out = []; const po = new PerformanceObserver(l => l.getEntries().forEach(e => out.push(Math.round(e.duration)))); po.observe({ entryTypes: ['longtask'] }); await new Promise(r => setTimeout(r, 1500)); po.disconnect(); return out })
  console.log(`${label}: 30-move stroke = ${ms} ms (${(ms / 30).toFixed(0)} ms/move)`); await b.close(); return ms
}
execSync(`psql "${DB}" -q -c "update attempts set whiteboard='{}'::jsonb where attempt_id='T1'"`)
await run('EMPTY board')
