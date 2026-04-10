set -e

MARKET="${1:-}"
DRY_RUN=true

# Parse flags
for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=true ;;
    --no-dry-run) DRY_RUN=false ;;
  esac
done

if [[ -z "$MARKET" ]]; then
  echo "Usage: $0 <market> [--dry-run|--no-dry-run]" >&2
  echo "  Available markets: WBTC/USDC, cbBTC/USDC, wstETH/USDC" >&2
  echo "  --dry-run     Simulate only, do not broadcast (default)" >&2
  echo "  --no-dry-run  Broadcast the transaction" >&2
  exit 1
fi

case "$MARKET" in
  WBTC/USDC)
    export MORPHO_LOAN_TOKEN=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 # USDC
    export MORPHO_COLLATERAL_TOKEN=0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599 # WBTC
    export MORPHO_ORACLE=0xDddd770BADd886dF3864029e4B377B5F6a2B6b83
    export MORPHO_IRM=0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC
    export MORPHO_LLTV=860000000000000000 # 86%
    ;;
  wstETH/USDC)
    export MORPHO_LOAN_TOKEN=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 # USDC
    export MORPHO_COLLATERAL_TOKEN=0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0 # wstETH
    export MORPHO_ORACLE=0x48F7E36EB6B826B2dF4B2E630B62Cd25e89E40e2
    export MORPHO_IRM=0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC
    export MORPHO_LLTV=860000000000000000 # 86%
    ;;
  cbBTC/USDC)
    export MORPHO_LOAN_TOKEN=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 # USDC
    export MORPHO_COLLATERAL_TOKEN=0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf # cbBTC
    export MORPHO_ORACLE=0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a
    export MORPHO_IRM=0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC
    export MORPHO_LLTV=860000000000000000 # 86%
    ;;
  *)
    echo "Unknown market: $MARKET" >&2
    echo "  Available markets: WBTC/USDC, cbBTC/USDC" >&2
    exit 1
    ;;
esac

export MORPHO_BLUE=0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
export RPC_URL=https://rpc.mevblocker.io
export RESCUE_OWNER=0xEd6965EA279b83B449e4D98F270a709Cf46b7405  # Contract owner (monitored wallet address)
export RESCUE_EXECUTOR=0x03414113e25e24e35586b3f5b6ea7fbe49a72302 # MHT Hot wallet allowed to submit rescue txs
export INITIAL_OWNER=0x03414113e25e24e35586b3f5b6ea7fbe49a72302

if [[ -z "${DEPLOYER_PRIVATE_KEY:-}" ]]; then
  echo "Error: DEPLOYER_PRIVATE_KEY is not set." >&2
  exit 1
fi

BROADCAST_FLAG=()
if [[ "$DRY_RUN" == false ]]; then
  BROADCAST_FLAG=(--broadcast)
else
  echo "Dry-run mode: transaction will NOT be broadcast. Pass --no-dry-run to deploy."
fi

forge script script/DeployMorphoAtomicRepayV1.s.sol:DeployMorphoAtomicRepayV1 \
  --rpc-url $RPC_URL \
  --sig "run()" \
  "${BROADCAST_FLAG[@]}" \
  --private-key $DEPLOYER_PRIVATE_KEY