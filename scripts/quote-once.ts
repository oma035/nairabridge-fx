/**
 * Smoke test: indicative Textile quotes on Celo mainnet, both directions.
 *   npm run quote            -> $10
 *   npm run quote -- 50      -> $50
 * Read-only. Needs no key, no wallet, sends no transaction.
 */
import { parseUnits } from 'viem'
import { TOKENS, TEXTILE_CELO } from '../src/lib/config.js'
import { effectiveNgnPerUsdt, feeInSellUnits, textile } from '../src/lib/textile.js'

const usd = Number(process.argv[2] ?? 10)

const [ticker] = await textile.tickers('USDT_NGN')
const mid = Number(ticker.last_price)
console.log(`Textile feed USDT_NGN: last ${ticker.last_price}, bid ${ticker.bid}, ask ${ticker.ask}`)
console.log(`Reactor (address book): ${TEXTILE_CELO.limitOrderReactor}, taker fee ${TEXTILE_CELO.takerFeeBps} bps\n`)

for (const sell of ['USDT', 'cNGN'] as const) {
  const buy = sell === 'USDT' ? 'cNGN' : 'USDT'
  const human = sell === 'USDT' ? usd : usd * mid
  const sellAmount = parseUnits(human.toFixed(6), TOKENS[sell].decimals)
  const p = await textile.preview({ sell, buy, sellAmount })
  if (p.status !== 'preview') {
    console.log(`${sell} -> ${buy}: no quote (${p.reason}) available=${p.availableSellAmount ?? '?'}`)
    continue
  }
  const rate = effectiveNgnPerUsdt(sell, { takerPays: p.takerPays!, buyAmount: p.buyAmount! })
  console.log(`${sell} -> ${buy}  pay ${human.toFixed(2)} ${sell}  get ${(Number(p.buyAmount) / 1e6).toFixed(2)} ${buy}`)
  console.log(`   effective ${rate.toFixed(2)} NGN/USDT, fee ${feeInSellUnits(sell, p.feeAmount!).toFixed(4)} ${sell}`)
}
