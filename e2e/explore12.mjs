import { launch, signedInContext, WEB, sleep } from './lib.mjs'
const b = await launch()
for (const [w, h] of [[1360, 860], [1100, 800], [900, 800], [390, 844]]) {
  const ctx = await signedInContext(b, 'S1', { viewport: { width: w, height: h }, hasTouch: w < 500 }); const page = await ctx.newPage()
  await page.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(3000)
  await page.locator('button:has-text("Whiteboard")').first().click(); await sleep(5500)
  const r = await page.evaluate(() => {
    const box = s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    const hit = s => { const e = document.querySelector(s); if (!e) return 'missing'; const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return e === t || e.contains(t) ? 'clickable' : 'COVERED by ' + (t?.textContent || t?.tagName || '').trim().slice(0, 30) }
    return { undo: [box('[data-testid="button-undo"]'), hit('[data-testid="button-undo"]')], redo: [box('[data-testid="button-redo"]'), hit('[data-testid="button-redo"]')], zoomIn: hit('button[aria-label="Zoom in"]'), zoomOut: hit('button[aria-label="Zoom out"]'), help: hit('button[aria-label="Help"]'), diagram: box('button[title^="AI draws vector"]') }
  })
  console.log(`${w}x${h}`, JSON.stringify(r)); await page.screenshot({ path: `evidence/layout-${w}.png` }); await ctx.close()
}
await b.close()
