/**
 * Browser client for /link/<token> and /c/<token>.
 * Talks to the user's wallet over plain EIP-1193 (MiniPay, Valora, MetaMask, WalletConnect).
 * Every transaction it sends was built and tagged by the server; this page only asks the wallet to sign.
 */
import { createPublicClient, http, stringToHex, type Hex } from 'viem'
import { celo } from 'viem/chains'

type Eip1193 = { request(a: { method: string; params?: unknown[] | object }): Promise<any>; on?: (e: string, f: (...a: any[]) => void) => void }
declare global { interface Window { ethereum?: Eip1193 & { isMiniPay?: boolean; isMetaMask?: boolean } } }

const $app = document.getElementById('app')!
const pub = createPublicClient({ chain: celo, transport: http('https://forno.celo.org') })
const CELO_HEX = '0xa4ec'

// ---------------- tiny helpers ----------------
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const ngn = (n: number) => `₦${Math.round(n).toLocaleString('en-US')}`
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const amt = (n: number, t: string) => (t === 'USDT' ? `${usd(n)} USDT` : `${ngn(n)} cNGN`)
const rate = (r: number) => r.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${ngn(Math.abs(n))}`

async function api<T = any>(path: string, body?: object): Promise<T> {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error ?? `Request failed (${res.status})`)
  return j
}

function friendly(e: any): string {
  const code = e?.code ?? e?.data?.code
  if (code === 4001 || /reject|denied|cancel/i.test(e?.message ?? '')) return 'You cancelled in your wallet. Nothing was sent.'
  return e?.shortMessage ?? e?.message ?? String(e)
}

function render(html: string) { $app.innerHTML = html }
function note(kind: 'ok' | 'warn' | 'err', html: string) { return `<div class="note ${kind}">${html}</div>` }

// ---------------- wallet connection ----------------
let provider: Eip1193 | undefined
let account: Hex | undefined
let cfg: { chainId: number; walletConnectProjectId: string } = { chainId: 42220, walletConnectProjectId: '' }

async function connectInjected(): Promise<Hex> {
  provider = window.ethereum!
  const accts: string[] = await provider.request({ method: 'eth_requestAccounts' })
  return (account = accts[0] as Hex)
}

async function connectWalletConnect(): Promise<Hex> {
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider')
  const wc = await EthereumProvider.init({
    projectId: cfg.walletConnectProjectId,
    chains: [42220],
    showQrModal: true,
    metadata: { name: 'NairaBridge FX', description: 'Convert USDT and cNGN on Celo', url: location.origin, icons: [] },
  })
  await wc.connect()
  provider = wc as unknown as Eip1193
  return (account = (wc.accounts[0] as Hex))
}

async function ensureCelo() {
  const id: string = await provider!.request({ method: 'eth_chainId' })
  if (id?.toLowerCase() === CELO_HEX) return
  try {
    await provider!.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CELO_HEX }] })
  } catch (e: any) {
    if (e?.code !== 4902) throw new Error('Please switch your wallet to the Celo network and try again.')
    await provider!.request({ method: 'wallet_addEthereumChain', params: [{
      chainId: CELO_HEX, chainName: 'Celo', nativeCurrency: { name: 'CELO', symbol: 'CELO', decimals: 18 },
      rpcUrls: ['https://forno.celo.org'], blockExplorerUrls: ['https://celoscan.io'],
    }] })
  }
}

async function sendTx(tx: { to: string; data: string; value?: string }): Promise<Hex> {
  return provider!.request({ method: 'eth_sendTransaction', params: [{ from: account, to: tx.to, data: tx.data, value: tx.value ?? '0x0' }] })
}

/** Connect screen. Resolves once a wallet is connected on Celo. */
function connect(title: string, sub: string): Promise<Hex> {
  return new Promise((resolve) => {
    const go = async (fn: () => Promise<Hex>) => {
      try { await fn(); await ensureCelo(); resolve(account!) } catch (e) { $('#cerr').innerHTML = note('err', esc(friendly(e))) }
    }
    if (window.ethereum) {
      // MiniPay and in-wallet browsers inject a provider: connect straight away.
      render(`<div class="card"><h2>${title}</h2><p class="muted">${sub}</p><p class="muted">Connecting to your wallet…</p><div id="cerr"></div></div>`)
      go(connectInjected)
      return
    }
    const here = location.href.replace(/^https?:\/\//, '')
    render(`<div class="card"><h2>${title}</h2><p class="muted">${sub}</p>
      ${cfg.walletConnectProjectId ? '<button id="wc">Connect wallet (Valora, MetaMask, others)</button>' : ''}
      <a class="btn secondary" href="https://metamask.app.link/dapp/${esc(here)}">Open in MetaMask app</a>
      <button class="secondary" id="copy">Copy link (open it in your wallet's browser)</button>
      <div id="cerr"></div></div>`)
    $('#wc')?.addEventListener('click', () => go(connectWalletConnect))
    $('#copy').addEventListener('click', async () => {
      await navigator.clipboard.writeText(location.href).catch(() => {})
      $('#copy').textContent = 'Link copied'
    })
  })
}
const $ = (sel: string) => document.querySelector(sel) as HTMLElement

// ---------------- /link/<token> ----------------
async function linkPage(token: string) {
  const ch = await api<{ message: string; telegram: string }>(`/api/link/${token}`)
  const addr = await connect('Link your wallet', `For Telegram ${esc(ch.telegram)}. You will sign a message. It does not move funds.`)
  render(`<div class="card"><h2>Link this wallet?</h2>
    <div class="row"><span>Wallet</span><b class="mono">${esc(addr)}</b></div>
    <div class="row"><span>Telegram</span><b>${esc(ch.telegram)}</b></div>
    <button id="sign">Sign to link</button><div id="out"></div></div>`)
  $('#sign').addEventListener('click', async () => {
    const btn = $('#sign') as HTMLButtonElement
    btn.disabled = true
    try {
      const signature: Hex = await provider!.request({ method: 'personal_sign', params: [stringToHex(ch.message), addr] })
      const r = await api('/api/link', { token, address: addr, signature })
      const el = r.eligibility
      render(`<div class="card"><h2>✅ Wallet linked</h2>
        <p class="mono">${esc(r.wallet)}</p>
        ${note(el.eligible ? 'ok' : 'warn', esc(el.note))}
        <p class="muted">Go back to Telegram. Try <b>/rate</b> or <b>/convert 20 usdt</b>.</p></div>`)
    } catch (e) {
      btn.disabled = false
      $('#out').innerHTML = note('err', esc(friendly(e)))
    }
  })
}

// ---------------- /c/<token> ----------------
async function convertPage(token: string) {
  const info = await api(`/api/convert/${token}`)
  const title = `Convert ${amt(info.amount, info.sell)} → ${info.buy}`
  const addr = await connect(title, `From your linked wallet ${short(info.wallet)}.`)
  if (addr.toLowerCase() !== String(info.wallet).toLowerCase()) {
    return render(`<div class="card"><h2>Wrong wallet</h2>${note('err',
      `This conversion is for your linked wallet <b class="mono">${esc(info.wallet)}</b>, but your wallet is on <b class="mono">${esc(addr)}</b>. Switch accounts in your wallet and reload, or use /link in Telegram.`)}</div>`)
  }

  const steps = (n: number) => [`Approve ${info.sell}`, 'Get a firm quote', 'Confirm swap'].map((t, i) =>
    `<div class="step"><span class="dot ${i < n ? 'done' : i === n ? 'on' : ''}">${i < n ? '✓' : i + 1}</span>${t}</div>`).join('')

  // Step 1: allowance for exactly this amount (never unlimited)
  const approval = async () => {
    render(`<div class="card"><h2>${esc(title)}</h2>${steps(0)}<p class="muted">Checking your balance and approval…</p><div id="out"></div></div>`)
    const { txs } = await api('/api/convert/approval', { token })
    if (!txs.length) return quote()
    render(`<div class="card"><h2>${esc(title)}</h2>${steps(0)}
      <p class="muted">Allow Textile's settlement contract to take exactly ${amt(info.amount, info.sell)} from your wallet when you confirm. ${txs.length > 1 ? 'Your wallet will ask twice (reset, then approve).' : ''}</p>
      <button id="go">Approve ${esc(info.sell)}</button><div id="out"></div></div>`)
    $('#go').addEventListener('click', async () => {
      const b = $('#go') as HTMLButtonElement; b.disabled = true; b.textContent = 'Waiting for wallet…'
      try {
        for (const tx of txs) {
          const h = await sendTx(tx)
          b.textContent = 'Confirming on Celo…'
          const r = await pub.waitForTransactionReceipt({ hash: h, timeout: 120_000 })
          if (r.status !== 'success') throw new Error('Approval failed on-chain.')
        }
        quote()
      } catch (e) { b.disabled = false; b.textContent = `Approve ${info.sell}`; $('#out').innerHTML = note('err', esc(friendly(e))) }
    })
  }

  // Step 2: firm quote (may need a one-time proof-of-control signature)
  const quote = async (proof?: object) => {
    render(`<div class="card"><h2>${esc(title)}</h2>${steps(1)}<p class="muted">Asking market makers for a firm price…</p><div id="out"></div></div>`)
    try {
      const q = await api('/api/convert/quote', { token, takerProof: proof })
      if (q.needProof) {
        render(`<div class="card"><h2>${esc(title)}</h2>${steps(1)}
          <p class="muted">Textile asks your wallet to confirm it is yours once (valid about 12 hours). This signature does not move funds.</p>
          <button id="go">Sign to continue</button><div id="out"></div></div>`)
        $('#go').addEventListener('click', async () => {
          try {
            const signature = await provider!.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(q.typedData)] })
            quote({ nonce: q.nonce, issuedAt: q.issuedAt, signature })
          } catch (e) { $('#out').innerHTML = note('err', esc(friendly(e))) }
        })
        return
      }
      if (q.noQuote) {
        const max = q.maxSell ? `<br/>Max available right now: <b>${amt(q.maxSell, info.sell)}</b>. Go back to Telegram and convert that amount, or try again shortly.` : ''
        render(`<div class="card"><h2>${esc(title)}</h2>${steps(1)}${note('warn', `No maker can fill this right now.${max}`)}<button id="again">Try again</button></div>`)
        $('#again').addEventListener('click', () => quote())
        return
      }
      confirmScreen(q)
    } catch (e) {
      render(`<div class="card"><h2>${esc(title)}</h2>${steps(1)}${note('err', esc(friendly(e)))}<button id="again">Try again</button></div>`)
      $('#again').addEventListener('click', () => quote())
    }
  }

  // Step 3: show exact numbers + countdown, user confirms, wallet signs
  const confirmScreen = (q: any) => {
    const exp = Date.parse(q.expiresAt)
    const refRow = (r: any, s: number | null) => r?.rate && s !== null ? `<div class="row"><span>vs ${esc(r.label)} (${rate(r.rate)})</span><b>${signed(s)}</b></div>` : ''
    render(`<div class="card"><h2>${esc(title)}</h2>${steps(2)}
      <p class="muted" style="margin-top:12px">You receive exactly</p>
      <div class="big">${amt(q.receives, info.buy)}</div>
      <div style="margin-top:10px">
        <div class="row"><span>You pay</span><b>${amt(q.pays, info.sell)}</b></div>
        <div class="row"><span>Rate (fee included)</span><b>${rate(q.rate)} NGN/USDT</b></div>
        <div class="row"><span>Textile fee (0.01%)</span><b>${amt(q.fee, info.sell)}</b></div>
        ${refRow(q.refs.parallel, q.vsParallel)}${refRow(q.refs.official, q.vsOfficial)}
        <div class="row"><span>Slippage</span><b>None: firm quote</b></div>
        <div class="row"><span>Quote expires in</span><b class="timer" id="t">…</b></div>
      </div>
      <button id="go">Confirm swap</button>
      <p class="muted">Network fee is paid by your wallet. If the quote expires, nothing executes.</p>
      <div id="out"></div></div>`)
    const btn = $('#go') as HTMLButtonElement
    const timer = setInterval(() => {
      const left = Math.max(0, Math.floor((exp - Date.now()) / 1000))
      $('#t') && ($('#t').textContent = `${left}s`)
      if (left <= 3 && !btn.dataset.sent) {
        clearInterval(timer); btn.textContent = 'Get a new quote'; btn.onclick = () => quote()
      }
    }, 250)
    btn.onclick = async () => {
      if (Date.now() > exp - 3000) return quote()
      btn.disabled = true; btn.dataset.sent = '1'; btn.textContent = 'Confirm in your wallet…'
      try {
        const hash = await sendTx(q.swapTx)
        clearInterval(timer)
        await api('/api/convert/submit', { token, txHash: hash })
        settling(hash)
      } catch (e) {
        delete btn.dataset.sent; btn.disabled = false; btn.textContent = 'Confirm swap'
        $('#out').innerHTML = note('err', esc(friendly(e)))
      }
    }
  }

  const settling = async (hash: string) => {
    const link = `https://celoscan.io/tx/${hash}`
    render(`<div class="card"><h2>Swap sent</h2>${steps(3)}<p class="muted">Waiting for Celo to confirm (a few seconds)…</p>
      <p><a href="${link}" target="_blank" rel="noopener">View on Celoscan</a></p></div>`)
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000))
      const s = await api(`/api/convert/${token}/status`).catch(() => null)
      const st = s?.result?.state
      if (st === 'filled') return render(`<div class="card"><h2>✅ Converted</h2>${note('ok', 'Done. A receipt is in your Telegram chat.')}
        <p><a href="${link}" target="_blank" rel="noopener">View on Celoscan</a></p><p class="muted">You can close this page.</p></div>`)
      if (st === 'failed') return render(`<div class="card"><h2>Swap did not settle</h2>${note('err', 'Nothing was converted. Your funds stay in your wallet.')}
        <p><a href="${link}" target="_blank" rel="noopener">View on Celoscan</a></p></div>`)
    }
  }

  approval().catch((e) => render(`<div class="card"><h2>${esc(title)}</h2>${note('err', esc(friendly(e)))}</div>`))
}

// ---------------- router ----------------
;(async () => {
  try {
    cfg = await api('/api/config')
    const m = location.pathname.match(/^\/(link|c)\/([\w-]+)$/)
    if (!m) return render(`<div class="card"><h2>NairaBridge FX</h2><p class="muted">Open this page from the Telegram bot.</p></div>`)
    await (m[1] === 'link' ? linkPage(m[2]) : convertPage(m[2]))
  } catch (e) {
    render(`<div class="card">${note('err', esc(friendly(e)))}</div>`)
  }
})()
