# aash - Aave & Morpho Position Monitor

A React + Vite dashboard that auto-loads Aave loans, Morpho Blue market positions, and Morpho vault deposits from a wallet address and computes portfolio and risk metrics.

## Goals

- Use a single wallet address as input.
- Fetch live position data from public blockchain indexers.
- Show all detected Aave loans and Morpho positions for a wallet.
- Compute practical monitoring metrics (HF, LTV, liquidation, leverage, carry/net APY).
- Notify of meaningful changes to health factors via Telegram bot, grouped into one message per wallet when multiple loans alert in the same poll
- Partial auto-repay bot maintains loan within a target HF range

## Features

- Wallet-only input UX.
- Wallet details auto-fetch on load when valid.
- Last successfully loaded wallet is saved in browser `localStorage` and auto-used on reload when query params are absent.
- Manual `Refresh` button to reload the current dashboard data on demand.
- Automatic refresh every 120 seconds after a wallet is loaded.
- Multi-market support:
  - Aave V3: `proto_mainnet_v3`, `proto_lido_v3`
  - Morpho Blue: isolated markets (fetched from Morpho GraphQL API)
  - Morpho Vaults: vault deposits such as `Steakhouse Reservoir USDC`
- Support for multiple loans/borrowed assets plus supply-only vault deposits.
- Top-level portfolio metrics roll up all detected positions:
  - Loan-risk metrics stay loan-only (average health factor, borrow power used, repay coverage)
  - Asset/carry metrics include Morpho vault deposits (total assets, net worth, supply APY, net earnings, net APY)
- Fully paid-off / dust positions with effectively zero USD exposure are filtered out.
- Portfolio average HF color bands:
  - `HF > 2.2`: normal operation (green)
  - `HF 1.8–2.2`: no new leverage, monitor closely
  - `HF 1.5–1.8`: reduce debt or add collateral
  - `HF < 1.5`: mandatory deleveraging (red)
- Auto-fetched collateral/borrow amounts and market metadata.
- Price enrichment with CoinGecko, including symbol aliases for wrapped assets such as `cbBTC`.
- Dashboard analytics:
  - Health Factor
  - Liquidation price (primary-collateral approximation)
  - LTV, leverage, borrow headroom
  - Carry / Net APY summary
  - Separate Morpho vault table with deposited asset amount, USD value, net APY, and shares
  - Aave interest-rate model chart for the selected borrowed asset, including current utilization and the reserve kink
  - Borrow APR history chart for the selected borrowed asset, built from locally stored reserve telemetry samples
  - Repay coverage based on wallet balances that match borrowed assets
  - Monitoring checklist + sensitivity cards

## Tech Stack

- React 19
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui-style components
- Lucide icons

## Requirements

- Node.js 18+
- Yarn (classic)

## Environment Variables

Create `.env` in project root.

```bash
# Required for reliable multi-market Graph access (especially proto_lido_v3)
VITE_THE_GRAPH_API_KEY=your_the_graph_api_key

# Optional but recommended to avoid CoinGecko rate limits
VITE_COINGECKO_API_KEY=your_coingecko_demo_api_key

# Optional deploy APY used in carry calculations (decimal form, default: 0.1125)
VITE_R_DEPLOY=0.1125

```

Notes:

- Without `VITE_THE_GRAPH_API_KEY`, some markets may fail to load depending on endpoint availability.
- CoinGecko pricing still works without `VITE_COINGECKO_API_KEY`, but may be rate-limited.
- `VITE_R_DEPLOY` must be a non-negative decimal rate (for example, `0.1125` for 11.25%).

## Getting Started

1. Install dependencies:

```bash
yarn install --frozen-lockfile
```

2. Add `.env` (see above).

3. Start development server:

```bash
yarn dev
```

4. Optional but recommended for the utilization curve, borrow APR history, wallet balance lookups, and alert settings API:

```bash
yarn dev:server
```

5. Open the local URL shown by Vite (usually `http://localhost:5173`).

6. Optional: prefill wallet from query string:

```text
http://localhost:5173/?wallet=0xYourEthereumAddress
```

Supported query params: `wallet`, `address`, `walletAddress`.
If no supported query param is provided, the app falls back to the last wallet saved in browser storage.

## Scripts

```bash
yarn dev           # start frontend dev server
yarn dev:server    # start backend monitor server
yarn dev:all       # start both frontend and server
yarn typecheck     # TypeScript checks (frontend + core package + server package)
yarn lint          # ESLint
yarn format        # Prettier format
yarn test          # Server watchdog/config test suite
yarn test:contracts # Foundry smart contract tests (packages/rescue-contract)
yarn build         # production frontend build
yarn build:server  # production server build (includes @aave-monitor/core via TS project references)
yarn preview       # preview production build
```

Server test suite details:

- Location: `packages/server/test/*.test.ts`
- Runner: Node built-in test runner via `tsx --test`
- Current coverage focus: watchdog execution/cooldown behavior, watchdog config migration/merge logic, and Telegram command sync behavior
- `packages/server` uses `tsconfig.typecheck.json` for CI/local typechecks so `@aave-monitor/core` resolves from source without requiring a prebuilt `dist/`

## Docker Compose

Run the unified app (dashboard UI + API server) with:

```bash
docker compose up --build
```

The app is available at `http://localhost:3001` (both UI and API served from the same Express server).

Notes:

