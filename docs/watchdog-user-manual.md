# Watchdog User Manual (In Development)

This guide explains how the Health Factor Watchdog is designed to work, what is already implemented, and how to operate it safely once full end-to-end wiring is complete.

## Current Status

The watchdog engine and config model are implemented and tested, but full runtime wiring is still in progress.

Implemented now:

- Watchdog config model and defaults in server storage
- Stablecoin-only repay engine with:
  - adjusted HF trigger logic
  - repayment sizing (`triggerHF` -> `targetHF`)
  - wallet + same-asset-withdraw funding model
  - gas and ETH safety checks
  - dry-run and live execution branches
  - per-loan cooldown logic
  - signer/private-key wallet address safety check
- Automated unit tests and CI coverage for watchdog logic

Planned next (not fully wired end-to-end yet):

- Monitor integration pass (run watchdog after alerts)
- API endpoints for watchdog status/config surface
- Telegram watchdog command/status surface
- Full UI workflow for watchdog controls

## What the Watchdog Does

The watchdog monitors each loan and can auto-repay stablecoin debt when risk is elevated.

Core behavior:

1. Compute **adjusted HF** (ignores collateral that is the same asset as debt).
2. If adjusted HF is below `triggerHF`, compute required repayment to reach `targetHF`.
3. Cap repayment by `maxRepayUsd`.
4. Source funds from:
   - wallet stablecoin balance first
   - then withdraw same-asset supply if needed
5. Execute in dry-run or live mode.
6. Apply per-loan cooldown to avoid repeated immediate actions.

## Why Adjusted HF Is Used

Normal HF can overstate safety if part of collateral is the same asset as the debt being repaid.
The watchdog may need to withdraw that same-asset collateral to fund repayment, so it uses adjusted HF to avoid making decisions on an overly optimistic view.

## Configuration

Watchdog config fields:

- `enabled` (default `false`): Master on/off switch.
- `dryRun` (default `true`): Simulate actions and notify, no on-chain transactions.
- `triggerHF` (default `1.25`): Start watchdog logic when adjusted HF drops below this.
- `targetHF` (default `1.5`): Repayment target for adjusted HF.
- `cooldownMs` (default `1800000`): Minimum wait between actions for the same loan.
- `maxRepayUsd` (default `10000`): Per-action repayment cap.
- `maxGasGwei` (default `50`): Skip live execution when gas is above this threshold.

Environment overrides:

- `WATCHDOG_TRIGGER_HF`
- `WATCHDOG_TARGET_HF`

Both must be positive numbers to apply.

## Private Key and Wallet Safety

Live mode requires a private key (`WATCHDOG_PRIVATE_KEY`, planned runtime wiring).

Safety rule:

- The signer address derived from the private key must match the monitored wallet address.
- If they do not match, execution is aborted.

This prevents accidental repayment attempts from the wrong signer.

## Dry-Run Mode

Dry-run mode is the recommended first phase.

What happens in dry-run:

- Watchdog evaluates loans normally.
- It computes and logs the repayment plan.
- It sends notifications for what would be executed.
- It does not submit transactions.
- It still respects cooldown behavior to avoid repeated spam.

## Live Mode Execution Flow

When live mode is enabled and a loan triggers:

1. Check current gas price against `maxGasGwei`.
2. Check wallet ETH balance for transaction gas.
3. If needed, withdraw same-asset collateral from Aave pool.
4. Ensure ERC-20 allowance for pool repayment.
5. Submit repay transaction.
6. Record tx hashes and log result.

Failure handling:

- If an action is skipped before sending txs (for example high gas), no repayment is executed.
- If partial on-chain progress happened before a later failure, that partial state is logged and cooldown is applied conservatively.

## Operational Recommendations

Start safely:

1. Keep `enabled=true`, `dryRun=true` initially.
2. Use a conservative trigger and low cap (`maxRepayUsd`) while validating behavior.
3. Confirm Telegram notifications and computed amounts look correct.
4. Only then switch to `dryRun=false` in a controlled test wallet scenario.

Suggested starter values:

- `triggerHF`: `1.25`
- `targetHF`: `1.5`
- `maxRepayUsd`: `250` to `1000` during initial live testing
- `maxGasGwei`: set to your execution tolerance

## Troubleshooting

No actions happening:

- Check `enabled` and that adjusted HF is below `triggerHF`.
- Confirm debt asset is in supported stablecoin set.
- Confirm cooldown is not active.

Live mode not executing:

- Ensure private key is present and matches monitored wallet.
- Check gas is below `maxGasGwei`.
- Check wallet has enough ETH for gas.
- Check stablecoin liquidity/withdrawable same-asset supply.

Repeated skips:

- Review logs for reason (`gas too high`, `insufficient ETH`, `insufficient funds`, etc.).
- Adjust config values cautiously.

## Known Limitations (Current Phase)

- End-to-end monitor/API/Telegram command integration is still being finalized.
- Manual validation is still required for real transaction flow in a safe test wallet before production use.
- This is a mitigation tool, not a guarantee against liquidation.

## Quick Safety Checklist

- Start in dry-run.
- Use a small `maxRepayUsd`.
- Keep `maxGasGwei` conservative.
- Verify signer/wallet match.
- Monitor notifications and logs closely.
- Roll out gradually.
