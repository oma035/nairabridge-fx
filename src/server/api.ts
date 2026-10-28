/**
 * HTTP API for the wallet-link and convert pages. Non-custodial: the server never
 * sees a key. It builds tagged transactions; the user's wallet signs and sends them.
 */
import { encodeFunctionData, erc20Abi, getAddress, isAddress, isHex, recoverMessageAddress, type Hex } from 'viem'
import { randomBytes } from 'node:crypto'
import { CHAIN_ID, TEXTILE_CELO, TOKENS, config } from '../lib/config.js'
import { publicClient, celoscanTx } from '../lib/chain.js'
import { hasOurTag, tagCalldata } from '../lib/attribution.js'
import { assertSafeQuote, effectiveNgnPerUsdt, textile, TextileError, type TakerProof } from '../lib/textile.js'
import { referenceRates } from '../lib/reference.js'
import { checkEligibility } from '../lib/eligibility.js'
import { fromAtomic, fmtRate, fmtToken, savingsNgn, signedNgn } from '../lib/fx.js'
import {
  anySession, getUser, insertFill, linkWallet, liveSession, logFirmQuote, setEligibility, updateSessionPayload, useSession, walletOwner,
  type ConvertPayload,
} from '../lib/store.js'
import { notify } from '../bot/notify.js'

export class HttpError extends Error { constructor(public status: number, message: string) { super(message) } }
const bad = (msg: string) => new HttpError(400, msg)

// ---------------- wallet link ----------------
export function linkMessage(token: string, tgId: string) {
  return [
    'NairaBridge FX: link this wallet to my Telegram account.',
    `Telegram ID: ${tgId}`,
    `Code: ${token}`,
    'Signing this does not move funds or approve any spending.',
  ].join('\n')
}

export function linkChallenge(token: string) {
  const s = liveSession(token, 'link')
  if (!s) throw new HttpError(410, 'This link has expired. Send /start to the bot for a new one.')
  const u = getUser(s.user_id)!
  return { message: linkMessage(token, u.tg_id), telegram: u.tg_username ? `@${u.tg_username}` : `user ${u.tg_id}` }
}

export async function linkVerify(body: any) {
  const { token, address, signature } = body ?? {}
  const s = liveSession(String(token), 'link')
  if (!s) throw new HttpError(410, 'This link has expired. Send /start to the bot for a new one.')
  if (!isAddress(address) || !isHex(signature)) throw bad('address and signature required')
  const user = getUser(s.user_id)!
  const wallet = getAddress(address)
  const message = linkMessage(s.token, user.tg_id)
  // Normal wallets: recover locally. Smart wallets (EIP-1271 / ERC-6492): ask the chain.
  const recovered = await recoverMessageAddress({ message, signature }).catch(() => undefined)
  const ok = recovered?.toLowerCase() === wallet.toLowerCase() || (await publicClient.verifyMessage({ address: wallet, message, signature }).catch(() => false))
  if (!ok) throw bad('Signature does not match this wallet.')
  const owner = walletOwner(wallet)
  if (owner && owner.id !== user.id) throw new HttpError(409, 'This wallet is already linked to another Telegram account.')

  linkWallet(user.id, wallet)
  useSession(s.token)
  const el = await checkEligibility(wallet)
  setEligibility(user.id, el.eligible, el.firstTs, el.note)

  if (user.tg_chat_id) {
    await notify(user.tg_chat_id,
      `✅ Wallet linked: ${wallet}\n${el.eligible ? '🟢' : el.eligible === false ? '🟡' : '⚪️'} ${el.note}\n\nTry /rate or /convert 20 USDT`).catch(() => {})
  }
  return { wallet, eligibility: el }
}

// ---------------- convert ----------------
function convertSession(token: string) {
  const s = liveSession<ConvertPayload>(String(token), 'convert')
  if (!s) throw new HttpError(410, 'This convert link has expired or was already used. Send /convert again in Telegram.')
  const user = getUser(s.user_id)!
  if (!user.wallet) throw bad('Link a wallet first: send /start to the bot.')
  return { s, user, wallet: getAddress(user.wallet) }
}

export function convertInfo(token: string) {
  const { s, wallet } = convertSession(token)
  const p = s.payload
  return {
    sell: p.sell, buy: p.buy,
    amount: fromAtomic(p.sellAmount, p.sell),
    sellAmount: p.sellAmount,
    sellToken: TOKENS[p.sell].address,
    decimals: TOKENS[p.sell].decimals,
    wallet, reactor: TEXTILE_CELO.limitOrderReactor, chainId: CHAIN_ID,
    previewRate: p.previewRate ?? null,
    expiresAt: s.expires_at,
    result: (p as any).result ?? null,
  }
}

