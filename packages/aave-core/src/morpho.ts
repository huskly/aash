import type {
  AssetPosition,
  LoanPosition,
  MorphoMarketParams,
  MorphoVaultPosition,
} from './types.js';

const MORPHO_API_URL = 'https://api.morpho.org/graphql';
const MIN_POSITION_USD = 0.01;

type MorphoAsset = {
  symbol: string;
  address: string;
  decimals: number;
  priceUsd: number | null;
};

type MorphoMarketState = {
  utilization: number;
  borrowApy: number;
  supplyApy: number;
};

export type RawMorphoMarketPosition = {
  market: {
    uniqueKey: string;
    loanAsset: MorphoAsset;
    collateralAsset: MorphoAsset | null;
    oracleAddress: string;
    irmAddress: string;
    lltv: string;
    state: MorphoMarketState;
  };
  borrowAssets: string;
  borrowAssetsUsd: number | null;
  supplyAssets: string;
  supplyAssetsUsd: number | null;
  collateral: string;
};

type RawMorphoVault = {
  address: string;
  name: string | null;
  symbol: string | null;
  asset: MorphoAsset;
  avgApy?: number | null;
  avgNetApy?: number | null;
  state?: {
    apy: number | null;
    netApy: number | null;
  };
};

export type RawMorphoVaultV2Position = {
  vault: RawMorphoVault;
  assets: string;
  assetsUsd: number | null;
  shares: string;
};

export type RawMorphoVaultPosition = {
  vault: RawMorphoVault;
  state: {
    assets: string;
    assetsUsd: number | null;
    shares: string;
  };
};

type MorphoUserResponse = {
  data?: {
    userByAddress?: {
      address: string;
      marketPositions: RawMorphoMarketPosition[];
      vaultV2Positions: RawMorphoVaultV2Position[];
      vaultPositions: RawMorphoVaultPosition[];
    };
  };
  errors?: Array<{ message: string }>;
};

const MORPHO_POSITIONS_QUERY = `
  query UserPositions($address: String!, $chainId: Int!) {
    userByAddress(chainId: $chainId, address: $address) {
      address
        marketPositions {
        market {
          uniqueKey
          loanAsset {
            symbol
            address
            decimals
            priceUsd
          }
          collateralAsset {
            symbol
            address
            decimals
            priceUsd
          }
          oracleAddress
          irmAddress
          lltv
          state {
            utilization
            borrowApy
            supplyApy
          }
        }
        borrowAssets
        borrowAssetsUsd
        supplyAssets
        supplyAssetsUsd
        collateral
      }
      vaultV2Positions {
        vault {
          address
          name
          symbol
          asset {
            symbol
            address
            decimals
            priceUsd
          }
          avgApy
          avgNetApy
        }
        assets
        assetsUsd
        shares
      }
      vaultPositions {
        vault {
          address
          name
          symbol
          asset {
            symbol
            address
            decimals
            priceUsd
          }
          state {
            apy
            netApy
          }
        }
        state {
          assets
          assetsUsd
          shares
        }
      }
    }
  }
`;

function fromWad(raw: string): number {
  return Number(BigInt(raw)) / 1e18;
}

function parseAmount(raw: string, decimals: number): number {
  const value = Number(BigInt(raw)) / 10 ** decimals;
  return Number.isFinite(value) ? value : 0;
}

/**
 * Resolve USD price and value for a position. Prefers the position-level USD
 * total (e.g. `borrowAssetsUsd`) as the source of truth, back-calculating the
 * per-unit price when `asset.priceUsd` is null. This avoids zeroing out debt or
 * collateral when the per-asset price field is missing.
 */
function resolveUsd(
  asset: MorphoAsset,
  amount: number,
  positionUsd: number | null,
): { usdPrice: number; usdValue: number } {
  if (asset.priceUsd != null) {
    return { usdPrice: asset.priceUsd, usdValue: amount * asset.priceUsd };
  }
  if (positionUsd != null && positionUsd > 0) {
    return { usdPrice: amount > 0 ? positionUsd / amount : 0, usdValue: positionUsd };
  }
  return { usdPrice: 0, usdValue: 0 };
}

function buildCollateralPosition(pos: RawMorphoMarketPosition, lltv: number): AssetPosition | null {
  const asset = pos.market.collateralAsset;
  if (!asset) return null;

  const amount = parseAmount(pos.collateral, asset.decimals);
  if (amount <= 0) return null;

  // Collateral has no position-level USD field; fall back to supplyAssetsUsd
  // only when the collateral and supply sides refer to the same asset context.
  const { usdPrice, usdValue } = resolveUsd(asset, amount, pos.supplyAssetsUsd);
  return {
    symbol: asset.symbol.toUpperCase(),
    address: asset.address.toLowerCase(),
    decimals: asset.decimals,
    amount,
    usdPrice,
    usdValue,
    collateralEnabled: true,
    maxLTV: lltv,
    liqThreshold: lltv,
    supplyRate: pos.market.state.supplyApy,
    borrowRate: 0,
  };
}

function buildBorrowPosition(pos: RawMorphoMarketPosition): AssetPosition | null {
  const asset = pos.market.loanAsset;
  const amount = parseAmount(pos.borrowAssets, asset.decimals);
  if (amount <= 0) return null;

  const { usdPrice, usdValue } = resolveUsd(asset, amount, pos.borrowAssetsUsd);
  return {
    symbol: asset.symbol.toUpperCase(),
    address: asset.address.toLowerCase(),
    decimals: asset.decimals,
    amount,
    usdPrice,
    usdValue,
    collateralEnabled: false,
    maxLTV: 0,
    liqThreshold: 0,
    supplyRate: 0,
    borrowRate: pos.market.state.borrowApy,
  };
}

