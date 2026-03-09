# Rescue v1 Ops (WBTC Atomic Top-Up)

## Scope

v1 supports only:

- Ethereum mainnet Aave v3
- WBTC collateral top-up rescue
- owner-only contract execution

## Deploy

Prerequisite: Install [Foundry](https://github.com/foundry-rs/foundry).

From repo root:

```bash
cd packages/rescue-contract
forge build
forge test
```

Set env vars for deploy script:

```bash
export RESCUE_OWNER=0x...                # Contract owner (monitored wallet address)
export AAVE_POOL=0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2
export AAVE_ADDRESSES_PROVIDER=0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e
export AAVE_PROTOCOL_DATA_PROVIDER=0x7B4EB56E7CD4b454BA8ff71E4518426c587bb0e7
export WBTC_ADDRESS=0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599
export RPC_URL=https://rpc.mevblocker.io  # or https://eth.llamarpc.com
```

Dry-run (simulation only, no broadcast). `--sender` must match `RESCUE_OWNER` so the
`setSupportedAsset` call succeeds in simulation:

```bash
forge script script/DeployAaveAtomicRescueV1.s.sol:DeployAaveAtomicRescueV1 \
  --rpc-url $RPC_URL \
  --sig "run()" \
  --sender $RESCUE_OWNER
```

Expected output: 2 transactions (deploy + setSupportedAsset), ~1M gas, ~0.00026 ETH.

Broadcast (live deploy):

```bash
forge script script/DeployAaveAtomicRescueV1.s.sol:DeployAaveAtomicRescueV1 \
  --rpc-url $RPC_URL \
  --sig "run()" \
  --broadcast \
  --private-key $WATCHDOG_PRIVATE_KEY
```

Save the deployed contract address from the output.

## Post-Deploy

1. Save deployed `AaveAtomicRescueV1` address.

2. Set `watchdog.rescueContract` in `PUT /api/config`:

   ```bash
   curl -X PUT https://<your-host>/api/config \
     -H 'Content-Type: application/json' \
     -d '{"watchdog": {"rescueContract": "<deployed-address>"}}'
   ```

3. Approve WBTC from monitored wallet to rescue contract (unlimited allowance):

   ```bash
   cast send 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599 \
     "approve(address,uint256)" \
     <deployed-address> \
     $(cast max-uint) \
     --rpc-url $RPC_URL \
     --private-key $WATCHDOG_PRIVATE_KEY
   ```

   To use a capped allowance instead (e.g. 1 WBTC), replace `$(cast max-uint)` with `100000000` (8 decimals).

4. Verify WBTC is enabled as collateral on the user's Aave position. Query the
   ProtocolDataProvider — the last field (`bool usedAsCollateral`) must be `true`:

   ```bash
   # Get the ProtocolDataProvider address
   cast call 0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e \
     "getPoolDataProvider()(address)" \
     --rpc-url $RPC_URL

   # Check WBTC user reserve data (last field = usedAsCollateral)
   cast call <data-provider-address> \
     "getUserReserveData(address,address)(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint40,bool)" \
     0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599 \
     $RESCUE_OWNER \
     --rpc-url $RPC_URL
   ```

   If `usedAsCollateral` is `false`, enable it:

   ```bash
   cast send 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2 \
     "setUserUseReserveAsCollateral(address,bool)" \
     0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599 \
     true \
     --rpc-url $RPC_URL \
     --private-key $WATCHDOG_PRIVATE_KEY
   ```

5. Keep watchdog in dry-run first.
6. Switch to live mode after validation.

## Runtime Preconditions

- Monitored wallet signer key is set as `WATCHDOG_PRIVATE_KEY`.
- Signer address matches monitored wallet.
- Wallet holds WBTC and has allowance to rescue contract.
- Rescue contract has WBTC enabled as supported asset.
- WBTC must be enabled as collateral on the user's Aave position (see post-deploy step 4).

## Common Incident Checks

- `Invalid or missing rescueContract in watchdog config`
- `No available WBTC (balance/allowance/maxTopUp all exhausted)`
- `Insufficient WBTC to achieve minimum resulting HF`
- `Gas price ... exceeds max ...`
- `Signer address mismatch`
