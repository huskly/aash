# Rescue Contract (Foundry)

This package contains the v1 atomic rescue contracts for both Aave and Morpho Blue.

## Contents

- `src/AaveAtomicRepayV1.sol` - owner-only atomic debt repay executor for Aave
- `src/MorphoAtomicRepayV1.sol` - owner-only atomic debt repay executor for Morpho Blue
- `script/DeployAaveAtomicRepayV1.s.sol` - deploy script
- `script/DeployMorphoAtomicRepayV1.s.sol` - Morpho deploy script
- `test/AaveAtomicRepayV1.t.sol` - unit tests with mocks
- `test/MorphoAtomicRepayV1.t.sol` - Morpho unit tests with mocks

## Commands

```bash
forge build --root packages/rescue-contract
forge test --root packages/rescue-contract
forge script script/DeployAaveAtomicRepayV1.s.sol --root packages/rescue-contract --rpc-url $RPC_URL --broadcast
forge script script/DeployMorphoAtomicRepayV1.s.sol --root packages/rescue-contract --rpc-url $RPC_URL --broadcast
yarn morpho:market-env app.morpho.org/ethereum/market/<market-id>/<slug>
```

## Morpho Deploy Flow

The Morpho deploy script uses `RESCUE_OWNER` as the final contract owner.

If the final owner is a hardware wallet, you can deploy from a temporary hot wallet by setting
`INITIAL_OWNER` to the deployer address and broadcasting with that wallet's private key. The script
will:

1. Deploy `MorphoAtomicRepayV1` with `INITIAL_OWNER`
2. Enable the configured market
3. Transfer ownership to `RESCUE_OWNER`

Example:

```bash
export INITIAL_OWNER=0xYourHotWallet
export RESCUE_OWNER=0xYourHardwareWallet

forge script script/DeployMorphoAtomicRepayV1.s.sol:DeployMorphoAtomicRepayV1 \
  --rpc-url $RPC_URL \
  --sig "run()" \
  --broadcast \
  --private-key $DEPLOYER_PRIVATE_KEY
```

If `INITIAL_OWNER` is unset, the script behaves as before and deploys directly with
`RESCUE_OWNER` as the owner.
