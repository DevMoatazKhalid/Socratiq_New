import { launch, signedInContext, WEB, sleep } from './lib.mjs'
const b = await launch(); const ctx = await signedInContext(b, 'S1'); const page = await ctx.newPage()
await page.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(3500)
await page.locator('button:has-text("Whiteboard")').first().click(); await sleep(6000)
await page.mouse.click(1000, 650)
for (const id of ['hand', 'rectangle', 'text', 'eraser', 'selection', 'lock']) {
  await page.locator(`label:has([data-testid="toolbar-${id}"])`).first().click(); await sleep(300)
  const st = await page.$eval(`[data-testid="toolbar-${id}"]`, el => ({ tag: el.tagName, checked: el.checked, cls: el.className.slice(0, 40), ariaChecked: el.getAttribute('aria-checked'), parent: el.parentElement?.className.slice(0, 60), hint: document.querySelector('.HintViewer, [class*=Hint]')?.textContent?.slice(0, 50) }))
  console.log(id, JSON.stringify(st))
}
await b.close()
