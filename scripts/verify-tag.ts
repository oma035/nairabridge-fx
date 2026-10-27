/**
 * Check a Celo tx carries our ERC-8021 tag.  npm run verify-tag -- 0xHASH
 * With no hash, prints the suffix for the configured code (offline self-check).
 */
import { verifyTx, fromDataSuffix } from '@celo/attribution-tags'
import { attributionSuffix, tagCalldata } from '../src/lib/attribution.js'
import { config } from '../src/lib/config.js'
import { publicClient } from '../src/lib/chain.js'

const hash = process.argv[2] as `0x${string}` | undefined
if (!hash) {
  const sample = tagCalldata('0x095ea7b3')
  console.log('code   ', config.attributionCode())
  console.log('suffix ', attributionSuffix())
  console.log('decoded', fromDataSuffix(sample))
  console.log('idempotent', tagCalldata(sample) === sample)
} else {
  const r = await verifyTx({ client: publicClient as any, hash })
  console.log(r ?? 'NO TAG FOUND')
  process.exit(r?.codes.includes(config.attributionCode()) ? 0 : 1)
}
