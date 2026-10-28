import { decodeFunctionData, erc20Abi, keccak256, toHex } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { tg, state, user, REACTOR, realFetch } from './mocks.mts'
const R = new URL('../src', import.meta.url).pathname
const store = await import(`${R}/lib/store.ts`)
// grammY uses its own HTTP client: intercept Bot API calls with a transformer
const fakeTg = (method: string, payload: any) => { tg.push({ m: method, ...payload }); return Promise.resolve({ ok: true, result: { message_id: tg.length, date: 0, chat: { id: 1, type: 'private' } } } as any) }
const { notifyApi } = await import(`${R}/bot/notify.ts`)
notifyApi().config.use((_prev: any, method: string, payload: any) => fakeTg(method, payload))
const api = await import(`${R}/server/api.ts`)
const { fromDataSuffix } = await import('@celo/attribution-tags')
const check = (name: string, cond: any) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) process.exitCode = 1 }

// ---- link ----
const u0 = store.upsertUser(111, 'mel', 111)
const lt = store.createSession('link', u0.id, {}, 60000)
const ch = api.linkChallenge(lt)
const sig = await user.signMessage({ message: ch.message })
const bad = await api.linkVerify({ token: lt, address: user.address, signature: await privateKeyToAccount(generatePrivateKey()).signMessage({ message: ch.message }) }).catch((e: any) => e.message)
check('link rejects a signature from another wallet', /does not match/.test(bad))
const lv = await api.linkVerify({ token: lt, address: user.address, signature: sig })
check('link verifies signature and saves wallet', store.getUser(u0.id).wallet === user.address)
check('eligibility: active before 6 Oct', lv.eligibility.eligible === true)
check('telegram told about link', tg.some(t => t.m === 'sendMessage' && /Wallet linked/.test(t.text)))
check('link token single-use', await Promise.resolve().then(() => api.linkChallenge(lt)).then(() => false, () => true))

// ---- convert ----
const ct = store.createSession('convert', u0.id, { sell: 'USDT', buy: 'cNGN', sellAmount: '50000000', strategy: 'single', previewRate: 1384.02 }, 60000)
const info = api.convertInfo(ct); check('convert info amount = 50', info.amount === 50)
const ap = await api.convertApproval({ token: ct })
const apCall = decodeFunctionData({ abi: erc20Abi, data: ap.txs[0].data.slice(0, 138) as any })
check('approval: exact amount to reactor', ap.txs.length === 1 && apCall.functionName === 'approve' && apCall.args[0] === REACTOR && apCall.args[1] === 50000000n)
check('approval tx carries tag', fromDataSuffix(ap.txs[0].data)?.codes[0] === 'celo_f91a4dd61bbc')
const q1 = await api.convertQuote({ token: ct })
check('quote asks for proof of control first', q1.needProof && q1.typedData.primaryType === 'TakerControl')
const { EIP712Domain, ...types } = q1.typedData.types
const psig = await user.signTypedData({ domain: q1.typedData.domain, types, primaryType: 'TakerControl', message: { ...q1.typedData.message, issuedAt: BigInt(q1.issuedAt), chainId: 42220n } })
const q2 = await api.convertQuote({ token: ct, takerProof: { nonce: q1.nonce, issuedAt: q1.issuedAt, signature: psig } })
check('firm quote returned with numbers', q2.receives > 69000 && q2.rate > 1380 && q2.fee === 0.005)
check('swap tx targets reactor and carries tag', q2.swapTx.to === REACTOR && fromDataSuffix(q2.swapTx.data)?.codes[0] === 'celo_f91a4dd61bbc' && q2.swapTx.data.startsWith('0xdeadbeef'))
check('savings vs parallel/official computed', q2.vsParallel < 0 && q2.vsOfficial > 0)
state.swapInput = q2.swapTx.data
const hash = keccak256(toHex('tx1'))
const sub = await api.convertSubmit({ token: ct, txHash: hash })
check('submit returns celoscan link', sub.explorer.endsWith(hash))
let st: any; for (let i = 0; i < 40; i++) { st = api.convertStatus(ct); if (st.result) break; await new Promise(r => setTimeout(r, 250)) }
check('settled as filled with tag verified', st.result?.state === 'filled' && st.result.checks.tagged)
check('fill stored', store.allUserFills(u0.id).length === 1)
check('telegram receipt sent', tg.some(t => /Converted \$50\.00 USDT/.test(t.text ?? '')))
check('convert link closed after fill', await Promise.resolve().then(() => api.convertInfo(ct)).then(() => false, () => true))

// ---- safety ----
const { assertSafeQuote } = await import(`${R}/lib/textile.ts`)
const evil = { quote: { reactor: '0x0000000000000000000000000000000000000001' }, transactions: { swap: { to: REACTOR, value: '0', chainId: 42220 } } }
check('rejects quote with unknown reactor', (() => { try { assertSafeQuote(evil as any); return false } catch { return true } })())

// ---- bot ----
const { createBot } = await import(`${R}/bot/bot.ts`)
const bot = createBot(); bot.api.config.use((_p: any, m: string, pl: any) => fakeTg(m, pl)); (bot as any).botInfo = { id: 1, is_bot: true, first_name: 'NB', username: 'nb_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false }
let uid = 1
const send = async (text: string, from = 222) => { tg.length = 0; await bot.handleUpdate({ update_id: uid++, message: { message_id: uid, date: 0, chat: { id: from, type: 'private' }, from: { id: from, is_bot: false, first_name: 'T', username: 'tester' }, text, entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : [] } } as any); return tg.filter(t => t.m === 'sendMessage') }
let out = await send('/start'); check('/start new user gets link button', out.some(t => t.reply_markup?.inline_keyboard?.[0]?.[0]?.url?.startsWith('https://nb.example/link/')))
out = await send('/convert 20 usdt'); check('/convert without wallet asks to link', out.some(t => /link your wallet/i.test(t.text)))
out = await send('/rate 100'); check('/rate shows both directions', out[0] && /1,383\.88/.test(out[0].text) && /cNGN →/.test(out[0].text)); console.log('\n' + out[0]?.text + '\n')
out = await send('/convert 50 usdt', 111); check('/convert gives review link', out.some(t => t.reply_markup?.inline_keyboard?.[0]?.[0]?.url?.startsWith('https://nb.example/c/'))); console.log(out[0]?.text + '\n')
out = await send('/history', 111); check('/history lists the fill', /Converted|→/.test(out[0]?.text) && /vs mid-market/.test(out[0]?.text)); console.log(out[0]?.text + '\n')
out = await send('20k ngn'); check('plain amount gives a quote', /cNGN → /.test(out[0]?.text))

// ---- http ----
const { startServer } = await import(`${R}/server/http.ts`)
const srv = startServer(18787); await new Promise(r => setTimeout(r, 200))
const g = (p: string) => realFetch('http://127.0.0.1:18787' + p)
check('GET /c/<token> serves page', (await g('/c/abcdefghijklmnopqrst')).headers.get('content-type')?.includes('text/html'))
check('GET /app.js served', (await g('/app.js')).status === 200)
check('GET /api/link/<expired> -> 410', (await g('/api/link/abcdefghijklmnopqrst')).status === 410)
check('path traversal blocked', (await g('/..%2f.env.js')).status === 404)
srv.close()
console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED')
process.exit()
