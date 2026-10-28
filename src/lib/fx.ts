/** Shared FX helpers: parsing user amounts, previews, savings maths and formatting. */
import { formatUnits, parseUnits } from 'viem'
import { TOKENS, type TokenSymbol } from './config.js'
import { effectiveNgnPerUsdt, textile, type PreviewResult } from './textile.js'
import { referenceRates } from './reference.js'

export const other = (t: TokenSymbol): TokenSymbol => (t === 'USDT' ? 'cNGN' : 'USDT')

/** "50", "50 usdt", "20000 cngn", "20k ngn", "1,000" -> { amount, token }. Defaults to USDT. */
export function parseAmount(text: string): { amount: number; token: TokenSymbol } | null {
  const m = text.trim().toLowerCase().replace(/,/g, '').match(/^([0-9]*\.?[0-9]+)\s*(k)?\s*(usdt|usd|\$|cngn|ngn|naira|₦)?$/)
  if (!m) return null
  const amount = Number(m[1]) * (m[2] ? 1000 : 1)
  if (!(amount > 0)) return null
  const token: TokenSymbol = m[3] && ['cngn', 'ngn', 'naira', '₦'].includes(m[3]) ? 'cNGN' : 'USDT'
  return { amount, token }
}

export const toAtomic = (amount: number, t: TokenSymbol) => parseUnits(amount.toFixed(TOKENS[t].decimals), TOKENS[t].decimals)
export const fromAtomic = (atomic: string | bigint, t: TokenSymbol) => Number(formatUnits(BigInt(atomic), TOKENS[t].decimals))

export interface Preview {
  sell: TokenSymbol; buy: TokenSymbol; sellAmount: bigint
  ok: boolean; reason?: string; maxSell?: number
  pays?: number; receives?: number; fee?: number; rate?: number
  usd: number
  refs: Awaited<ReturnType<typeof referenceRates>>
}

/** Indicative Textile price for spending `amount` of `sell`. Never reserves liquidity. */
export async function preview(sell: TokenSymbol, amount: number): Promise<Preview> {
  const buy = other(sell)
  const sellAmount = toAtomic(amount, sell)
  const [p, refs] = await Promise.all([textile.preview({ sell, buy, sellAmount }), referenceRates()])
  const base = { sell, buy, sellAmount, refs }
  if (p.status !== 'preview' || !p.takerPays || !p.buyAmount) {
    const maxSell = p.availableSellAmount ? fromAtomic(p.availableSellAmount, sell) : undefined
    const usd = sell === 'USDT' ? amount : amount / (refs.official.rate ?? 1400)
    return { ...base, ok: false, reason: p.reason ?? 'no_quote', maxSell, usd }
  }
  const rate = effectiveNgnPerUsdt(sell, { takerPays: p.takerPays, buyAmount: p.buyAmount })
  const pays = fromAtomic(p.takerPays, sell)
  const receives = fromAtomic(p.buyAmount, buy)
  return { ...base, ok: true, pays, receives, fee: fromAtomic(p.feeAmount ?? '0', sell), rate, usd: sell === 'USDT' ? pays : receives }
}

/**
 * Naira the user is better off by, versus converting at `ref` (NGN per USD).
 *  selling USDT: got `rate` naira per dollar instead of `ref`  -> (rate - ref) * usd
 *  buying USDT:  paid `rate` naira per dollar instead of `ref` -> (ref - rate) * usd
 */
export function savingsNgn(sell: TokenSymbol, rate: number, usd: number, ref: number | null | undefined): number | null {
  if (!ref) return null
  return (sell === 'USDT' ? rate - ref : ref - rate) * usd
}

// ---------- formatting (plain text, Telegram-friendly) ----------
export const ngn = (n: number) => `₦${Math.round(n).toLocaleString('en-US')}`
export const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const fmtToken = (n: number, t: TokenSymbol) => (t === 'USDT' ? `${usd(n)} USDT` : `${ngn(n)} cNGN`)
export const fmtRate = (r: number) => r.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const signedNgn = (n: number) => `${n >= 0 ? '+' : '-'}${ngn(Math.abs(n))}`
