// Demo mode: the service must start with an empty environment and serve a live board.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'nbfx-demo-'))
const PORT = '18797'
const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
  // Empty TELEGRAM_BOT_TOKEN and PUBLIC_URL win over any local .env (dotenv never overrides set vars).
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TELEGRAM_BOT_TOKEN: '', PUBLIC_URL: '', DEMO_DB_PATH: join(dir, 'demo.db'), DB_PATH: join(dir, 'real.db'), PORT },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
child.stdout.on('data', (d) => (log += d)); child.stderr.on('data', (d) => (log += d))

let failed = 0
const check = (name: string, ok: boolean) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`); if (!ok) failed++ }
const base = `http://127.0.0.1:${PORT}`
const wait = async (fn: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { try { if (await fn()) return true } catch {} await new Promise((r) => setTimeout(r, 300)) }
  return false
}

try {
  check('starts with no secrets', await wait(async () => (await fetch(`${base}/healthz`)).ok))
  check('prints demo banner', log.includes('DEMO MODE'))
  check('bot stays off', !/bot: @/.test(log))
  const filled = await wait(async () => (await (await fetch(`${base}/api/board`)).json()).headline?.sellUsdt?.rate > 0)
  check('Sentinel fills the board from the simulated market', filled)
  const b = await (await fetch(`${base}/api/board`)).json()
  const r = b.headline?.sellUsdt?.rate
  check('cash-out rate is realistic', r > 1300 && r < 1500)
  check('depth probe finds the simulated $600 cap', b.depth?.USDT?.limited === true && b.depth?.USDT?.maxUsd === 600)
  check('reference rates are labelled demo', /demo/.test(b.references?.official?.label ?? ''))
  const h = await fetch(`${base}/api/board/history?range=24h`)
  check('history endpoint responds', h.ok)
  const root = await fetch(`${base}/`, { redirect: 'manual' })
  check('root redirects to the local board feed', root.status === 302 && (root.headers.get('location') ?? '').endsWith('/api/board'))
  const { existsSync } = await import('node:fs')
  check('demo never writes to the real DB_PATH', !existsSync(join(dir, 'real.db')))
} finally {
  child.kill('SIGTERM')
}

// A deployed service (Render) with a missing token must fail, not fall back to fake data.
const render = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TELEGRAM_BOT_TOKEN: '', PUBLIC_URL: '', RENDER: 'true', DB_PATH: join(dir, 'r.db'), PORT: '18798' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let rlog = ''
render.stdout.on('data', (d) => (rlog += d)); render.stderr.on('data', (d) => (rlog += d))
const code = await new Promise<number | null>((res) => { render.on('exit', res); setTimeout(() => { render.kill('SIGTERM'); res(-1) }, 15_000) })
check('on Render, a missing token stops the service (no silent demo)', code !== 0 && code !== -1 && !rlog.includes('DEMO MODE'))
if (failed) { console.log(log); console.log(`\n${failed} demo check(s) failed`); process.exit(1) }
console.log('\nDEMO MODE OK')
