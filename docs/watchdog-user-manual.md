# Watchdog User Manual (Atomic Rescue v1)

This guide explains the current watchdog behavior after the breaking change to the on-chain rescue path.

## Current Behavior

The watchdog no longer runs multi-transaction repay flows.

It now acts as a planner/submission bot:

1. Reads loan health factor (HF).
2. If HF is below `triggerHF`, computes required WBTC top-up.
3. Calls the on-chain rescue contract in one transaction.
4. Contract atomically supplies WBTC collateral and enforces post-HF safety.

Rescue asset in v1 is fixed to **WBTC** for Aave positions.

For Morpho Blue positions, the collateral asset is market-specific (e.g., WETH, WBTC) and is resolved automatically from the loan position data.

## Why This Is Safer

- Old flow was non-atomic (`withdraw -> approve -> repay` across multiple txs).
- New flow is atomic (`rescue(...)`), so either full success or full revert.
- Contract checks resulting HF and reverts if it is below `minResultingHF`.

## Configuration

Watchdog config fields:

- `enabled` (default `false`)
- `dryRun` (default `true`)
- `triggerHF` (default `1.65`)
- `targetHF` (default `1.9`)
- `minResultingHF` (default `1.85`)
- `cooldownMs` (default `1800000`)
- `maxTopUpWbtc` (default `0.5`)
- `deadlineSeconds` (default `300`)
- `rescueContract` (required for Aave rescue when `enabled=true`)
- `morphoRescueContract` (required for Morpho rescue when `enabled=true`)
- `maxGasGwei` (default `50`)

Validation rules:

- `targetHF > triggerHF`
- `minResultingHF > triggerHF`
- `minResultingHF <= targetHF`
- `rescueContract` must be a valid address when watchdog is enabled

Environment overrides:

- `WATCHDOG_TRIGGER_HF`
- `WATCHDOG_TARGET_HF`
- `WATCHDOG_MIN_RESULTING_HF`
- `WATCHDOG_MAX_TOP_UP_WBTC`
- `WATCHDOG_MORPHO_RESCUE_CONTRACT`

## On-Chain Requirements

### Aave rescue

Live mode requires:

- `WATCHDOG_PRIVATE_KEY` set on server
- signer address matches monitored wallet
- monitored wallet has WBTC balance
- monitored wallet has approved `rescueContract` to pull WBTC
- WBTC is enabled as collateral on the user's Aave position (`pool.setUserUseReserveAsCollateral(WBTC, true)` called once from the monitored wallet)

### Morpho Blue rescue

Live mode additionally requires:

- `morphoRescueContract` configured (separate contract from the Aave rescue)
- monitored wallet has collateral token balance (market-specific, e.g., WETH)
- monitored wallet has approved `morphoRescueContract` to pull the collateral token
- monitored wallet has authorized the rescue contract on Morpho Blue: call `morpho.setAuthorization(morphoRescueContractAddress, true)` once from the monitored wallet (Morpho Blue address: `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`)

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
- `GET /api/config`: includes watchdog section
- `PUT /api/config`: updates watchdog fields
- `/watchdog`: shows watchdog status and recent actions

## Typical Failure Reasons

- Missing/invalid `rescueContract` or `morphoRescueContract`
- Morpho rescue contract not authorized on Morpho Blue
- Cooldown active
- No usable WBTC (balance/allowance/max cap)
- Projected HF cannot reach `minResultingHF`
- Gas above `maxGasGwei`
- Insufficient ETH for gas
- Signer mismatch

## Safety Checklist

- Start with `dryRun=true`.
- Configure `rescueContract` (Aave) and/or `morphoRescueContract` (Morpho) and verify addresses.
- Pre-approve collateral tokens from monitored wallet to rescue contract(s).
- For Morpho: call `morpho.setAuthorization(morphoRescueContract, true)` from the monitored wallet.
- Keep `maxTopUpWbtc` small during rollout.
- Monitor Telegram alerts and `/api/watchdog/status`.
