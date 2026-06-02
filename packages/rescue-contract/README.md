# Rescue Contract (Foundry)

This package contains the v1 atomic rescue contracts for both Aave and Morpho Blue.

## Contents

- `src/AaveAtomicRepayV1.sol` - owner-funded, executor-triggered atomic debt repay for Aave
- `src/MorphoAtomicRepayV1.sol` - owner-funded, executor-triggered atomic debt repay for Morpho Blue
- `src/MorphoVaultWithdrawV1.sol` - owner-approved, executor-triggered ERC-4626 vault withdrawal helper
- `script/DeployAaveAtomicRepayV1.s.sol` - deploy script
- `script/DeployMorphoAtomicRepayV1.s.sol` - Morpho deploy script that also enables the first market
- `script/DeployMorphoVaultWithdrawV1.s.sol` - Morpho vault withdraw helper deploy script that also enables one or more vaults
- `deploy-morpho-vault-withdraw.sh` - operator wrapper around the vault withdraw helper deploy script
- `test/AaveAtomicRepayV1.t.sol` - unit tests with mocks
- `test/MorphoAtomicRepayV1.t.sol` - Morpho unit tests with mocks
- `test/MorphoVaultWithdrawV1.t.sol` - vault withdraw helper unit tests with mocks

## Commands

```bash
forge build --root packages/rescue-contract
forge test --root packages/rescue-contract
cd packages/rescue-contract
forge script script/DeployAaveAtomicRepayV1.s.sol:DeployAaveAtomicRepayV1 --rpc-url $RPC_URL --broadcast
forge script script/DeployMorphoAtomicRepayV1.s.sol:DeployMorphoAtomicRepayV1 --rpc-url $RPC_URL --broadcast
forge script script/DeployMorphoVaultWithdrawV1.s.sol:DeployMorphoVaultWithdrawV1 --rpc-url $RPC_URL --broadcast
./deploy-morpho-vault-withdraw.sh --dry-run
yarn morpho:market-env app.morpho.org/ethereum/market/<market-id>/<slug>
```

## Morpho Deploy Flow

The deploy scripts use `RESCUE_OWNER` as the final contract owner and `RESCUE_EXECUTOR`
as the wallet allowed to call `rescue(...)`.

If the final owner is a hardware wallet, you can deploy from a temporary hot wallet by setting
`INITIAL_OWNER` to the deployer address and broadcasting with that wallet's private key. The script
will:

1. Deploy `MorphoAtomicRepayV1` with `INITIAL_OWNER`
2. Set `RESCUE_EXECUTOR` (defaults to `INITIAL_OWNER` if unset)
3. Enable the configured market
4. Transfer ownership to `RESCUE_OWNER`

Example:

```bash
export INITIAL_OWNER=0xYourHotWallet
export RESCUE_OWNER=0xYourHardwareWallet
export RESCUE_EXECUTOR=0xYourHotWallet

forge script script/DeployMorphoAtomicRepayV1.s.sol:DeployMorphoAtomicRepayV1 \
  --rpc-url $RPC_URL \
  --sig "run()" \
  --broadcast \
  --private-key $DEPLOYER_PRIVATE_KEY
```

For the default operator wallet/RPC settings used by `deploy-morpho-repay.sh`, use the wrapper.
With no vault argument it enables Gauntlet USDC Prime
(`0x8c106EEDAd96553e64287A5A6839c3Cc78afA3D0`). Pass a vault address or comma-separated vault list
to override that default:

```bash
./deploy-morpho-vault-withdraw.sh --dry-run
./deploy-morpho-vault-withdraw.sh 0xVaultA,0xVaultB --dry-run
./deploy-morpho-vault-withdraw.sh 0xVaultA,0xVaultB --no-dry-run
```

If `INITIAL_OWNER` is unset, the script deploys directly with `RESCUE_OWNER` as owner.
If `RESCUE_EXECUTOR` is unset, it defaults to `INITIAL_OWNER`.

## Morpho Multi-Market Support

`MorphoAtomicRepayV1` is designed to support multiple Morpho markets for the same monitored
wallet / executor pair. The deploy script enables the first market, and later markets can be
added on the same contract with `setSupportedMarket(...)`.

Example:

Use Etherscan `Write Contract` on the verified rescue contract and call
`setSupportedMarket((address,address,address,address,uint256),bool)` from the current owner wallet.
This works well with MetaMask or Rabby when the owner is backed by a hardware wallet.

## Morpho Vault Withdraw Deploy Flow

`DeployMorphoVaultWithdrawV1` follows the same ownership model as the Morpho repay deploy script.
It uses:

- `RESCUE_OWNER` as the final helper owner / monitored wallet
- `INITIAL_OWNER` as an optional temporary setup owner
- `RESCUE_EXECUTOR` as the wallet allowed to call `withdraw(...)`, defaulting to `INITIAL_OWNER`
- `MORPHO_VAULT` for one vault, or `MORPHO_VAULTS` for a comma-separated list of vaults to enable

The script deploys `MorphoVaultWithdrawV1`, calls `setSupportedVault(..., true)` for every
configured vault, and transfers ownership to `RESCUE_OWNER` when `INITIAL_OWNER` is used.

Example:

```bash
export INITIAL_OWNER=0xYourHotWallet
export RESCUE_OWNER=0xYourHardwareWallet
export RESCUE_EXECUTOR=0xYourHotWallet
export MORPHO_VAULTS=0xVaultA,0xVaultB

forge script script/DeployMorphoVaultWithdrawV1.s.sol:DeployMorphoVaultWithdrawV1 \
  --rpc-url $RPC_URL \
  --sig "run()" \
  --broadcast \
  --private-key $DEPLOYER_PRIVATE_KEY
```
