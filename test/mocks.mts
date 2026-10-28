// Shared network mocks for tests: Telegram, Textile, Blockscout and Celo RPC.
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { toHex } from 'viem'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const S = mkdtempSync(join(tmpdir(), 'nbfx-'))
Object.assign(process.env, {
  ATTRIBUTION_CODE: 'celo_f91a4dd61bbc', DB_PATH: `${S}/e2e.db`, TELEGRAM_BOT_TOKEN: '123:abc', PUBLIC_URL: 'https://nb.example',
  REF_PARALLEL_MODE: 'static', REF_PARALLEL_STATIC: '1460', REF_PARALLEL_LABEL: 'Parallel (manual)',
  REF_OFFICIAL_MODE: 'static', REF_OFFICIAL_STATIC: '1353.43', REF_OFFICIAL_LABEL: 'Mid-market', PORT: '18787', RUN_SENTINEL: '0',
})
export const user = privateKeyToAccount(generatePrivateKey())
export const REACTOR = '0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3'
export const tg: any[] = []
export const state = { swapInput: '', requestCalls: 0 }
export const realFetch = globalThis.fetch
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url); const ok = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s })
  if (u.startsWith('http://127.0.0.1')) return realFetch(url, init)
  if (u.includes('api.telegram.org')) { const m = u.split('/').pop(); const b = init?.body ? JSON.parse(init.body) : {}; tg.push({ m, ...b }); return ok({ ok: true, result: m === 'getMe' ? { id: 1, is_bot: true, first_name: 'NB', username: 'nb_bot' } : { message_id: tg.length, date: 0, chat: { id: 1, type: 'private' } } }) }
  if (u.includes('blockscout')) return ok({ status: '1', result: [{ timeStamp: String(Date.UTC(2026, 6, 1) / 1000) }] })
  if (u.includes('/v2/rfq/preview')) { const b = JSON.parse(init.body); const sell = BigInt(b.sellAmount); const fee = sell / 10000n; const isU = b.sellToken.startsWith('0x4806'); return ok({ data: { status: 'preview', sellAmount: b.sellAmount, takerPays: b.sellAmount, feeAmount: fee.toString(), buyAmount: (isU ? (sell - fee) * 138402n / 100n : (sell - fee) * 100n / 138458n).toString() } }) }
  if (u.includes('/v2/rfq/request')) {
    state.requestCalls++; const b = JSON.parse(init.body)
    if (!b.takerProof) return ok({ error: { code: 'unauthorized', message: 'proof required', details: { reason: 'proof_of_control_required' } } }, 401)
    const sell = BigInt(b.sellAmount); const fee = sell / 10000n
    return ok({ data: { rfqId: 'rfq_1', claimToken: 'rfqc_1', status: 'quoted', quote: { sellAmount: b.sellAmount, takerPays: b.sellAmount, feeAmount: fee.toString(), buyAmount: ((sell - fee) * 138402n / 100n).toString(), rateRay: '0', expiresAt: new Date(Date.now() + 30000).toISOString(), orderDeadline: '', latestOrderDeadline: '', reactor: REACTOR, taker: b.taker, orders: [{}] },
      transactions: { approval: { to: b.sellToken, data: '0x095ea7b3', value: '0', chainId: 42220 }, swap: { to: REACTOR, data: '0xdeadbeef', value: '0', chainId: 42220 } } } })
  }
  if (u.includes('/submit')) return ok({ data: { status: 'submitted' } })
  if (u.includes('forno')) return ok(rpc(JSON.parse(init.body)))
  throw new Error('unmocked fetch ' + u)
}) as any

/** Celo JSON-RPC mock (single or batch). */
export function rpc(body: any) {
    const many = Array.isArray(body); const reqs = many ? body : [body]
    const res = reqs.map((r: any) => {
      let result: any
      switch (r.method) {
        case 'eth_chainId': result = '0xa4ec'; break
        case 'eth_blockNumber': result = '0x100'; break
        case 'eth_call': { const sel = r.params[0].data.slice(0, 10); result = sel === '0xdd62ed3e' ? toHex(0n, { size: 32 }) : toHex(10n ** 12n, { size: 32 }); break }
        case 'eth_getTransactionReceipt': result = { blockHash: '0x' + '1'.repeat(64), blockNumber: '0xff', contractAddress: null, cumulativeGasUsed: '0x1', effectiveGasPrice: '0x1', from: user.address, gasUsed: '0x1', logs: [], logsBloom: '0x' + '0'.repeat(512), status: '0x1', to: REACTOR, transactionHash: r.params[0], transactionIndex: '0x0', type: '0x0' }; break
        case 'eth_getTransactionByHash': result = { hash: r.params[0], from: user.address, to: REACTOR, input: state.swapInput, nonce: '0x1', value: '0x0', gas: '0x1', gasPrice: '0x1', blockHash: '0x' + '1'.repeat(64), blockNumber: '0xff', transactionIndex: '0x0', type: '0x0', v: '0x1b', r: '0x1', s: '0x1', chainId: '0xa4ec' }; break
        default: throw new Error('unmocked rpc ' + r.method)
      }
      return { jsonrpc: '2.0', id: r.id, result }
    })
    return many ? res : res[0]
}

