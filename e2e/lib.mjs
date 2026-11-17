import { createRequire } from 'node:module'
import fs from 'node:fs'
const require = createRequire('/home/claude/browser/package.json')
const chromium = require('@sparticuz/chromium').default ?? require('@sparticuz/chromium')
const { chromium: pw } = require('playwright-core')
export const WEB = 'http://localhost:5173', API = 'http://localhost:8000/api/v1'
export const AUTH = { S1: '00000000-0000-0000-0000-0000000000b1', S2: '00000000-0000-0000-0000-0000000000b2', P1: '00000000-0000-0000-0000-0000000000a1' }
const DROP = /^--(single-process|disable-web-security|disable-site-isolation-trials|allow-running-insecure-content|no-zygote)$|IsolateOrigins|site-per-process/
export async function launch(extra = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']) {
  const args = chromium.args.filter(a => !DROP.test(a)).map(a => a.startsWith('--disable-features=') ? a.split(',').filter(f => !/IsolateOrigins|site-per-process/.test(f)).join(',') : a)
  return pw.launch({ executablePath: await chromium.executablePath(), args: [...args, ...(extra || [])], headless: true })
}
export const session = (who, token = null) => JSON.stringify({ access_token: token ?? `tok:${AUTH[who]}`, refresh_token: 'r', token_type: 'bearer', expires_in: 36000, expires_at: Math.floor(Date.now() / 1000) + 36000,
  user: { id: AUTH[who], aud: 'authenticated', role: 'authenticated', email: who.toLowerCase() + '@u1.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } })
export async function signedInContext(browser, who, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, ...opts })
  await ctx.addInitScript(([k, v]) => { try { if (!localStorage.getItem(k)) localStorage.setItem(k, v) } catch {} }, ['sb-localhost-auth-token', session(who)])
  return ctx
}
export const results = []
export function record(name, ok, detail = '') { results.push({ name, ok, detail }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  -- ' + detail : '')) }
export const sleep = ms => new Promise(r => setTimeout(r, ms))
export { fs }
