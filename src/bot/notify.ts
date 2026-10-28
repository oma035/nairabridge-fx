import { Api, type RawApi } from 'grammy'
import { config } from '../lib/config.js'

let api: Api<RawApi> | undefined
/** Shared Bot API client (also lets tests install a transformer). */
export const notifyApi = () => (api ??= new Api(config.botToken()))
const get = notifyApi

/** Send a plain-text Telegram message from anywhere (server, settlement, alerts). */
export async function notify(chatId: string | number, text: string, extra: Record<string, unknown> = {}) {
  return get().sendMessage(chatId, text, { link_preview_options: { is_disabled: true }, ...extra })
}
