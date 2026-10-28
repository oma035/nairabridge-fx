# NairaBridge FX

**A non-custodial agent on Celo that helps Nigerian freelancers paid in dollars move between USDT and cNGN (on-chain naira) at the best available rate, using Textile FX.**

It watches Textile's live market every 3 minutes, shows the real executable rate and liquidity on a public board, quotes and converts from Telegram, and alerts users when the rate hits their target. Users always sign in their own wallet; the agent never holds keys or funds.

Created by **Oma** ([@Omaofweb3](https://x.com/Omaofweb3)) for **Agents on Open Rails** (Celo x Loops House), Open Corridors track, Textile FX lane.

| | |
| --- | --- |
| Rate board (Quote Sentinel) | https://nairabridgefx.lovable.app |
| Telegram bot | https://t.me/NairaBridgeFX_bot |
| Public data feed | https://nairabridge-fx.onrender.com/api/board |
| ERC-8004 agent | #9998 on Celo |

## Why

A Nigerian freelancer paid $500 in USDT has to guess where to turn it into naira: exchanges, P2P desks and the parallel market all quote differently, and the spread is rarely visible before you commit. On Celo, cNGN (the regulated naira stablecoin) trades against USDT on Textile FX, where market makers compete to fill each trade at a firm price. NairaBridge FX makes that market usable from a chat: one command shows what you would really get, fee included, and one tap converts it from your own wallet.

## What it does

**Quote Sentinel and public rate board.** Every 3 minutes the agent asks Textile for prices in both directions at $5, $10, $25, $50, $200 and $1,000. It records the fee-inclusive rate, the spread, and how much can actually be filled right now. When a size gets no quote, it probes the largest size that does fill. The board shows live rates by size, depth, 24h and 7d history, comparisons with the mid-market and parallel rates, and public stats and P&L. The Sentinel caught cash-out depth moving from about $18 to over $1,000 overnight, which is why *when* to convert matters as much as *where*.

**Telegram bot.**

| Command | What it does |
| --- | --- |
| `/start` | Link an existing wallet by signing a message (no keys, no funds move) |
| `/rate 100` | Live rate both ways for $100, fee included, against reference rates |
| `/convert 50 usdt` | Cash out USDT to cNGN |
| `/convert 70000 cngn` | Top up USDT with cNGN |
| `/alert 1390` | Tell me when $100 cashes out at ₦1,390 or more per $1 |
| `/alert 1380 70000 cngn` | Tell me when buying USDT costs ₦1,380 or less per $1 |
| `/alerts` | List and cancel active alerts |
| `/history` | Past conversions and savings |
| `/wallet` | Linked wallet and eligibility status |

Typing an amount on its own (`50 usdt`, `20k ngn`) gives a quick quote.

**Convert page.** `/convert` and alert messages hand out a 15-minute link to a small page that works with MiniPay and other injected wallets (OKX, MetaMask's in-app browser) and with any WalletConnect wallet (Valora, Trust, MetaMask, Rainbow and others). The user:

1. approves exactly the amount being converted (never an unlimited allowance);
2. gets a **firm** Textile quote bound to their wallet, showing the exact amount received, the fee-inclusive rate, the 0.01% fee, comparisons with the reference rates and a live expiry countdown;
3. confirms, and signs the swap in their own wallet.

The server waits for the receipt, checks the swap on-chain (success, sent from the user's wallet, sent to the Textile reactor, carrying our attribution tag), records it, and sends a Telegram receipt with a Celoscan link.

**Rate alerts.** After every Sentinel pass the agent re-quotes each distinct alert amount once and fires the alerts that are met. An alert fires exactly once (it is claimed in the database before the message is sent), expires after 7 days, and is capped at 5 per user. The message includes a one-tap convert link and a "Set again" button.

## Hackathon entry data

| Item | Value |
| --- | --- |
| Network | Celo mainnet (42220) only |
| ERC-8004 agent ID | **9998** on Identity Registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` ([registration tx](https://celoscan.io/tx/0xeb12ce2591426396ba7319c37db9a5928457d8db7a5c29b20daf766094741e30)) |
| Agent registration file | [`agent.json`](agent.json) (served from this repo) |
| Agent wallet | [`0x1663a732de275506b569a92A90233be582288906`](https://celoscan.io/address/0x1663a732de275506b569a92A90233be582288906) |
| ERC-8021 attribution code | `celo_f91a4dd61bbc` (Loops House), set in `ATTRIBUTION_CODE` |
| Example mainnet txs (all tagged) | [ERC-8004 registration](https://celoscan.io/tx/0xeb12ce2591426396ba7319c37db9a5928457d8db7a5c29b20daf766094741e30) · [$2 USDT → ₦2,768 cNGN](https://celoscan.io/tx/0x4056ad60417f38fc9d2c3afebdcd06e5692833c529d18e209826dcf5f687796f) · [₦1,500 cNGN → $1.08 USDT](https://celoscan.io/tx/0xe7d68600b44e7de83149f890327a20dbe09e8bb656fd06e9aca9ec7c7150ea1e) |
| Gas sponsorship / relayer | **None.** Users pay their own network fees and sign every transaction in their own wallet. |
| User wallets | Never created or funded by the team. Users link wallets they already own. |

### User eligibility

The hackathon counts users whose wallets had Celo activity before 6 Oct 2026. When a wallet is linked, the agent looks up its earliest Celo transaction on Blockscout and records the result (🟢 active before 6 Oct, 🟡 not, ⚪️ could not check). It never blocks anyone; it only feeds the "eligible users" count on the board, so the count is honest and checkable.

## How the attribution tag is applied

One config value, `ATTRIBUTION_CODE`, is encoded once with [`@celo/attribution-tags`](https://www.npmjs.com/package/@celo/attribution-tags) in [`src/lib/attribution.ts`](src/lib/attribution.ts). Nothing in the codebase builds a transaction without passing through it:

- **Agent transactions** (ERC-8004 registration) go through `sendTagged()`.
- **User transactions** (the approval and the Textile swap) are tagged on the server with `tagCalldata()` before the page hands them to the user's wallet, so the browser never adds or removes anything.

The suffix sits after the ABI-encoded calldata, which the EVM ignores, so contract behaviour is unchanged. `tagCalldata()` is idempotent, and every settled swap is re-checked on-chain for the tag. Check any transaction with:

```bash
npm run verify-tag -- 0xHASH
```

## Textile integration

All contract and token addresses come from Textile's official address book (`docs.textilecredit.com/protocol/address-book.html`) and are documented in [`src/lib/config.ts`](src/lib/config.ts). On Celo: LimitOrderReactor `0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3`, 1 bps taker fee, cNGN and USDT both 6 decimals.

- **Sentinel and bot previews** use `POST /v2/rfq/preview`: indicative, no wallet needed, never reserve maker inventory or take one of the 4 outstanding-RFQ slots.
- **Conversions** use `POST /v2/rfq/request` for a firm quote bound to the user's wallet. Without a partner key, Textile asks the wallet to sign a one-time `TakerControl` proof (valid about 12 hours); the convert page handles that step.
- **Safety checks** (`assertSafeQuote`): the quote's reactor and swap target must match the address book, value must be zero, chain must be Celo, `takerPays` can never exceed the user's spend cap, and the quote must be bound to the linked wallet. The page always broadcasts `transactions.swap` (never only the first order of a multi-maker bundle).
- The tx hash is reported with `/v2/rfq/{id}/submit`. A client-side throttle keeps us under 60 requests a minute, with exponential backoff that honours `Retry-After`.

Textile has no Celo testnet deployment (its sandboxes are BSC testnet and Base Sepolia), so the project reads live mainnet previews and was tested with small mainnet trades.

## Rates, P&L and volumes

Rates are **naira per 1 USDT, fee included**, computed from `takerPays` (the exact debit) and `buyAmount`:

- cash out (USDT → cNGN): naira received per dollar, higher is better;
- top up (cNGN → USDT): naira paid per dollar, lower is better.

**P&L** is the naira users gained versus converting at each benchmark captured at request time (positive = better for the user):

- **vs mid-market:** the official or mid-market NGN/USD rate (open.er-api.com);
- **vs parallel market:** a configurable parallel-market rate (left blank when not set);
- **vs single-shot / when set:** for a normal conversion, the indicative quote shown before the firm quote; for an alert conversion, the rate when the alert was set, which measures the value of waiting.

Results are broken down by strategy (single, alert, split) on the board.

**Volumes** are reported honestly: *firm* quoted volume (real RFQs requested for users' wallets) is kept separate from the Sentinel's *indicative* preview volume, which is monitoring only and never shown as trading volume.

## Architecture

```
Telegram ──► bot (grammY) ──► short-lived link ──► convert page (browser, user's wallet)
                │                                        │ signs approve + swap (tagged)
                ▼                                        ▼
        Render service: HTTP API + bot + Sentinel ──► Textile RFQ v2 ──► Celo LimitOrderReactor
                │                       ▲
                ▼                       │ every 3 min: previews at 6 sizes, both directions
             SQLite (quotes, users, fills, alerts, sessions)
                │
                ▼
        /api/board (public, read-only, CORS) ──► Lovable rate board
```

```
src/
  main.ts               one process: web + bot + Sentinel loop + alert checks
  lib/config.ts         env + official addresses (with sources)
  lib/attribution.ts    ERC-8021: the single place the tag is applied
  lib/textile.ts        RFQ v2 client, throttle, backoff, safety checks, rate maths
  lib/fx.ts             amount parsing, previews, savings maths, formatting
  lib/reference.ts      labelled mid-market and parallel reference rates
  lib/eligibility.ts    first-Celo-activity lookup (hackathon user rule)
  lib/store.ts, db.ts   SQLite access and migrations
  lib/chain.ts          viem clients (Celo)
  sentinel/run.ts       Quote Sentinel with depth probe
  agent/alerts.ts       rate alerts: create, check, fire once, re-arm
  bot/bot.ts            Telegram commands
  server/api.ts         wallet link + convert API (builds tagged txs, settles fills)
  server/board.ts       public board feed and history
  server/http.ts        minimal HTTP server
web/                    convert and wallet-link pages (bundled with esbuild)
scripts/                quote-once, register-agent, verify-tag, new-wallet
test/                   end-to-end tests with Telegram, Textile, explorer and RPC mocked
```

## Running it

```bash
cp .env.example .env      # set TELEGRAM_BOT_TOKEN and PUBLIC_URL at minimum
npm install
npm test                  # 69 checks: link, convert, settle, board, alerts
npm run quote             # live Textile quotes on Celo, read-only
npm run dev               # web + bot + Sentinel
```

Main settings (see `.env.example`):

| Variable | Purpose |
| --- | --- |
| `ATTRIBUTION_CODE` | ERC-8021 code applied to every transaction |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `PUBLIC_URL` | Public HTTPS address of this server (for wallet links) |
| `WALLETCONNECT_PROJECT_ID` | Enables the WalletConnect button (Reown dashboard) |
| `DB_PATH` | SQLite file (on Render: a persistent disk) |
| `SENTINEL_SIZES_USD`, `SENTINEL_INTERVAL_SEC` | What the Sentinel quotes and how often |
| `REF_OFFICIAL_*`, `REF_PARALLEL_*` | Reference rate sources and labels |
| `TEXTILE_API_KEY` | Optional Textile partner key |

**Production** runs on Render as one web service (`npm install && npm run build`, start `npx tsx src/main.ts`) with a 1 GB persistent disk at `/var/data`. The agent's private key is never deployed; it was used only to register the ERC-8004 identity.

### Register the agent (ERC-8004)

1. Host `agent.json` (this repo's raw GitHub URL) and set `AGENT_URI`.
2. Fund the agent wallet with a little CELO and set `AGENT_PRIVATE_KEY` locally.
3. `npm run register-agent`, then add the printed `agentId` to `agent.json`.

## Safety

- Non-custodial: the agent never holds or asks for user keys. Wallets are linked by signature; every transaction is signed by the user.
- Exact approvals only, checked against the user's balance first.
- Every conversion shows the exact amount received, fee, rate, expiry and "no slippage (firm quote)", and needs explicit confirmation in the page and in the wallet. An expired quote never executes.
- Quotes are checked against Textile's address book before they reach the user.
- The public feed exposes no usernames or wallet addresses.

## Known limitations

- MiniPay only opens listed Mini Apps, so MiniPay users need a listing (or developer mode for testing). Other wallets work today through WalletConnect.
- MiniPay displays only USDm, USDC and USDT, so cNGN received there arrives on-chain but is not shown in its balance.
- MetaMask users need a little CELO for network fees; MiniPay pays fees in stablecoins.
- Textile liquidity on Celo can thin out at times; the Sentinel shows the current maximum and alerts let users wait for depth.

## Roadmap

- Split execution: break large orders into chunks over time and report the average rate against a single-shot quote.
- MiniPay Mini App listing.
- Textile partner key for webhooks and a single-signature flow.

All code in this repository was written during the hackathon.

Built by Oma · [@Omaofweb3](https://x.com/Omaofweb3)
