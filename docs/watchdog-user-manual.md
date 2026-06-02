# Watchdog User Manual (Atomic Rescue v1)

This guide explains the current watchdog behavior using the on-chain debt repay rescue path,
including the optional layer-0 pre-rescue Morpho vault withdrawal.

## Current Behavior

The watchdog acts as a planner/submission bot:

1. Reads loan health factor (HF).
2. If pre-rescue is enabled and HF is in `[triggerHF, preRescueTriggerHF)`, it can withdraw the debt token from a matching Morpho ERC-4626 vault into the monitored wallet.
3. If HF is below `triggerHF`, computes required debt repay amount.
4. Calls the on-chain rescue contract in one transaction.
5. Contract atomically repays debt using stablecoins (e.g. USDC/USDT) from the wallet and enforces post-HF safety.

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
- `preRescueEnabled` (default `false`)
- `preRescueTriggerHF` (default `1.7`)
- `vaultWithdrawContract` (required when `preRescueEnabled=true`)
- `maxVaultWithdrawAmount` (default `500`) — denominated in the debt token

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
- `preRescueTriggerHF > triggerHF` when pre-rescue is enabled
- `vaultWithdrawContract` must be a valid address when set
- `preRescueEnabled=true` requires a valid `vaultWithdrawContract`
- `maxVaultWithdrawAmount > 0`

Environment overrides:

- `WATCHDOG_TRIGGER_HF`
- `WATCHDOG_TARGET_HF`
- `WATCHDOG_MIN_RESULTING_HF`
- `WATCHDOG_MAX_REPAY_AMOUNT`
- `WATCHDOG_DEADLINE_SECONDS`
- `WATCHDOG_RESCUE_CONTRACT`
- `WATCHDOG_MORPHO_RESCUE_CONTRACT`
- `WATCHDOG_PRE_TRIGGER_HF`
- `WATCHDOG_VAULT_WITHDRAW_CONTRACT`
- `WATCHDOG_MAX_VAULT_WITHDRAW_AMOUNT`

## On-Chain Requirements

### Aave rescue

Live mode requires:

- `WATCHDOG_EXECUTOR_PRIVATE_KEY` set on server (`WATCHDOG_PRIVATE_KEY` still works as a fallback alias)
- executor address is authorized by the rescue contract
- monitored wallet has debt token balance (e.g. USDC)
- monitored wallet has approved `rescueContract` to pull the debt token

### Morpho Blue rescue

Live mode additionally requires:

- `morphoRescueContract` configured (separate contract from the Aave rescue)
- the configured Morpho rescue contract has the monitored market enabled via `setSupportedMarket(...)`
- executor address is authorized by the Morpho rescue contract
- monitored wallet has loan token balance (e.g. USDC)
- monitored wallet has approved `morphoRescueContract` to pull the loan token

Operational note:

- `morphoRescueContract` is one contract address for Morpho rescue, not one contract per market.
- One `MorphoAtomicRepayV1` contract can support multiple Morpho markets for the same monitored wallet / executor pair.
- Enable additional markets on the existing contract with `setSupportedMarket(...)`, typically from Etherscan `Write Contract` signed by the owner wallet.

### Layer-0 pre-rescue vault withdrawal

Live mode additionally requires:

- `preRescueEnabled=true`
- `vaultWithdrawContract` configured with a `MorphoVaultWithdrawV1` deployment
- executor address is authorized by the vault withdraw contract
- monitored wallet is the vault withdraw contract `owner()`
- the Morpho ERC-4626 vault is enabled with `setSupportedVault(vault, true)`
- monitored wallet has approved the vault share token to `vaultWithdrawContract`
- the matching vault has usable owner-specific capacity:
  - positive `maxWithdraw(monitoredWallet)` for standard ERC-4626 vaults
  - or, for Morpho Vault V2 vaults whose max functions conservatively return
    zero, positive wallet share asset value from `previewRedeem(balanceOf(wallet))`

## Dry Run vs Live

Dry run:

- Computes amount and projected HF.
- Sends notifications and logs.
- No transaction submission.

Live:

- Enforces gas and ETH checks.
- For layer 0, submits exactly one `withdraw(...)` tx to `MorphoVaultWithdrawV1`.
- For layer 1, submits exactly one `rescue(...)` tx.
- Logs tx hash and applies cooldown.

## API and Telegram

- `GET /api/watchdog/status`: returns summary + recent action log
- Status summary fields include `aaveRescueContract`, `morphoRescueContract`, `preRescueEnabled`, `preRescueTriggerHF`, and `vaultWithdrawContract`
- Recent action entries include `protocol`, `repayAmount`, `repayAssetSymbol`, and `projectedHF`
- `GET /api/config`: includes watchdog and utilization sections
- `PUT /api/config`: updates watchdog and utilization alert fields
- `/watchdog`: shows watchdog status and recent actions

## Typical Failure Reasons

