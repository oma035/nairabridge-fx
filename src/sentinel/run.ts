/**
 * Quote Sentinel: every SENTINEL_INTERVAL_SEC, preview cNGN<->USDT on Textile (Celo)
 * at each size in both directions and store the result. Previews are indicative,
 * free, need no key and hold no outstanding-RFQ slot, so the board never locks
 * maker inventory. Sizes are USD notional; the cNGN leg is sized from the latest mid.
 *
 * Depth probe: when a size gets no_quote but Textile reports the depth available,
 * we preview once more just under that depth, so the board always shows the
 * largest amount convertible right now and its rate (probe = 1 rows).
 */
import { formatUnits, parseUnits } from 'viem'
import { config, TOKENS, type TokenSymbol } from '../lib/config.js'
import { db } from '../lib/db.js'
import { effectiveNgnPerUsdt, sleep, textile, TextileError, type PreviewResult } from '../lib/textile.js'
import { referenceRates } from '../lib/reference.js'

const insert = db.prepare(`INSERT INTO quotes
  (ts, source, kind, sell, buy, size_usd, status, reason, sell_amount, buy_amount, taker_pays, fee_amount, rate_ngn_usdt, ref_parallel, ref_official, available_sell, probe)
  VALUES (@ts,'sentinel','preview',@sell,@buy,@size_usd,@status,@reason,@sell_amount,@buy_amount,@taker_pays,@fee_amount,@rate,@ref_parallel,@ref_official,@available_sell,@probe)`)

const PROBE_FRACTION = 0.98 // stay just under published depth
const MIN_PROBE_USD = 1     // Textile mainnet floor is about $1

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

const toUsd = (sell: TokenSymbol, atomic: bigint, mid: number) => {
  const h = Number(formatUnits(atomic, TOKENS[sell].decimals))
  return sell === 'USDT' ? h : h / mid
}

export async function tick() {
  const ts = Date.now()
  const [mid, refs] = await Promise.all([midNgnPerUsdt(), referenceRates()])
  const rows: Array<Record<string, unknown>> = []

  async function sample(sell: TokenSymbol, sellAmount: bigint, sizeUsd: number, probe: boolean): Promise<PreviewResult | undefined> {
    const buy: TokenSymbol = sell === 'USDT' ? 'cNGN' : 'USDT'
    const base = { ts, sell, buy, size_usd: Math.round(sizeUsd * 100) / 100, ref_parallel: refs.parallel.rate, ref_official: refs.official.rate, probe: probe ? 1 : 0 }
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
        available_sell: p.availableSellAmount ?? null,
        rate: ok ? effectiveNgnPerUsdt(sell, { takerPays: p.takerPays!, buyAmount: p.buyAmount! }) : null,
      })
      return p
    } catch (e: any) {
      rows.push({ ...base, status: 'error', reason: e instanceof TextileError ? e.code : String(e.message).slice(0, 120),
        sell_amount: sellAmount.toString(), buy_amount: null, taker_pays: null, fee_amount: null, available_sell: null, rate: null })
    }
  }

  for (const sell of ['USDT', 'cNGN'] as TokenSymbol[]) {
    let probed = false
    for (const sizeUsd of config.sentinel.sizesUsd) {
      const human = sell === 'USDT' ? sizeUsd : sizeUsd * mid
      const sellAmount = parseUnits(human.toFixed(TOKENS[sell].decimals), TOKENS[sell].decimals)
      const p = await sample(sell, sellAmount, sizeUsd, false)

      // First no_quote with known depth in this direction: probe the max fillable size.
      if (!probed && p?.status === 'no_quote' && p.availableSellAmount) {
        probed = true
        const cap = (BigInt(p.availableSellAmount) * BigInt(Math.round(PROBE_FRACTION * 1000))) / 1000n
        const capUsd = toUsd(sell, cap, mid)
        if (cap < sellAmount && capUsd >= MIN_PROBE_USD) await sample(sell, cap, capUsd, true)
      }
    }
  }
  db.transaction(() => rows.forEach((r) => insert.run(r)))()
  return { mid, refs, rows }
}

function fmt(r: Record<string, unknown>) {
  const rate = r.rate ? (r.rate as number).toFixed(2) : '   -   '
  const size = `$${r.size_usd}`.padEnd(8)
  const tag = r.probe ? '  <- max fillable now' : ''
  return `${String(r.sell).padEnd(4)} -> ${String(r.buy).padEnd(4)} ${size} ${rate} NGN/USDT  ${r.status}${r.reason ? ` (${r.reason})` : ''}${tag}`
}

async function main() {
  const once = process.argv.includes('--once')
  console.log(`Quote Sentinel: sizes $${config.sentinel.sizesUsd.join(', $')} every ${config.sentinel.intervalSec}s${once ? ' (once)' : ''}`)
  for (;;) {
    try {
      const { mid, refs, rows } = await tick()
      console.log(`\n${new Date().toISOString()}  Textile mid ${mid.toFixed(2)} | ${refs.parallel.label}: ${refs.parallel.rate ?? 'n/a'} | ${refs.official.label}: ${refs.official.rate?.toFixed(2) ?? 'n/a'}`)
      rows.forEach((r) => console.log('  ' + fmt(r)))
    } catch (e: any) {
      console.error('tick failed:', e.message)
    }
    if (once) break
    await sleep(config.sentinel.intervalSec * 1000)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
