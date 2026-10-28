# NairaBridge FX

A non-custodial agent on **Celo mainnet** that helps Nigerian freelancers paid in dollars move between **cNGN** (on-chain naira) and **USDT** at the best available rate, using **Textile FX**. It ships with **Quote Sentinel**, a public rate board that tracks Textile's real executable rates against the parallel and official markets.

Built for **Agents on Open Rails** (Celo x Loops House), Open Corridors track, Textile FX lane.

> Status: work in progress. Step 1 (scaffold, attribution, Textile client, ERC-8004 registration, Sentinel collector) is done. Rate board, Telegram convert flow, alerts and split execution follow.

## Hackathon entry data

| Item | Value |
| --- | --- |
| Network | Celo mainnet (42220) only |
| ERC-8004 agent ID | **9998** on Identity Registry `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` ([registration tx](https://celoscan.io/tx/0xeb12ce2591426396ba7319c37db9a5928457d8db7a5c29b20daf766094741e30)) |
| Agent wallet | [`0x1663a732de275506b569a92A90233be582288906`](https://celoscan.io/address/0x1663a732de275506b569a92A90233be582288906) |
| ERC-8021 attribution code | `celo_f91a4dd61bbc` (Loops House), set in `ATTRIBUTION_CODE` |
| Example mainnet txs | [ERC-8004 registration (tagged)](https://celoscan.io/tx/0xeb12ce2591426396ba7319c37db9a5928457d8db7a5c29b20daf766094741e30), [first Textile swap: $2 USDT → ₦2,768 cNGN (tagged)](https://celoscan.io/tx/0x4056ad60417f38fc9d2c3afebdcd06e5692833c529d18e209826dcf5f687796f) |
| Gas sponsorship / relayer | **None.** Users pay their own gas and sign every transaction in their own wallet. |

## How the attribution tag is applied

One config value, `ATTRIBUTION_CODE`, is encoded once with `@celo/attribution-tags` in `src/lib/attribution.ts`. Nothing else in the codebase builds a transaction without passing through it:

- **Agent transactions** (ERC-8004 registration and any future agent call) go through `sendTagged()`.
- **User transactions** (the Textile approval and swap returned by `/v2/rfq/request`) go through `tagCalldata()` before they are handed to the user's wallet to sign.

The suffix is appended after the ABI-encoded calldata, which the EVM ignores, so contract behaviour is unchanged. `tagCalldata()` is idempotent. Check any transaction with `npm run verify-tag -- 0xHASH`.

## Textile integration

All addresses come from Textile's official address book (`docs.textilecredit.com/protocol/address-book.html`) and are documented in `src/lib/config.ts`. On Celo: LimitOrderReactor `0xa9AA…35b3`, 1 bps taker fee, cNGN and USDT both 6 decimals. Before any swap is shown to a user, `assertSafeQuote()` checks that the quote's reactor and swap target match the address book, the value is zero and the chain is Celo.

- **Sentinel** uses `POST /v2/rfq/preview`: indicative, free, no wallet, and it never reserves maker inventory or takes one of the 4 outstanding-RFQ slots.
- **Conversions** use `POST /v2/rfq/request` for a firm quote bound to the user's wallet, then the user approves `takerPays` to the reactor and broadcasts `transactions.swap` (never the bare first order, which under-fills split quotes). The hash is reported with `/submit`.
- Client-side throttle keeps us under Textile's 60 req/min, with exponential backoff that honours `Retry-After` on 429/5xx.

**Testnet note:** Textile has no Celo Sepolia deployment (its sandboxes are BSC testnet and Base Sepolia only), so this project reads live mainnet previews from day one and executes with small mainnet trades. The Textile minimum is about $1.

## Rate definitions

Rates are **NGN per USDT, fee included**, computed from `takerPays` (the exact debit) and `buyAmount`:

- USDT → cNGN: naira received per dollar paid (higher is better)
- cNGN → USDT: naira paid per dollar received (lower is better)

Reference rates are configurable and always labelled: a parallel-market source and an official or mid-market source (`REF_*` in `.env`).

## Setup

```bash
cp .env.example .env      # ATTRIBUTION_CODE is prefilled
npm install
npm run new-wallet        # creates the agent wallet, key stays in .env
npm run quote             # live Textile quotes on Celo, $10 both ways (read-only)
npm run quote -- 200
npm run sentinel -- --once
npm run sentinel          # loop every SENTINEL_INTERVAL_SEC
npm run verify-tag        # offline check of the encoded tag
```

### Register the agent (ERC-8004)

1. Host `agent.json` (e.g. raw GitHub URL) and set `AGENT_URI`.
2. Fund the agent wallet with a little CELO.
3. `npm run register-agent`, then add the printed `agentId` to `agent.json` and to the table above.

Registry: `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` (Celo docs).

## Architecture

```
src/
  lib/config.ts        env + official addresses (with sources)
  lib/attribution.ts   ERC-8021: the single place the tag is applied
  lib/textile.ts       RFQ v2 client, throttle, backoff, rate maths
  lib/reference.ts     labelled parallel / official reference rates
  lib/db.ts            SQLite: quotes, users, fills, alerts
  lib/chain.ts         viem clients (Celo)
  sentinel/run.ts      Quote Sentinel collector
scripts/               quote-once, register-agent, verify-tag, new-wallet
```

## Safety

- Non-custodial. The agent never holds or asks for user keys; wallets are linked by signing a message.
- Every conversion shows rate, fee, quote expiry and the minimum received, and needs an explicit confirmation.
- No wallets are created for users and no user is funded by the team.

All code in this repository was written during the hackathon.
