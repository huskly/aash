# Rescue v1 Ops (Atomic Debt Repay)

## Scope

v1 currently supports:

- Ethereum mainnet Aave v3 via `AaveAtomicRepayV1`
- Ethereum mainnet Morpho Blue via `MorphoAtomicRepayV1`
- Optional layer-0 Morpho ERC-4626 vault withdrawal via `MorphoVaultWithdrawV1`
- owner-funded, executor-triggered contract execution

## Build And Test

Prerequisite: Install [Foundry](https://github.com/foundry-rs/foundry).

From repo root:

```bash
cd packages/rescue-contract
forge build
forge test
```

## Deploy Aave

Set env vars for the Aave deploy script:

```bash
export RESCUE_OWNER=0x...                # Contract owner (monitored wallet address)
export RESCUE_EXECUTOR=0x...             # Hot wallet allowed to submit rescue txs
export AAVE_POOL=0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2
export AAVE_ADDRESSES_PROVIDER=0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e
export DEBT_TOKEN_ADDRESS=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48  # e.g. USDC
export RPC_URL=https://rpc.mevblocker.io  # or https://eth.llamarpc.com
```

Dry-run (simulation only, no broadcast). `--sender` must match `INITIAL_OWNER` (or `RESCUE_OWNER`
when `INITIAL_OWNER` is unset) so the
`setSupportedAsset` call succeeds in simulation:

```bash
forge script script/DeployAaveAtomicRepayV1.s.sol:DeployAaveAtomicRepayV1 \
  --rpc-url $RPC_URL \
  --sig "run()" \
  --sender ${INITIAL_OWNER:-$RESCUE_OWNER}
```

Broadcast (live deploy):

```bash
forge script script/DeployAaveAtomicRepayV1.s.sol:DeployAaveAtomicRepayV1 \
  --rpc-url $RPC_URL \
  --sig "run()" \
  --broadcast \
  --private-key $DEPLOYER_PRIVATE_KEY
```

If `RESCUE_OWNER` is a hardware wallet, set a temporary deployer as `INITIAL_OWNER`. The script
will deploy from the hot wallet, set `RESCUE_EXECUTOR`, enable the supported asset, and then
transfer ownership to `RESCUE_OWNER` in the same run:

```bash
export INITIAL_OWNER=0xYourHotWallet
export RESCUE_OWNER=0xYourHardwareWallet
export RESCUE_EXECUTOR=0xYourHotWallet

forge script script/DeployAaveAtomicRepayV1.s.sol:DeployAaveAtomicRepayV1 \
  --rpc-url $RPC_URL \
  --sig "run()" \
  --broadcast \
  --private-key $DEPLOYER_PRIVATE_KEY
```

Save the deployed contract address from the output.

## Post-Deploy Aave

1. Save deployed `AaveAtomicRepayV1` address.

2. Set `watchdog.rescueContract` in `PUT /api/config`:

   ```bash
   curl -X PUT https://<your-host>/api/config \
     -H 'Content-Type: application/json' \
     -d '{"watchdog": {"rescueContract": "<deployed-address>"}}'
   ```

3. Approve the debt token (e.g. USDC) from monitored wallet to rescue contract (unlimited allowance):

   ```bash
   cast send <debt-token-address> \
     "approve(address,uint256)" \
     <deployed-address> \
     $(cast max-uint) \
     --rpc-url $RPC_URL \
     # sign this with the monitored wallet in your wallet UI / hardware wallet
   ```

   To use a capped allowance instead (e.g. 1000 USDC), replace `$(cast max-uint)` with `1000000000` (6 decimals).

4. Keep watchdog in dry-run first.
5. Switch to live mode after validation.

## Runtime Preconditions

- Monitored wallet is set as `RESCUE_OWNER`.
- Executor wallet is set as `RESCUE_EXECUTOR` (or defaults to `INITIAL_OWNER`).
- Wallet holds the debt token (e.g. USDC/USDT) and has allowance to the Aave rescue contract.
- Rescue contract has the debt token enabled as supported asset.

## Deploy Morpho

Set env vars for the Morpho deploy script:

```bash
export RESCUE_OWNER=0x...                # Contract owner (monitored wallet address)
export RESCUE_EXECUTOR=0x...             # Hot wallet allowed to submit rescue txs
export MORPHO_BLUE=0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
export MORPHO_LOAN_TOKEN=0x...
export MORPHO_COLLATERAL_TOKEN=0x...
export MORPHO_ORACLE=0x...
export MORPHO_IRM=0x...
export MORPHO_LLTV=<wad-value>           # e.g. 860000000000000000 for 86%
export RPC_URL=https://rpc.mevblocker.io # or https://eth.llamarpc.com
```

To avoid typos, generate these directly from a Morpho market URL or market unique key:

```bash
yarn morpho:market-env \
  app.morpho.org/ethereum/market/0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64/cbbtc-usdc
```

Example output for Ethereum `cbBTC/USDC`:

```bash
export MORPHO_BLUE=0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
export MORPHO_LOAN_TOKEN=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
export MORPHO_COLLATERAL_TOKEN=0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf
export MORPHO_ORACLE=0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a
export MORPHO_IRM=0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC
export MORPHO_LLTV=860000000000000000
```

The `MORPHO_*` market params must match the monitored market exactly. A mismatch in
loan token, collateral token, oracle, IRM, or LLTV will make the rescue contract reject the call.

Dry-run (simulation only, no broadcast). `--sender` must match `INITIAL_OWNER` (or `RESCUE_OWNER`
when `INITIAL_OWNER` is unset) so the
`setSupportedMarket` call succeeds in simulation:

```bash
forge script script/DeployMorphoAtomicRepayV1.s.sol:DeployMorphoAtomicRepayV1 \
  --rpc-url $RPC_URL \
  --sig "run()" \
  --sender ${INITIAL_OWNER:-$RESCUE_OWNER}
```

Broadcast (live deploy):

```bash
forge script script/DeployMorphoAtomicRepayV1.s.sol:DeployMorphoAtomicRepayV1 \
  --rpc-url $RPC_URL \
  --sig "run()" \
  --broadcast \
  --private-key $DEPLOYER_PRIVATE_KEY
```

If `RESCUE_OWNER` is a hardware wallet, set a temporary deployer as `INITIAL_OWNER`. The script
will deploy from the hot wallet, set `RESCUE_EXECUTOR`, call `setSupportedMarket(...)`, and then
transfer ownership to `RESCUE_OWNER` in the same run:

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

Save the deployed contract address from the output.

The deployed `MorphoAtomicRepayV1` contract is not limited to that first market. It can support
multiple Morpho markets for the same monitored wallet / executor pair by enabling additional
market tuples with `setSupportedMarket(...)`.

## Post-Deploy Morpho

1. Save deployed `MorphoAtomicRepayV1` address.

2. Set `watchdog.morphoRescueContract` in `PUT /api/config`:

```bash
  curl -X PUT https://<your-host>/api/config \
    -H 'Content-Type: application/json' \
    -d '{"watchdog": {"morphoRescueContract": "<deployed-address>"}}'
```

3. Approve the loan token (e.g. USDC `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`) from the monitored wallet to the rescue contract:

   ```bash
   cast send <borrowed-token-address> \
     "approve(address,uint256)" \
     <deployed-address> \
     $(cast max-uint) \
     --rpc-url $RPC_URL \
     # sign this with the monitored wallet in your wallet UI / hardware wallet
   ```

   For a capped allowance, replace `$(cast max-uint)` with the intended amount in token base units.
   The approval must be signed by the monitored wallet / rescue contract owner, not by the deployer,
   because the rescue contract pulls the loan token from `params.user` via `transferFrom(...)`.

   You can also do this from the etherscan UI at https://etherscan.io/address/<borrowed-token-address>#writeProxyContract

   If you want to use Etherscan’s Write Contract UI instead:
   1. Open the USDC contract on Etherscan.
   2. Go to Contract -> Write as Proxy.
   3. Connect your wallet through MetaMask/Rabby with the Trezor account selected.
   4. Use approve(address spender, uint256 amount).
   5. Enter:
      - spender: <deployed-address>
      - amount: 115792089237316195423570985008687907853269984665640564039457584007913129639935 for unlimited, or e.g. 1000000000 for 1000 USDC
   6. Submit and confirm on the Trezor.

4. Verify the supported market params match the monitored loan exactly:
   - `loanToken`
   - `collateralToken`
   - `oracle`
   - `irm`
   - `lltv`

   To add another Morpho market to the same rescue contract later, enable it on the existing
   contract instead of deploying a new one. The simplest path for hardware-wallet owners is
   Etherscan `Write Contract`:
   1. Open the verified rescue contract on Etherscan.
   2. Go to `Contract` -> `Write Contract`.
   3. Connect MetaMask or Rabby with the owner wallet selected.
   4. Call `setSupportedMarket((address,address,address,address,uint256),bool)`.
   5. Enter the exact Morpho market tuple:
      - `loanToken`
      - `collateralToken`
      - `oracle`
      - `irm`
      - `lltv`
      - `enabled = true`
   6. Sign with the owner wallet.

   This call is `onlyOwner`, not executor-authorized, so the connected wallet must match the
   contract `owner()`.

5. Verify the contract source on Etherscan:

   ```bash
   forge verify-contract --chain mainnet \
     --watch \
     --guess-constructor-args \
     --rpc-url $RPC_URL \
     --etherscan-api-key $ETHERSCAN_API_KEY \
     <deployed-address> \
     src/MorphoAtomicRepayV1.sol:MorphoAtomicRepayV1
   ```

   If the contract was deployed with a temporary `INITIAL_OWNER`, `--guess-constructor-args`
   should resolve the constructor from the creation bytecode correctly.

   The current implementation does not auto-discover or auto-register new Morpho markets on-chain. If the monitored
   wallet moves to a different market, register that exact market tuple on the existing rescue contract before
   enabling live mode. Deploy a new contract only when the monitored wallet owner or executor model changes.

6. Keep watchdog in dry-run first.
7. Switch to live mode after validation.

## Runtime Preconditions (Morpho)

- Monitored wallet is set as `RESCUE_OWNER`.
- Executor wallet is set as `RESCUE_EXECUTOR` (or defaults to `INITIAL_OWNER`).
- Wallet holds the loan token (e.g. USDC) and has allowance to the Morpho rescue contract.
- Rescue contract has the exact Morpho market enabled via `setSupportedMarket`.

## Deploy Pre-Rescue Morpho Vault Withdrawal

`MorphoVaultWithdrawV1` is separate from the layer-1 Morpho repay contract. It only
orchestrates ERC-4626 withdrawals from owner-approved vault shares into the monitored wallet.
It does not custody funds and does not repay debt directly.

Set env vars for the pre-rescue deploy script:

```bash
export RESCUE_OWNER=0x...                # Final owner (monitored wallet address)
export RESCUE_EXECUTOR=0x...             # Hot wallet allowed to submit withdraw txs
export MORPHO_VAULT=0x...                # ERC-4626 vault to enable at deploy time
export RPC_URL=https://rpc.mevblocker.io # or https://eth.llamarpc.com
```

For the current operator defaults, the wrapper sets `RESCUE_OWNER`, `RESCUE_EXECUTOR`,
`INITIAL_OWNER`, and `RPC_URL` the same way as `deploy-morpho-repay.sh`. With no vault argument it
enables Gauntlet USDC Prime (`0x8c106EEDAd96553e64287A5A6839c3Cc78afA3D0`). Pass one vault address
or a comma-separated vault list to override that default:

```bash
./deploy-morpho-vault-withdraw.sh --dry-run
./deploy-morpho-vault-withdraw.sh 0xVaultAddress --dry-run
./deploy-morpho-vault-withdraw.sh 0xVaultA,0xVaultB --no-dry-run
```

To enable multiple vaults in the same deploy, use a comma-separated `MORPHO_VAULTS` list instead
of `MORPHO_VAULT`:

```bash
export MORPHO_VAULTS=0xVaultA,0xVaultB,0xVaultC
```

Dry-run (simulation only, no broadcast). `--sender` must match `INITIAL_OWNER` (or `RESCUE_OWNER`
when `INITIAL_OWNER` is unset) so the `setSupportedVault` call succeeds in simulation:

```bash
forge script script/DeployMorphoVaultWithdrawV1.s.sol:DeployMorphoVaultWithdrawV1 \
  --rpc-url $RPC_URL \
  --sig "run()" \
  --sender ${INITIAL_OWNER:-$RESCUE_OWNER}
```

Broadcast (live deploy):

```bash
forge script script/DeployMorphoVaultWithdrawV1.s.sol:DeployMorphoVaultWithdrawV1 \
  --rpc-url $RPC_URL \
  --sig "run()" \
  --broadcast \
  --private-key $DEPLOYER_PRIVATE_KEY
```

If `RESCUE_OWNER` is a hardware wallet, set a temporary deployer as `INITIAL_OWNER`. The script
will deploy from the hot wallet, set `RESCUE_EXECUTOR`, enable every vault from `MORPHO_VAULT`
or `MORPHO_VAULTS`, and then transfer ownership to `RESCUE_OWNER` in the same run:

```bash
export INITIAL_OWNER=0xYourHotWallet
export RESCUE_OWNER=0xYourHardwareWallet
export RESCUE_EXECUTOR=0xYourHotWallet
export MORPHO_VAULT=0xYourMorphoVault

forge script script/DeployMorphoVaultWithdrawV1.s.sol:DeployMorphoVaultWithdrawV1 \
  --rpc-url $RPC_URL \
  --sig "run()" \
  --broadcast \
  --private-key $DEPLOYER_PRIVATE_KEY
```

Verify the source on Etherscan:

```bash
forge verify-contract --chain mainnet \
  --watch \
  --guess-constructor-args \
  --rpc-url $RPC_URL \
  --etherscan-api-key $ETHERSCAN_API_KEY \
  <vault-withdraw-contract> \
  src/MorphoVaultWithdrawV1.sol:MorphoVaultWithdrawV1
```

## Post-Deploy Pre-Rescue

1. Save deployed `MorphoVaultWithdrawV1` address.

2. Set watchdog pre-rescue config in `PUT /api/config`:

   ```bash
   curl -X PUT https://<your-host>/api/config \
     -H 'Content-Type: application/json' \
     -d '{"watchdog": {"preRescueEnabled": true, "preRescueTriggerHF": 1.7, "vaultWithdrawContract": "<vault-withdraw-contract>", "maxVaultWithdrawAmount": 500}}'
   ```

   `preRescueTriggerHF` must be greater than `triggerHF`. Layer 0 runs only in the buffer band
   `[triggerHF, preRescueTriggerHF)`.

3. Confirm each ERC-4626 vault that can be used as a source of debt-token liquidity was enabled.
   The deploy script already enables `MORPHO_VAULT` or every address in `MORPHO_VAULTS`. To add
   another vault later:

   ```bash
   cast send <vault-withdraw-contract> \
     "setSupportedVault(address,bool)" \
     <morpho-vault-address> true \
     --rpc-url $RPC_URL
     # sign this with the owner wallet, or with the temporary owner before ownership transfer
   ```

4. Approve the vault share token from the monitored wallet to the vault withdraw contract. This is
   required even when the monitored wallet already has funds in the vault. The approval must be
   signed by the monitored wallet / vault owner, not by the executor wallet.

   The vault address is also the ERC-20 share token address for ERC-4626 vaults:

   ```bash
   cast send <morpho-vault-address> \
     "approve(address,uint256)" \
     <vault-withdraw-contract> \
     $(cast max-uint) \
     --rpc-url $RPC_URL
     # sign this with the monitored wallet in your wallet UI / hardware wallet
   ```

   For the current Gauntlet USDC Prime setup:
   - vault/share token: `0x8c106EEDAd96553e64287A5A6839c3Cc78afA3D0`
   - vault withdraw contract/spender: `<vault-withdraw-contract>`
   - production helper currently configured as `0xd001e5218d89737fe064b3cc7fb507f2981d8aa1`

   In Etherscan, open the vault contract's **Write Contract** tab, connect the monitored wallet,
   and call `approve(spender, amount)` with:
   - `spender`: the `MorphoVaultWithdrawV1` address
   - `amount`: `type(uint256).max`
     (`115792089237316195423570985008687907853269984665640564039457584007913129639935`)

   Verify the allowance before live mode:

   ```bash
   cast call <morpho-vault-address> \
     "allowance(address,address)(uint256)" \
     <monitored-wallet> \
     <vault-withdraw-contract> \
     --rpc-url $RPC_URL
   ```

   The result must be non-zero and large enough for the planned withdrawal. If it is `0`, the
   watchdog will skip live pre-rescue with an insufficient share allowance log entry.

5. Keep watchdog in dry-run first and confirm `/api/watchdog/status` logs
   `vault-withdraw-dry-run` entries when HF enters the pre-rescue buffer band.
6. Switch watchdog to live mode after the layer-0 dry run and layer-1 rescue dry run both look correct.

## Runtime Preconditions (Pre-Rescue)

- Watchdog is enabled and `preRescueEnabled=true`.
- `vaultWithdrawContract` points to `MorphoVaultWithdrawV1`.
- Monitored wallet is the vault withdraw contract `owner()`.
- Executor wallet is the vault withdraw contract `executor()`.
- The candidate Morpho vault is enabled with `setSupportedVault`.
- The monitored wallet has approved vault shares to `vaultWithdrawContract`.
- The vault's underlying asset matches the loan debt token.
- The vault has usable owner-specific withdrawal capacity. Standard ERC-4626 vaults use
  `maxWithdraw(monitoredWallet)`; Morpho Vault V2 vaults can report zero from max functions and
  still be usable through the wallet's share asset value.
- A valid Aave or Morpho layer-1 rescue contract is configured so the watchdog can preview the HF impact before withdrawing.

Operational notes:

- The watchdog chooses candidate vaults by debt-token address and selects the vault with the largest usable owner-specific capacity.
- The withdrawal amount is the shortfall between wallet balance and the debt-token amount needed to reach `targetHF`.
- Withdrawal is capped by `maxVaultWithdrawAmount`, owner-specific usable capacity, and the layer-1 `maxRepayAmount`.
- Pre-rescue only moves funds into the monitored wallet. If HF later crosses `triggerHF`, the existing layer-1 rescue consumes that wallet balance on a later poll.
- If HF recovers above `preRescueTriggerHF`, the withdrawn funds remain in the wallet until manually redeposited.
- The pre-rescue cooldown uses a separate `-prerescue` key; failed live pre-rescue transactions also apply cooldown.

## Common Incident Checks

- `Invalid or missing rescueContract in watchdog config`
- `No available USDC (balance/allowance/maxRepay all exhausted)`
- `Insufficient USDC to achieve minimum resulting HF`
- `Invalid or missing morphoRescueContract in watchdog config`
- `No available <debt-symbol> (balance/allowance/maxRepay all exhausted)`
- `Insufficient <debt-symbol> to achieve minimum resulting HF`
- `Invalid or missing vaultWithdrawContract in watchdog config`
- `Pre-rescue: no Morpho vault with withdrawable <debt-symbol> found`
- `Pre-rescue: wallet already holds ...`
- `Pre-rescue: ... (wallet + vault, capped) not enough to reach target HF`
- `Pre-rescue tx failed`
- `MarketNotSupported`
- `VaultNotSupported`
- `Gas price ... exceeds max ...`
- `NotExecutor`