- Server runtime env vars (for example `TELEGRAM_BOT_TOKEN`) are loaded from the root `.env` via `env_file`.

## GitHub Pages Deployment

This project is configured to deploy automatically to GitHub Pages from `main` using GitHub Actions.

Files involved:

- `.github/workflows/deploy-pages.yml`
- `vite.config.ts` (uses `VITE_BASE_PATH` so asset URLs work under `/<repo>/`)

Setup steps:

1. Push this repo to GitHub.
2. In GitHub, open `Settings -> Pages`.
3. Set `Source` to `GitHub Actions`.
4. Add repository secrets (if needed) in `Settings -> Secrets and variables -> Actions`:
   - `VITE_THE_GRAPH_API_KEY` (recommended/usually required)
   - `VITE_COINGECKO_API_KEY` (optional)

After each push to `main`, the workflow builds the app and publishes `dist` to GitHub Pages.

## Telegram Notifications

A backend monitoring service can poll your positions and send Telegram alerts when health factor zones change (e.g. Safe → Comfort → Watch → Alert → Action → Critical). When multiple loans for the same wallet trigger during a poll, they are grouped into one Telegram message instead of being sent separately. See **[docs/telegram-setup.md](docs/telegram-setup.md)** for full setup instructions.
On server startup, Telegram command metadata is synced with `setMyCommands`, so the in-app slash-command menu matches the backend command handlers.
The Telegram `/status` command includes a loan-focused portfolio summary with average health factor, Net APY, total collateral, total debt, portfolio borrow power used, and repay coverage (USD and %).
Each `/status` loan row uses the human-readable market name, so Morpho positions display labels like `morpho_cbBTC_USDC` instead of raw market IDs.
The `/status` footer shows `Last updated` with both an absolute timestamp and relative time (e.g. `3 minutes ago`).
Reminder alerts include a human-readable elapsed duration label (e.g. `2h 40m ago`).
Paid-off / zero-value positions are excluded from both dashboard and Telegram status output.
Legacy configs that only persisted five zones are automatically hydrated back to the default six-zone model (`safe`, `comfort`, `watch`, `alert`, `action`, `critical`) when loaded.

Quick start:

1. Create a Telegram bot via [@BotFather](https://t.me/BotFather) and get the bot token.
2. Add `TELEGRAM_BOT_TOKEN=<your token>` to the project root `.env`.
3. Run `yarn dev:server` to start the monitor.
4. Use the bell icon in the dashboard to configure alerts.
5. If monitor status appears stale, trigger an immediate refresh with `POST /api/status/refresh` (see docs).

## Watchdog (Atomic Rescue v1)

Detailed user manual: **[docs/watchdog-user-manual.md](docs/watchdog-user-manual.md)**.  
Deployment/ops runbook: **[docs/rescue-v1-ops.md](docs/rescue-v1-ops.md)**.

The watchdog monitors loan health and can execute an atomic on-chain rescue when HF drops below threshold. It computes a debt repay amount and submits a single `rescue(...)` transaction to the rescue contract, which repays the loan's borrowed stablecoin (e.g. USDC/USDT) from the wallet.

- Runs after each monitor poll, evaluating all loans
- Monitor polling runs when at least one wallet is enabled (Telegram can stay disabled)
- Dry-run mode by default (notifies what _would_ happen, no on-chain transactions)
- Live mode requires `WATCHDOG_EXECUTOR_PRIVATE_KEY` on the server (`WATCHDOG_PRIVATE_KEY` still works as a fallback alias)
- Live mode requires allowance for the debt token (e.g. USDC) to be pulled by the rescue contract
- For Morpho Blue deploys, generate exact `MORPHO_*` market env vars from a market URL or unique key with `yarn morpho:market-env <market-url-or-unique-key>` to avoid loan/collateral/oracle/IRM mismatches.
- API: `GET /api/watchdog/status` for status and recent action log
- Telegram: `/watchdog` command for status and recent actions
- Config: watchdog section in `GET/PUT /api/config`
- Dashboard UI: bell settings panel includes rescue contracts, HF thresholds, rescue-asset cap, deadline, gas cap

## How It Works

1. User enters an Ethereum wallet address, provides it via query string (`wallet`, `address`, or `walletAddress`), or reloads with the last saved wallet from browser storage.
2. App queries Aave subgraph data for supported markets.
3. Aave reserves are grouped into loan positions per market; Morpho market loans and Morpho vault deposits are fetched from Morpho's GraphQL API.
4. Token prices are fetched from CoinGecko for Aave assets, while Morpho positions use API-provided pricing or USD back-calculation.
5. Portfolio-level aggregate metrics are computed across all active positions, with loan-risk metrics kept separate from supply-only vault assets.
6. Detailed risk metrics are computed and rendered for the selected loan, while Morpho vaults render in a separate table.
7. When the API server is available, the dashboard also reads on-chain reserve telemetry for the selected borrowed asset and stores periodic borrow APR samples in browser `localStorage` to build the history chart over time.

## Limitations

- Liquidation price is shown as a primary-collateral approximation for multi-collateral positions.
- Coverage depends on the supported market list and indexer availability.
- Metrics are simplified monitoring estimates, not a substitute for protocol-native risk engines.
- Borrow APR history is forward-looking: it is sampled from each dashboard refresh and stored in the current browser, so newly visited assets start with an empty chart.
- GitHub Pages deployments require proper repository secrets if API keys are needed at build time.
