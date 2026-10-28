/**
 * Public, read-only data feed for the Quote Sentinel rate board (consumed by the Lovable front end).
 *   GET /api/board                    live snapshot, stats, P&L, recent fills
 *   GET /api/board/history?range=24h  time series (24h | 7d) for charts
 * No user identities or wallets are exposed; fills show only amounts, rate and tx hash.
 */
import { db } from '../lib/db.js'
import { config, ERC8004, TEXTILE_CELO } from '../lib/config.js'
import { referenceRates } from '../lib/reference.js'
import { fromAtomic, savingsNgn } from '../lib/fx.js'
import type { Fill } from '../lib/store.js'

const AGENT = {
  name: 'NairaBridge FX',
  agentId: 9998,
  registry: ERC8004.identityRegistry,
  wallet: '0x1663a732de275506b569a92A90233be582288906',
  attributionCode: () => process.env.ATTRIBUTION_CODE ?? null,
  repo: 'https://github.com/oma035/nairabridge-fx',
  bot: 'https://t.me/NairaBridgeFX_bot',
  reactor: TEXTILE_CELO.limitOrderReactor,
  takerFeeBps: TEXTILE_CELO.takerFeeBps,
}

interface QuoteRow {
  ts: number; sell: 'USDT' | 'cNGN'; buy: 'USDT' | 'cNGN'; size_usd: number; status: string; reason: string | null
  sell_amount: string | null; buy_amount: string | null; taker_pays: string | null; fee_amount: string | null
  rate_ngn_usdt: number | null; available_sell: string | null; probe: number
}

const r2 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100)

function latestTick(): QuoteRow[] {
  const last = db.prepare(`SELECT MAX(ts) AS ts FROM quotes WHERE source = 'sentinel'`).get() as { ts: number | null }
  if (!last?.ts) return []
  return db.prepare(`SELECT * FROM quotes WHERE source = 'sentinel' AND ts = ? ORDER BY sell, probe, size_usd`).all(last.ts) as QuoteRow[]
}

/** Largest USD amount fillable right now per direction, from the latest tick. null = no limit seen. */
function depth(rows: QuoteRow[]) {
  const out: Record<'USDT' | 'cNGN', { maxUsd: number | null; limited: boolean }> = { USDT: { maxUsd: null, limited: false }, cNGN: { maxUsd: null, limited: false } }
  for (const side of ['USDT', 'cNGN'] as const) {
    const mine = rows.filter((r) => r.sell === side)
    const blocked = mine.find((r) => r.status === 'no_quote' && r.available_sell)
    if (blocked) {
      const avail = fromAtomic(blocked.available_sell!, side)
      const mid = mine.find((r) => r.rate_ngn_usdt)?.rate_ngn_usdt ?? 1400
      out[side] = { maxUsd: r2(side === 'USDT' ? avail : avail / mid), limited: true }
    } else {
      const ok = mine.filter((r) => r.status === 'preview').map((r) => r.size_usd)
      out[side] = { maxUsd: ok.length ? Math.max(...ok) : null, limited: false } // filled every size we tried
    }
  }
  return out
}

function pnl(fills: Fill[]) {
  type Acc = { count: number; volumeUsd: number; vsOfficialNgn: number | null; vsParallelNgn: number | null; vsSingleShotNgn: number | null }
  const add = (a: number | null, b: number | null) => (b === null ? a : (a ?? 0) + b) // null = reference never available
  const empty = (): Acc => ({ count: 0, volumeUsd: 0, vsOfficialNgn: null, vsParallelNgn: null, vsSingleShotNgn: null })
  const by: Record<string, Acc> = {}
  const total = empty()
  for (const f of fills) {
    const usd = f.sell === 'USDT' ? fromAtomic(f.sell_amount, 'USDT') : fromAtomic(f.buy_amount, 'USDT')
    for (const s of [(by[f.strategy] ??= empty()), total]) {
      s.count++
      s.volumeUsd += usd
      s.vsOfficialNgn = add(s.vsOfficialNgn, savingsNgn(f.sell, f.rate_ngn_usdt, usd, f.ref_official))
      s.vsParallelNgn = add(s.vsParallelNgn, savingsNgn(f.sell, f.rate_ngn_usdt, usd, f.ref_parallel))
      s.vsSingleShotNgn = add(s.vsSingleShotNgn, savingsNgn(f.sell, f.rate_ngn_usdt, usd, f.single_shot_rate))
    }
  }
  const round = (s: Acc) => ({ count: s.count, volumeUsd: r2(s.volumeUsd), vsOfficialNgn: r2(s.vsOfficialNgn), vsParallelNgn: r2(s.vsParallelNgn), vsSingleShotNgn: r2(s.vsSingleShotNgn) })
  return {
    note: 'Naira the users gained versus converting at each reference rate captured at request time (positive = better for the user; null = reference not available).',
    total: round(total),
    byStrategy: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, round(v)])),
  }
}

let cache: { at: number; data: unknown } | undefined

