/**
 * NairaBridge FX Telegram bot.
 * The bot never holds keys. It links a wallet by signature and hands out short-lived
 * links to a convert page where the user signs in their own wallet.
 */
import { Bot, InlineKeyboard, type Context } from 'grammy'
import { config } from '../lib/config.js'
import { celoscanAddr } from '../lib/chain.js'
import { allUserFills, createSession, getUserByTg, upsertUser, useSession, liveSession, userFills, type User, type ConvertPayload } from '../lib/store.js'
import { fmtRate, fmtToken, ngn, other, parseAmount, preview, savingsNgn, signedNgn, toAtomic, fromAtomic, type Preview } from '../lib/fx.js'
import type { TokenSymbol } from '../lib/config.js'
import { db } from '../lib/db.js'
import { activeAlerts, cancelAlert, createAlert, describeAlert, firedMessage, getAlert, isMet } from '../agent/alerts.js'

const LINK_TTL = 15 * 60_000
const CONVERT_TTL = 15 * 60_000

const HELP = [
  'NairaBridge FX converts between USDT and cNGN (on-chain naira) on Celo at the best Textile FX rate. You always sign in your own wallet; I never hold your keys.',
  '',
  '/rate 100  current rate for $100 (or /rate 50000 cngn)',
  '/convert 50 usdt  USDT → naira',
  '/convert 70000 cngn  naira → USDT',
  '/alert 1390  tell me when $100 cashes out at ₦1,390+ per $1',
  '/alert 1380 70000 cngn  tell me when buying USDT costs ₦1,380 or less',
  '/alerts  your active alerts',
  '/history  your conversions and savings',
  '/wallet  your linked wallet',
  '/link  link a different wallet',
].join('\n')

function me(ctx: Context): User {
  return upsertUser(ctx.from!.id, ctx.from!.username, ctx.chat?.id ?? ctx.from!.id)
}

async function sendLink(ctx: Context, user: User) {
  const token = createSession('link', user.id, {}, LINK_TTL)
  const kb = new InlineKeyboard().url('🔗 Link my wallet', `${config.publicUrl()}/link/${token}`)
  await ctx.reply(
    'Link your Celo wallet (MiniPay, Valora, MetaMask or any WalletConnect wallet). You sign a short message to prove it is yours. It does not move funds. The link works for 15 minutes.',
    { reply_markup: kb },
  )
}

function refLines(p: Preview, usdAmt: number) {
  const out: string[] = []
  for (const r of [p.refs.parallel, p.refs.official]) {
    if (!r.rate || !p.rate) continue
    const s = savingsNgn(p.sell, p.rate, usdAmt, r.rate)!
    out.push(`vs ${r.label} ${fmtRate(r.rate)}: ${ngn(Math.abs(s))} ${s >= 0 ? 'better' : 'worse'} for you`)
  }
  return out
}

function describe(p: Preview): string {
  if (!p.ok) {
    const max = p.maxSell && p.maxSell >= (p.sell === 'USDT' ? 1 : 1500) ? `\nMax available right now: ${fmtToken(p.maxSell, p.sell)}` : ''
    const why = p.reason === 'no_makers_online' ? 'No market makers are online for this pair right now.' : 'No maker can fill this size right now.'
    return `${p.sell} → ${p.buy}: ${why}${max}`
  }
  const usdAmt = p.sell === 'USDT' ? p.pays! : p.receives!
  return [
    `${fmtToken(p.pays!, p.sell)} → ${fmtToken(p.receives!, p.buy)}`,
    `Rate ${fmtRate(p.rate!)} NGN/USDT (0.01% Textile fee included: ${fmtToken(p.fee!, p.sell)})`,
    ...refLines(p, usdAmt),
  ].join('\n')
}

