/** Minimal HTTP server: serves the wallet pages and the JSON API. No framework needed. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from '../lib/config.js'
import { TextileError } from '../lib/textile.js'
import { boardHistory, boardSnapshot } from './board.js'
import { convertApproval, convertInfo, convertQuote, convertStatus, convertSubmit, HttpError, linkChallenge, linkVerify, publicConfig } from './api.js'

const WEB = join(process.cwd(), 'web')

async function body(req: IncomingMessage): Promise<any> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 32_000) throw new HttpError(413, 'body too large')
  }
  try { return raw ? JSON.parse(raw) : {} } catch { throw new HttpError(400, 'invalid JSON') }
}

function send(res: ServerResponse, status: number, data: unknown, type = 'application/json', extra: Record<string, string> = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extra,
  })
  res.end(type === 'application/json' ? JSON.stringify(data) : (data as string | Buffer))
}

async function page(res: ServerResponse) {
  send(res, 200, await readFile(join(WEB, 'index.html')), 'text/html; charset=utf-8')
}

type Handler = (req: IncomingMessage, m: RegExpMatchArray) => Promise<unknown> | unknown
const routes: Array<[string, RegExp, Handler]> = [
  ['GET', /^\/api\/config$/, () => publicConfig()],
  ['GET', /^\/api\/link\/([\w-]+)$/, (_r, m) => linkChallenge(m[1])],
  ['POST', /^\/api\/link$/, async (r) => linkVerify(await body(r))],
  ['GET', /^\/api\/convert\/([\w-]+)$/, (_r, m) => convertInfo(m[1])],
  ['GET', /^\/api\/convert\/([\w-]+)\/status$/, (_r, m) => convertStatus(m[1])],
  ['POST', /^\/api\/convert\/approval$/, async (r) => convertApproval(await body(r))],
  ['POST', /^\/api\/convert\/quote$/, async (r) => convertQuote(await body(r))],
  ['POST', /^\/api\/convert\/submit$/, async (r) => convertSubmit(await body(r))],
]

export function startServer(port = config.port) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    try {
      // the public rate board lives on Lovable; send visitors of the bare domain there
      if (req.method === 'GET' && path === '/') { res.writeHead(302, { Location: config.boardUrl }); return res.end() }
      if (req.method === 'GET' && /^\/(link|c)\/[\w-]+$/.test(path)) return await page(res)
      // bundled client: /app.js and its lazily loaded chunks (WalletConnect)
      const js = path.match(/^\/((?:app|chunk-[A-Za-z0-9]+))\.js$/)
      if (req.method === 'GET' && js) {
        return send(res, 200, await readFile(join(WEB, 'dist', `${js[1]}.js`)).catch(() => { throw new HttpError(404, 'not found') }),
          'text/javascript; charset=utf-8')
      }
      if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true })
      // public, read-only rate board feed (CORS open so the Lovable front end can call it)
      if (path.startsWith('/api/board')) {
        const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'public, max-age=15' }
        if (req.method === 'OPTIONS') return send(res, 204, '', 'text/plain', cors)
        if (req.method === 'GET' && path === '/api/board') return send(res, 200, await boardSnapshot(), 'application/json', cors)
        if (req.method === 'GET' && path === '/api/board/history') return send(res, 200, boardHistory(url.searchParams.get('range') ?? '24h'), 'application/json', cors)
      }
      for (const [method, re, handler] of routes) {
        const m = path.match(re)
        if (m && req.method === method) return send(res, 200, await handler(req, m))
      }
      send(res, 404, { error: 'not found' })
    } catch (e: any) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message })
      if (e instanceof TextileError) {
        console.error('textile', e.message)
        return send(res, e.transient ? 503 : 502, { error: e.transient ? 'Textile is busy, try again in a few seconds.' : 'Textile rejected the request.' })
      }
      console.error(path, e)
      send(res, 500, { error: 'Something went wrong. Nothing was sent from your wallet.' })
    }
  })
  server.listen(port, () => console.log(`web: listening on :${port}`))
  return server
}
