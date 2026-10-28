// Groups: only /rate answers; other commands redirect to a private chat; chatter ignored;
// group activity never changes where a user's private messages go.
import { tg } from './mocks.mts'
const R = new URL('../src', import.meta.url).pathname
const store = await import(`${R}/lib/store.ts`)
const { createBot, setCommands } = await import(`${R}/bot/bot.ts`)
const check = (name: string, cond: any) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) process.exitCode = 1 }
const bot = createBot()
bot.api.config.use((_p: any, m: string, pl: any) => { tg.push({ m, ...pl }); return Promise.resolve({ ok: true, result: m === 'sendMessage' ? { message_id: 1, date: 0, chat: { id: 1, type: 'private' } } : true } as any) })
;(bot as any).botInfo = { id: 1, is_bot: true, first_name: 'NB', username: 'NairaBridgeFX_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false, has_main_web_app: false }
let uid = 1
const GROUP = -100123, ME = 4242
const say = async (text: string, chat: { id: number; type: string }) => {
  tg.length = 0
  const cmd = text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : []
  await bot.handleUpdate({ update_id: uid++, message: { message_id: uid, date: 0, chat, from: { id: ME, is_bot: false, first_name: 'Ada', username: 'ada' }, text, entities: cmd } } as any)
  return tg.filter(t => t.m === 'sendMessage')
}
const group = { id: GROUP, type: 'supergroup' }, dm = { id: ME, type: 'private' }

// private chat first: user exists with their DM as chat
await say('/start', dm)
check('private /start records the DM chat', store.getUserByTg(ME)?.tg_chat_id === String(ME))

let out = await say('/rate 100', group)
check('group /rate answers with live rate', out.length === 1 && /Textile FX on Celo, live/.test(out[0].text))
check('group /rate has a "Convert privately" button to the bot', out[0].reply_markup?.inline_keyboard?.[0]?.[0]?.url === 'https://t.me/NairaBridgeFX_bot?start=convert')
check('group /rate does not overwrite the private chat', store.getUserByTg(ME)?.tg_chat_id === String(ME))

out = await say('/rate@NairaBridgeFX_bot 50', group); check('group /rate@ourbot works', /\$50\.00 USDT/.test(out[0]?.text ?? ''))
out = await say('/convert 50 usdt', group)
check('group /convert redirects to private chat', /works in a private chat/.test(out[0]?.text) && out[0].reply_markup.inline_keyboard[0][0].url === 'https://t.me/NairaBridgeFX_bot?start=convert')
check('redirect replies to the command message', !!out[0]?.reply_parameters?.message_id)
for (const c of ['/alert 1390', '/alerts', '/history', '/wallet', '/link', '/start', '/help']) {
  out = await say(c, group)
  if (!(out.length === 1 && /works in a private chat/.test(out[0].text))) { check(`group ${c} redirects`, false) }
}
check('every other command redirects in groups', true)
check('group commands never create a link or convert session', !out.some(t => /\/link\/|\/c\//.test(JSON.stringify(t))))
out = await say('what is the dollar rate today?', group); check('normal group chat is ignored', out.length === 0)
out = await say('50 usdt', group); check('amount text in group is ignored (no spam)', out.length === 0)
out = await say('/rate@SomeOtherBot', group); check('commands for other bots are ignored', out.length === 0)

const stranger = 5151
tg.length = 0
await bot.handleUpdate({ update_id: uid++, message: { message_id: 1, date: 0, chat: group, from: { id: stranger, is_bot: false, first_name: 'X' }, text: '/rate', entities: [{ type: 'bot_command', offset: 0, length: 5 }] } } as any)
check('group /rate does not register a new user', !store.getUserByTg(stranger))

out = await say('/rate 100', dm); check('private /rate unchanged (no group button)', !out[0]?.reply_markup?.inline_keyboard && /\/convert locks a firm quote/.test(out[0].text))
out = await say('50 usdt', dm); check('private amount text still quotes', /To convert: \/convert 50 usdt/.test(out[0]?.text))

tg.length = 0; await setCommands(bot)
const scoped = tg.filter(t => t.m === 'setMyCommands')
check('command menus: full in private, only /rate in groups', scoped.length === 2 && scoped[1].scope?.type === 'all_group_chats' && scoped[1].commands.length === 1 && scoped[1].commands[0].command === 'rate')
console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED')
process.exit()