/** Approval txs needed so the reactor can pull `sellAmount`. Exact amount, never unlimited. */
export async function convertApproval(body: any) {
  const { s, wallet } = convertSession(body?.token)
  const token = TOKENS[s.payload.sell].address
  const need = BigInt(s.payload.sellAmount)
  const [allowance, balance] = await Promise.all([
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [wallet, TEXTILE_CELO.limitOrderReactor] }),
    publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] }),
  ])
  if (balance < need) {
    throw bad(`Not enough ${s.payload.sell}: wallet has ${fmtToken(fromAtomic(balance, s.payload.sell), s.payload.sell)}, needs ${fmtToken(fromAtomic(need, s.payload.sell), s.payload.sell)}.`)
  }
  if (allowance >= need) return { txs: [] }
  const approve = (amt: bigint) => ({
    to: token,
    data: tagCalldata(encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TEXTILE_CELO.limitOrderReactor, amt] })),
    value: '0x0',
  })
  // USDT-style tokens reject approve(nonzero -> nonzero): reset to 0 first.
  return { txs: allowance > 0n ? [approve(0n), approve(need)] : [approve(need)] }
}

/** Firm quote bound to the user's wallet. Returns the tagged swap tx to sign, or a proof request. */
export async function convertQuote(body: any) {
  const { s, user, wallet } = convertSession(body?.token)
  const p = s.payload
  if (p.txHash) throw new HttpError(409, 'A swap was already sent for this link.')

  let takerProof: TakerProof | undefined
  if (body?.takerProof) {
    const { nonce, issuedAt, signature } = body.takerProof
    if (!isHex(nonce) || !isHex(signature) || typeof issuedAt !== 'number') throw bad('bad takerProof')
    takerProof = { nonce, issuedAt, signature }
  }

  const refs = await referenceRates()
  let q
  try {
    q = await textile.request({ sell: p.sell, buy: p.buy, sellAmount: BigInt(p.sellAmount), taker: wallet, takerProof })
  } catch (e) {
    if (e instanceof TextileError && e.status === 401 && String((e.details as any)?.reason ?? '').startsWith('proof_of_control')) {
      // No partner key: Textile wants the wallet to prove control once (~12h). Hand the page the typed data to sign.
      const nonce = `0x${randomBytes(32).toString('hex')}` as Hex
      const issuedAt = Date.now()
      return {
        needProof: true,
        typedData: {
          domain: { name: 'Textile Taker Control', version: '1', chainId: CHAIN_ID },
          types: {
            EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }],
            TakerControl: [{ name: 'taker', type: 'address' }, { name: 'chainId', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }, { name: 'issuedAt', type: 'uint256' }],
          },
          primaryType: 'TakerControl',
          message: { taker: wallet, chainId: CHAIN_ID, nonce, issuedAt },
        },
        nonce, issuedAt,
      }
    }
    if (e instanceof TextileError && (e.details as any)?.reason === 'insufficient_funds') {
      throw bad(`Your wallet doesn't hold enough ${p.sell} for this quote.`)
    }
    throw e
  }

  const sizeUsd = p.sell === 'USDT' ? fromAtomic(p.sellAmount, 'USDT') : fromAtomic(p.sellAmount, 'cNGN') / (refs.official.rate ?? 1400)
  if (q.status !== 'quoted' || !q.quote || !q.transactions) {
    logFirmQuote({ userId: user.id, sell: p.sell, buy: p.buy, sizeUsd, status: 'no_quote', reason: q.reason, rfqId: q.rfqId })
    const maxSell = q.availableSellAmount ? fromAtomic(q.availableSellAmount, p.sell) : undefined
    return { noQuote: true, reason: q.reason, maxSell, retryAfterMs: q.retryAfterMs }
  }

  assertSafeQuote(q)
  const quote = q.quote
  if (BigInt(quote.takerPays) > BigInt(p.sellAmount)) throw new Error('quote exceeds spend cap')
  if (quote.taker.toLowerCase() !== wallet.toLowerCase()) throw new Error('quote bound to a different wallet')

  const rate = effectiveNgnPerUsdt(p.sell, quote)
  logFirmQuote({ userId: user.id, sell: p.sell, buy: p.buy, sizeUsd, status: 'quoted', sellAmount: quote.sellAmount, buyAmount: quote.buyAmount,
    takerPays: quote.takerPays, feeAmount: quote.feeAmount, rate, refParallel: refs.parallel.rate, refOfficial: refs.official.rate, rfqId: q.rfqId })

  updateSessionPayload(s.token, {
    ...p, refParallel: refs.parallel.rate, refOfficial: refs.official.rate,
    rfq: { id: q.rfqId, claim: q.claimToken, expiresAt: quote.expiresAt, takerPays: quote.takerPays, buyAmount: quote.buyAmount, feeAmount: quote.feeAmount, rate, swapTo: q.transactions.swap.to },
  })

  const usdAmt = p.sell === 'USDT' ? fromAtomic(quote.takerPays, 'USDT') : fromAtomic(quote.buyAmount, 'USDT')
  return {
    rfqId: q.rfqId,
    pays: fromAtomic(quote.takerPays, p.sell),
    receives: fromAtomic(quote.buyAmount, p.buy),
    fee: fromAtomic(quote.feeAmount, p.sell),
    rate,
    expiresAt: quote.expiresAt,
    makers: quote.orders?.length ?? 1,
    vsParallel: savingsNgn(p.sell, rate, usdAmt, refs.parallel.rate),
    vsOfficial: savingsNgn(p.sell, rate, usdAmt, refs.official.rate),
    refs: { parallel: refs.parallel, official: refs.official },
    swapTx: { to: q.transactions.swap.to, data: tagCalldata(q.transactions.swap.data), value: '0x0' },
  }
}

