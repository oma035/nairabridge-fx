/**
 * Register NairaBridge FX in the ERC-8004 Identity Registry on Celo mainnet.
 * The tx carries the ERC-8021 attribution tag (sendTagged).
 *
 * Order (docs.celo.org/build/agents/8004):
 *  1. host agent.json without `registrations` and set AGENT_URI to its URL
 *  2. npm run register-agent
 *  3. add the printed agentId to agent.json `registrations`
 * The wallet that sends this owns the identity. Use the agent wallet, not a personal one.
 */
import { encodeFunctionData, parseEventLogs } from 'viem'
import { config, ERC8004 } from '../src/lib/config.js'
import { agentWallet, publicClient, celoscanTx } from '../src/lib/chain.js'
import { sendTagged } from '../src/lib/attribution.js'

const abi = [
  { type: 'function', name: 'register', stateMutability: 'nonpayable', inputs: [{ name: 'agentURI', type: 'string' }], outputs: [{ name: 'agentId', type: 'uint256' }] },
  { type: 'event', name: 'Registered', inputs: [
    { name: 'agentId', type: 'uint256', indexed: true },
    { name: 'agentURI', type: 'string' },
    { name: 'owner', type: 'address', indexed: true },
  ] },
] as const

const wallet = agentWallet()
const uri = config.agentUri()
console.log(`Registering ${wallet.account.address} with URI ${uri}`)

await publicClient.simulateContract({ account: wallet.account, address: ERC8004.identityRegistry, abi, functionName: 'register', args: [uri] })
const hash = await sendTagged(wallet, { to: ERC8004.identityRegistry, data: encodeFunctionData({ abi, functionName: 'register', args: [uri] }) })
console.log('tx', celoscanTx(hash))

const receipt = await publicClient.waitForTransactionReceipt({ hash })
const [ev] = parseEventLogs({ abi, eventName: 'Registered', logs: receipt.logs })
console.log(`Registered. agentId = ${ev.args.agentId}`)
console.log(`Add to agent.json: "registrations": [{ "agentId": ${ev.args.agentId}, "agentRegistry": "eip155:42220:${ERC8004.identityRegistry}" }]`)
