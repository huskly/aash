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
  price?: { usd: number | null } | null;
  priceUsd?: number | null;
};

type MorphoMarketState = {
  utilization: number;
  borrowApy: number;
  supplyApy: number;
  avgBorrowApy?: number | null;
  avgSupplyApy?: number | null;
};

type MorphoApyHistoryPoint = {
  x: number;
  y: number;
};

type MorphoHistoricalState = {
  borrowApy?: MorphoApyHistoryPoint[] | null;
  supplyApy?: MorphoApyHistoryPoint[] | null;
};

type MorphoMarketPositionState = {
  borrowAssets: string;
  borrowAssetsUsd: number | null;
  accruedBorrowInterest?: string | null;
  accruedBorrowInterestUsd?: number | null;
  supplyAssets: string;
  supplyAssetsUsd: number | null;
  collateral: string;
};

export type RawMorphoMarketPosition = {
  market: {
    marketId?: string;
    uniqueKey?: string;
    loanAsset: MorphoAsset;
    collateralAsset: MorphoAsset | null;
    oracle?: { address: string } | null;
    oracleAddress?: string;
    irmAddress: string;
    lltv: string;
    state: MorphoMarketState;
  };
  state?: MorphoMarketPositionState;
  borrowAssets?: string;
  borrowAssetsUsd?: number | null;
  accruedBorrowInterest?: string | null;
  accruedBorrowInterestUsd?: number | null;
  supplyAssets?: string;
  supplyAssetsUsd?: number | null;
  collateral?: string;
};

