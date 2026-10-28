/**
 * One process for everything: web pages + API, Telegram bot, and the Quote Sentinel loop.
 *   npm run dev      (local)
 *   npm start        (server)
 * Set RUN_SENTINEL=0 if a separate `npm run sentinel` is already running against the same DB.
 */
import { config } from './lib/config.js'
import { startServer } from './server/http.js'
import { createBot, setCommands } from './bot/bot.js'
import { tick } from './sentinel/run.js'
import { sleep } from './lib/textile.js'

startServer()

const bot = createBot()
await setCommands(bot).catch((e) => console.error('setMyCommands failed', e.message))
bot.start({ onStart: (me) => console.log(`bot: @${me.username} running (wallet pages at ${config.publicUrl()})`) })

if (process.env.RUN_SENTINEL !== '0') {
  ;(async () => {
    for (;;) {
      try {
        const { rows } = await tick()
        console.log(`sentinel: ${rows.length} quotes stored`)
      } catch (e: any) {
        console.error('sentinel tick failed:', e.message)
      }
      await sleep(config.sentinel.intervalSec * 1000)
    }
  })()
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => { bot.stop(); process.exit(0) })
