import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import { config } from './config.js'

export const publicClient = createPublicClient({ chain: celo, transport: http(config.rpcUrl) })

/** Agent's own wallet. Signs only agent actions (registration). Never user swaps. */
export function agentWallet() {
  const account = privateKeyToAccount(config.agentPrivateKey())
  return createWalletClient({ account, chain: celo, transport: http(config.rpcUrl) })
}

export const celoscanTx = (hash: string) => `https://celoscan.io/tx/${hash}`
export const celoscanAddr = (addr: string) => `https://celoscan.io/address/${addr}`
