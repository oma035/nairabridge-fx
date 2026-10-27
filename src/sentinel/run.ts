/**
 * Quote Sentinel: every SENTINEL_INTERVAL_SEC, preview cNGN<->USDT on Textile (Celo)
 * at each size in both directions and store the result. Previews are indicative,
 * free, need no key and hold no outstanding-RFQ slot, so the board never locks
 * maker inventory. Sizes are USD notional; the cNGN leg is sized from the latest mid.
 */
import { parseUnits } from 'viem'
import { config, TOKENS, type TokenSymbol } from '../lib/config.js'
import { db } from '../lib/db.js'
import { effectiveNgnPerUsdt, sleep, textile, TextileError } from '../lib/textile.js'
import { referenceRates } from '../lib/reference.js'

const insert = db.prepare(`INSERT INTO quotes
  (ts, source, kind, sell, buy, size_usd, status, reason, sell_amount, buy_amount, taker_pays, fee_amount, rate_ngn_usdt, ref_parallel, ref_official)
  VALUES (@ts,'sentinel','preview',@sell,@buy,@size_usd,@status,@reason,@sell_amount,@buy_amount,@taker_pays,@fee_amount,@rate,@ref_parallel,@ref_official)`)

async function midNgnPerUsdt(): Promise<number> {
  try {
    const [t] = await textile.tickers('USDT_NGN')
    const v = Number(t?.last_price)
    if (v > 0) return v
  } catch {}
  const { official } = await referenceRates()
  if (official.rate) return official.rate
  throw new Error('no mid rate available to size the cNGN leg')
}

export async function tick() {
  const ts = Date.now()
  const [mid, refs] = await Promise.all([midNgnPerUsdt(), referenceRates()])
  const rows: Array<Record<string, unknown>> = []

  for (const sizeUsd of config.sentinel.sizesUsd) {
    for (const sell of ['USDT', 'cNGN'] as TokenSymbol[]) {
      const buy: TokenSymbol = sell === 'USDT' ? 'cNGN' : 'USDT'
      const human = sell === 'USDT' ? sizeUsd : sizeUsd * mid
      const sellAmount = parseUnits(human.toFixed(TOKENS[sell].decimals), TOKENS[sell].decimals)
      const base = { ts, sell, buy, size_usd: sizeUsd, ref_parallel: refs.parallel.rate, ref_official: refs.official.rate }
      try {
        const p = await textile.preview({ sell, buy, sellAmount })
        const ok = p.status === 'preview' && p.takerPays && p.buyAmount
        rows.push({
          ...base,
          status: p.status,
          reason: p.reason ?? null,
          sell_amount: p.sellAmount ?? sellAmount.toString(),
          buy_amount: p.buyAmount ?? null,
          taker_pays: p.takerPays ?? null,
          fee_amount: p.feeAmount ?? null,
          rate: ok ? effectiveNgnPerUsdt(sell, { takerPays: p.takerPays!, buyAmount: p.buyAmount! }) : null,
        })
      } catch (e: any) {
        rows.push({ ...base, status: 'error', reason: e instanceof TextileError ? e.code : String(e.message).slice(0, 120),
          sell_amount: sellAmount.toString(), buy_amount: null, taker_pays: null, fee_amount: null, rate: null })
      }
    }
  }
  db.transaction(() => rows.forEach((r) => insert.run(r)))()
  return { mid, refs, rows }
}

function fmt(r: Record<string, unknown>) {
  const rate = r.rate ? (r.rate as number).toFixed(2) : '   -   '
  return `${String(r.sell).padEnd(4)} -> ${String(r.buy).padEnd(4)} $${String(r.size_usd).padEnd(5)} ${rate} NGN/USDT  ${r.status}${r.reason ? ` (${r.reason})` : ''}`
}

async function main() {
  const once = process.argv.includes('--once')
  console.log(`Quote Sentinel: sizes $${config.sentinel.sizesUsd.join(', $')} every ${config.sentinel.intervalSec}s${once ? ' (once)' : ''}`)
  for (;;) {
    try {
      const { mid, refs, rows } = await tick()
      console.log(`\n${new Date().toISOString()}  Textile mid ${mid.toFixed(2)} | ${refs.parallel.label}: ${refs.parallel.rate ?? 'n/a'} | ${refs.official.label}: ${refs.official.rate ?? 'n/a'}`)
      rows.forEach((r) => console.log('  ' + fmt(r)))
    } catch (e: any) {
      console.error('tick failed:', e.message)
    }
    if (once) break
    await sleep(config.sentinel.intervalSec * 1000)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
