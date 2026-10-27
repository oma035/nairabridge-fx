import 'dotenv/config'
import { getAddress, type Address } from 'viem'

function env(name: string, fallback?: string): string {
  const v = process.env[name]
  if (v !== undefined && v !== '') return v
  if (fallback !== undefined) return fallback
  throw new Error(`Missing env var ${name} (see .env.example)`)
}

export const CHAIN_ID = 42220 // Celo mainnet only (hackathon rule)

/**
 * Textile FX deployments on Celo (chain 42220).
 * Source: https://docs.textilecredit.com/protocol/address-book.html (checked 2026-10-27).
 * Re-check that page before going live. Quotes also return `quote.reactor`;
 * the code refuses to execute if it differs from the value below.
 */
export const TEXTILE_CELO = {
  limitOrderReactor: getAddress('0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3'),
  feeController: getAddress('0x7b005466F905DD882A959888154587fA76cd3Ea7'), // 0.01% / 1 bps taker fee
  permit2: getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3'),
  takerFeeBps: 1,
} as const

/** Tokens, same source. Both are 6 decimals on Celo. */
export const TOKENS = {
  cNGN: { address: getAddress('0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f'), decimals: 6, symbol: 'cNGN' },
  USDT: { address: getAddress('0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e'), decimals: 6, symbol: 'USDT' },
} as const
export type TokenSymbol = keyof typeof TOKENS

/**
 * ERC-8004 registries on Celo mainnet.
 * Source: https://docs.celo.org/build/agents/8004 (checked 2026-10-27).
 */
export const ERC8004 = {
  identityRegistry: getAddress('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432'),
  reputationRegistry: getAddress('0x8004BAa17C55a88189AE136b182e5fdA19dE9b63'),
} as const

export const config = {
  attributionCode: () => env('ATTRIBUTION_CODE'),
  rpcUrl: env('CELO_RPC_URL', 'https://forno.celo.org'),
  textile: {
    base: env('TEXTILE_API_BASE', 'https://api.textilecredit.com').replace(/\/$/, ''),
    apiKey: process.env.TEXTILE_API_KEY || undefined,
  },
  agentPrivateKey: () => env('AGENT_PRIVATE_KEY') as `0x${string}`,
  agentUri: () => env('AGENT_URI'),
  sentinel: {
    intervalSec: Number(env('SENTINEL_INTERVAL_SEC', '180')),
    sizesUsd: env('SENTINEL_SIZES_USD', '10,50,200,1000').split(',').map(Number).filter((n) => n > 0),
  },
  dbPath: env('DB_PATH', './data/nairabridge.db'),
}

export type { Address }
