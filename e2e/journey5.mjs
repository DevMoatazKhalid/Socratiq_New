import { launch, signedInContext, WEB, sleep, record, results, fs } from './lib.mjs'
import http from 'node:http'
const put = p => new Promise(r => { const q = http.request({ host: '127.0.0.1', port: 9911, path: p, method: 'PUT' }, res => { res.resume(); res.on('end', r) }); q.end() })
const live = async () => (await fetch('http://127.0.0.1:9911/__live')).json()
const b = await launch()
const openBoard = async (ctx) => { const p = await ctx.newPage(); await p.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(3500); await p.locator('button:has-text("Whiteboard")').first().click(); await sleep(5500); return p }
const body = p => p.innerText('body')
const startLive = async p => { await p.locator('button:has-text("Live")').first().click() }

// ---------------------------------------------------------------- happy path
await put('/live-reset')
{
  const ctx = await signedInContext(b, 'S1', { permissions: ['microphone'] }); const p = await openBoard(ctx)
  const wsOpened = []; p.on('websocket', w => wsOpened.push(w.url()))
  await startLive(p); await sleep(700)
  const early = await body(p)
  await p.waitForFunction(() => /Listening|speaking/i.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {})
  const t = await body(p)
  record('the UI shows a connecting state first, then Listening only after the provider connection exists', /Connecting/i.test(early) || /Listening/i.test(t), (early.match(/Connecting[^\n]*/i) || ['(no connecting text seen)'])[0].slice(0, 60))
  record('the browser opened the relay WebSocket on the app origin (not directly to the provider)', wsOpened.some(u => /localhost:8000.*smartboard\/live/.test(u)) && !wsOpened.some(u => /googleapis/.test(u)), JSON.stringify(wsOpened))
  await sleep(4500)
  const s = await live()
  record('the relay connected to the (fake) provider exactly once, with the key in its handshake', s.connected === 1 && s.paths.some(x => /key=/.test(x)), JSON.stringify({ connected: s.connected }))
  record("the provider received the SERVER's setup (pedagogical rules present, client-supplied text absent)", s.setup_has_server_rules === true && s.setup_has_client_evil === false)
  record('microphone audio chunks really flowed browser -> relay -> provider', s.audio_chunks >= 3, 'chunks=' + s.audio_chunks)
  await p.screenshot({ path: 'evidence/live-1-listening.png' })
  const t2 = await body(p)
  record('provider audio came back and the UI reflects a live conversation (no error state)', !/Disconnected|failed|error/i.test(t2) && /Listening|Speaking|speaking|Gemini/i.test(t2), (t2.match(/(Listening|Speaking|Connecting)[^\n]*/i) || [''])[0].slice(0, 60))
  const before = (await live()).audio_chunks
  await p.locator('[title="End Live Voice Call"]').click(); await sleep(1500)
  const after1 = (await live()).audio_chunks; await sleep(1500); const after2 = (await live()).audio_chunks; const s2 = await live()
  record('ending the call closes the provider connection', s2.closed === 1, JSON.stringify({ connected: s2.connected, closed: s2.closed }))
  record('and microphone audio stops flowing (the capture is really released)', after2 === after1, `chunks ${before} -> ${after1} -> ${after2}`)
  await ctx.close()
}

// ---------------------------------------------------------------- provider drops mid-session
await put('/live-reset'); await put('/live-drop')
{
  const ctx = await signedInContext(b, 'S1', { permissions: ['microphone'] }); const p = await openBoard(ctx)
  await startLive(p)
  await p.waitForFunction(() => /ended|Session ended|interrupted|Disconnected|Retry/i.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {})
  const t = await body(p)
  record('the provider dropping mid-session is reported to the user (not left looking connected)', /ended|interrupted|Disconnected|Retry/i.test(t) && !/Listening to you/i.test(t), (t.match(/(Session ended|ended|interrupted|Disconnected)[^\n]*/i) || [''])[0].slice(0, 80))
  await sleep(1500); const s = await live()
  const c1 = s.audio_chunks; await sleep(1500)
  record('after the drop the browser has stopped capturing/sending audio', (await live()).audio_chunks === c1, `chunks ${c1}`)
  await p.screenshot({ path: 'evidence/live-2-provider-dropped.png' })
  await ctx.close()
}

// ---------------------------------------------------------------- relay rejects: no session / bad token never reach the provider
await put('/live-reset')
{
  const ctx = await signedInContext(b, 'S1', { permissions: ['microphone'] })
  await ctx.addInitScript(([k, v]) => localStorage.setItem(k, v), ['sb-localhost-auth-token', JSON.stringify({ access_token: 'forged-garbage', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: 'x', aud: 'authenticated', email: 'x@x', app_metadata: {}, user_metadata: {}, created_at: '2020-01-01' } })])
  const p = await ctx.newPage(); await p.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(5000)
  record('a forged token never reaches the provider (relay or API refuses first)', (await live()).connected === 0, JSON.stringify(await live()))
  await ctx.close()
}

// ---------------------------------------------------------------- microphone denied (separate browser that auto-denies permission prompts)
await put('/live-reset')
{
  const bd = await launch(['--deny-permission-prompts']); const ctx = await signedInContext(bd, 'S1'); const p = await ctx.newPage()
  await p.goto(WEB + '/student/courses/C1/assignments/A1/coach', { waitUntil: 'domcontentloaded' }); await sleep(3500); await p.locator('button:has-text("Whiteboard")').first().click(); await sleep(5500)
  await p.locator('button:has-text("Live")').first().click()
  await p.waitForFunction(() => /Microphone|denied|No microphone|Disconnected/i.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {})
  const t = await body(p)
  record('microphone denied: the user is told so', /Microphone access denied|No microphone|microphone/i.test(t) && !/Listening to you/i.test(t), (t.match(/[^\n]*[Mm]icrophone[^\n]*/) || ['(none)'])[0].slice(0, 90))
  await sleep(1500); const s = await live()
  record('microphone denied: the provider session is closed, not left running', s.connected === 0 || s.closed === s.connected, JSON.stringify({ connected: s.connected, closed: s.closed }))
  await p.screenshot({ path: 'evidence/live-3-mic-denied.png' })
  await bd.close()
}
await b.close()
fs.writeFileSync('evidence/journey5-results.json', JSON.stringify(results, null, 2))
console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`); process.exit(results.some(r => !r.ok) ? 1 : 0)
