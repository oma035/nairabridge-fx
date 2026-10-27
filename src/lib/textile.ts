/**
 * Textile FX v2 RFQ client. Docs: https://docs.textilecredit.com/api/v2/rfq.html
 *
 * - preview:  indicative price, no taker, no slot, no key. Used by the Sentinel.
 * - request:  firm quote bound to the user's wallet (taker). Blocks up to ~70s.
 * - submit:   report the tx hash the user broadcast (courtesy; fills reconcile on-chain anyway).
 * - status:   GET /v2/rfq/{id}
 *
 * Limits (docs, Errors & limits): 60 req/min per key or IP, max 4 outstanding firm RFQs.
 */
import { formatUnits, type Address, type Hex } from 'viem'
import { CHAIN_ID, TEXTILE_CELO, TOKENS, config, type TokenSymbol } from './config.js'

// ---------- types (shapes from the RFQ docs) ----------
export type Routing = Record<string, unknown>

export interface PreviewResult {
  status: 'preview' | 'no_quote'
  sellAmount?: string
  buyAmount?: string
  feeAmount?: string
  takerPays?: string
  rateRay?: string
  availableSellAmount?: string
  availableBuyAmount?: string
  reason?: 'no_makers_online' | 'no_restricted_liquidity' | 'no_valid_quote'
  reservedUntil?: string
  retryAfterMs?: number
}

export interface TxRequest { to: Address; data: Hex; value: string; chainId: number }

export interface FirmQuote {
  rfqId: string
  claimToken: string
  status: 'quoted' | 'no_quote'
  reason?: string
  availableSellAmount?: string
  retryAfterMs?: number
  quote?: {
    sellAmount: string
    buyAmount: string
    feeAmount: string
    takerPays: string
    rateRay: string
    expiresAt: string
    orderDeadline: string
    latestOrderDeadline: string
    reactor: Address
    taker: Address
    orders: Array<{ sellAmount: string; buyAmount: string; feeAmount: string; maker: Address }>
  }
  transactions?: { approval: TxRequest; swap: TxRequest }
}

export interface TakerProof { nonce: Hex; issuedAt: number; signature: Hex; scheme?: 'eip191' }

export class TextileError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown, public retryAfterMs?: number) {
    super(`[textile ${status} ${code}] ${message}`)
  }
  get transient() { return [429, 500, 502, 503].includes(this.status) }
}

// ---------- simple client-side rate limiter (stay under 60/min) ----------
const MAX_PER_MIN = 45
const stamps: number[] = []
async function throttle() {
  for (;;) {
    const now = Date.now()
    while (stamps.length && now - stamps[0] > 60_000) stamps.shift()
    if (stamps.length < MAX_PER_MIN) { stamps.push(now); return }
    await sleep(60_000 - (now - stamps[0]) + 50)
  }
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown, opts: { timeoutMs?: number; claim?: string } = {}): Promise<T> {
  await throttle()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.textile.apiKey) headers.Authorization = `Bearer ${config.textile.apiKey}`
  if (opts.claim) headers['X-Rfq-Claim'] = opts.claim
  const res = await fetch(`${config.textile.base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok) {
    const ra = res.headers.get('retry-after')
    throw new TextileError(res.status, json?.error?.code ?? 'unknown', json?.error?.message ?? res.statusText, json?.error?.details, ra ? Number(ra) * 1000 : undefined)
  }
  return json.data as T
}

/** Retry transient errors (429/5xx) with exponential backoff, honouring Retry-After. */
export async function withBackoff<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let delay = 2_000
  for (let i = 0; ; i++) {
    try { return await fn() } catch (e) {
      if (!(e instanceof TextileError) || !e.transient || i >= tries - 1) throw e
      await sleep(e.retryAfterMs ?? delay)
      delay *= 2
    }
  }
}

// ---------- endpoints ----------
type Leg = { sell: TokenSymbol; buy: TokenSymbol } & ({ sellAmount: bigint } | { buyAmount: bigint })

function legBody(leg: Leg) {
  return {
    chainId: CHAIN_ID,
    sellToken: TOKENS[leg.sell].address,
    buyToken: TOKENS[leg.buy].address,
    ...('sellAmount' in leg ? { sellAmount: leg.sellAmount.toString() } : { buyAmount: leg.buyAmount.toString() }),
  }
}

export const textile = {
  preview: (leg: Leg) => withBackoff(() => call<PreviewResult>('POST', '/v2/rfq/preview', legBody(leg))),

  /** Firm quote for the user's wallet. Without an API key, pass a takerProof signed by the user. */
  request: (leg: Leg & { taker: Address; takerProof?: TakerProof }) =>
    call<FirmQuote>('POST', '/v2/rfq/request', { ...legBody(leg), taker: leg.taker, ...(leg.takerProof ? { takerProof: leg.takerProof } : {}) }, { timeoutMs: 75_000 }),

  submit: (rfqId: string, txHash: Hex, claim?: string) =>
    withBackoff(() => call<{ status: string }>('POST', `/v2/rfq/${rfqId}/submit`, { txHash }, { claim })),

  cancel: (rfqId: string, claim?: string) => call<{ status: string }>('POST', `/v2/rfq/${rfqId}/cancel`, {}, { claim }),

  status: (rfqId: string, claim?: string) => withBackoff(() => call<Record<string, any>>('GET', `/v2/rfq/${rfqId}`, undefined, { claim })),

  /** Public no-auth rates feed (CoinGecko tickers format). */
  tickers: async (tickerId = 'USDT_NGN') => {
    const res = await fetch(`${config.textile.base}/tickers?ticker_id=${tickerId}`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`tickers ${res.status}`)
    return (await res.json()) as Array<{ ticker_id: string; last_price: string; bid: string; ask: string; base_volume: string; target_volume: string }>
  },
}

/** Refuse to hand a user a swap that doesn't target the address-book reactor. */
export function assertSafeQuote(q: FirmQuote) {
  const want = TEXTILE_CELO.limitOrderReactor.toLowerCase()
  if (q.quote?.reactor.toLowerCase() !== want) throw new Error(`reactor mismatch: ${q.quote?.reactor}`)
  if (q.transactions?.swap.to.toLowerCase() !== want) throw new Error(`swap target mismatch: ${q.transactions?.swap.to}`)
  if (q.transactions?.swap.value !== '0') throw new Error('swap must carry zero value')
  if (q.transactions.swap.chainId !== CHAIN_ID) throw new Error('wrong chain')
}

// ---------- rate maths ----------
const units = (amt: string, sym: TokenSymbol) => Number(formatUnits(BigInt(amt), TOKENS[sym].decimals))

/**
 * Effective all-in rate in NGN per USDT, fee included (uses takerPays, the exact debit).
 *  USDT -> cNGN: naira received per dollar paid   (higher is better for the user)
 *  cNGN -> USDT: naira paid per dollar received   (lower is better for the user)
 */
export function effectiveNgnPerUsdt(sell: TokenSymbol, q: { takerPays: string; buyAmount: string }): number {
  const paid = units(q.takerPays, sell)
  const got = units(q.buyAmount, sell === 'USDT' ? 'cNGN' : 'USDT')
  return sell === 'USDT' ? got / paid : paid / got
}

export function feeInSellUnits(sell: TokenSymbol, feeAmount: string) { return units(feeAmount, sell) }
