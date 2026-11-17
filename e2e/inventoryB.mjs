import { launch, signedInContext, WEB, sleep, record, results, fs } from './lib.mjs'
import { execSync } from 'node:child_process'
const DB = fs.readFileSync('/tmp/e2e_db_url', 'utf8').trim()
const sql = q => execSync(`psql "${DB}" -At -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const live = () => (JSON.parse(sql("select coalesce(whiteboard->'scene'->'elements','[]'::jsonb) from attempts where attempt_id='T1'") || '[]')).filter(e => !e.isDeleted)
sql("update attempts set whiteboard='{}'::jsonb where attempt_id='T1'")
const b = await launch(); const ctx = await signedInContext(b, 'S1'); const page = await ctx.newPage()
const posts = []; page.on('response', r => { if (r.request().method() === 'POST' && r.url().includes('/api/v1')) posts.push(r.status() + ' ' + r.url().split('/api/v1')[1]) })
await page.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(3500)
const body = () => page.innerText('body')
const openMenu = async () => { if (!(await page.locator('[data-testid="dropdown-menu"]').isVisible().catch(() => false))) { await page.locator('[data-testid="main-menu-trigger"]').click(); await sleep(450) } }

// ---- tabs
await page.locator('button:has-text("Whiteboard")').first().click(); await sleep(5500)
record('tab: "Whiteboard" shows the board', (await page.$('.excalidraw')) !== null)
await page.mouse.click(1180, 300); await page.keyboard.press('r'); await page.mouse.move(700, 300); await page.mouse.down(); await page.mouse.move(800, 360, { steps: 5 }); await page.mouse.up()
await page.waitForFunction(() => /Saved \d/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {}); await sleep(1500)
await page.locator('button:has-text("Chat")').first().click(); await sleep(800)
record('tab: "Chat" shows the conversation input and hides the board', (await page.locator('input[placeholder^="Start your chat"]').isVisible().catch(() => false)) && (await page.locator('.excalidraw').isVisible().catch(() => false)) === false)
await page.locator('button:has-text("Whiteboard")').first().click(); await sleep(4000)
record('tab: switching away and back keeps the drawn work (restored from the server)', live().some(e => e.type === 'rectangle') && (await page.$('.excalidraw')) !== null, 'db elements=' + live().length)

// ---- menu
await page.locator('[data-testid="main-menu-trigger"]').click(); await sleep(500)
const menu = (await page.locator('[data-testid="dropdown-menu"]').innerText()).replace(/\s+/g, ' ')
record('menu: opens and lists board actions', /Export image/.test(menu) && /Find on canvas/.test(menu) && /Help/.test(menu) && /Reset the canvas/.test(menu), menu.slice(0, 150))
record('menu: contains no third-party social links (GitHub / Follow us / Discord)', !/GitHub|Follow us|Discord/.test(menu))
await page.locator('[data-testid="image-export-button"]').click(); await sleep(800)
record('menu: "Export image…" opens the export dialog', (await page.$('.ImageExportModal, .Modal, [role=dialog]')) !== null && /Export|PNG|SVG/i.test(await body()))
await page.keyboard.press('Escape'); await sleep(400)
await openMenu(); await page.locator('[data-testid="search-menu-button"]').click(); await sleep(700)
record('menu: "Find on canvas" opens the search panel', (await page.$('.layer-ui__search, [class*=search]')) !== null)
await page.keyboard.press('Escape'); await sleep(300)
await openMenu(); await page.locator('[data-testid="toggle-dark-mode"]').click(); await sleep(700)
record('menu: "Dark mode" toggles the theme', await page.$eval('.excalidraw', e => e.classList.contains('theme--dark')).catch(() => false))
await openMenu(); await page.locator('[data-testid="toggle-dark-mode"]').click(); await sleep(500)
await openMenu(); await page.locator('[data-testid="clear-canvas-button"]').click(); await sleep(700)
const confirmOpen = /Reset the canvas|clear the whole canvas|Clear canvas/i.test(await body()) && (await page.$('[role=dialog], .Modal, .Dialog')) !== null
record('menu: "Reset the canvas" asks for confirmation before destroying work', confirmOpen)
await page.keyboard.press('Escape'); await sleep(500)
const cancel = page.locator('button:has-text("Cancel")'); if (await cancel.count()) await cancel.first().click().catch(() => {})
await sleep(2500); record('menu: cancelling the reset leaves the work untouched', live().some(e => e.type === 'rectangle'), 'db elements=' + live().length)

// ---- help, library
await page.locator('button[aria-label="Help"]').click(); await sleep(700)
record('help: the "?" button opens the help dialog', /Shortcuts|Help|Keyboard/i.test(await body()) && (await page.$('[role=dialog], .Modal')) !== null)
await page.keyboard.press('Escape'); await sleep(400)
const sidebarBefore = await page.locator('.default-sidebar').count()
await page.locator('.sidebar-trigger').first().click(); await sleep(900)
record('library: the Library button opens the library sidebar (panel appears, and it was absent before)', sidebarBefore === 0 && (await page.locator('.default-sidebar').count()) > 0 && /Browse libraries|Add to library|Search library|Library/.test(await page.locator('.default-sidebar').innerText().catch(() => '')), `before=${sidebarBefore}`)
await page.locator('.sidebar-trigger').first().click().catch(() => {}); await sleep(500)

// ---- AI bar
for (const [mode, ph] of [['Image', /image/i], ['Simulate', /simulation/i], ['Diagram', /diagram/i]]) {
  await page.locator(`button:has-text("${mode}")`).first().click(); await sleep(300)
  const p = await page.getByLabel(/Ask the AI to draw or explain/).getAttribute('placeholder')
  record(`AI bar: "${mode}" mode switches the prompt for that kind of request`, ph.test(p || ''), p)
}
const dis = await page.getByRole('button', { name: /^Draw$/ }).isDisabled(); record('AI bar: submit is disabled while the prompt is empty', dis)
posts.length = 0
await page.locator('button:has-text("Ask Coach")').first().click().catch(() => {}); await sleep(300)
await page.getByLabel(/Ask the AI to draw or explain/).fill('what should I do next?'); await page.keyboard.press('Enter'); await sleep(3500)
record('AI bar: Enter submits the prompt and reaches a real backend route', posts.some(p => /^2\d\d /.test(p)), JSON.stringify(posts.slice(0, 3)))
posts.length = 0
await page.waitForFunction(() => /Added/.test(document.body.innerText), null, { timeout: 25000 }).catch(() => {})
await page.locator('button:has-text("Ask SocratiQ")').first().waitFor({ state: 'visible', timeout: 25000 }).catch(() => {})
await page.screenshot({ path: 'evidence/debug-before-quick.png' })
const menuNames = []
// The quick actions live in a <details><summary>Ask SocratiQ ▾</summary> disclosure.
for (const chip of ['Explain this', 'Check my work']) {
  const det = page.locator('details:has(summary:has-text("Ask SocratiQ"))').first()
  if (!(await det.evaluate(d => d.open).catch(() => false))) await det.locator('summary').click({ timeout: 8000 }).catch(() => {})
  await sleep(400)
  const item = det.locator(`button:has-text("${chip}")`).first()
  const vis = await item.isVisible().catch(() => false); menuNames.push(chip + (vis ? '' : '(not visible)'))
  if (vis) { await item.click({ timeout: 6000 }).catch(() => {}); await sleep(3500) }
}
record('quick actions: "Explain this" and "Check my work" each send a request to the Coach', posts.filter(p => /^2\d\d /.test(p)).length >= 2, JSON.stringify({ menuNames, posts: posts.slice(0, 4) }))
posts.length = 0
const chat = page.locator('input[placeholder^="Ask SocratiQ about the board"]'); await chat.fill('hello coach'); await page.locator('button[aria-label="Send message"], button:has-text("Send message")').first().click().catch(() => chat.press('Enter')); await sleep(3500)
record('chat bar: sending a message reaches the Coach route', posts.some(p => /^2\d\d /.test(p)), JSON.stringify(posts.slice(0, 3)))

// ---- simulation panel controls
await page.locator('button:has-text("Simulate")').first().click(); await page.getByLabel(/Ask the AI to draw or explain/).fill('spring'); await page.locator('button', { hasText: /^Simulate$/ }).last().click()
await page.waitForSelector('iframe', { timeout: 20000 }).catch(() => {}); await sleep(1500)
const t0 = parseFloat(await page.frameLocator('iframe').locator('#t').textContent().catch(() => '0'))
await page.locator('button[title="Reload simulation"], button[aria-label="Reload simulation"]').first().click(); await sleep(900)
const t1 = parseFloat(await page.frameLocator('iframe').locator('#t').textContent().catch(() => '99'))
record('simulation panel: "Reload" restarts the simulation from zero', t1 < t0 && t1 < 2, `t ${t0} -> ${t1}`)
const w0 = (await page.$eval('[role=dialog]', e => e.getBoundingClientRect().width).catch(() => 0))
await page.locator('button[title="Expand"], button[aria-label="Expand"]').first().click(); await sleep(600)
const w1 = (await page.$eval('[role=dialog]', e => e.getBoundingClientRect().width).catch(() => 0))
record('simulation panel: "Expand" enlarges the panel', w1 > w0 + 50, `${Math.round(w0)}px -> ${Math.round(w1)}px`)
await page.locator('button[title="Close"], button[aria-label="Close"]').first().click(); await sleep(600)
record('simulation panel: "Close" removes the panel and stops the simulation', (await page.$$('iframe')).length === 0)

// ---- layout: no control is covered by another at common widths
for (const [w, h] of [[1360, 860], [1100, 800], [900, 800]]) {
  const c2 = await signedInContext(b, 'S1', { viewport: { width: w, height: h } }); const p2 = await c2.newPage()
  await p2.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(3000); await p2.locator('button:has-text("Whiteboard")').first().click(); await sleep(5000)
  const covered = await p2.evaluate(() => ['[data-testid="button-undo"]', '[data-testid="button-redo"]', 'button[aria-label="Zoom in"]', 'button[aria-label="Zoom out"]', 'button[aria-label="Reset zoom"]', 'button[aria-label="Help"]', 'button[aria-label="Fit to content"], button:has(+*)'].slice(0, 6).map(s => { const e = document.querySelector(s); if (!e) return s + ' missing'; const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return (e === t || e.contains(t)) ? null : s + ' covered by ' + (t?.textContent || '').trim().slice(0, 20) }).filter(Boolean))
  record(`layout ${w}px: undo/redo/zoom/help are not covered by the AI bar`, covered.length === 0, JSON.stringify(covered))
  await c2.close()
}

// ---- mobile touch session
sql("update attempts set whiteboard='{}'::jsonb where attempt_id='T1'")
{
  const mctx = await signedInContext(b, 'S1', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }); const m = await mctx.newPage()
  await m.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(3500)
  await m.locator('button:has-text("Whiteboard")').first().click(); await sleep(5500)
  await m.screenshot({ path: 'evidence/mobile-1-board.png' })
  const toolbar = await m.$$eval('[data-testid^="toolbar-"]', xs => xs.length)
  record('mobile 390px: the drawing toolbar is present', toolbar >= 6, 'tools=' + toolbar)
  await m.locator('label:has([data-testid="toolbar-freedraw"])').first().tap().catch(async () => { await m.locator('label:has([data-testid="toolbar-freedraw"])').first().click() }); await sleep(400)
  const cdp = await mctx.newCDPSession(m); const pts = Array.from({ length: 14 }, (_, i) => ({ x: 90 + i * 16, y: 400 + Math.sin(i / 2) * 40 }))
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pts[0]] }); for (const p of pts.slice(1)) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [p] }); await sleep(20) } ; await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await m.waitForFunction(() => /Saved \d/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {}); await sleep(2000)
  record('mobile touch: a finger-drawn stroke is created and saved to the database', live().some(e => e.type === 'freedraw' && e.points.length > 5), 'elements=' + live().length)
  record('mobile 390px: the AI bar and chat input are reachable', (await m.locator('button:has-text("Diagram")').first().isVisible()) && (await m.locator('input[placeholder^="Ask SocratiQ about the board"]').isVisible()))
  const hs = await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  record('mobile 390px: no horizontal page overflow', hs)
  await m.screenshot({ path: 'evidence/mobile-2-after-touch-draw.png' })
  await mctx.close()
}
await b.close()
fs.writeFileSync('evidence/inventoryB-results.json', JSON.stringify(results, null, 2))
console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`); process.exit(results.some(r => !r.ok) ? 1 : 0)
