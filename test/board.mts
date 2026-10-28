// Rate board feed: shape, depth detection, P&L maths, privacy, CORS.
import { tg, realFetch } from './mocks.mts'
const R = new URL('../src', import.meta.url).pathname
const { db } = await import(`${R}/lib/db.ts`)
const store = await import(`${R}/lib/store.ts`)
const check = (name: string, cond: any) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) process.exitCode = 1 }
void tg

// two sentinel ticks: USDT side blocked above ~$18 in the latest one
const ins = db.prepare(`INSERT INTO quotes (ts, source, kind, sell, buy, size_usd, status, reason, sell_amount, buy_amount, taker_pays, fee_amount, rate_ngn_usdt, ref_parallel, ref_official, available_sell, probe)
  VALUES (?, 'sentinel', 'preview', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1460, 1353.43, ?, ?)`)
const now = Date.now(), old = now - 3 * 3600_000
for (const [ts, blocked] of [[old, false], [now, true]] as const) {
  for (const size of [10, 50, 200]) {
    const usdtBlocked = blocked && size > 18
    ins.run(ts, 'USDT', 'cNGN', size, usdtBlocked ? 'no_quote' : 'preview', usdtBlocked ? 'no_valid_quote' : null, String(size * 1e6),
      usdtBlocked ? null : String(Math.round(size * 1384.02 * 1e6)), usdtBlocked ? null : String(size * 1e6), usdtBlocked ? null : String(size * 100), usdtBlocked ? null : 1384.02, usdtBlocked ? '18657606' : null, 0)
    ins.run(ts, 'cNGN', 'USDT', size, 'preview', null, String(Math.round(size * 1384.58 * 1e6)), String(size * 1e6), String(Math.round(size * 1384.58 * 1e6)), '1', 1384.58, null, 0)
  }
  if (blocked) ins.run(ts, 'USDT', 'cNGN', 18.28, 'preview', null, '18284454', '25300000000', '18284454', '1828', 1383.9, null, 1)
}
// one user + one filled conversion
const u = store.upsertUser(5, 'secretname', 5); store.linkWallet(u.id, '0x00000000000000000000000000000000000000AA'); store.setEligibility(u.id, true, 1, 'ok')
store.insertFill({ ts: now, user_id: u.id, strategy: 'single', parent_id: null, rfq_id: 'r1', sell: 'USDT', buy: 'cNGN', sell_amount: '2000000', buy_amount: '2767920000',
  fee_amount: '200', rate_ngn_usdt: 1383.96, ref_parallel: null, ref_official: 1353.43, single_shot_rate: 1384.02, tx_hash: '0x' + 'ab'.repeat(32), status: 'filled' })

const { startServer } = await import(`${R}/server/http.ts`)
const srv = startServer(18789); await new Promise(r => setTimeout(r, 200))
const res = await realFetch('http://127.0.0.1:18789/api/board')
const b: any = await res.json()
check('board: CORS open', res.headers.get('access-control-allow-origin') === '*')
check('board: latest tick only (no probe rows in rates)', b.rates.length === 6 && b.rates.every((r: any) => r.sizeUsd !== 18.28))
check('board: depth detects USDT limit ~$18.66', b.depth.USDT.limited && Math.abs(b.depth.USDT.maxUsd - 18.66) < 0.01)
check('board: cNGN side unlimited up to largest size', !b.depth.cNGN.limited && b.depth.cNGN.maxUsd === 200)
check('board: headline uses nearest size that quoted', b.headline.sellUsdt.sizeUsd === 10 && b.headline.buyUsdt.sizeUsd === 50)
check('board: spread in bps', b.headline.spreadBps > 3 && b.headline.spreadBps < 5)
check('board: P&L vs official = (1383.96-1353.43)*2', Math.abs(b.pnl.total.vsOfficialNgn - 61.06) < 0.01)
check('board: P&L vs single shot slightly negative', b.pnl.byStrategy.single.vsSingleShotNgn < 0)
check('board: P&L vs parallel is null when never set', b.pnl.total.vsParallelNgn === null)
check('board: small fees not rounded to zero', b.rates[0].fee === 0.001)
check('board: users counted', b.stats.users.total === 1 && b.stats.users.eligible === 1 && b.stats.users.converting === 1)
check('board: filled volume', b.stats.volumeFilledUsd === 2 && b.stats.fills === 1)
check('board: recent fill has explorer link', b.recentFills[0].explorer.includes('celoscan.io/tx/0xabab'))
check('board: no user identity leaked', !JSON.stringify(b).includes('secretname') && !JSON.stringify(b).toLowerCase().includes('00000000000000000000000000000000000000aa'))
const h: any = await (await realFetch('http://127.0.0.1:18789/api/board/history?range=24h')).json()
check('history: two buckets with both directions', h.points.length === 2 && h.points.every((p: any) => p.sellUsdtRate && p.buyUsdtRate))
check('history: depth series shows the drop', h.points[0].depthSellUsdtUsd === 200 && h.points[1].depthSellUsdtUsd === 18.28)
const h7: any = await (await realFetch('http://127.0.0.1:18789/api/board/history?range=7d')).json()
check('history: 7d uses hourly buckets', h7.bucketMs === 3600000 && h7.points.length === 2)
check('history: times aligned to buckets', h.points.every((p: any) => p.t % 600000 === 0) && h7.points.every((p: any) => p.t % 3600000 === 0))
srv.close()
console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED')
process.exit()
