/**
 * Create the agent wallet locally and store its key in .env (AGENT_PRIVATE_KEY).
 * Prints only the address. Refuses to overwrite an existing key.
 *   npm run new-wallet
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const path = '.env'
if (!existsSync(path)) {
  console.error('No .env yet. Run: cp .env.example .env')
  process.exit(1)
}
const env = readFileSync(path, 'utf8')
const current = env.match(/^AGENT_PRIVATE_KEY=(.*)$/m)?.[1]?.trim()
if (current) {
  console.log(`Agent wallet already set: ${privateKeyToAccount(current as `0x${string}`).address}`)
  process.exit(0)
}

const key = generatePrivateKey()
const line = `AGENT_PRIVATE_KEY=${key}`
const next = /^AGENT_PRIVATE_KEY=.*$/m.test(env) ? env.replace(/^AGENT_PRIVATE_KEY=.*$/m, line) : `${env.trimEnd()}\n${line}\n`
writeFileSync(path, next)
chmodSync(path, 0o600)

const addr = privateKeyToAccount(key).address
console.log(`Agent wallet created: ${addr}`)
console.log(`Celoscan: https://celoscan.io/address/${addr}`)
console.log('Key saved to .env only (file permissions 600). Back it up somewhere safe; never commit .env.')
