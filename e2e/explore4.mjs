import { launch, signedInContext, WEB, sleep } from './lib.mjs'
const b = await launch(); const ctx = await signedInContext(b, 'S1'); const page = await ctx.newPage()
const puts = []; page.on('request', r => { if (r.method()==='PUT') puts.push(r.url()) }); page.on('requestfailed', r => { if (r.method()!=='GET') puts.push('FAILED '+r.method()+' '+r.url()+' '+r.failure()?.errorText) })
await page.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(3500)
await page.locator('button:has-text("Whiteboard")').first().click(); await sleep(6000)
await page.mouse.click(700, 400); await page.keyboard.press('p'); await page.mouse.move(500, 300); await page.mouse.down()
for (let i = 0; i < 10; i++) await page.mouse.move(500 + i * 15, 300 + i * 6); await page.mouse.up()
for (const t of [500, 2000, 5000]) { await sleep(t); console.log(t, 'status:', JSON.stringify(await page.locator('[role=status],[aria-live]').allInnerTexts()), 'puts:', puts.length) }
await page.screenshot({ path: 'evidence/explore-after-stroke.png' })
console.log(puts.join('\n')); await b.close()
