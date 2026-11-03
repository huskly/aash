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
  borrowPnl?: string | null;
  borrowPnlUsd?: number | null;
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
  borrowPnl?: string | null;
  borrowPnlUsd?: number | null;
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
  pnlUsd?: number | null;
};

export type RawMorphoVaultPosition = {
  vault: RawMorphoVault;
  state: {
    assets: string;
    assetsUsd: number | null;
    shares: string;
    pnlUsd?: number | null;
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
          borrowPnl
          borrowPnlUsd
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
        pnlUsd
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
          pnlUsd
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
    borrowPnl: pos.state?.borrowPnl ?? pos.borrowPnl ?? null,
    borrowPnlUsd: pos.state?.borrowPnlUsd ?? pos.borrowPnlUsd ?? null,
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
    const accruedBorrowInterestUsd = positionState(pos).borrowPnlUsd ?? undefined;

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
  pnlUsd?: number | null,
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
      accruedEarningsUsd: pnlUsd ?? undefined,
    },
  ];
}

function buildMorphoVaultV2Positions(positions: RawMorphoVaultV2Position[]): MorphoVaultPosition[] {
  return positions.flatMap((pos) =>
    buildMorphoVaultPosition(pos.vault, pos.assets, pos.assetsUsd, pos.shares, pos.pnlUsd),
  );
}

function buildMorphoVaultPositions(positions: RawMorphoVaultPosition[]): MorphoVaultPosition[] {
  return positions.flatMap((pos) =>
    buildMorphoVaultPosition(
      pos.vault,
      pos.state.assets,
      pos.state.assetsUsd,
      pos.state.shares,
      pos.state.pnlUsd,
    ),
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

const MIDNIGHT_API_URL = 'https://api.morpho.org/v0/midnight';
const WAD = 10n ** 18n;

export type RawMidnightPosition = {
  chain_id: number;
  market_id: string;
  created_at: number;
  loan_token: string;
  maturity: number;
  type: 'lend' | 'borrow' | 'collateral_only';
  /** Units owed at maturity, in loan-token base units. */
  debt: string;
  /** WAD-scaled loan-token base units received when the debt was opened. */
  cost_basis: string | null;
  effective_apr: number | null;
  collaterals: Array<{ token: string; amount: string }>;
};

export type RawMidnightMarket = {
  market_id: string;
  collaterals: Array<{ token: string; lltv: string; oracle: string }>;
};

type MidnightPage<T> = { cursor: string | null; data: T[] };

type MorphoAssetsResponse = {
  data?: { assets?: { items: MorphoAsset[] } };
  errors?: Array<{ message: string }>;
};

const MORPHO_ASSETS_QUERY = `
  query Assets($addresses: [String!], $chainId: Int!) {
    assets(where: { address_in: $addresses, chainId_in: [$chainId] }) {
      items {
        symbol
        address
        decimals
        price {
          usd
        }
      }
    }
  }
`;

async function fetchMidnightJson<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(`${MIDNIGHT_API_URL}${path}${query ? `?${query}` : ''}`);
  if (!response.ok) {
    throw new Error(`Morpho Midnight API returned ${response.status}`);
  }
  return (await response.json()) as T;
}

async function fetchMorphoAssets(addresses: string[], chainId: number): Promise<MorphoAsset[]> {
  if (addresses.length === 0) return [];
  const response = await fetch(MORPHO_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: MORPHO_ASSETS_QUERY, variables: { addresses, chainId } }),
  });
  if (!response.ok) {
    throw new Error(`Morpho API returned ${response.status}`);
  }
  const payload = (await response.json()) as MorphoAssetsResponse;
  if (payload.errors?.length) {
    throw new Error(`Morpho API error: ${payload.errors[0]?.message ?? 'unknown'}`);
  }
  return payload.data?.assets?.items ?? [];
}

function maturityDate(maturity: number): string {
  return new Date(maturity * 1000).toISOString().slice(0, 10);
}

/**
 * Midnight borrows are fixed-rate: the loan owes `debt` at maturity, and the
 * interest (`debt` minus the principal received) is spread in equal daily
 * amounts from when the position was opened until maturity.
 */
export function midnightAccruedInterest(pos: RawMidnightPosition, nowMs: number): number {
  const debt = BigInt(pos.debt);
  const principal = pos.cost_basis ? BigInt(pos.cost_basis) / WAD : debt;
  const totalInterest = Number(debt - principal);
  const termSeconds = pos.maturity - pos.created_at;
  if (totalInterest <= 0 || termSeconds <= 0) return Math.max(0, totalInterest);
  const elapsedFraction = Math.min(1, Math.max(0, (nowMs / 1000 - pos.created_at) / termSeconds));
  return totalInterest * elapsedFraction;
}

