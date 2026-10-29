/**
 * Demo mode: start the whole service with no secrets and no access to Textile.
 *
 *   npm run demo          (or set DEMO_MODE=1)
 *
 * It also switches on by itself on a fresh checkout (no TELEGRAM_BOT_TOKEN and no PUBLIC_URL),
 * but never on Render: a deployed service missing its token fails loudly instead of serving
 * simulated rates to the public board.
 *
 * What runs: the HTTP server, the public board API (/api/board, /api/board/history) and the
 * Quote Sentinel, fed by a simulated Textile market (rates drift gently, cash-out depth is
 * capped at $600 so the depth probe can be seen working). Reference rates are static.
 * What does not run: the Telegram bot and real conversions, which need a bot token and a
 * user's wallet on Celo mainnet. Demo data always goes to its own database (./data/demo.db,
 * or DEMO_DB_PATH), never to DB_PATH, so it cannot mix with real quotes.
 *
 * This file must be the first import in main.ts: it sets env defaults before config loads.
 */
import 'dotenv/config'

const freshCheckout = !process.env.TELEGRAM_BOT_TOKEN && !process.env.PUBLIC_URL && !process.env.RENDER
export const DEMO = process.env.DEMO_MODE === '1' || freshCheckout

if (DEMO) {
  const set = (k: string, v: string) => { if (!process.env[k]) process.env[k] = v }
  set('ATTRIBUTION_CODE', 'celo_f91a4dd61bbc')
  set('PORT', '8787')
  process.env.PUBLIC_URL = `http://localhost:${process.env.PORT}`
  process.env.DB_PATH = process.env.DEMO_DB_PATH || './data/demo.db'
  set('SENTINEL_INTERVAL_SEC', '20')
  set('BOARD_URL', '/api/board')
  Object.assign(process.env, {
    REF_OFFICIAL_MODE: 'static', REF_OFFICIAL_STATIC: process.env.REF_OFFICIAL_STATIC || '1353.43', REF_OFFICIAL_LABEL: 'Mid-market (demo)',
    REF_PARALLEL_MODE: 'static', REF_PARALLEL_STATIC: process.env.REF_PARALLEL_STATIC || '1460', REF_PARALLEL_LABEL: 'Parallel market (demo)',
  })
  installSimulatedTextile()
}

/** Replaces fetch for Textile URLs only; every other request goes to the real network. */
function installSimulatedTextile() {
  const realFetch = globalThis.fetch
  const USDT = '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e'
  const DEPTH_USDT = 600n * 10n ** 6n // cash-out liquidity cap, in USDT atomic units
  const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } })
  // Mid rate drifts slowly around 1,384 NGN per USDT; spread of about 4 bps each side.
  const mid = () => 1384.6 + 2.2 * Math.sin(Date.now() / 600_000) + 0.6 * Math.sin(Date.now() / 97_000)

  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input instanceof Request ? input.url : input)
    if (!url.includes('textilecredit.com')) return realFetch(input, init)

    if (url.includes('/tickers')) {
      const m = mid()
      return json([{ ticker_id: 'USDT_NGN', last_price: m.toFixed(2), bid: (m * 0.9996).toFixed(2), ask: (m * 1.0004).toFixed(2), base_volume: '0', target_volume: '0' }])
    }
    if (url.includes('/v2/rfq/preview')) {
      const b = JSON.parse(init?.body ?? '{}')
      const sell = BigInt(b.sellAmount)
      const cashOut = String(b.sellToken).toLowerCase() === USDT
      if (cashOut && sell > DEPTH_USDT) {
        return json({ data: { status: 'no_quote', reason: 'no_valid_quote', availableSellAmount: DEPTH_USDT.toString() } })
      }
      const fee = sell / 10_000n // 1 bps, same as Textile on Celo
      const net = Number(sell - fee)
      const rate = cashOut ? mid() * 0.9996 : mid() * 1.0004
      const buy = BigInt(Math.floor(cashOut ? net * rate : net / rate))
      return json({ data: { status: 'preview', sellAmount: b.sellAmount, takerPays: b.sellAmount, feeAmount: fee.toString(), buyAmount: buy.toString() } })
    }
    return json({ error: { code: 'demo_mode', message: 'Firm quotes and swaps are disabled in demo mode' } })
  }) as typeof fetch
}
