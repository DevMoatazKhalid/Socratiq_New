import { launch, signedInContext, WEB, API, AUTH, sleep, fs } from './lib.mjs'
import { execSync } from 'node:child_process'
const DB = fs.readFileSync('/tmp/e2e_db_url', 'utf8').trim()
execSync(`psql "${DB}" -q -c "update attempts set whiteboard='{}'::jsonb where attempt_id='T1'"`)
const el = (id, type, x, y, extra = {}) => ({ id, type, x, y, width: 160, height: 80, angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, index: 'a' + id.length, ...extra })
const scene = { type: 'excalidraw', version: 2, source: 'e2e', elements: [el('stu-rect', 'rectangle', 100, 100), el('stu-text', 'text', 120, 300, { text: 'student wrote this', originalText: 'student wrote this', fontSize: 20, fontFamily: 1, textAlign: 'left', verticalAlign: 'top', containerId: null, lineHeight: 1.25, autoResize: true }), el('ai-ell', 'ellipse', 400, 100, { customData: { socratiq: { v: 1, opId: 'o1', role: 'diagram-node', author: 'ai', legacyId: null } } })], appState: {}, files: {} }
const r = await fetch(API + '/student/assignments/A1/whiteboard', { method: 'PUT', headers: { 'content-type': 'application/json', Authorization: 'Bearer tok:' + AUTH.S1 }, body: JSON.stringify({ scene, base_rev: 0 }) })
console.log('seed PUT', r.status)
const b = await launch(); const ctx = await signedInContext(b, 'P1'); const page = await ctx.newPage()
const net = []; page.on('response', r => { if (r.url().includes('/api/v1')) net.push(r.status() + ' ' + r.request().method() + ' ' + r.url().replace('http://localhost:8000/api/v1', '')) })
await page.goto(WEB + '/teacher/courses/C1/assignments/A1/submissions/S1', { waitUntil: 'domcontentloaded' }); await sleep(7000)
await page.screenshot({ path: 'evidence/explore-teacher.png' })
console.log(net.slice(0, 12).join('\n')); console.log('url', page.url(), '| excalidraw', await page.$('.excalidraw') !== null, '| canvases', (await page.$$('canvas')).length)
console.log('TEXT', (await page.innerText('body')).replace(/\s+/g, ' ').slice(0, 500))
await b.close()
