import { launch, signedInContext, WEB, API, sleep, record, results, fs } from './lib.mjs'
import { execSync } from 'node:child_process'
const DB = fs.readFileSync('/tmp/e2e_db_url', 'utf8').trim()
const sql = q => execSync(`psql "${DB}" -At -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const scene = () => JSON.parse(sql("select coalesce(whiteboard->'scene','{}'::jsonb) from attempts where attempt_id='T1'") || '{}')
sql("update attempts set whiteboard='{}'::jsonb where attempt_id='T1'")
const b = await launch(); const ctx = await signedInContext(b, 'S1'); const page = await ctx.newPage()
const net = []; const errs = []
page.on('response', r => { if (/generate|whiteboard/.test(r.url()) && !/\.ts/.test(r.url())) net.push(r.status() + ' ' + r.request().method() + ' ' + r.url().split('/').pop()) })
page.on('pageerror', e => errs.push(e.message))
const open = async () => { await page.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(3500); await page.locator('button:has-text("Whiteboard")').first().click(); await sleep(6000) }
const ask = async (mode, submit, text) => { await page.locator(`button:has-text("${mode}")`).first().click(); await page.getByLabel(/Ask the AI to draw or explain/).fill(text); await page.locator('button', { hasText: new RegExp('^' + submit + '$') }).last().click() }
const saved = async () => { await page.waitForFunction(() => /Saved/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {}); await sleep(2500) }
await open()

// ---------------- IMAGE
await ask('Image', 'Generate', 'a red apple'); await page.waitForFunction(() => /Added image/i.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {}); await saved()
let sc = scene(); const imgEl = (sc.elements || []).find(e => e.type === 'image' && !e.isDeleted)
const file = imgEl && sc.files?.[imgEl.fileId]
record('image generation hit the real route and succeeded', net.includes('200 POST generate-image'), JSON.stringify(net))
record('the image element is persisted with its binary data in the database', !!file && /^data:image\/(png|jpeg|webp);base64,/.test(file.dataURL), file ? file.mimeType + ' ' + Math.round(file.dataURL.length / 1024) + 'KB' : 'no file')
record('the image is a real decodable PNG (magic bytes) not a placeholder', !!file && Buffer.from(file.dataURL.split(',')[1], 'base64').subarray(0, 8).toString('hex') === '89504e470d0a1a0a')
record('image has sane size on the board', !!imgEl && imgEl.width >= 50 && imgEl.width <= 1200, imgEl ? `${Math.round(imgEl.width)}x${Math.round(imgEl.height)}` : '')
record('image is marked as AI-generated', imgEl?.customData?.socratiq?.author === 'ai', JSON.stringify(imgEl?.customData?.socratiq?.author))

// ---------------- SIMULATION: generate, animate, interact
await ask('Simulate', 'Simulate', 'spring mass oscillator')
await page.waitForSelector('iframe', { timeout: 20000 }); await sleep(1500)
const fr = () => page.frameLocator('iframe')
const num = async s => parseFloat(await fr().locator(s).textContent())
const t1 = await num('#t'); await sleep(900); const t2 = await num('#t')
record('simulation runs in the sandboxed frame and its clock advances', t2 > t1 + 0.4, `t ${t1} -> ${t2}`)
const sandbox = await page.$eval('iframe', f => f.getAttribute('sandbox')); record('iframe sandbox is exactly allow-scripts', sandbox === 'allow-scripts', sandbox)
const x1 = await num('#x'); await sleep(350); const x2 = await num('#x'); record('the moving object really moves (position changes)', Math.abs(x1 - x2) > 0.5, `x ${x1} -> ${x2}`)
await fr().locator('#p').click(); const tp = await num('#t'); await sleep(500); const tq = await num('#t')
record('Pause stops the simulation', Math.abs(tq - tp) < 0.03, `t ${tp} -> ${tq}`)
await fr().locator('#p').click(); await sleep(400); record('Play resumes it', (await num('#t')) > tq + 0.2)
await fr().locator('#r').click(); await sleep(80); record('Reset restarts it', (await num('#t')) < 0.4)
await fr().locator('#k').fill('30'); await fr().locator('#k').dispatchEvent('input'); await sleep(900)
const xs = []; for (let i = 0; i < 12; i++) { xs.push(await num('#x')); await sleep(60) }
record('the slider changes the dynamics (stiffer spring oscillates faster)', xs.some((v, i) => i && Math.sign(v) !== Math.sign(xs[i - 1])) || Math.max(...xs) - Math.min(...xs) > 40, xs.map(v => v.toFixed(0)).join(','))
await page.screenshot({ path: 'evidence/student-4-simulation-running.png' })

// ---------------- PIN to the board, persist
await page.locator('button:has-text("Pin to Board")').first().click(); await sleep(1500); await saved()
sc = scene(); const card = (sc.elements || []).find(e => e.customData?.simulation && !e.isDeleted)
const simData = card?.customData?.simulation
record('pinning creates a persistent simulation card in the database', !!card, card ? card.type + ' ' + Math.round(card.width) + 'x' + Math.round(card.height) : 'none')
record('the card stores the runnable source code', !!simData?.code && /<script/.test(simData.code) && simData.code.length > 300, simData ? simData.code.length + ' chars' : '')
record('the card has a title and a persistent identifier', !!simData?.title && !!(simData.id || card?.id), JSON.stringify({ title: simData?.title, id: simData?.id ?? card?.id }))
record('the card is not an empty rectangle (it carries a visible label/preview)', (sc.elements || []).some(e => e.type === 'text' && !e.isDeleted && (e.containerId === card?.id || /spring|simulation/i.test(e.text || ''))) || card?.type === 'image' || card?.type === 'embeddable', JSON.stringify((sc.elements || []).filter(e => !e.isDeleted).map(e => e.type)))
record('the card is associated with the AI author (not student)', card?.customData?.socratiq?.author === 'ai', JSON.stringify(card?.customData?.socratiq))
const n1 = (sc.elements || []).filter(e => !e.isDeleted).length

// ---------------- RELOAD, reopen, interact again
await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(3500); await page.locator('button:has-text("Whiteboard")').first().click(); await sleep(6500)
await page.screenshot({ path: 'evidence/student-5-after-reload-with-sim-and-image.png' })
const el = await page.evaluate(async ([a, t]) => (await (await fetch(a + '/student/assignments/A1/whiteboard', { headers: { Authorization: 'Bearer ' + t } })).json()), [API, 'tok:00000000-0000-0000-0000-0000000000b1'])
record('after reload the server returns every element (image + simulation card + labels)', (el.scene?.elements || []).filter(e => !e.isDeleted).length === n1, `${(el.scene?.elements || []).length} vs ${n1}`)
const reopen = async pg => { await pg.locator('button:has-text("Fit to")').first().click(); await sleep(800); await pg.mouse.click(1050, 460); await sleep(900); await pg.locator('button:has-text("Open Simulation")').first().click({ timeout: 8000 }); await sleep(1500); return (await pg.$$('iframe')).length > 0 }
const opened = await reopen(page).catch(() => false)
record('selecting the persisted card and choosing "Open and run" reopens the simulation', opened)
if (opened) {
  await sleep(1200); const r1 = await num('#t'); await sleep(800); const r2 = await num('#t')
  record('the reopened simulation animates again', r2 > r1 + 0.3, `t ${r1} -> ${r2}`)
  await fr().locator('#p').click(); const a = await num('#t'); await sleep(400); record('and responds to controls after reload (Pause)', Math.abs((await num('#t')) - a) < 0.03)
  await page.screenshot({ path: 'evidence/student-6-simulation-reopened.png' })
}

// ---------------- another authorized session sees the same content
const ctx2 = await signedInContext(b, 'S1'); const p2 = await ctx2.newPage()
await p2.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(3500); await p2.locator('button:has-text("Whiteboard")').first().click(); await sleep(6000)
const opened2 = await reopen(p2).catch(() => false)
record('a second authorized session opens the same persisted simulation', opened2)
if (opened2) { await sleep(1000); const q1 = parseFloat(await p2.frameLocator('iframe').locator('#t').textContent()); await sleep(800); const q2 = parseFloat(await p2.frameLocator('iframe').locator('#t').textContent()); record('and it animates in that session too', q2 > q1 + 0.3, `t ${q1} -> ${q2}`) }
record('no uncaught page errors', errs.length === 0, errs.slice(0, 2).join(' | '))
await b.close()
fs.writeFileSync('evidence/journey2-results.json', JSON.stringify(results, null, 2))
console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`); process.exit(results.some(r => !r.ok) ? 1 : 0)
