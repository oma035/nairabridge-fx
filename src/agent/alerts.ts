/**
 * Rate alerts. A user asks to be told when Textile's fee-inclusive rate for their amount
 * beats a target. After each Sentinel run the agent previews every distinct (direction, amount)
 * once, fires the alerts that are met, and hands the user a one-tap convert link.
 *
 *  cash out (sell USDT): fires when naira received per $1 >= target
 *  top up   (sell cNGN): fires when naira paid per $1     <= target
 *
 * The rate when the alert was set is stored, so an alert-triggered conversion can be scored
 * against "converting right away instead of waiting" (the alert strategy's P&L).
 */
import { InlineKeyboard } from 'grammy'
import { db } from '../lib/db.js'
import { config, type TokenSymbol } from '../lib/config.js'
import { createSession, getUser } from '../lib/store.js'
import { fmtRate, fmtToken, fromAtomic, other, preview, toAtomic } from '../lib/fx.js'
import { notify } from '../bot/notify.js'

export const MAX_ACTIVE_PER_USER = 5
export const ALERT_TTL_MS = 7 * 86_400_000
const CONVERT_TTL = 15 * 60_000
const MAX_PREVIEWS_PER_RUN = 20 // stay well inside Textile's 60 req/min next to the Sentinel

export interface Alert {
  id: number; user_id: number; sell: TokenSymbol; amount: string; target_rate: number
  created_at: number; fired_at: number | null; created_rate: number | null; expires_at: number
  cancelled_at: number | null; fired_rate: number | null
}

export const isMet = (sell: TokenSymbol, rate: number, target: number) => (sell === 'USDT' ? rate >= target : rate <= target)
export const describeAlert = (a: Pick<Alert, 'sell' | 'amount' | 'target_rate'>) =>
  a.sell === 'USDT'
    ? `cash out ${fmtToken(fromAtomic(a.amount, 'USDT'), 'USDT')} at ≥ ${fmtRate(a.target_rate)} NGN/USDT`
    : `top up with ${fmtToken(fromAtomic(a.amount, 'cNGN'), 'cNGN')} at ≤ ${fmtRate(a.target_rate)} NGN/USDT`

export function activeAlerts(userId: number): Alert[] {
  return db.prepare(`SELECT * FROM alerts WHERE user_id = ? AND fired_at IS NULL AND cancelled_at IS NULL AND expires_at > ? ORDER BY id`)
    .all(userId, Date.now()) as Alert[]
}

export function createAlert(userId: number, sell: TokenSymbol, amount: number, target: number, currentRate: number | null): Alert {
  if (activeAlerts(userId).length >= MAX_ACTIVE_PER_USER) throw new Error(`You already have ${MAX_ACTIVE_PER_USER} active alerts. Cancel one in /alerts first.`)
  const now = Date.now()
  const info = db.prepare(`INSERT INTO alerts (user_id, sell, amount, target_rate, created_at, created_rate, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, sell, toAtomic(amount, sell).toString(), target, now, currentRate, now + ALERT_TTL_MS)
  return db.prepare('SELECT * FROM alerts WHERE id = ?').get(info.lastInsertRowid) as Alert
}

export function cancelAlert(userId: number, id: number): boolean {
  return db.prepare('UPDATE alerts SET cancelled_at = ? WHERE id = ? AND user_id = ? AND fired_at IS NULL AND cancelled_at IS NULL')
    .run(Date.now(), id, userId).changes > 0
}

export const getAlert = (id: number) => db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as Alert | undefined

/** Build the "your alert hit" message and its buttons. Exported for the immediate-hit case too. */
export function firedMessage(a: Alert, rate: number, receives: number, hasWallet: boolean) {
  const sell = a.sell
  const amount = fromAtomic(a.amount, sell)
  const kb = new InlineKeyboard()
  if (hasWallet) {
    const token = createSession('convert', a.user_id, {
      sell, buy: other(sell), sellAmount: a.amount, strategy: 'alert', parentId: `alert:${a.id}`,
      previewRate: a.created_rate ?? rate, // benchmark = converting when the alert was set
    }, CONVERT_TTL)
    kb.url(`✍️ Convert ${fmtToken(amount, sell)} now`, `${config.publicUrl()}/c/${token}`).row()
  }
  kb.text('🔁 Set again', `rearm:${a.id}`)
  const waited = a.created_rate ? (sell === 'USDT' ? rate - a.created_rate : a.created_rate - rate) * (sell === 'USDT' ? amount : receives) : null
  const text = [
    `🔔 Alert hit: ${describeAlert(a)}`,
    '',
    `Now: ${fmtToken(amount, sell)} → ${fmtToken(receives, other(sell))}`,
    `Rate ${fmtRate(rate)} NGN/USDT (fee included)`,
    waited !== null ? `vs when you set it (${fmtRate(a.created_rate!)}): ₦${Math.round(Math.abs(waited)).toLocaleString('en-US')} ${waited >= 0 ? 'better' : 'worse'}` : '',
    '',
    hasWallet ? 'Rates move fast: the link works for 15 minutes and locks a firm quote before you sign.' : 'Link a wallet with /link to convert in one tap next time.',
  ].filter((l, i, arr) => l !== '' || arr[i - 1] !== '').join('\n')
  return { text, kb }
}

/** One pass: expire stale alerts, preview each distinct (sell, amount), fire the ones that are met. */
export async function checkAlerts(): Promise<{ checked: number; fired: number }> {
  const now = Date.now()
  const live = db.prepare(`SELECT * FROM alerts WHERE fired_at IS NULL AND cancelled_at IS NULL AND expires_at > ? ORDER BY id`).all(now) as Alert[]
  const groups = new Map<string, Alert[]>()
  for (const a of live) {
    const k = `${a.sell}:${a.amount}`
    groups.set(k, [...(groups.get(k) ?? []), a])
  }
  let checked = 0, fired = 0
  for (const [k, alerts] of [...groups].slice(0, MAX_PREVIEWS_PER_RUN)) {
    const [sell, amount] = k.split(':') as [TokenSymbol, string]
    const p = await preview(sell, fromAtomic(amount, sell)).catch(() => undefined)
    checked++
    if (!p?.ok || !p.rate || !p.receives) continue // no liquidity at this size right now: keep waiting
    for (const a of alerts) {
      if (!isMet(sell, p.rate, a.target_rate)) continue
      // claim it first so a slow Telegram send can never fire it twice
      const claimed = db.prepare('UPDATE alerts SET fired_at = ?, fired_rate = ? WHERE id = ? AND fired_at IS NULL').run(Date.now(), p.rate, a.id).changes
      if (!claimed) continue
      fired++
      const user = getUser(a.user_id)
      if (!user?.tg_chat_id) continue
      const { text, kb } = firedMessage(a, p.rate, p.receives, !!user.wallet)
      await notify(user.tg_chat_id, text, { reply_markup: kb }).catch((e) => console.error('alert notify failed', e.message))
    }
  }
  return { checked, fired }
}

export function alertStats() {
  return db.prepare(`SELECT
      SUM(fired_at IS NULL AND cancelled_at IS NULL AND expires_at > ?) AS active,
      SUM(fired_at IS NOT NULL) AS fired, COUNT(*) AS total FROM alerts`).get(Date.now()) as { active: number | null; fired: number | null; total: number }
}
