import { launch, signedInContext, WEB, sleep } from './lib.mjs'
const b = await launch(); const ctx = await signedInContext(b, 'S1'); const page = await ctx.newPage()
await page.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(3500)
await page.locator('button:has-text("Whiteboard")').first().click(); await sleep(5500)
console.log('MATCHES', JSON.stringify(await page.$$eval('*', els => els.filter(e => e.children.length <= 2 && /^Ask SocratiQ/.test((e.textContent || '').trim()) && e.offsetParent !== null).map(e => e.tagName + '|role=' + e.getAttribute('role') + '|' + (e.className || '').toString().slice(0, 50) + '|' + (e.textContent || '').trim().slice(0, 30)).slice(0, 8))))
await b.close()