function buildMorphoMarketLoans(positions: RawMorphoMarketPosition[]): LoanPosition[] {
  return positions.flatMap((pos): LoanPosition[] => {
    const lltv = fromWad(pos.market.lltv);
    const collateral = buildCollateralPosition(pos, lltv);
    const borrow = buildBorrowPosition(pos);

    if (!collateral && !borrow) return [];

    const supplied = collateral ? [collateral] : [];
    const borrowed = borrow ? [borrow] : [];
    const totalSuppliedUsd = supplied.reduce((sum, a) => sum + a.usdValue, 0);
    const totalBorrowedUsd = borrowed.reduce((sum, a) => sum + a.usdValue, 0);

    if (totalSuppliedUsd < MIN_POSITION_USD && totalBorrowedUsd < MIN_POSITION_USD) return [];

    const collateralSymbol = pos.market.collateralAsset?.symbol.toUpperCase() ?? '?';
    const loanSymbol = pos.market.loanAsset.symbol.toUpperCase();

    const morphoMarketParams: MorphoMarketParams | undefined = pos.market.collateralAsset
      ? {
          loanToken: pos.market.loanAsset.address.toLowerCase(),
          collateralToken: pos.market.collateralAsset.address.toLowerCase(),
          oracle: pos.market.oracleAddress.toLowerCase(),
          irm: pos.market.irmAddress.toLowerCase(),
          lltv: pos.market.lltv,
        }
      : undefined;

    return [
      {
        id: pos.market.uniqueKey,
        marketName: `morpho_${collateralSymbol}_${loanSymbol}`,
        borrowed,
        supplied,
        totalSuppliedUsd,
        totalBorrowedUsd,
        morphoMarketParams,
      },
    ];
  });
}

function buildMorphoVaultPosition(
  vault: RawMorphoVault,
  rawAssets: string,
  rawAssetsUsd: number | null,
  rawShares: string,
): MorphoVaultPosition[] {
  const amount = parseAmount(rawAssets, vault.asset.decimals);
  const shareAmount = parseAmount(rawShares, vault.asset.decimals);
  const { usdPrice, usdValue } = resolveUsd(vault.asset, amount, rawAssetsUsd);

  if (usdValue < MIN_POSITION_USD && amount < MIN_POSITION_USD) return [];

  const apy = vault.avgApy ?? vault.state?.apy ?? 0;
  const netApy = vault.avgNetApy ?? vault.state?.netApy ?? apy;
  const asset: AssetPosition = {
    symbol: vault.asset.symbol.toUpperCase(),
    address: vault.asset.address.toLowerCase(),
    decimals: vault.asset.decimals,
    amount,
    usdPrice,
    usdValue,
    collateralEnabled: false,
    maxLTV: 0,
    liqThreshold: 0,
    supplyRate: netApy,
    borrowRate: 0,
  };

  return [
    {
      id: vault.address.toLowerCase(),
      kind: 'morpho-vault',
      protocol: 'morpho',
      vaultAddress: vault.address.toLowerCase(),
      vaultName: vault.name?.trim() || vault.symbol?.trim() || 'Morpho Vault',
      vaultSymbol: vault.symbol?.trim() || vault.asset.symbol.toUpperCase(),
      asset,
      shares: shareAmount,
      totalAssets: amount,
      totalAssetsUsd: usdValue,
      apy,
      netApy,
    },
  ];
}

function buildMorphoVaultV2Positions(positions: RawMorphoVaultV2Position[]): MorphoVaultPosition[] {
  return positions.flatMap((pos) =>
    buildMorphoVaultPosition(pos.vault, pos.assets, pos.assetsUsd, pos.shares),
  );
}

function buildMorphoVaultPositions(positions: RawMorphoVaultPosition[]): MorphoVaultPosition[] {
  return positions.flatMap((pos) =>
    buildMorphoVaultPosition(pos.vault, pos.state.assets, pos.state.assetsUsd, pos.state.shares),
  );
}

export async function fetchMorphoPositions(
  wallet: string,
  chainId: number = 1,
): Promise<{ marketLoans: LoanPosition[]; vaultPositions: MorphoVaultPosition[] }> {
  const response = await fetch(MORPHO_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: MORPHO_POSITIONS_QUERY,
      variables: { address: wallet.toLowerCase(), chainId },
    }),
  });

  if (!response.ok) {
    throw new Error(`Morpho API returned ${response.status}`);
  }

  const payload = (await response.json()) as MorphoUserResponse;

  if (payload.errors?.length) {
    throw new Error(`Morpho API error: ${payload.errors[0]?.message ?? 'unknown'}`);
  }

  const user = payload.data?.userByAddress;
  const marketPositions = user?.marketPositions ?? [];
  const vaultV2Positions = user?.vaultV2Positions ?? [];
  const vaultPositions = user?.vaultPositions ?? [];

  return {
    marketLoans: buildMorphoMarketLoans(marketPositions),
    vaultPositions: [
      ...buildMorphoVaultV2Positions(vaultV2Positions),
      ...buildMorphoVaultPositions(vaultPositions),
    ],
  };
}

export async function fetchFromMorphoApi(
  wallet: string,
  chainId: number = 1,
): Promise<LoanPosition[]> {
  const positions = await fetchMorphoPositions(wallet, chainId);
  return positions.marketLoans;
}
