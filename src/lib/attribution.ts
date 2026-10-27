/**
 * ERC-8021 attribution. The ONLY place the Loops House code is applied.
 *
 * Every transaction this project builds goes through `tagCalldata` or `sendTagged`:
 *  - the agent's own txs (ERC-8004 registration, etc.) via sendTagged
 *  - user swap/approval txs returned by Textile, before the user signs them
 *
 * The suffix sits after the ABI-encoded args; the EVM ignores trailing calldata,
 * so it never changes what the contract does. See docs.celo.org/build/agents/attribution-tags
 */
import { toDataSuffix, fromDataSuffix } from '@celo/attribution-tags'
import { concat, type Hex, type WalletClient, type Account, type Chain, type Transport } from 'viem'
import { config } from './config.js'

let cached: Hex | undefined

export function attributionSuffix(): Hex {
  if (!cached) {
    const code = config.attributionCode()
    if (!/^[a-z0-9_]{1,32}$/.test(code)) throw new Error(`ATTRIBUTION_CODE "${code}" is not a valid ERC-8021 code`)
    cached = toDataSuffix(code) as Hex
  }
  return cached
}

/** Append the tag once. Idempotent: data already carrying our code is returned unchanged. */
export function tagCalldata(data: Hex = '0x'): Hex {
  const existing = fromDataSuffix(data)
  if (existing?.codes.includes(config.attributionCode())) return data
  return concat([data, attributionSuffix()])
}

export function hasOurTag(data: Hex): boolean {
  return !!fromDataSuffix(data)?.codes.includes(config.attributionCode())
}

/** sendTransaction that can't forget the tag. Use for every agent-signed tx. */
export async function sendTagged(
  wallet: WalletClient<Transport, Chain, Account>,
  tx: { to: Hex; data?: Hex; value?: bigint },
): Promise<Hex> {
  return wallet.sendTransaction({ to: tx.to, data: tagCalldata(tx.data), value: tx.value ?? 0n })
}