export function buildMidnightLoans(
  positions: RawMidnightPosition[],
  markets: Map<string, RawMidnightMarket>,
  assets: Map<string, MorphoAsset>,
  nowMs: number,
): LoanPosition[] {
  return positions.flatMap((pos): LoanPosition[] => {
    if (pos.type === 'lend') return [];
    const loanAsset = assets.get(pos.loan_token.toLowerCase());
    const market = markets.get(pos.market_id.toLowerCase());
    if (!loanAsset || !market) return [];

    const supplied = pos.collaterals.flatMap((entry): AssetPosition[] => {
      const asset = assets.get(entry.token.toLowerCase());
      const params = market.collaterals.find(
        (c) => c.token.toLowerCase() === entry.token.toLowerCase(),
      );
      if (!asset || !params) return [];
      const amount = parseAmount(entry.amount, asset.decimals);
      if (amount <= 0) return [];
      const lltv = fromWad(params.lltv);
      const { usdPrice, usdValue } = resolveUsd(asset, amount, null);
      return [
        {
          symbol: asset.symbol.toUpperCase(),
          address: asset.address.toLowerCase(),
          decimals: asset.decimals,
          amount,
          usdPrice,
          usdValue,
          collateralEnabled: true,
          maxLTV: lltv,
          liqThreshold: lltv,
          supplyRate: 0,
          borrowRate: 0,
        },
      ];
    });

    // Debt is the amount owed at maturity, which is what Midnight's health check uses.
    const debtAmount = parseAmount(pos.debt, loanAsset.decimals);
    const { usdPrice: loanUsdPrice, usdValue: debtUsd } = resolveUsd(loanAsset, debtAmount, null);
    const borrowed: AssetPosition[] =
      debtAmount > 0
        ? [
            {
              symbol: loanAsset.symbol.toUpperCase(),
              address: loanAsset.address.toLowerCase(),
              decimals: loanAsset.decimals,
              amount: debtAmount,
              usdPrice: loanUsdPrice,
              usdValue: debtUsd,
              collateralEnabled: false,
              maxLTV: 0,
              liqThreshold: 0,
              supplyRate: 0,
              borrowRate: pos.effective_apr ?? 0,
            },
          ]
        : [];

    const totalSuppliedUsd = supplied.reduce((sum, a) => sum + a.usdValue, 0);
    if (totalSuppliedUsd < MIN_POSITION_USD && debtUsd < MIN_POSITION_USD) return [];

    const accruedInterest = parseAmount(
      BigInt(Math.round(midnightAccruedInterest(pos, nowMs))).toString(),
      loanAsset.decimals,
    );
    const collateralSymbol = supplied.map((a) => a.symbol).join('+') || '?';

    return [
      {
        id: pos.market_id.toLowerCase(),
        marketName: `midnight_${collateralSymbol}_${loanAsset.symbol.toUpperCase()}_${maturityDate(pos.maturity)}`,
        borrowed,
        supplied,
        totalSuppliedUsd,
        totalBorrowedUsd: debtUsd,
        accruedBorrowInterestUsd: debtAmount > 0 ? accruedInterest * loanUsdPrice : undefined,
      },
    ];
  });
}

export async function fetchMidnightLoans(
  wallet: string,
  chainId: number = 1,
): Promise<LoanPosition[]> {
  const positions: RawMidnightPosition[] = [];
  let cursor: string | null = null;
  do {
    const page: MidnightPage<RawMidnightPosition> = await fetchMidnightJson(
      `/users/${wallet.toLowerCase()}/positions`,
      { chain_ids: String(chainId), ...(cursor ? { cursor } : {}) },
    );
    positions.push(...page.data);
    cursor = page.cursor;
  } while (cursor);

  const borrowPositions = positions.filter((pos) => pos.type !== 'lend');
  if (borrowPositions.length === 0) return [];

  const marketIds = Array.from(new Set(borrowPositions.map((pos) => pos.market_id.toLowerCase())));
  const tokenAddresses = Array.from(
    new Set(
      borrowPositions.flatMap((pos) => [
        pos.loan_token.toLowerCase(),
        ...pos.collaterals.map((c) => c.token.toLowerCase()),
      ]),
    ),
  );

  const [marketList, assetList] = await Promise.all([
    Promise.all(
      marketIds.map((id) =>
        fetchMidnightJson<{ data: RawMidnightMarket }>(`/markets/${id}`).then((r) => r.data),
      ),
    ),
    fetchMorphoAssets(tokenAddresses, chainId),
  ]);

  return buildMidnightLoans(
    borrowPositions,
    new Map(marketList.map((m) => [m.market_id.toLowerCase(), m])),
    new Map(assetList.map((a) => [a.address.toLowerCase(), a])),
    Date.now(),
  );
}

export function isMidnightLoan(loan: LoanPosition): boolean {
  return loan.marketName.startsWith('midnight_');
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
