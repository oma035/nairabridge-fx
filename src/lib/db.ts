import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from './config.js'

mkdirSync(dirname(config.dbPath), { recursive: true })
export const db = new Database(config.dbPath)
db.pragma('journal_mode = WAL')

db.exec(`
-- Every quote we see: Sentinel previews and user firm quotes.
CREATE TABLE IF NOT EXISTS quotes (
  id            INTEGER PRIMARY KEY,
  ts            INTEGER NOT NULL,           -- unix ms
  source        TEXT NOT NULL,              -- 'sentinel' | 'user'
  kind          TEXT NOT NULL,              -- 'preview' | 'firm'
  sell          TEXT NOT NULL,              -- 'USDT' | 'cNGN'
  buy           TEXT NOT NULL,
  size_usd      REAL NOT NULL,
  status        TEXT NOT NULL,              -- preview | quoted | no_quote | error
  reason        TEXT,
  sell_amount   TEXT, buy_amount TEXT, taker_pays TEXT, fee_amount TEXT,
  rate_ngn_usdt REAL,                       -- effective, fee-inclusive
  ref_parallel  REAL, ref_official REAL,
  rfq_id        TEXT,
  user_id       INTEGER
);
CREATE INDEX IF NOT EXISTS quotes_ts ON quotes(ts);
CREATE INDEX IF NOT EXISTS quotes_dir ON quotes(sell, size_usd, ts);

-- Telegram users and the wallet they proved they own (signature, never a key).
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY,
  tg_id       TEXT UNIQUE NOT NULL,
  wallet      TEXT,
  linked_at   INTEGER,
  first_celo_tx_ts INTEGER,                 -- eligibility evidence: activity before Oct 6
  created_at  INTEGER NOT NULL
);

-- Executed conversions, one row per on-chain fill.
CREATE TABLE IF NOT EXISTS fills (
  id            INTEGER PRIMARY KEY,
  ts            INTEGER NOT NULL,
  user_id       INTEGER NOT NULL,
  strategy      TEXT NOT NULL,              -- 'single' | 'split' | 'alert'
  parent_id     TEXT,                       -- groups chunks of one split order
  rfq_id        TEXT NOT NULL,
  sell TEXT NOT NULL, buy TEXT NOT NULL,
  sell_amount TEXT NOT NULL, buy_amount TEXT NOT NULL, fee_amount TEXT NOT NULL,
  rate_ngn_usdt REAL NOT NULL,
  ref_parallel  REAL, ref_official REAL, single_shot_rate REAL,
  tx_hash       TEXT UNIQUE NOT NULL,
  status        TEXT NOT NULL               -- submitted | filled | failed
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, sell TEXT NOT NULL,
  amount TEXT NOT NULL, target_rate REAL NOT NULL, created_at INTEGER NOT NULL, fired_at INTEGER
);
`)

// ---- migrations (add columns to databases created by earlier versions) ----
function addColumn(table: string, col: string, type: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
}
addColumn('quotes', 'available_sell', 'TEXT')            // published depth on the sell leg (atomic)
addColumn('quotes', 'probe', 'INTEGER NOT NULL DEFAULT 0') // 1 = max-fillable probe row
addColumn('users', 'tg_username', 'TEXT')
addColumn('users', 'tg_chat_id', 'TEXT')
addColumn('users', 'eligible', 'INTEGER')                  // 1/0/null(unknown)
addColumn('users', 'eligibility_note', 'TEXT')
addColumn('alerts', 'created_rate', 'REAL')                // rate when the alert was set (benchmark for "waiting")
addColumn('alerts', 'expires_at', 'INTEGER NOT NULL DEFAULT 0')
addColumn('alerts', 'cancelled_at', 'INTEGER')
addColumn('alerts', 'fired_rate', 'REAL')

db.exec(`
-- Short-lived, single-purpose links the bot hands out (wallet link, convert).
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,               -- 'link' | 'convert'
  user_id     INTEGER NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',  -- JSON (convert: sell, amount; server-side rfq state)
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);
`)