- Missing/invalid `rescueContract` or `morphoRescueContract`
- Missing/invalid `vaultWithdrawContract` when pre-rescue is enabled
- Cooldown active
- No usable debt token (balance/allowance/max cap)
- No matching Morpho vault with usable owner-specific withdrawal capacity
- Projected HF cannot reach `minResultingHF`
- Gas above `maxGasGwei`
- Insufficient ETH for gas
- Missing executor authorization

## Safety Checklist

- Start with `dryRun=true`.
- Configure `rescueContract` (Aave) and/or `morphoRescueContract` (Morpho) and verify addresses.
- Pre-approve debt/loan tokens from monitored wallet to rescue contract(s).
- If using pre-rescue, configure `vaultWithdrawContract`, enable the supported vault, and approve vault shares from the monitored wallet to the vault withdraw contract.
- Keep `maxRepayAmount` small during rollout.
- Monitor Telegram alerts and `/api/watchdog/status` for recent repay activity.

## Layer 0: Pre-rescue Morpho Vault Withdrawal

If the operator's debt-token funds are parked in a Morpho ERC-4626 vault (e.g.
Gauntlet USDC Prime) rather than sitting idle in the wallet, the regular rescue
path would log "no available USDC" even when the operator has plenty of capital
to defend the loan. Layer 0 closes that gap by pre-emptively withdrawing from the
vault into the wallet _before_ HF reaches the layer-1 trigger.

### How it works

- Layer 0 fires only when HF is in the buffer band `[triggerHF, preRescueTriggerHF)`.
- It computes the debt repay amount that would be needed to reach `targetHF` using the relevant Aave or Morpho rescue contract preview.
- The capacity search is capped at `min(wallet debt-token balance + usable vault withdrawal, maxRepayAmount)`.
- The usable vault amount is capped by both `maxVaultWithdrawAmount` and the
  vault's owner-specific capacity. Standard ERC-4626 vaults use
  `maxWithdraw(monitoredWallet)`; Morpho Vault V2 vaults fall back to the
  wallet's share asset value because their max functions intentionally return
  zero.
- It checks the wallet for existing balance, then withdraws the shortfall plus a
  500 debt-token buffer. Pre-rescue will not submit vault withdrawals below 500
  debt tokens; if the configured cap or usable vault capacity is below that
  floor, it skips instead of paying gas for a dust-sized movement.
- The vault is selected automatically by matching the loan's debt-token address;
  if multiple vaults match, the one with the largest on-chain usable capacity wins.
- In live mode, it simulates the exact helper `withdraw(...)` call immediately
  before broadcasting so reverts are logged before submitting a raw transaction.
- Withdrawn assets are sent directly to the monitored wallet via the ERC-4626
  `withdraw(assets, owner, owner)` call. The helper contract never custodies
  funds.
- A separate cooldown key (`-prerescue`) prevents repeated withdrawals; failed live transactions also apply the cooldown.
- If HF recovers above `preRescueTriggerHF`, the withdrawn funds simply stay in
  the wallet; the operator can redeposit them manually.
- If HF crosses `triggerHF`, the existing layer-1 rescue runs in the next poll
  cycle, consuming the now-funded wallet balance — no change to layer-1 code.

### Configuration

- `preRescueEnabled` (default `false`)
- `preRescueTriggerHF` (default `1.7`)
- `vaultWithdrawContract` (required when `preRescueEnabled=true`) — address of
  `MorphoVaultWithdrawV1`
- `maxVaultWithdrawAmount` (default `500`) — per-action cap in the debt token

Validation: `preRescueTriggerHF > triggerHF` and `vaultWithdrawContract` must be
a valid address when `preRescueEnabled` is true.

Environment overrides:

- `WATCHDOG_PRE_TRIGGER_HF`
- `WATCHDOG_VAULT_WITHDRAW_CONTRACT`
- `WATCHDOG_MAX_VAULT_WITHDRAW_AMOUNT`

### On-chain requirements

- Deploy `MorphoVaultWithdrawV1(owner=monitoredWallet, executor=botAddress)`.
- Call `setSupportedVault(vaultAddress, true)` from the owner wallet for each
  Morpho vault you want to draw from (one contract supports multiple vaults).
- From the monitored wallet, approve the vault's share token (the vault is the
  ERC-4626 itself): `vault.approve(vaultWithdrawContract, type(uint256).max)`.
- The executor key may differ from the monitored wallet (same model as the
  existing rescue contracts).
- `withdraw(...)` rejects a `user` that is not the helper `owner()`, unsupported
  vaults, zero amounts, expired deadlines, and calls from non-executors.

### Log entries

Layer-0 outcomes appear in `/api/watchdog/status` with new action types:

- `vault-withdraw` — live withdrawal succeeded; `txHash` and `vaultAddress` set
- `vault-withdraw-dry-run` — dry-run preview entry
- `skipped` — buffer-band conditions not met (wallet already funded, no matching
  vault, cooldown, etc.)
