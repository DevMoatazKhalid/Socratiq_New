import { launch, signedInContext, WEB, sleep } from './lib.mjs'
const b = await launch(); const ctx = await signedInContext(b, 'S1'); const page = await ctx.newPage()
const ev = []
page.on('requestfailed', r => ev.push('FAILED ' + r.method() + ' ' + r.url().replace('http://localhost:8000','') + ' ' + r.failure()?.errorText))
page.on('request', r => { if (r.url().includes('/whiteboard')) ev.push('REQ ' + r.method() + ' ' + r.url().replace('http://localhost:8000','')) })
page.on('response', r => { if (r.url().includes('/whiteboard')) ev.push('RES ' + r.status() + ' ' + r.request().method()) })
page.on('console', m => { if (m.type()==='error' && !/54321|ERR_NAME|ERR_CONNECTION/.test(m.text())) ev.push('CONSOLE ' + m.text().slice(0,200)) })
await page.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(3500)
await page.locator('button:has-text("Whiteboard")').first().click(); await sleep(6000)
await page.mouse.click(700, 400); await page.keyboard.press('p'); await page.mouse.move(500, 300); await page.mouse.down()
for (let i = 0; i < 10; i++) await page.mouse.move(500 + i * 15, 300 + i * 6); await page.mouse.up()
await sleep(6000)
console.log(ev.join('\n')); console.log('BODYTEXT', (await page.innerText('body')).match(/Saved[^\n]*|Saving[^\n]*|Unsaved[^\n]*|Not saved[^\n]*|Offline[^\n]*/g))
await b.close()
