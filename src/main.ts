/**
 * One process for everything: web pages + API, Telegram bot, and the Quote Sentinel loop.
 *   npm run dev      (local)
 *   npm start        (server)
 * Set RUN_SENTINEL=0 if a separate `npm run sentinel` is already running against the same DB.
 * `npm run demo` (or a fresh checkout with no .env) starts demo mode: see src/demo.ts.
 */
import { DEMO } from './demo.js' // must stay first: sets demo env before config loads
import { config } from './lib/config.js'
import { startServer } from './server/http.js'
import { createBot, setCommands } from './bot/bot.js'
import { tick } from './sentinel/run.js'
import { sleep } from './lib/textile.js'
import { checkAlerts } from './agent/alerts.js'

startServer()

const bot = DEMO ? null : createBot()
if (bot) {
  await setCommands(bot).catch((e) => console.error('setMyCommands failed', e.message))
  bot.start({ onStart: (me) => console.log(`bot: @${me.username} running (wallet pages at ${config.publicUrl()})`) })
} else {
  console.log([
    '',
    '  DEMO MODE: no secrets needed. Textile market is simulated; the Telegram bot is off.',
    `  Board feed:  ${config.publicUrl()}/api/board`,
    `  History:     ${config.publicUrl()}/api/board/history`,
    `  Health:      ${config.publicUrl()}/healthz`,
    '  Set TELEGRAM_BOT_TOKEN and PUBLIC_URL in .env to run the real agent on Celo mainnet.',
    '',
  ].join('\n'))
}

if (process.env.RUN_SENTINEL !== '0') {
  ;(async () => {
    for (;;) {
      try {
        const { rows } = await tick()
        console.log(`sentinel: ${rows.length} quotes stored`)
      } catch (e: any) {
        console.error('sentinel tick failed:', e.message)
      }
      try {
        const { checked, fired } = await checkAlerts()
        if (checked) console.log(`alerts: ${checked} checked, ${fired} fired`)
      } catch (e: any) {
        console.error('alert check failed:', e.message)
      }
      await sleep(config.sentinel.intervalSec * 1000)
    }
  })()
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { bot?.stop(); process.exit(0) })
