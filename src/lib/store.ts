/** Data access for users, sessions and fills. All SQL lives here or in db.ts. */
import { randomBytes } from 'node:crypto'
import { db } from './db.js'
import type { TokenSymbol } from './config.js'

export interface User {
  id: number
  tg_id: string
  tg_username: string | null
  tg_chat_id: string | null
  wallet: string | null
  linked_at: number | null
  first_celo_tx_ts: number | null
  eligible: number | null
  eligibility_note: string | null
  created_at: number
}

export function upsertUser(tgId: string | number, username: string | undefined, chatId: string | number): User {
  db.prepare(`INSERT INTO users (tg_id, tg_username, tg_chat_id, created_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(tg_id) DO UPDATE SET tg_username = excluded.tg_username, tg_chat_id = excluded.tg_chat_id`)
    .run(String(tgId), username ?? null, String(chatId), Date.now())
  return getUserByTg(tgId)!
}

export const getUserByTg = (tgId: string | number) =>
  db.prepare('SELECT * FROM users WHERE tg_id = ?').get(String(tgId)) as User | undefined
export const getUser = (id: number) => db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined

/** One wallet belongs to one Telegram account. Returns the other user if already taken. */
export function walletOwner(wallet: string) {
  return db.prepare('SELECT * FROM users WHERE lower(wallet) = lower(?)').get(wallet) as User | undefined
}

export function linkWallet(userId: number, wallet: string) {
  db.prepare('UPDATE users SET wallet = ?, linked_at = ?, eligible = NULL, eligibility_note = NULL, first_celo_tx_ts = NULL WHERE id = ?')
    .run(wallet, Date.now(), userId)
}

export function setEligibility(userId: number, eligible: boolean | null, firstTs: number | null, note: string) {
  db.prepare('UPDATE users SET eligible = ?, first_celo_tx_ts = ?, eligibility_note = ? WHERE id = ?')
    .run(eligible === null ? null : eligible ? 1 : 0, firstTs, note, userId)
}

// ---------- sessions ----------
export type SessionKind = 'link' | 'convert'
export interface ConvertPayload {
  sell: TokenSymbol
  buy: TokenSymbol
  sellAmount: string          // atomic, the user's spend cap
  strategy: 'single' | 'split' | 'alert'
  parentId?: string
  refParallel?: number | null
  refOfficial?: number | null
  previewRate?: number | null // single-shot indicative rate when the bot offered it
  rfq?: { id: string; claim: string; expiresAt: string; takerPays: string; buyAmount: string; feeAmount: string; rate: number; swapTo: string }
  txHash?: string
}
export interface Session<P = any> { token: string; kind: SessionKind; user_id: number; payload: P; created_at: number; expires_at: number; used_at: number | null }

export function createSession(kind: SessionKind, userId: number, payload: object, ttlMs: number): string {
  const token = randomBytes(18).toString('base64url')
  const now = Date.now()
  db.prepare('INSERT INTO sessions (token, kind, user_id, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(token, kind, userId, JSON.stringify(payload), now, now + ttlMs)
  return token
}

/** Returns a live (unexpired, unused) session of the given kind, else undefined. */
export function liveSession<P>(token: string, kind: SessionKind): Session<P> | undefined {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return undefined
  const row = db.prepare('SELECT * FROM sessions WHERE token = ? AND kind = ?').get(token, kind) as any
  if (!row || row.used_at || row.expires_at < Date.now()) return undefined
  return { ...row, payload: JSON.parse(row.payload) }
}

/** Any session by token, used or not (for status polling by the token holder). */
export function anySession<P>(token: string, kind: SessionKind): Session<P> | undefined {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return undefined
  const row = db.prepare('SELECT * FROM sessions WHERE token = ? AND kind = ?').get(token, kind) as any
  return row ? { ...row, payload: JSON.parse(row.payload) } : undefined
}

export function updateSessionPayload(token: string, payload: object) {
  db.prepare('UPDATE sessions SET payload = ? WHERE token = ?').run(JSON.stringify(payload), token)
}
export function useSession(token: string) {
  db.prepare('UPDATE sessions SET used_at = ? WHERE token = ?').run(Date.now(), token)
}

// ---------- quotes & fills ----------
export function logFirmQuote(r: {
  userId: number; sell: TokenSymbol; buy: TokenSymbol; sizeUsd: number; status: string; reason?: string | null
  sellAmount?: string; buyAmount?: string; takerPays?: string; feeAmount?: string; rate?: number | null
  refParallel?: number | null; refOfficial?: number | null; rfqId?: string
}) {
  db.prepare(`INSERT INTO quotes (ts, source, kind, sell, buy, size_usd, status, reason, sell_amount, buy_amount, taker_pays, fee_amount, rate_ngn_usdt, ref_parallel, ref_official, rfq_id, user_id)
              VALUES (?, 'user', 'firm', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(Date.now(), r.sell, r.buy, r.sizeUsd, r.status, r.reason ?? null, r.sellAmount ?? null, r.buyAmount ?? null,
      r.takerPays ?? null, r.feeAmount ?? null, r.rate ?? null, r.refParallel ?? null, r.refOfficial ?? null, r.rfqId ?? null, r.userId)
}

export interface Fill {
  id: number; ts: number; user_id: number; strategy: string; parent_id: string | null; rfq_id: string
  sell: TokenSymbol; buy: TokenSymbol; sell_amount: string; buy_amount: string; fee_amount: string
  rate_ngn_usdt: number; ref_parallel: number | null; ref_official: number | null; single_shot_rate: number | null
  tx_hash: string; status: string
}

export function insertFill(f: Omit<Fill, 'id'>) {
  db.prepare(`INSERT OR IGNORE INTO fills (ts, user_id, strategy, parent_id, rfq_id, sell, buy, sell_amount, buy_amount, fee_amount, rate_ngn_usdt, ref_parallel, ref_official, single_shot_rate, tx_hash, status)
              VALUES (@ts, @user_id, @strategy, @parent_id, @rfq_id, @sell, @buy, @sell_amount, @buy_amount, @fee_amount, @rate_ngn_usdt, @ref_parallel, @ref_official, @single_shot_rate, @tx_hash, @status)`).run(f)
}

export const userFills = (userId: number, limit = 10) =>
  db.prepare('SELECT * FROM fills WHERE user_id = ? AND status = ? ORDER BY ts DESC LIMIT ?').all(userId, 'filled', limit) as Fill[]
export const allUserFills = (userId: number) =>
  db.prepare('SELECT * FROM fills WHERE user_id = ? AND status = ?').all(userId, 'filled') as Fill[]
