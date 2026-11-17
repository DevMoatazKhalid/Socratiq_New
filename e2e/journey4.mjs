import { launch, signedInContext, WEB, API, AUTH, sleep, record, results, fs } from './lib.mjs'
import { execSync } from 'node:child_process'
const DB = fs.readFileSync('/tmp/e2e_db_url', 'utf8').trim()
const sql = q => execSync(`psql "${DB}" -At -c "${q.replace(/"/g, '\\"')}"`).toString().trim()
const hash = () => sql("select md5(whiteboard::text) from attempts where attempt_id='T1'")
const el = (id, type, x, y, extra = {}) => ({ id, type, x, y, width: 220, height: 80, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, index: 'a' + id.length, ...extra })
const mk = els => ({ type: 'excalidraw', version: 2, source: 'e2e', elements: els, appState: {}, files: {} })
const S1 = 'tok:' + AUTH.S1, P1 = 'tok:' + AUTH.P1
const api = async (path, tok, method = 'GET', body) => { const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + tok }, body: body && JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) } }
sql("update attempts set whiteboard='{}'::jsonb where attempt_id='T1'")
const ai = { socratiq: { v: 1, opId: 'o1', role: 'diagram-node', author: 'ai', legacyId: null } }
const put1 = await api('/student/assignments/A1/whiteboard', S1, 'PUT', { scene: mk([el('stu-rect', 'rectangle', 100, 100), el('ai-ell', 'ellipse', 400, 100, { customData: ai })]), base_rev: 0 })
record('setup: the student saved a board (student rectangle + AI ellipse)', put1.status === 200)

const b = await launch(); const ctx = await signedInContext(b, 'P1'); const page = await ctx.newPage()
const writes = []; page.on('request', r => { if (['PUT', 'POST', 'PATCH', 'DELETE'].includes(r.method()) && r.url().includes('/api/v1')) writes.push(r.method() + ' ' + r.url().split('/api/v1')[1]) })
await page.goto(WEB + '/teacher/courses/C1/assignments/A1/submissions/S1', { waitUntil: 'domcontentloaded' }); await sleep(8000)
const t = await page.innerText('body')
record("the teacher opens the student's submission page and the board renders", /Whiteboard/.test(t) && (await page.$('.excalidraw')) !== null)
const before = hash()
// pixel census of the board canvas: teal (AI) and dark (student) strokes must both be present
const census = await page.evaluate(() => { const cs = [...document.querySelectorAll('canvas')]; let teal = 0, dark = 0; for (const c of cs) { const g = c.getContext('2d'); if (!g || !c.width) continue; const d = g.getImageData(0, 0, c.width, c.height).data; for (let i = 0; i < d.length; i += 16) { if (d[i + 3] < 200) continue; const [r, gg, bb] = [d[i], d[i + 1], d[i + 2]]; if (r < 60 && gg > 100 && gg < 160 && bb > 90 && bb < 150) teal++; else if (r < 60 && gg < 60 && bb < 60) dark++ } } return { teal, dark } })
record('the board shows the student\'s dark strokes AND the AI\'s teal-edged ellipse (authorship is visible)', census.teal > 50 && census.dark > 50, JSON.stringify(census))
await page.screenshot({ path: 'evidence/teacher-1-review.png' })
// read-only: try to draw / select-all+delete on the board
const box = await page.$eval('.excalidraw', e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2); await page.keyboard.press('p'); await page.mouse.move(box.x + 100, box.y + 300); await page.mouse.down(); for (let i = 1; i < 10; i++) await page.mouse.move(box.x + 100 + i * 15, box.y + 300 + i * 4); await page.mouse.up()
await page.keyboard.press('Control+a'); await page.keyboard.press('Delete'); await sleep(4000)
record("the teacher's attempts to draw or delete change nothing in the database", hash() === before)
record('and the teacher page sent no write requests at all', writes.length === 0, JSON.stringify(writes))
await page.screenshot({ path: 'evidence/teacher-2-readonly-attempt.png' })
// API-level permissions
const ro = await api('/student/assignments/A1/whiteboard', P1, 'PUT', { scene: mk([]) }); record('API: the teacher cannot PUT to the student board endpoint', [401, 403, 404].includes(ro.status), 'status ' + ro.status)
record('API: the board is unchanged after that attempt', hash() === before)
const other = await api('/teacher/assignments/A2/students/S2', P1); record("API: the teacher cannot read a student's board in a course they don't teach", [403, 404].includes(other.status), 'status ' + other.status)
const own = await api('/teacher/assignments/A1/students/S1', P1); const wbEls = (own.json?.attempt?.whiteboard?.scene?.elements) || (own.json?.whiteboard?.scene?.elements) || []
record("API: the teacher's view of their own student includes the scene and the AI authorship metadata", own.status === 200 && wbEls.some(e => e.customData?.socratiq?.author === 'ai'), `status ${own.status}, elements=${wbEls.length}`)
// the student changes the board; the teacher sees it after a reload (Realtime is not available locally, so this is reload-based sync)
const rev1 = (await api('/student/assignments/A1/whiteboard', S1)).json.scene_rev
const put2 = await api('/student/assignments/A1/whiteboard', S1, 'PUT', { scene: mk([el('stu-rect', 'rectangle', 100, 100), el('ai-ell', 'ellipse', 400, 100, { customData: ai }), el('stu-new', 'text', 120, 300, { text: 'added later', originalText: 'added later', fontSize: 20, fontFamily: 1, textAlign: 'left', verticalAlign: 'top', containerId: null, lineHeight: 1.25, autoResize: true })]), base_rev: rev1 })
await page.reload({ waitUntil: 'domcontentloaded' }); await sleep(7000)
const own2 = await api('/teacher/assignments/A1/students/S1', P1); const n2 = ((own2.json?.attempt?.whiteboard?.scene?.elements) || (own2.json?.whiteboard?.scene?.elements) || []).length
record("after the student's later save, the teacher's reload shows the new content", put2.status === 200 && n2 === 3, 'elements=' + n2)
await b.close()
fs.writeFileSync('evidence/journey4-results.json', JSON.stringify(results, null, 2))
console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`); process.exit(results.some(r => !r.ok) ? 1 : 0)
