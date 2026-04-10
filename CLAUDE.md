# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
yarn dev           # start Vite dev server (localhost:5173)
yarn build         # tsc -b && vite build (production)
yarn preview       # preview production build
yarn typecheck     # frontend + backend workspace TypeScript checks
yarn lint          # eslint
yarn format        # prettier --write
yarn format:check  # prettier --check
yarn test          # server watchdog/config tests (node:test via tsx)
```

Always run `typecheck`, `lint`, and `format` before finishing changes. Also make sure you check
instructions in AGENTS.md if you haven't already.

## Environment Variables

Configured via `.env` in project root (prefixed with `VITE_` for Vite exposure):

- `VITE_THE_GRAPH_API_KEY` — required for multi-market subgraph access
- `VITE_COINGECKO_API_KEY` — optional, avoids CoinGecko rate limits
- `VITE_BASE_PATH` — used in vite.config.ts for GitHub Pages deployment
- `RPC_URL` — Ethereum JSON-RPC endpoint used by backend for on-chain reads (default `https://eth.llamarpc.com`)
- `WATCHDOG_EXECUTOR_PRIVATE_KEY` — optional private key for watchdog live mode executor; `WATCHDOG_PRIVATE_KEY` remains a fallback alias for backward compatibility
- `WATCHDOG_MIN_RESULTING_HF` — optional override for minimum required post-rescue HF
- `WATCHDOG_MAX_REPAY_AMOUNT` — optional override for the max debt-repay amount per rescue action (`WATCHDOG_MAX_TOP_UP_AMOUNT` and `WATCHDOG_MAX_TOP_UP_WBTC` still work as legacy fallbacks)
- `WATCHDOG_DEADLINE_SECONDS` — optional override for rescue transaction deadline in seconds
- `WATCHDOG_RESCUE_CONTRACT` — optional override for Aave rescue contract address
- `WATCHDOG_MORPHO_RESCUE_CONTRACT` — optional override for Morpho Blue rescue contract address
- `TELEGRAM_BOT_TOKEN` — backend Telegram bot token (loaded from root `.env`)
- `PORT` — optional backend port (default `3001`)

Backend server notes:

- `packages/server` auto-loads the root `.env` on startup.
- `packages/server` uses a TypeScript project reference to `packages/aave-core`; `yarn workspace @aave-monitor/server build` builds the referenced core package first and consumes its emitted declarations instead of importing core source files directly.
- `packages/server` typechecks through `packages/server/tsconfig.typecheck.json`, which resolves `@aave-monitor/core` to source for CI/local checks without requiring `packages/aave-core/dist` to exist first.
- Backend Graph/CoinGecko keys are read from `VITE_THE_GRAPH_API_KEY` and `VITE_COINGECKO_API_KEY` (legacy non-`VITE_` names still work as fallback).
- `POST /api/status/refresh` forces an immediate monitor recomputation and returns fresh `/api/status` payload.
- `GET /api/reserves/telemetry?market=<market>&asset=<address>&symbol=<optional>` returns live on-chain reserve utilization and interest-rate-strategy parameters for the selected borrowed asset.
- Telegram `/status` includes portfolio average health factor, Net APY, total collateral, total debt, portfolio borrow power used, and repay coverage (USD and %) alongside per-loan health factors. Telegram alerts include per-asset liquidation prices for each collateral asset, and multiple loan alerts for the same wallet are grouped into a single Telegram message per poll.
- Telegram `/status` renders each loan row using the human-readable market name (`marketName`), so Morpho entries show labels like `morpho_cbBTC_USDC` instead of the raw `uniqueKey` / address-like loan ID.
- Telegram `/status` includes `Last updated` with absolute timestamp + relative time (e.g. `3 minutes ago`).
- Telegram command metadata (`/status`, `/refresh`, `/watchdog`, `/help`) is synced on server startup via `setMyCommands`, so Telegram slash-command suggestions stay current.
- Reminder alerts include a human-readable elapsed duration label (e.g. `2h 40m ago`).
- Fully paid-off / zero-value positions are filtered out of both dashboard data and Telegram status output.
- Watchdog user-facing docs live in `docs/watchdog-user-manual.md`.
- Watchdog uses an atomic on-chain rescue path: it computes the required debt-token repay amount off-chain and submits a single `rescue(...)` transaction to the configured rescue contract, which repays the loan's borrowed asset (e.g. USDC/USDT) from the monitored wallet.
- Watchdog is fully wired: monitor integration, `GET /api/watchdog/status` endpoint, `/watchdog` Telegram command, config via `GET/PUT /api/config`, and dashboard settings controls for watchdog fields.
- `zones[].maxHF` accepts JSON `null` on `PUT /api/config` and is normalized to `Infinity` (important because JSON serialization turns `Infinity` into `null`).
- Legacy configs that omit one or more zones are hydrated back to the full default six-zone set by name, so runtime, `/api/config`, and the dashboard stay aligned.
- Monitor runtime is driven by enabled wallets (not Telegram enablement), so watchdog polling can run without Telegram configured.
- Morpho positions are fetched from `https://api.morpho.org/graphql` in `packages/aave-core/src/morpho.ts`.
- `fetchFromMorphoApi()` still returns only Morpho market loans for server/watchdog compatibility; `fetchMorphoPositions()` returns both `marketLoans` and `vaultPositions` for the dashboard.
- Morpho positions use API-provided USD prices (no CoinGecko dependency).
- Aave pricing uses the `COINGECKO_IDS_BY_SYMBOL` alias map in `packages/aave-core/src/constants.ts`; add wrapped/alias symbols there when Aave reserve symbols differ from CoinGecko slugs (for example `cbBTC` -> `coinbase-wrapped-btc`).
- Monitor logs normalize reserve symbols before checking the CoinGecko price map, and per-loan collateral log lines use each asset's resolved `usdPrice` so mixed-case symbols such as `cbBTC` / `wstETH` do not appear as `$MISSING` when pricing succeeded.
- Morpho markets use a single LLTV (Liquidation LTV) mapped to both `maxLTV` and `liqThreshold` on `AssetPosition`.
- Morpho loan IDs use the market ID; market names follow the `morpho_<COLLATERAL>_<LOAN>` convention.
- Morpho Blue market collateral is not yield-bearing supply. Market collateral keeps `supplyRate=0`, so carry / net APY subtracts borrow cost without adding the market's loan-asset supply APY to collateral.
- Morpho vault positions are modeled separately from `LoanPosition`; they are supply-only, render in their own dashboard table, and do not participate in HF / borrow-power math.
- Interest rate / utilization curve charts are not available for Morpho markets (Aave-specific on-chain telemetry).
- Watchdog rescue supports both Aave and Morpho Blue loans via separate rescue contracts (`rescueContract` for Aave, `morphoRescueContract` for Morpho).
- Morpho rescue uses the market-specific loan token (resolved from `LoanPosition.morphoMarketParams.loanToken`) to repay debt.
- Morpho rescue preview/guard math uses accrued borrow interest and Morpho's virtual-share conversion instead of raw stale market totals.
- Rescue contracts support a split-role model: `owner` is the monitored wallet that funds the repay and grants allowance, while `executor` is the hot wallet allowed to submit `rescue(...)`.
- In live mode the server signs with `WATCHDOG_EXECUTOR_PRIVATE_KEY` (or legacy `WATCHDOG_PRIVATE_KEY` fallback); this executor key no longer needs to match the monitored wallet.
- Debt-token approval must still be signed by the monitored wallet / contract owner, because the rescue contract calls `transferFrom(params.user, ...)`.
- Watchdog repay caps are configured via `maxRepayAmount` (denominated in the debt token, e.g. 500 USDC).
- `yarn morpho:market-env <market-url-or-unique-key>` resolves a Morpho market through the public GraphQL API, prints exact `MORPHO_*` exports, and verifies the params hash back to the market `uniqueKey`.

