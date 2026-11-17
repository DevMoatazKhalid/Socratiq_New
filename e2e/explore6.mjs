import { launch, signedInContext, WEB, sleep } from './lib.mjs'
const b = await launch(); const ctx = await signedInContext(b, 'S1'); const page = await ctx.newPage()
await page.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(3500)
await page.locator('button:has-text("Whiteboard")').first().click(); await sleep(6000)
for (const m of ['Image', 'Simulate']) {
  await page.locator(`button:has-text("${m}")`).first().click(); await sleep(500)
  await page.getByLabel(/Ask the AI to draw or explain/).fill('x')
  console.log(m, 'BUTTONS', JSON.stringify(await page.$$eval('button', bs => bs.map(x => (x.getAttribute('aria-label')||x.title||x.textContent||'').trim().slice(0,28)).filter(Boolean).slice(-14))))
  console.log(m, 'placeholder', await page.getByLabel(/Ask the AI to draw or explain/).getAttribute('placeholder'))
}
await b.close()
