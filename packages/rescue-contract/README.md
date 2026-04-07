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
```