Frontend notes:

- `src/App.tsx` stores the last successfully loaded wallet under `localStorage['aave-monitor:last-wallet']`.
- `src/App.tsx` also stores borrow APR history per market/asset in browser `localStorage` under the `aave-monitor:borrow-apr-history:*` prefix.
- On page load, wallet resolution order is: query string (`wallet`, `address`, `walletAddress`) first, then saved local storage wallet.
- Portfolio summary math is centralized in `computePortfolioSummary()` in `packages/aave-core/src/metrics.ts`.
- The dashboard's `Total Assets`, `Net worth`, `Supply APY`, `Net earnings`, and `Net APY` include Morpho vault deposits; `HF`, `Borrow power used`, and `Repay coverage` remain loan-only.
- Top-level portfolio metrics use hover/focus tooltips to explain their calculation in one sentence.
- The loan positions table is sortable. It defaults to USD debt descending and supports sorting by market, collateral, borrowed asset, HF, rate, LTV, and liquidation price.
- Portfolio `Net borrow cost` displays the gross annual loan borrow interest cost before supply earnings or Morpho vault income offsets.
- The portfolio card labeled `Repay coverage` is based on wallet-held balances of tokens that also appear in the loan's borrowed asset set; it does not include unrelated wallet assets or vault deposits.
- The utilization curve and borrow APR history charts depend on the Express API server for on-chain reserve telemetry. Without `yarn dev:server` (or the unified Docker/server runtime), those charts fall back to an unavailable message.
- Server settings saves surface toast feedback in the dashboard for both successful updates and failed save attempts.

## Architecture

This is a single-page React 19 + TypeScript + Vite app. Nearly all application logic lives in **`src/App.tsx`** (~1000 lines), which is a single large component containing:

- **Type definitions** — `RawUserReserve`, `AssetPosition`, `LoanPosition`, `FetchState`
- **Data fetching** — queries Aave subgraph (The Graph) for user reserves across supported markets (`proto_mainnet_v3`, `proto_lido_v3`), fetches token prices from CoinGecko
- **Loan grouping** — raw reserves are grouped into `LoanPosition` objects per borrowed asset per market
- **Metric computation** — health factor, LTV, liquidation price, leverage, borrow headroom, carry/net APY, all computed inline
- **Rendering** — portfolio-level aggregates, tabbed per-loan details, sensitivity cards, monitoring checklist

Supporting files:

- `src/main.tsx` — React entry point
- `src/styles.css` — Tailwind CSS imports
- `src/components/ui/` — shadcn/ui-style primitives (Button, Card, Badge, Input, Separator)
- `src/lib/utils.ts` — `cn()` utility (clsx + tailwind-merge)

Testing currently exists for backend watchdog/config behavior in `packages/server/test/*.test.ts` and runs with `yarn test`. There is still no routing, no state management library, and no API abstraction layer. The app is self-contained with external data coming from The Graph and CoinGecko APIs.

## Deployment

- **GitHub Pages**: automated via `.github/workflows/deploy-pages.yml` on push to `main`
- **Docker Compose**: `docker compose up --build` starts the unified app on `http://localhost:3001`
- **Docker**: single unified image where Express serves both API and frontend static files
- **hl**: `git push production master` deploys via hl with Procfile (`web: node dist/index.js`)