/** User reports the swap hash. We verify it on-chain in the background and notify Telegram. */
export async function convertSubmit(body: any) {
  const { s, user, wallet } = convertSession(body?.token)
  const p = s.payload
  const hash = body?.txHash
  if (!isHex(hash) || hash.length !== 66) throw bad('txHash required')
  if (!p.rfq) throw bad('No live quote for this link.')
  if (p.txHash && p.txHash !== hash) throw new HttpError(409, 'A different swap was already reported for this link.')
  if (!p.txHash) updateSessionPayload(s.token, { ...p, txHash: hash })
  textile.submit(p.rfq.id, hash, p.rfq.claim).catch(() => {}) // courtesy; fills reconcile on-chain anyway
  void settle(s.token, user.id, user.tg_chat_id, wallet, { ...p, txHash: hash })
  return { ok: true, explorer: celoscanTx(hash) }
}

async function settle(token: string, userId: number, chatId: string | null, wallet: string, p: ConvertPayload) {
  const hash = p.txHash as Hex
  const rfq = p.rfq!
  const save = (result: object) => updateSessionPayload(token, { ...p, result })
  try {
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 })
    const tx = await publicClient.getTransaction({ hash })
    const checks = {
      success: receipt.status === 'success',
      from: tx.from.toLowerCase() === wallet.toLowerCase(),
      to: tx.to?.toLowerCase() === TEXTILE_CELO.limitOrderReactor.toLowerCase(),
      tagged: hasOurTag(tx.input),
    }
    const filled = checks.success && checks.from && checks.to
    insertFill({
      ts: Date.now(), user_id: userId, strategy: p.strategy, parent_id: p.parentId ?? null, rfq_id: rfq.id,
      sell: p.sell, buy: p.buy, sell_amount: rfq.takerPays, buy_amount: rfq.buyAmount, fee_amount: rfq.feeAmount,
      rate_ngn_usdt: rfq.rate, ref_parallel: p.refParallel ?? null, ref_official: p.refOfficial ?? null,
      single_shot_rate: p.previewRate ?? null, tx_hash: hash, status: filled ? 'filled' : 'failed',
    })
    useSession(token)
    save({ state: filled ? 'filled' : 'failed', checks, explorer: celoscanTx(hash) })

    if (chatId) {
      if (filled) {
        const usdAmt = p.sell === 'USDT' ? fromAtomic(rfq.takerPays, 'USDT') : fromAtomic(rfq.buyAmount, 'USDT')
        const vsPar = savingsNgn(p.sell, rfq.rate, usdAmt, p.refParallel)
        const vsOff = savingsNgn(p.sell, rfq.rate, usdAmt, p.refOfficial)
        const lines = [
          `✅ Converted ${fmtToken(fromAtomic(rfq.takerPays, p.sell), p.sell)} → ${fmtToken(fromAtomic(rfq.buyAmount, p.buy), p.buy)}`,
          `Rate ${fmtRate(rfq.rate)} NGN/USDT (fee included)`,
          vsPar !== null ? `vs parallel market: ${signedNgn(vsPar)}` : '',
          vsOff !== null ? `vs mid-market: ${signedNgn(vsOff)}` : '',
          celoscanTx(hash),
        ]
        await notify(chatId, lines.filter(Boolean).join('\n')).catch((e) => console.error('receipt notify failed', e.message))
      } else {
        await notify(chatId, `⚠️ The swap did not settle. Nothing was converted.\n${celoscanTx(hash)}`).catch(() => {})
      }
    }
  } catch (e: any) {
    save({ state: 'unknown', error: String(e.message).slice(0, 200), explorer: celoscanTx(hash) })
    if (chatId) await notify(chatId, `⏳ Still waiting for your swap to confirm. Check it here:\n${celoscanTx(hash)}`).catch(() => {})
  }
}

/** Settlement status for the page to poll. Works after the session is used up. */
export function convertStatus(token: string) {
  const s = anySession<ConvertPayload>(String(token), 'convert')
  if (!s) throw new HttpError(404, 'unknown link')
  return { txHash: s.payload.txHash ?? null, result: (s.payload as any).result ?? null }
}

export const publicConfig = () => ({
  chainId: CHAIN_ID,
  rpcUrl: config.rpcUrl,
  walletConnectProjectId: config.walletConnectProjectId,
})
