// Rate alerts: parsing, immediate hits, background firing (exactly once), convert link, cancel, re-arm, limits.
import { tg, state } from './mocks.mts'
const R = new URL('../src', import.meta.url).pathname
const store = await import(`${R}/lib/store.ts`)
const { notifyApi } = await import(`${R}/bot/notify.ts`)
const fakeTg = (m: string, p: any) => { tg.push({ m, ...p }); return Promise.resolve({ ok: true, result: true } as any) }
notifyApi().config.use((_p: any, m: string, pl: any) => fakeTg(m, pl))
const { createBot } = await import(`${R}/bot/bot.ts`)
const alerts = await import(`${R}/agent/alerts.ts`)
const { db } = await import(`${R}/lib/db.ts`)
const check = (name: string, cond: any) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) process.exitCode = 1 }

const bot = createBot(); bot.api.config.use((_p: any, m: string, pl: any) => fakeTg(m, pl))
;(bot as any).botInfo = { id: 1, is_bot: true, first_name: 'NB', username: 'nb_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false }
let uid = 1
const FROM = 777
const send = async (text: string) => { tg.length = 0; await bot.handleUpdate({ update_id: uid++, message: { message_id: uid, date: 0, chat: { id: FROM, type: 'private' }, from: { id: FROM, is_bot: false, first_name: 'A' }, text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] } } as any); return tg.filter(t => t.m === 'sendMessage') }
const tap = async (data: string) => { tg.length = 0; await bot.handleUpdate({ update_id: uid++, callback_query: { id: String(uid), chat_instance: '1', data, from: { id: FROM, is_bot: false, first_name: 'A' }, message: { message_id: 1, date: 0, chat: { id: FROM, type: 'private' }, text: 'x' } } } as any); return tg.filter(t => t.m === 'sendMessage') }

const u = store.upsertUser(FROM, 'alice', FROM); store.linkWallet(u.id, '0x00000000000000000000000000000000000000B0')

let out = await send('/alert'); check('/alert alone shows help + current rate', /Set a rate alert/.test(out[0].text) && /1,383\.88/.test(out[0].text))
out = await send('/alert 50'); check('nonsense target rejected', /doesn't look like/.test(out[0].text))
out = await send('/alert 1390'); check('/alert 1390 sets cash-out alert for $100', /Alert #\d+ set: cash out \$100\.00 USDT at ≥ 1,390\.00/.test(out[0].text) && /Now: 1,383\.88/.test(out[0].text))
const a1 = alerts.activeAlerts(u.id)[0]
check('alert stores the rate when set (benchmark)', Math.abs(a1.created_rate - 1383.88) < 0.01 && a1.amount === '100000000')

out = await send('/alert 1380'); check('/alert below current rate fires immediately with a convert button', /already beats your target/.test(out[0].text) && out[0].reply_markup.inline_keyboard[0][0].url.includes('/c/'))
out = await send('/alert 1380 70000 cngn'); check('top-up alert (≤ target) set, not met', /top up with ₦70,000 cNGN at ≤ 1,380\.00/.test(out[0].text))

let r = await alerts.checkAlerts(); check('background check: nothing fires at current rate', r.fired === 0 && r.checked === 2)
state.usdtRate = 139200n // market improves for cash-out
tg.length = 0; r = await alerts.checkAlerts()
const msg = tg.find(t => t.m === 'sendMessage')
check('background check fires the met alert', r.fired === 1 && /Alert hit: cash out \$100\.00 USDT/.test(msg?.text) && /1,391\.86/.test(msg?.text))
check('message shows value of waiting vs when set', /vs when you set it \(1,383\.88\): ₦798 better/.test(msg?.text))
const url = msg.reply_markup.inline_keyboard[0][0].url as string
const token = url.split('/c/')[1]
const sess = store.liveSession(token, 'convert') as any
check('convert link: alert strategy, benchmark = rate when set', sess.payload.strategy === 'alert' && Math.abs(sess.payload.previewRate - 1383.88) < 0.01 && sess.payload.sellAmount === '100000000')
check('fired alert has a Set again button', msg.reply_markup.inline_keyboard[1][0].callback_data.startsWith('rearm:'))
tg.length = 0; r = await alerts.checkAlerts(); check('fires exactly once', r.fired === 0 && !tg.some(t => t.m === 'sendMessage'))

out = await send('/alerts'); check('/alerts lists the one remaining (top-up) alert, no empty button rows', /#\d+\s+top up/.test(out[0].text) && out[0].reply_markup.inline_keyboard.length === 1 && out[0].reply_markup.inline_keyboard.every((r: any[]) => r.length > 0))
const topId = alerts.activeAlerts(u.id)[0].id
out = await tap(`cancelalert:${topId}`); check('cancel button cancels', /cancelled/.test(out[0]?.text) && alerts.activeAlerts(u.id).length === 0)
state.usdtRate = 138402n // market back below the 1390 target
out = await tap(`rearm:${a1.id}`); check('Set again re-arms the same alert', alerts.activeAlerts(u.id).length === 1 && alerts.activeAlerts(u.id)[0].target_rate === 1390)

const stranger = store.upsertUser(888, 'bob', 888)
out = await (async () => { tg.length = 0; await bot.handleUpdate({ update_id: uid++, callback_query: { id: 'z', chat_instance: '1', data: `rearm:${a1.id}`, from: { id: 888, is_bot: false, first_name: 'B' }, message: { message_id: 1, date: 0, chat: { id: 888, type: 'private' }, text: 'x' } } } as any); return tg.filter(t => t.m === 'sendMessage') })()
check("can't re-arm someone else's alert", /not yours/.test(out[0]?.text) && alerts.activeAlerts(stranger.id).length === 0)

for (let i = 0; i < 4; i++) await send(`/alert ${1395 + i}`)
out = await send('/alert 1400'); check('max 5 active alerts per user', /already have 5 active alerts/.test(out[0].text))

db.prepare('UPDATE alerts SET expires_at = 1 WHERE user_id = ?').run(u.id)
check('expired alerts are not active', alerts.activeAlerts(u.id).length === 0)
const s = alerts.alertStats(); check('alert stats', s.total === 8 && (s.fired ?? 0) === 2 && (s.active ?? 0) === 0)
console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED')
process.exit()
