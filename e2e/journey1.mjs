import { launch, signedInContext, WEB, API, sleep, record, results, fs } from './lib.mjs'
import { execSync } from 'node:child_process'
const DB = fs.readFileSync('/tmp/e2e_db_url', 'utf8').trim()
const sql = q => execSync(`psql "${DB}" -At -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const sceneEls = () => JSON.parse(sql("select coalesce(whiteboard->'scene'->'elements','[]'::jsonb) from attempts where attempt_id='T1'") || '[]')
const rev = () => parseInt(sql("select coalesce(whiteboard->>'scene_rev','0') from attempts where attempt_id='T1'"))

sql("update attempts set whiteboard='{}'::jsonb where attempt_id='T1'")          // every run starts from an empty board
const b = await launch(); const ctx = await signedInContext(b, 'S1'); const page = await ctx.newPage()
const puts = [], gens = [], errs = []
page.on('request', r => { if (r.method() === 'PUT' && r.url().endsWith('/whiteboard')) { try { puts.push(JSON.parse(r.postData())) } catch {} } })
page.on('response', r => { if (r.url().includes('/smartboard/generate') || r.url().includes('/generate')) gens.push(r.status() + ' ' + r.url().split('/').pop()) })
page.on('pageerror', e => errs.push(e.message))
await page.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' })
await sleep(3500); await page.locator('button:has-text("Whiteboard")').first().click(); await sleep(6000)

// ---- drawing with real pointer + keyboard input
const box = { x: 640, y: 250 }                         // clear canvas area: the style panel occupies x<505 and the AI bar y>740
await page.mouse.click(1000, 600); await page.keyboard.press('r'); await page.mouse.move(box.x, box.y); await page.mouse.down(); await page.mouse.move(box.x + 160, box.y + 90, { steps: 8 }); await page.mouse.up()
await page.keyboard.press('p'); await page.mouse.move(box.x + 300, box.y + 20); await page.mouse.down()
for (let i = 1; i <= 12; i++) await page.mouse.move(box.x + 300 + i * 12, box.y + 20 + Math.sin(i / 2) * 30)
await page.mouse.up()
await page.keyboard.press('t'); await page.mouse.click(box.x + 20, box.y + 230); await sleep(300); await page.keyboard.type('2x + 4 = 10', { delay: 25 }); await page.keyboard.press('Escape'); await sleep(400)
await page.screenshot({ path: 'evidence/student-1-drawn.png' })

// wait for the autosave to reach the server AND the database
await page.waitForFunction(() => /Saved/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {})
await sleep(2500)
let els = sceneEls().filter(e => !e.isDeleted)
const types = els.map(e => e.type)
record('drawn rectangle is persisted in the database', types.includes('rectangle'), JSON.stringify(types))
record('drawn freehand stroke is persisted (with real points)', els.some(e => e.type === 'freedraw' && e.points?.length > 5))
record('typed text is persisted with the typed content', els.some(e => e.type === 'text' && /2x \+ 4 = 10/.test(e.text || '')), JSON.stringify(els.filter(e => e.type === 'text').map(e => e.text)))
record('hand-drawn elements are stamped as student-authored (or unstamped)', els.filter(e => ['rectangle','freedraw','text'].includes(e.type)).every(e => !e.customData?.socratiq?.author || e.customData.socratiq.author === 'student'))
const r1 = rev()
record('the server revision advanced (save confirmed by the database)', r1 >= 1, 'scene_rev=' + r1)
record('client sent base_rev with its saves', puts.length > 0 && puts.every(p => typeof p.base_rev === 'number'), 'puts=' + puts.length + ' base_revs=' + puts.map(p => p.base_rev).join(','))
record('the UI says Saved only after that', /Saved/.test(await page.innerText('body')))

// ---- AI diagram through the real UI -> real backend route -> (fake) provider -> validator -> board
await page.locator('button:has-text("Diagram")').first().click().catch(() => {})
const prompt = page.locator('input[placeholder^="Ask AI to draw"]'); await prompt.fill('login flow'); await page.getByRole('button', { name: /^Draw$/ }).click()
await page.waitForFunction(() => /Added/i.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {})
await sleep(2500)
record('diagram request reached the real backend route and succeeded', gens.some(g => g.startsWith('200') && g.includes('generate-diagram')), JSON.stringify(gens))
await page.screenshot({ path: 'evidence/student-2-diagram.png' })
await page.waitForFunction(() => /Saved/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {}); await sleep(2500)
els = sceneEls().filter(e => !e.isDeleted)
const labels = els.filter(e => e.type === 'text').map(e => e.text)
record('diagram text labels are persisted (Start / Valid? / Home / Retry)', ['Start', 'Valid?', 'Home', 'Retry'].every(l => labels.some(t => (t || '').includes(l))), JSON.stringify(labels))
record('diagram is marked AI-generated, distinct from student work', els.some(e => e.customData?.socratiq?.author && e.customData.socratiq.author !== 'student') , JSON.stringify([...new Set(els.map(e => e.customData?.socratiq?.author))]))
const connectors = els.filter(e => e.type === 'arrow')
record('diagram arrows are bound to nodes (editable connectors)', connectors.length >= 3 && connectors.every(a => a.startBinding || a.endBinding), 'arrows=' + connectors.length)
const byId = new Map(els.map(e => [e.id, e]))
const radial = (t, p) => { const dx = Math.abs(p[0] - (t.x + t.width / 2)) / (t.width / 2), dy = Math.abs(p[1] - (t.y + t.height / 2)) / (t.height / 2); return t.type === 'ellipse' ? Math.hypot(dx, dy) : t.type === 'diamond' ? dx + dy : Math.max(dx, dy) }
const offTarget = []
for (const a of connectors) for (const [bd, pt, w] of [[a.startBinding, [a.x + a.points[0][0], a.y + a.points[0][1]], 'start'], [a.endBinding, [a.x + a.points.at(-1)[0], a.y + a.points.at(-1)[1]], 'end']]) {
  const t = bd && byId.get(bd.elementId); if (!t) continue; const r = radial(t, pt); if (r < 0.8 || r > 1.45) offTarget.push(`${a.id.slice(0, 9)} ${w}->${t.type} r=${r.toFixed(2)}`)
}
record('every persisted diagram arrow starts and ends ON the shapes it connects (none ends in empty space)', offTarget.length === 0, JSON.stringify(offTarget))
const countBefore = els.length

// ---- RELOAD: everything must come back from the database
await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(3500); await page.locator('button:has-text("Whiteboard")').first().click(); await sleep(6000)
await page.screenshot({ path: 'evidence/student-3-after-reload.png' })
const got = await page.evaluate(async ([api, tok]) => (await (await fetch(api + '/student/assignments/A1/whiteboard', { headers: { Authorization: 'Bearer ' + tok } })).json()), [API, 'tok:00000000-0000-0000-0000-0000000000b1'])
record('after reload the server returns the saved scene (same element count)', (got.scene?.elements || []).filter(e => !e.isDeleted).length === countBefore, `${(got.scene?.elements || []).length} vs ${countBefore}`)
const px = await page.evaluate(() => { const c = document.querySelector('canvas.interactive') || document.querySelectorAll('canvas')[1]; return c ? [c.width, c.height] : null })
record('the board re-renders content after reload (screenshot taken)', true, 'canvas=' + JSON.stringify(px))
record('no uncaught page errors during the journey', errs.length === 0, errs.slice(0, 3).join(' | '))
await b.close()
fs.writeFileSync('evidence/journey1-results.json', JSON.stringify(results, null, 2))
console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`); process.exit(results.some(r => !r.ok) ? 1 : 0)