type RawMorphoVault = {
  address: string;
  name: string | null;
  symbol: string | null;
  asset: MorphoAsset;
  avgApy?: number | null;
  avgNetApy?: number | null;
  avgNetApyExcludingRewards?: number | null;
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

type MorphoHistoricalRatesResponse = {
  data?: Record<
    string,
    {
      historicalState?: MorphoHistoricalState | null;
    } | null
  >;
  errors?: Array<{ message: string }>;
};

const MORPHO_POSITIONS_QUERY = `
  query UserPositions($address: String!, $chainId: Int!) {
    userByAddress(chainId: $chainId, address: $address) {
      address
      marketPositions {
        market {
          marketId
          loanAsset {
            symbol
            address
            decimals
            price {
              usd
            }
          }
          collateralAsset {
            symbol
            address
            decimals
            price {
              usd
            }
          }
          oracle {
            address
          }
          irmAddress
          lltv
          state {
            utilization
            borrowApy
            supplyApy
            avgBorrowApy
            avgSupplyApy
          }
        }
        state {
          borrowAssets
          borrowAssetsUsd
          accruedBorrowInterest
          accruedBorrowInterestUsd
          supplyAssets
          supplyAssetsUsd
          collateral
        }
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
            price {
              usd
            }
          }
          avgNetApy
          avgNetApyExcludingRewards
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
            price {
              usd
            }
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

const MORPHO_RATE_AVERAGE_WINDOW_SECONDS = 24 * 60 * 60;

function buildMorphoHistoricalRatesQuery(marketIds: string[]): string {
  const markets = marketIds
    .map(
      (marketId, index) => `
      market_${index}: marketByUniqueKey(chainId: $chainId, uniqueKey: "${marketId}") {
        historicalState {
          borrowApy(
            options: {
              startTimestamp: $startTimestamp
              endTimestamp: $endTimestamp
              interval: HOUR
            }
          ) {
            x
            y
          }
          supplyApy(
            options: {
              startTimestamp: $startTimestamp
              endTimestamp: $endTimestamp
              interval: HOUR
            }
          ) {
            x
            y
          }
        }
      }`,
    )
    .join('\n');

  return `
    query MarketHistoricalRates($chainId: Int!, $startTimestamp: Int!, $endTimestamp: Int!) {
      ${markets}
    }
  `;
}

function fromWad(raw: string): number {
  return Number(BigInt(raw)) / 1e18;
}

function parseAmount(raw: string, decimals: number): number {
  const value = Number(BigInt(raw)) / 10 ** decimals;
  return Number.isFinite(value) ? value : 0;
}

function averageApy(points: MorphoApyHistoryPoint[] | null | undefined): number | null {
  if (!points?.length) return null;

  const values = points.map((point) => point.y).filter((value) => Number.isFinite(value));
  if (values.length === 0) return null;

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function assetPriceUsd(asset: MorphoAsset): number | null {
  return asset.price?.usd ?? asset.priceUsd ?? null;
}

function positionState(pos: RawMorphoMarketPosition): MorphoMarketPositionState {
  return {
    borrowAssets: pos.state?.borrowAssets ?? pos.borrowAssets ?? '0',
    borrowAssetsUsd: pos.state?.borrowAssetsUsd ?? pos.borrowAssetsUsd ?? null,
    accruedBorrowInterest: pos.state?.accruedBorrowInterest ?? pos.accruedBorrowInterest ?? null,
    accruedBorrowInterestUsd:
      pos.state?.accruedBorrowInterestUsd ?? pos.accruedBorrowInterestUsd ?? null,
    supplyAssets: pos.state?.supplyAssets ?? pos.supplyAssets ?? '0',
    supplyAssetsUsd: pos.state?.supplyAssetsUsd ?? pos.supplyAssetsUsd ?? null,
    collateral: pos.state?.collateral ?? pos.collateral ?? '0',
  };
}

/**
 * Resolve USD price and value for a position. Prefers the position-level USD
 * total (e.g. `borrowAssetsUsd`) as the source of truth, back-calculating the
 * per-unit price when `asset.price.usd` is null. This avoids zeroing out debt
 * or vault assets when their aggregate USD field is available.
 */
function resolveUsd(
  asset: MorphoAsset,
  amount: number,
  positionUsd: number | null,
): { usdPrice: number; usdValue: number } {
  const priceUsd = assetPriceUsd(asset);
  if (priceUsd != null) {
    return { usdPrice: priceUsd, usdValue: amount * priceUsd };
  }
  if (positionUsd != null && positionUsd > 0) {
    return { usdPrice: amount > 0 ? positionUsd / amount : 0, usdValue: positionUsd };
  }
  return { usdPrice: 0, usdValue: 0 };
}

function buildCollateralPosition(pos: RawMorphoMarketPosition, lltv: number): AssetPosition | null {
  const asset = pos.market.collateralAsset;
  if (!asset) return null;

  const amount = parseAmount(positionState(pos).collateral, asset.decimals);
  if (amount <= 0) return null;

  const { usdPrice, usdValue } = resolveUsd(asset, amount, null);
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
    // Morpho Blue collateral is not supplied to the loan-asset pool and does not earn supply APY.
    supplyRate: 0,
    borrowRate: 0,
  };
}

function buildBorrowPosition(pos: RawMorphoMarketPosition): AssetPosition | null {
  const asset = pos.market.loanAsset;
  const state = positionState(pos);
  const amount = parseAmount(state.borrowAssets, asset.decimals);
  if (amount <= 0) return null;

  const { usdPrice, usdValue } = resolveUsd(asset, amount, state.borrowAssetsUsd);
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
    const marketId = pos.market.marketId ?? pos.market.uniqueKey;
    if (!marketId) return [];

    const lltv = fromWad(pos.market.lltv);
    const collateral = buildCollateralPosition(pos, lltv);
    const borrow = buildBorrowPosition(pos);

    if (!collateral && !borrow) return [];

    const supplied = collateral ? [collateral] : [];
    const borrowed = borrow ? [borrow] : [];
    const totalSuppliedUsd = supplied.reduce((sum, a) => sum + a.usdValue, 0);
    const totalBorrowedUsd = borrowed.reduce((sum, a) => sum + a.usdValue, 0);
    const accruedBorrowInterestUsd = positionState(pos).accruedBorrowInterestUsd ?? undefined;

    if (totalSuppliedUsd < MIN_POSITION_USD && totalBorrowedUsd < MIN_POSITION_USD) return [];

    const collateralSymbol = pos.market.collateralAsset?.symbol.toUpperCase() ?? '?';
    const loanSymbol = pos.market.loanAsset.symbol.toUpperCase();
    const oracleAddress = pos.market.oracle?.address ?? pos.market.oracleAddress;

    const morphoMarketParams: MorphoMarketParams | undefined =
      pos.market.collateralAsset && oracleAddress
        ? {
            loanToken: pos.market.loanAsset.address.toLowerCase(),
            collateralToken: pos.market.collateralAsset.address.toLowerCase(),
            oracle: oracleAddress.toLowerCase(),
            irm: pos.market.irmAddress.toLowerCase(),
            lltv: pos.market.lltv,
          }
        : undefined;

    return [
      {
        id: marketId,
        marketName: `morpho_${collateralSymbol}_${loanSymbol}`,
        borrowed,
        supplied,
        totalSuppliedUsd,
        totalBorrowedUsd,
        accruedBorrowInterestUsd,
        morphoMarketParams,
        utilizationRate: pos.market.state.utilization,
        marketSupplyApy: pos.market.state.supplyApy,
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

  const apy = vault.avgNetApyExcludingRewards ?? vault.avgApy ?? vault.state?.apy ?? 0;
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

function dedupeMorphoVaultPositions(vaults: MorphoVaultPosition[]): MorphoVaultPosition[] {
  const byAddress = new Map<string, MorphoVaultPosition>();
  for (const vault of vaults) {
    const address = vault.vaultAddress.toLowerCase();
    const existing = byAddress.get(address);
    if (!existing || vault.totalAssetsUsd > existing.totalAssetsUsd) {
      byAddress.set(address, vault);
    }
  }
  return Array.from(byAddress.values());
}

async function fetchAverageMarketApys(
  marketIds: string[],
  chainId: number,
): Promise<Map<string, { borrowApy: number; supplyApy: number }>> {
  if (marketIds.length === 0) return new Map();

  const now = Math.floor(Date.now() / 1000);
  const response = await fetch(MORPHO_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: buildMorphoHistoricalRatesQuery(marketIds),
      variables: {
        chainId,
        startTimestamp: now - MORPHO_RATE_AVERAGE_WINDOW_SECONDS,
        endTimestamp: now,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Morpho API returned ${response.status}`);
  }

  const payload = (await response.json()) as MorphoHistoricalRatesResponse;
  if (payload.errors?.length) {
    throw new Error(`Morpho API error: ${payload.errors[0]?.message ?? 'unknown'}`);
  }

  const averaged = new Map<string, { borrowApy: number; supplyApy: number }>();
  for (const [index, marketId] of marketIds.entries()) {
    const market = payload.data?.[`market_${index}`];
    const borrowApy = averageApy(market?.historicalState?.borrowApy);
    const supplyApy = averageApy(market?.historicalState?.supplyApy);
    if (borrowApy == null && supplyApy == null) continue;

    averaged.set(marketId, {
      borrowApy: borrowApy ?? 0,
      supplyApy: supplyApy ?? 0,
    });
  }

  return averaged;
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
  const marketIds = Array.from(
    new Set(
      marketPositions
        .filter(
          (pos) => pos.market.state.avgBorrowApy == null && pos.market.state.avgSupplyApy == null,
        )
        .map((pos) => pos.market.marketId ?? pos.market.uniqueKey)
        .filter((marketId): marketId is string => Boolean(marketId)),
    ),
  );

  let averageMarketApys = new Map<string, { borrowApy: number; supplyApy: number }>();
  try {
    averageMarketApys = await fetchAverageMarketApys(marketIds, chainId);
  } catch {
    // Fall back to spot rates when historical APY data is unavailable.
  }

  const marketPositionsWithAverageRates = marketPositions.map((pos) => {
    const marketId = pos.market.marketId ?? pos.market.uniqueKey;
    const avgBorrowApy = pos.market.state.avgBorrowApy;
    const avgSupplyApy = pos.market.state.avgSupplyApy;

    if (avgBorrowApy != null || avgSupplyApy != null) {
      return {
        ...pos,
        market: {
          ...pos.market,
          state: {
            ...pos.market.state,
            borrowApy: avgBorrowApy ?? pos.market.state.borrowApy,
            supplyApy: avgSupplyApy ?? pos.market.state.supplyApy,
          },
        },
      };
    }

    if (!marketId) return pos;

    const averaged = averageMarketApys.get(marketId);
    if (!averaged) return pos;

    return {
      ...pos,
      market: {
        ...pos.market,
        state: {
          ...pos.market.state,
          borrowApy: averaged.borrowApy,
          supplyApy: averaged.supplyApy,
        },
      },
    };
  });

  return {
    marketLoans: buildMorphoMarketLoans(marketPositionsWithAverageRates),
    vaultPositions: dedupeMorphoVaultPositions([
      ...buildMorphoVaultV2Positions(vaultV2Positions),
      ...buildMorphoVaultPositions(vaultPositions),
    ]),
  };
}

export async function fetchFromMorphoApi(
  wallet: string,
  chainId: number = 1,
): Promise<LoanPosition[]> {
  const positions = await fetchMorphoPositions(wallet, chainId);
  return positions.marketLoans;
}
