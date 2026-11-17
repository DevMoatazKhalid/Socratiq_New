import { launch, signedInContext, WEB, sleep, fs } from './lib.mjs'
import { execSync } from 'node:child_process'
const DB = fs.readFileSync('/tmp/e2e_db_url', 'utf8').trim()
execSync(`psql "${DB}" -q -c "update attempts set whiteboard='{}'::jsonb where attempt_id='T1'"`)
const b = await launch(); const ctx = await signedInContext(b, 'S1'); const page = await ctx.newPage()
const net = []; page.on('response', r => { if (/generate|whiteboard/.test(r.url())) net.push(r.status() + ' ' + r.request().method() + ' ' + r.url().split('/').pop()) })
await page.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(3500)
await page.locator('button:has-text("Whiteboard")').first().click(); await sleep(6000)
const ask = async (mode, text) => { await page.locator(`button:has-text("${mode}")`).first().click(); await page.getByLabel(/Ask the AI to draw or explain/).fill(text); await page.locator('button', { hasText: new RegExp('^' + ({Image:'Generate',Simulate:'Simulate'}[mode]) + '$') }).last().click() }
await ask('Image', 'a red apple'); await sleep(6000); await page.screenshot({ path: 'evidence/explore-image.png' })
await ask('Simulate', 'spring mass oscillator'); await sleep(7000); await page.screenshot({ path: 'evidence/explore-sim.png' })
console.log(net.join('\n'))
console.log('BUTTONS', JSON.stringify(await page.$$eval('button', bs => bs.map(x => (x.getAttribute('aria-label')||x.title||x.textContent||'').trim().slice(0,40)).filter(Boolean))))
console.log('iframes', await page.$$eval('iframe', f => f.map(x => x.getAttribute('sandbox'))))
await b.close()
