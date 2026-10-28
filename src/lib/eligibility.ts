/**
 * Hackathon user rule: a counted user's wallet must have had Celo activity before 6 Oct 2026.
 * We look up the wallet's earliest transaction (sent, or token received) on a Blockscout
 * explorer API. Result is evidence we store and show; it never blocks the user.
 */
import { ELIGIBILITY_CUTOFF_MS, config } from './config.js'

async function firstTs(action: 'txlist' | 'tokentx', address: string): Promise<number | null> {
  const url = `${config.explorerApi}?module=account&action=${action}&address=${address}&sort=asc&page=1&offset=1`
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`explorer HTTP ${res.status}`)
  const j: any = await res.json()
  const ts = Number(j?.result?.[0]?.timeStamp)
  return ts > 0 ? ts * 1000 : null
}

export interface Eligibility { eligible: boolean | null; firstTs: number | null; note: string }

export async function checkEligibility(address: string): Promise<Eligibility> {
  try {
    const [a, b] = await Promise.all([firstTs('txlist', address), firstTs('tokentx', address)])
    const first = [a, b].filter((x): x is number => x !== null).sort((x, y) => x - y)[0] ?? null
    if (first === null) return { eligible: false, firstTs: null, note: 'no Celo activity found' }
    const day = new Date(first).toISOString().slice(0, 10)
    return first < ELIGIBILITY_CUTOFF_MS
      ? { eligible: true, firstTs: first, note: `active on Celo since ${day}` }
      : { eligible: false, firstTs: first, note: `first Celo activity ${day}, after 6 Oct` }
  } catch (e: any) {
    return { eligible: null, firstTs: null, note: `could not check (${e.message})` }
  }
}
