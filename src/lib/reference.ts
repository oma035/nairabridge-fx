/**
 * Reference NGN-per-USD rates shown next to Textile. Each source is configurable
 * and always carries a human label so the board never shows an unlabelled number.
 */
import 'dotenv/config'

export interface RefRate { kind: 'parallel' | 'official'; label: string; rate: number | null; fetchedAt: number; error?: string }

function pick(obj: any, path: string): unknown {
  return path.split('.').filter(Boolean).reduce((o, k) => (o == null ? undefined : o[k]), obj)
}

async function load(kind: RefRate['kind']): Promise<RefRate> {
  const P = kind === 'parallel' ? 'REF_PARALLEL' : 'REF_OFFICIAL'
  const mode = process.env[`${P}_MODE`] ?? 'static'
  const label = process.env[`${P}_LABEL`] ?? kind
  const fetchedAt = Date.now()
  try {
    if (mode === 'static') {
      const v = Number(process.env[`${P}_STATIC`])
      return { kind, label, rate: v > 0 ? v : null, fetchedAt, error: v > 0 ? undefined : 'not set' }
    }
    const url = process.env[`${P}_URL`]
    if (!url) throw new Error('URL not set')
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const v = Number(pick(await res.json(), process.env[`${P}_PATH`] ?? ''))
    if (!(v > 0)) throw new Error('no numeric value at path')
    return { kind, label, rate: v, fetchedAt }
  } catch (e: any) {
    return { kind, label, rate: null, fetchedAt, error: e.message }
  }
}

let cache: { at: number; refs: RefRate[] } | undefined
/** Cached for 10 minutes so the Sentinel loop doesn't hammer free APIs. */
export async function referenceRates(): Promise<{ parallel: RefRate; official: RefRate }> {
  if (!cache || Date.now() - cache.at > 600_000) cache = { at: Date.now(), refs: await Promise.all([load('parallel'), load('official')]) }
  return { parallel: cache.refs[0], official: cache.refs[1] }
}