export async function boardSnapshot() {
  if (cache && Date.now() - cache.at < 15_000) return cache.data
  const rows = latestTick()
  const refs = await referenceRates()
  const fills = db.prepare(`SELECT * FROM fills WHERE status = 'filled' ORDER BY ts DESC`).all() as Fill[]

  const rates = rows.filter((r) => !r.probe).map((r) => ({
    sizeUsd: r.size_usd, sell: r.sell, buy: r.buy, status: r.status, reason: r.reason,
    rate: r2(r.rate_ngn_usdt),
    pays: r.taker_pays ? r2(fromAtomic(r.taker_pays, r.sell)) : null,
    receives: r.buy_amount ? r2(fromAtomic(r.buy_amount, r.buy)) : null,
    fee: r.fee_amount ? Math.round(fromAtomic(r.fee_amount, r.sell) * 1e4) / 1e4 : null,
  }))

  // headline: closest size to $100 that quoted in each direction
  const pick = (side: 'USDT' | 'cNGN') => rates.filter((r) => r.sell === side && r.rate)
    .sort((a, b) => Math.abs(a.sizeUsd - 100) - Math.abs(b.sizeUsd - 100))[0]
  const sellUsdt = pick('USDT'), buyUsdt = pick('cNGN')
  const spreadBps = sellUsdt?.rate && buyUsdt?.rate ? r2(((buyUsdt.rate - sellUsdt.rate) / sellUsdt.rate) * 10_000) : null
  const on100 = (ref: number | null) => (sellUsdt?.rate && ref ? r2((sellUsdt.rate - ref) * 100) : null)

  const q = db.prepare(`SELECT
      SUM(CASE WHEN source='sentinel' AND status='preview' THEN size_usd ELSE 0 END) AS previewUsd,
      SUM(CASE WHEN source='sentinel' THEN 1 ELSE 0 END) AS previews,
      SUM(CASE WHEN source='user' AND status='quoted' THEN size_usd ELSE 0 END) AS firmUsd,
      SUM(CASE WHEN source='user' AND status='quoted' THEN 1 ELSE 0 END) AS firm,
      MIN(ts) AS since
    FROM quotes`).get() as any
  const u = db.prepare(`SELECT COUNT(*) AS users, SUM(wallet IS NOT NULL) AS linked, SUM(eligible = 1) AS eligible,
      (SELECT COUNT(DISTINCT user_id) FROM fills WHERE status='filled') AS converting FROM users`).get() as any
  const filledUsd = fills.reduce((a, f) => a + (f.sell === 'USDT' ? fromAtomic(f.sell_amount, 'USDT') : fromAtomic(f.buy_amount, 'USDT')), 0)

  const data = {
    updatedAt: rows[0]?.ts ?? null,
    intervalSec: config.sentinel.intervalSec,
    pair: 'cNGN/USDT', chain: { id: 42220, name: 'Celo' },
    headline: {
      sellUsdt: sellUsdt ? { sizeUsd: sellUsdt.sizeUsd, rate: sellUsdt.rate } : null,  // naira you get per $1
      buyUsdt: buyUsdt ? { sizeUsd: buyUsdt.sizeUsd, rate: buyUsdt.rate } : null,      // naira you pay per $1
      spreadBps,
      extraNgnPer100: { vsOfficial: on100(refs.official.rate), vsParallel: on100(refs.parallel.rate) },
    },
    references: {
      official: { label: refs.official.label, rate: r2(refs.official.rate) },
      parallel: { label: refs.parallel.label, rate: r2(refs.parallel.rate) },
    },
    rates,
    depth: depth(rows),
    stats: {
      since: q.since ?? null,
      indicativeQuotes: q.previews ?? 0,
      volumeQuotedUsd: { indicative: r2(q.previewUsd ?? 0), firm: r2(q.firmUsd ?? 0) },
      firmQuotes: q.firm ?? 0,
      volumeFilledUsd: r2(filledUsd),
      fills: fills.length,
      users: { total: u.users ?? 0, linkedWallets: u.linked ?? 0, eligible: u.eligible ?? 0, converting: u.converting ?? 0 },
    },
    pnl: pnl(fills),
    recentFills: fills.slice(0, 10).map((f) => ({
      ts: f.ts, sell: f.sell, buy: f.buy, strategy: f.strategy,
      pays: r2(fromAtomic(f.sell_amount, f.sell)), receives: r2(fromAtomic(f.buy_amount, f.buy)),
      rate: r2(f.rate_ngn_usdt), txHash: f.tx_hash, explorer: `https://celoscan.io/tx/${f.tx_hash}`,
    })),
    agent: { ...AGENT, attributionCode: AGENT.attributionCode() },
  }
  cache = { at: Date.now(), data }
  return data
}

/** Bucketed history for charts. 24h -> 10-minute buckets, 7d -> 1-hour buckets. */
export function boardHistory(range: string) {
  const r = range === '7d' ? '7d' : '24h'
  const span = r === '7d' ? 7 * 86_400_000 : 86_400_000
  const bucket = r === '7d' ? 3_600_000 : 600_000
  const from = Date.now() - span
  const rows = db.prepare(`SELECT CAST(ts / ? AS INTEGER) * ? AS t, sell,
        AVG(CASE WHEN status='preview' AND size_usd <= 200 THEN rate_ngn_usdt END) AS rate,  -- any size that filled, so thin-liquidity periods still chart
        AVG(ref_official) AS official, AVG(ref_parallel) AS parallel,
        MAX(CASE WHEN status='preview' THEN size_usd END) AS maxOkUsd,
        SUM(status='no_quote') AS blocked
      FROM quotes WHERE source='sentinel' AND ts >= ? GROUP BY t, sell ORDER BY t`).all(bucket, bucket, from) as any[]
  const map = new Map<number, any>()
  for (const x of rows) {
    const p = map.get(x.t) ?? { t: x.t, sellUsdtRate: null, buyUsdtRate: null, official: null, parallel: null, depthSellUsdtUsd: null, depthBuyUsdtUsd: null }
    if (x.sell === 'USDT') { p.sellUsdtRate = r2(x.rate); p.depthSellUsdtUsd = r2(x.maxOkUsd) } else { p.buyUsdtRate = r2(x.rate); p.depthBuyUsdtUsd = r2(x.maxOkUsd) }
    p.official = r2(x.official ?? p.official); p.parallel = r2(x.parallel ?? p.parallel)
    map.set(x.t, p)
  }
  return { range: r, bucketMs: bucket, points: [...map.values()] }
}
