import { launch, signedInContext, WEB, sleep, record, results, fs } from './lib.mjs'
import { execSync } from 'node:child_process'
const DB = fs.readFileSync('/tmp/e2e_db_url', 'utf8').trim()
const sql = q => execSync(`psql "${DB}" -At -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const els = () => (JSON.parse(sql("select coalesce(whiteboard->'scene'->'elements','[]'::jsonb) from attempts where attempt_id='T1'") || '[]'))
const live = () => els().filter(e => !e.isDeleted)
sql("update attempts set whiteboard='{}'::jsonb where attempt_id='T1'")
const b = await launch(); const ctx = await signedInContext(b, 'S1'); const page = await ctx.newPage()
await page.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(3500)
await page.locator('button:has-text("Whiteboard")').first().click(); await sleep(6000)
const settle = async () => { await page.waitForFunction(() => /Saved \d/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {}); await sleep(2200) }
const tool = id => page.locator(`label:has([data-testid="toolbar-${id}"]), [data-testid="toolbar-${id}"]`).first()
const isOn = id => page.$eval(`[data-testid="toolbar-${id}"]`, el => !!el.checked).catch(() => false)
const active = async (id, want = true) => { for (let i = 0; i < 20; i++) { if ((await isOn(id)) === want) return want; await sleep(100) } return !want }
const drag = async (x1, y1, x2, y2) => { await page.mouse.move(x1, y1); await page.mouse.down(); await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 }); await page.mouse.move(x2, y2, { steps: 4 }); await page.mouse.up() }
const zoomText = async () => (await page.innerText('body')).match(/(\d+)%/)?.[1]

// 1. every drawing tool: clicking it activates it
await page.mouse.click(1180, 300)
for (const id of ['hand', 'rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text', 'eraser', 'selection']) {
  await tool(id).click()
  record(`toolbar: "${id}" button activates the ${id} tool`, await active(id))
}
await tool('lock').click(); const lockOn = await active('lock', true); await tool('lock').click(); const lockOff = await active('lock', false)
record('toolbar: "lock" button toggles keep-tool-active mode on and off', lockOn && !lockOff, `on=${lockOn} off=${!lockOff}`)

// 2. every shape tool actually draws, and the result is persisted
await tool('rectangle').click(); await drag(600, 260, 700, 330)
await tool('diamond').click(); await drag(780, 260, 880, 340)
await tool('ellipse').click(); await drag(950, 260, 1050, 330)
await tool('arrow').click(); await drag(600, 430, 740, 430)
await tool('line').click(); await drag(800, 430, 920, 480)
await tool('freedraw').click(); await page.mouse.move(980, 430); await page.mouse.down(); for (let i = 1; i <= 10; i++) await page.mouse.move(980 + i * 10, 430 + Math.sin(i) * 25); await page.mouse.up()
await tool('text').click(); await page.mouse.click(620, 570); await sleep(300); await page.keyboard.type('hello board', { delay: 20 }); await page.keyboard.press('Escape')
await settle()
let types = live().map(e => e.type)
for (const t of ['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text']) record(`draw: the ${t} tool creates a ${t} and it is saved to the database`, types.includes(t), t)
record('draw: typed text content is stored exactly', live().some(e => e.type === 'text' && e.text === 'hello board'))
record('draw: nothing drawn by the student is marked as AI or Coach work', live().every(e => !e.customData?.socratiq?.author || e.customData.socratiq.author === 'student'))

// 3. style panel: colour and width really apply to the next shape
await tool('rectangle').click(); await sleep(300)
await page.locator('[data-testid="color-top-pick-#e03131"]').first().click().catch(() => {})
await drag(600, 620, 700, 680); await settle()
const red = live().filter(e => e.type === 'rectangle').at(-1)
record('style: choosing red in the style panel colours the next rectangle red', red?.strokeColor === '#e03131', red?.strokeColor)
const nBefore = live().length

// 4. selection, move, copy/paste, duplicate, delete, undo, redo
await tool('selection').click(); await page.mouse.click(600, 295); await sleep(300)   // click the first rectangle's edge
const before = live().find(e => e.type === 'rectangle')
await page.mouse.move(650, 262); await page.mouse.down(); await page.mouse.move(700, 300, { steps: 5 }); await page.mouse.up(); await settle()
const after = live().find(e => e.id === before.id)
record('select+drag: moving an element updates its position in the saved scene', Math.abs(after.x - before.x) > 20 || Math.abs(after.y - before.y) > 20, `Δ=(${Math.round(after.x - before.x)},${Math.round(after.y - before.y)})`)
await page.keyboard.press('Control+c'); await page.keyboard.press('Control+v'); await settle()
record('copy/paste: Ctrl+C then Ctrl+V adds a copy', live().length === nBefore + 1, `${nBefore} -> ${live().length}`)
await page.keyboard.press('Delete'); await settle()
record('delete: the Delete key removes the selection', live().length === nBefore, `now ${live().length}`)
await page.locator('[data-testid="button-undo"]').click(); await settle()
record('undo button: restores the deleted element', live().length === nBefore + 1, `now ${live().length}`)
await page.locator('[data-testid="button-redo"]').click(); await settle()
record('redo button: re-applies the deletion', live().length === nBefore, `now ${live().length}`)
await tool('selection').click(); await page.mouse.click(1180, 300); await page.keyboard.press('Control+z'); await settle()
record('Ctrl+Z works as undo too', live().length === nBefore + 1)

// 5. eraser removes the stroke it crosses
const strokes0 = live().filter(e => e.type === 'freedraw').length
await tool('eraser').click(); await page.mouse.move(975, 430); await page.mouse.down(); await page.mouse.move(1100, 430, { steps: 10 }); await page.mouse.up(); await settle()
record('eraser: dragging across a stroke deletes it', live().filter(e => e.type === 'freedraw').length < strokes0, `${strokes0} -> ${live().filter(e => e.type === 'freedraw').length}`)

// 6. zoom & navigation
await tool('selection').click()
const z0 = await zoomText(); await page.locator('button[aria-label="Zoom in"]').click(); await sleep(250); const z1 = await zoomText()
await page.locator('button[aria-label="Zoom out"]').click(); await page.locator('button[aria-label="Zoom out"]').click(); await sleep(250); const z2 = await zoomText()
await page.locator('button[aria-label="Reset zoom"]').click(); await sleep(250); const z3 = await zoomText()
record('zoom: + increases, − decreases, reset returns to 100%', +z1 > +z0 && +z2 < +z0 && z3 === '100', `${z0}% -> ${z1}% -> ${z2}% -> ${z3}%`)
await page.locator('button:has-text("Fit to")').first().click(); await sleep(500); const zf = await zoomText()
await page.locator('button:has-text("Reset view")').first().click(); await sleep(500); const zr = await zoomText()
record('navigation: "Fit to content" changes the view and "Reset view" returns to 100%', zf !== undefined && zr === '100', `fit=${zf}% reset=${zr}%`)
await page.screenshot({ path: 'evidence/inventory-board-final.png' })
await b.close()
fs.writeFileSync('evidence/inventoryA-results.json', JSON.stringify(results, null, 2))
console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`); process.exit(results.some(r => !r.ok) ? 1 : 0)
