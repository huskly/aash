# Watchdog User Manual (Atomic Rescue v1)

This guide explains the current watchdog behavior using the on-chain debt repay rescue path.

## Current Behavior

The watchdog acts as a planner/submission bot:

1. Reads loan health factor (HF).
2. If HF is below `triggerHF`, computes required debt repay amount.
3. Calls the on-chain rescue contract in one transaction.
4. Contract atomically repays debt using stablecoins (e.g. USDC/USDT) from the wallet and enforces post-HF safety.

The repay token is determined from the loan's borrowed asset (e.g. USDC for an Aave USDC borrow, or the `loanToken` for a Morpho market).

## Why This Is Safer

- Rescue is atomic (`rescue(...)`), so either full success or full revert.
- Contract checks resulting HF and reverts if it is below `minResultingHF`.
- For Morpho Blue, preview/guard math accounts for accrued borrow interest and Morpho's virtual-share conversion.

## Configuration

Watchdog config fields:

- `enabled` (default `false`)
- `dryRun` (default `true`)
- `triggerHF` (default `1.65`)
- `targetHF` (default `1.9`)
- `minResultingHF` (default `1.85`)
- `cooldownMs` (default `1800000`)
- `maxRepayAmount` (default `500`) — denominated in the debt token (e.g. 500 USDC)
- `deadlineSeconds` (default `300`)
- `rescueContract` (required for Aave rescue when `enabled=true`)
- `morphoRescueContract` (required for Morpho rescue when `enabled=true`)
- `maxGasGwei` (default `50`)

Note:

- `rescueContract` is the persisted config field for the Aave rescue contract.
- `/api/watchdog/status` exposes this as `aaveRescueContract` to make the protocol explicit.

Validation rules:

- `targetHF > triggerHF`
- `minResultingHF > triggerHF`
- `minResultingHF <= targetHF`
- `rescueContract` must be a valid address when set
- `morphoRescueContract` must be a valid address when set
- At least one of `rescueContract` or `morphoRescueContract` must be configured when watchdog is enabled

Environment overrides:

- `WATCHDOG_TRIGGER_HF`
- `WATCHDOG_TARGET_HF`
- `WATCHDOG_MIN_RESULTING_HF`
- `WATCHDOG_MAX_REPAY_AMOUNT` (`WATCHDOG_MAX_TOP_UP_AMOUNT` and `WATCHDOG_MAX_TOP_UP_WBTC` still work as legacy fallbacks)
- `WATCHDOG_MORPHO_RESCUE_CONTRACT`

## On-Chain Requirements

### Aave rescue

Live mode requires:

- `WATCHDOG_PRIVATE_KEY` set on server
- signer address matches monitored wallet
- monitored wallet has debt token balance (e.g. USDC)
- monitored wallet has approved `rescueContract` to pull the debt token

### Morpho Blue rescue

Live mode additionally requires:

- `morphoRescueContract` configured (separate contract from the Aave rescue)
- monitored wallet has loan token balance (e.g. USDC)
- monitored wallet has approved `morphoRescueContract` to pull the loan token

## Dry Run vs Live

Dry run:

- Computes amount and projected HF.
- Sends notifications and logs.
- No transaction submission.

Live:

- Enforces gas and ETH checks.
- Submits exactly one `rescue(...)` tx.
- Logs tx hash and applies cooldown.

## API and Telegram

- `GET /api/watchdog/status`: returns summary + recent action log
- Status summary fields include `aaveRescueContract` and `morphoRescueContract`
- Recent action entries include `protocol`, `repayAmount`, and `repayAssetSymbol`
- `GET /api/config`: includes watchdog section
- `PUT /api/config`: updates watchdog fields
- `/watchdog`: shows watchdog status and recent actions

## Typical Failure Reasons

- Missing/invalid `rescueContract` or `morphoRescueContract`
- Cooldown active
- No usable debt token (balance/allowance/max cap)
- Projected HF cannot reach `minResultingHF`
- Gas above `maxGasGwei`
- Insufficient ETH for gas
- Signer mismatch

## Safety Checklist

- Start with `dryRun=true`.
- Configure `rescueContract` (Aave) and/or `morphoRescueContract` (Morpho) and verify addresses.
- Pre-approve debt/loan tokens from monitored wallet to rescue contract(s).
- Keep `maxRepayAmount` small during rollout.
- Monitor Telegram alerts and `/api/watchdog/status` for recent repay activity.