export function createBot() {
  const bot = new Bot(config.botToken())

  bot.command('start', async (ctx) => {
    const user = me(ctx)
    if (user.wallet) {
      return ctx.reply(`Welcome back. Linked wallet: ${user.wallet}\n\n${HELP}`)
    }
    await ctx.reply(`👋 ${HELP}`)
    await sendLink(ctx, user)
  })

  bot.command('help', (ctx) => ctx.reply(HELP))

  bot.command('link', async (ctx) => sendLink(ctx, me(ctx)))

  bot.command('wallet', async (ctx) => {
    const u = me(ctx)
    if (!u.wallet) return sendLink(ctx, u)
    const el = u.eligible === 1 ? '🟢' : u.eligible === 0 ? '🟡' : '⚪️'
    return ctx.reply(`Wallet: ${u.wallet}\n${el} ${u.eligibility_note ?? 'eligibility not checked yet'}\n${celoscanAddr(u.wallet)}`,
      { link_preview_options: { is_disabled: true } })
  })

  bot.command('rate', async (ctx) => {
    me(ctx)
    const parsed = parseAmount(ctx.match || '100') ?? parseAmount('100')!
    await ctx.replyWithChatAction('typing')
    const p = await preview(parsed.token, parsed.amount)
    const lines = [`📊 Textile FX on Celo, live`, '', describe(p)]
    // the other direction at roughly the same dollar size, for context
    const mid = p.rate ?? p.refs.official.rate ?? 1400
    const otherAmt = parsed.token === 'USDT' ? parsed.amount * mid : parsed.amount / mid
    const q = await preview(other(parsed.token), otherAmt).catch(() => undefined)
    if (q) lines.push('', describe(q))
    lines.push('', 'Indicative price. /convert locks a firm quote before you sign.')
    await ctx.reply(lines.join('\n'))
  })

  bot.command('convert', async (ctx) => {
    const user = me(ctx)
    if (!user.wallet) {
      await ctx.reply('First, link your wallet.')
      return sendLink(ctx, user)
    }
    const parsed = parseAmount(ctx.match || '')
    if (!parsed) return ctx.reply('Tell me how much, for example:\n/convert 50 usdt\n/convert 70000 cngn')
    await ctx.replyWithChatAction('typing')
    const p = await preview(parsed.token, parsed.amount)
    if (!p.ok) {
      const tip = p.maxSell && p.maxSell >= 1 ? `\n\nTry /convert ${Math.floor(p.maxSell)} ${parsed.token.toLowerCase()} now.` : ''
      return ctx.reply(`${describe(p)}${tip}`)
    }
    const token = createSession('convert', user.id, {
      sell: p.sell, buy: p.buy, sellAmount: toAtomic(parsed.amount, p.sell).toString(), strategy: 'single',
      previewRate: p.rate, refParallel: p.refs.parallel.rate, refOfficial: p.refs.official.rate,
    }, CONVERT_TTL)
    const kb = new InlineKeyboard()
      .url('✍️ Review & sign in wallet', `${config.publicUrl()}/c/${token}`).row()
      .text('Cancel', `cancel:${token}`)
    await ctx.reply([
      `🔁 Convert ${fmtToken(parsed.amount, p.sell)} → ${p.buy}`,
      '',
      describe(p),
      '',
      'Next: open the link, approve, and confirm. You get a firm quote (valid up to 60 seconds) and see the exact amount before signing. Nothing happens without your confirmation.',
    ].join('\n'), { reply_markup: kb })
  })

  bot.callbackQuery(/^cancel:([\w-]+)$/, async (ctx) => {
    const token = ctx.match[1]
    const s = liveSession<ConvertPayload>(token, 'convert')
    if (s && String(getUserByTg(ctx.from.id)?.id) === String(s.user_id) && !s.payload.txHash) useSession(token)
    await ctx.answerCallbackQuery({ text: 'Cancelled' })
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {})
    await ctx.reply('Cancelled. Nothing was sent.')
  })

  // ---------- alerts ----------
  const ALERT_HELP = [
    'Set a rate alert. I check Textile every 3 minutes and message you when it hits.',
    '',
    '/alert 1390  cash out $100 when you get ₦1,390+ per $1',
    '/alert 1390 50 usdt  same, for $50',
    '/alert 1380 70000 cngn  top up when ₦70,000 buys USDT at ₦1,380 or less per $1',
  ].join('\n')

  /** "/alert <rate> [amount] [usdt|cngn]" -> parts, or an error message */
  function parseAlert(text: string): { target: number; sell: TokenSymbol; amount: number } | string {
    const [first, ...rest] = text.trim().replace(/,/g, '').split(/\s+/)
    const target = Number(first?.replace(/^₦/, ''))
    if (!first || !(target > 0)) return ALERT_HELP
    if (target < 500 || target > 5000) return `${first} doesn't look like a naira per dollar rate. Rates are around ${fmtRate(1385)}.`
    const tail = rest.join(' ').toLowerCase()
    if (!tail) return { target, sell: 'USDT', amount: 100 }
    if (/^(usdt|usd|\$)$/.test(tail)) return { target, sell: 'USDT', amount: 100 }
    if (/^(cngn|ngn|naira|₦)$/.test(tail)) return { target, sell: 'cNGN', amount: 140_000 }
    const amt = parseAmount(tail)
    return amt ? { target, sell: amt.token, amount: amt.amount } : ALERT_HELP
  }

  async function setAlert(ctx: Context, user: User, target: number, sell: TokenSymbol, amount: number) {
    const p = await preview(sell, amount)
    let a
    try { a = createAlert(user.id, sell, amount, target, p.ok ? p.rate! : null) } catch (e: any) { return ctx.reply(e.message) }
    // already met right now: fire immediately instead of waiting 3 minutes
    if (p.ok && p.rate && p.receives && isMet(sell, p.rate, target)) {
      db.prepare('UPDATE alerts SET fired_at = ?, fired_rate = ? WHERE id = ?').run(Date.now(), p.rate, a.id)
      const { text, kb } = firedMessage(a, p.rate, p.receives, !!user.wallet)
      return ctx.reply(`Good news, the rate already beats your target.\n\n${text}`, { reply_markup: kb })
    }
    const now = p.ok ? `Now: ${fmtRate(p.rate!)} NGN/USDT for this amount.` : 'No maker can fill this amount right now; I will keep checking.'
    return ctx.reply(`🔔 Alert #${a.id} set: ${describeAlert(a)}\n${now}\nI check every 3 minutes for 7 days. /alerts to manage.`)
  }

  bot.command('alert', async (ctx) => {
    const user = me(ctx)
    const parsed = parseAlert(ctx.match || '')
    if (typeof parsed === 'string') {
      const p = await preview('USDT', 100).catch(() => undefined)
      return ctx.reply(p?.ok ? `${parsed}\n\nRight now $100 cashes out at ${fmtRate(p.rate!)} NGN/USDT.` : parsed)
    }
    await ctx.replyWithChatAction('typing')
    return setAlert(ctx, user, parsed.target, parsed.sell, parsed.amount)
  })

  bot.command('alerts', async (ctx) => {
    const user = me(ctx)
    const list = activeAlerts(user.id)
    if (!list.length) return ctx.reply(`No active alerts.\n\n${ALERT_HELP}`)
    const kb = InlineKeyboard.from(list.map((a) => [InlineKeyboard.text(`✖ Cancel #${a.id}`, `cancelalert:${a.id}`)]))
    const lines = list.map((a) => `#${a.id}  ${describeAlert(a)}  (until ${new Date(a.expires_at).toISOString().slice(0, 10)})`)
    return ctx.reply(['🔔 Your active alerts', '', ...lines].join('\n'), { reply_markup: kb })
  })

  bot.callbackQuery(/^cancelalert:(\d+)$/, async (ctx) => {
    const user = me(ctx)
    const ok = cancelAlert(user.id, Number(ctx.match[1]))
    await ctx.answerCallbackQuery({ text: ok ? 'Alert cancelled' : 'Already gone' })
    if (ok) await ctx.reply(`Alert #${ctx.match[1]} cancelled.`)
  })

  bot.callbackQuery(/^rearm:(\d+)$/, async (ctx) => {
    const user = me(ctx)
    const old = getAlert(Number(ctx.match[1]))
    await ctx.answerCallbackQuery()
    if (!old || old.user_id !== user.id) return ctx.reply('That alert is not yours.')
    return setAlert(ctx, user, old.target_rate, old.sell, fromAtomic(old.amount, old.sell))
  })

  bot.command('history', async (ctx) => {
    const u = me(ctx)
    const recent = userFills(u.id, 10)
    if (!recent.length) return ctx.reply('No conversions yet. Try /convert 20 usdt')
    const lines = ['🧾 Your last conversions', '']
    for (const f of recent) {
      const d = new Date(f.ts).toISOString().slice(0, 10)
      lines.push(`${d}  ${fmtToken(fromAtomic(f.sell_amount, f.sell), f.sell)} → ${fmtToken(fromAtomic(f.buy_amount, f.buy), f.buy)} @ ${fmtRate(f.rate_ngn_usdt)}`)
    }
    let par = 0, off = 0, parN = 0, offN = 0, vol = 0
    for (const f of allUserFills(u.id)) {
      const usdAmt = f.sell === 'USDT' ? fromAtomic(f.sell_amount, 'USDT') : fromAtomic(f.buy_amount, 'USDT')
      vol += usdAmt
      const a = savingsNgn(f.sell, f.rate_ngn_usdt, usdAmt, f.ref_parallel); if (a !== null) { par += a; parN++ }
      const b = savingsNgn(f.sell, f.rate_ngn_usdt, usdAmt, f.ref_official); if (b !== null) { off += b; offN++ }
    }
    lines.push('', `Total converted: $${vol.toFixed(2)}`)
    if (parN) lines.push(`vs parallel market: ${signedNgn(par)}`)
    if (offN) lines.push(`vs mid-market: ${signedNgn(off)}`)
    await ctx.reply(lines.join('\n'))
  })

  // "50 usdt" or "20k ngn" on its own = a quick rate check
  bot.on('message:text', async (ctx) => {
    const parsed = parseAmount(ctx.message.text)
    if (!parsed) return ctx.reply(HELP)
    me(ctx)
    const p = await preview(parsed.token, parsed.amount)
    await ctx.reply(`${describe(p)}\n\nTo convert: /convert ${parsed.amount} ${parsed.token.toLowerCase()}`)
  })

  bot.catch((err) => {
    console.error('bot error', err.error)
    err.ctx.reply('Sorry, something went wrong. Nothing was sent from your wallet. Please try again.').catch(() => {})
  })

  return bot
}

export async function setCommands(bot: Bot) {
  await bot.api.setMyCommands([
    { command: 'rate', description: 'Live USDT ↔ naira rate' },
    { command: 'convert', description: 'Convert, e.g. /convert 50 usdt' },
    { command: 'alert', description: 'Rate alert, e.g. /alert 1390' },
    { command: 'alerts', description: 'Your active alerts' },
    { command: 'history', description: 'Your conversions and savings' },
    { command: 'wallet', description: 'Your linked wallet' },
    { command: 'link', description: 'Link a different wallet' },
    { command: 'help', description: 'How it works' },
  ])
}
