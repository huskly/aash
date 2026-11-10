import { Contract, JsonRpcProvider } from 'ethers';
import type { RateHistoryDb } from './rateHistoryDb.js';

const MORPHO_API_URL = 'https://api.morpho.org/graphql';
const MIDNIGHT_API_URL = 'https://api.morpho.org/v0/midnight';
const MORPHO_BLUE_ADDRESS = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const MIDNIGHT_ADDRESS = '0x471686c42792f93528b000bef54bc10e3aa2045f';
const VIRTUAL_SHARES = 10n ** 6n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
const WAD = 10n ** 18n;
const SECONDS_PER_BLOCK = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

const MORPHO_BLUE_ABI = [
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
];
const MIDNIGHT_ABI = [
  'function debt(bytes32 id, address user) view returns (uint128)',
  'function collateralBitmap(bytes32 id, address user) view returns (uint128)',
  'function collateral(bytes32 id, address user, uint256 index) view returns (uint128)',
];
const ORACLE_ABI = ['function price() view returns (uint256)'];

const WALLET_MARKETS_QUERY = `
  query WalletMarketTransactions($wallet: String!, $skip: Int!) {
    marketTransactions(
      first: 500
      skip: $skip
      where: { userAddress_in: [$wallet], chainId_in: [1] }
      orderBy: Timestamp
      orderDirection: Asc
    ) {
      items {
        blockNumber
        market {
          marketId
          lltv
          oracle {
            address
          }
          loanAsset {
            decimals
            price {
              usd
            }
          }
        }
      }
      pageInfo {
        countTotal
      }
    }
  }
`;

const ASSETS_QUERY = `
  query Assets($addresses: [String!]) {
    assets(where: { address_in: $addresses, chainId_in: [1] }) {
      items {
        address
        decimals
        price {
          usd
        }
      }
    }
  }
`;

type LoanAsset = { decimals: number; priceUsd: number };

/** One loan market the wallet has used, with a reader for its archive state at a block. */
export type BackfillMarket = {
  marketId: string;
  firstBlock: number;
  loanAsset: LoanAsset;
  /** Borrow capacity and debt in loan-token base units, or null when the wallet had no debt. */
  read: (blockTag: number) => Promise<{ maxBorrow: bigint; debt: bigint } | null>;
};

type MarketTransactionsResponse = {
  data?: {
    marketTransactions: {
      items: Array<{
        blockNumber: string | number;
        market: {
          marketId: string;
          lltv: string;
          oracle: { address: string } | null;
          loanAsset: { decimals: number; price: { usd: number } | null };
        };
      }>;
      pageInfo: { countTotal: number };
    };
  };
  errors?: Array<{ message: string }>;
};

async function postGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await fetch(MORPHO_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Morpho API returned ${response.status}`);
  return (await response.json()) as T;
}

async function fetchMidnightJson<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(`${MIDNIGHT_API_URL}${path}${query ? `?${query}` : ''}`);
  if (!response.ok) throw new Error(`Morpho Midnight API returned ${response.status}`);
  return (await response.json()) as T;
}

/** Morpho Blue `toAssetsUp` with virtual shares, as used for the borrow side. */
export function morphoBorrowAssets(
  borrowShares: bigint,
  totalBorrowAssets: bigint,
  totalBorrowShares: bigint,
): bigint {
  const numerator = borrowShares * (totalBorrowAssets + 1n);
  const denominator = totalBorrowShares + VIRTUAL_SHARES;
  return (numerator + denominator - 1n) / denominator;
}

/** Collateral valued at the oracle price (1e36-scaled, loan units per collateral unit) × LLTV. */
export function maxBorrowAssets(collateral: bigint, oraclePrice: bigint, lltv: bigint): bigint {
  return (((collateral * oraclePrice) / ORACLE_PRICE_SCALE) * lltv) / WAD;
}

function isRateLimited(error: unknown): boolean {
  return (error as { info?: { error?: { code?: number } } }).info?.error?.code === 429;
}

/** Free-tier archive RPCs throttle by compute units per second; back off and retry. */
async function withRateLimitRetry<T>(call: () => Promise<T>, attempts = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (!isRateLimited(error) || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

/** Every Morpho Blue market the wallet has ever interacted with, including closed positions. */
async function fetchBlueMarkets(
  wallet: string,
  provider: JsonRpcProvider,
): Promise<BackfillMarket[]> {
  const morpho = new Contract(MORPHO_BLUE_ADDRESS, MORPHO_BLUE_ABI, provider);
  const markets = new Map<string, BackfillMarket>();
  for (let skip = 0; ; skip += 500) {
    const body = await postGraphql<MarketTransactionsResponse>(WALLET_MARKETS_QUERY, {
      wallet,
      skip,
    });
    if (!body.data) throw new Error(body.errors?.[0]?.message ?? 'Morpho API returned no data');

    const { items, pageInfo } = body.data.marketTransactions;
    for (const item of items) {
      const { marketId, lltv, oracle, loanAsset } = item.market;
      if (!oracle || markets.has(marketId)) continue;
      const oracleContract = new Contract(oracle.address, ORACLE_ABI, provider);
      markets.set(marketId, {
        marketId,
        firstBlock: Number(item.blockNumber),
        loanAsset: { decimals: loanAsset.decimals, priceUsd: loanAsset.price?.usd ?? 0 },
        read: async (blockTag) => {
          const position = await withRateLimitRetry(() =>
            morpho.position!(marketId, wallet, { blockTag }),
          );
          const borrowShares = position.borrowShares as bigint;
          if (borrowShares === 0n) return null;
          const state = await withRateLimitRetry(() => morpho.market!(marketId, { blockTag }));
          const price = (await withRateLimitRetry(() =>
            oracleContract.price!({ blockTag }),
          )) as bigint;
          return {
            maxBorrow: maxBorrowAssets(position.collateral as bigint, price, BigInt(lltv)),
            debt: morphoBorrowAssets(
              borrowShares,
              state.totalBorrowAssets as bigint,
              state.totalBorrowShares as bigint,
            ),
          };
        },
      });
    }
    if (skip + items.length >= pageInfo.countTotal || items.length === 0) break;
  }
  return Array.from(markets.values());
}

type MidnightTransaction = { id: string; market_id: string };
type MidnightMarket = {
  loan_token: string;
  collaterals: Array<{ token: string; lltv: string; oracle: string }>;
};

/**
 * Every Midnight market the wallet has ever interacted with, including closed positions.
 * Debt is the amount owed at maturity and collateral indexes follow the market's collateral
 * list, matching Midnight's own health check.
 */
async function fetchMidnightMarkets(
  wallet: string,
  provider: JsonRpcProvider,
): Promise<BackfillMarket[]> {
  const firstBlocks = new Map<string, number>();
  let cursor: string | null = null;
  do {
    const page: { cursor: string | null; data: MidnightTransaction[] } = await fetchMidnightJson(
      `/users/${wallet}/transactions`,
      { chain_ids: '1', ...(cursor ? { cursor } : {}) },
    );
    for (const tx of page.data) {
      // Transaction ids start with the zero-padded block number, e.g. `0026331605-...`.
      const block = Number(tx.id.split('-')[0]);
      const marketId = tx.market_id.toLowerCase();
      firstBlocks.set(marketId, Math.min(block, firstBlocks.get(marketId) ?? Infinity));
    }
    cursor = page.cursor;
  } while (cursor);
  if (firstBlocks.size === 0) return [];

  const marketList = await Promise.all(
    Array.from(firstBlocks.keys()).map((marketId) =>
      fetchMidnightJson<{ data: MidnightMarket }>(`/markets/${marketId}`).then((r) => r.data),
    ),
  );
  const loanTokens = Array.from(new Set(marketList.map((m) => m.loan_token.toLowerCase())));
  const assetsBody = await postGraphql<{
    data?: {
      assets: {
        items: Array<{ address: string; decimals: number; price: { usd: number } | null }>;
      };
    };
  }>(ASSETS_QUERY, { addresses: loanTokens });
  const loanAssets = new Map(
    (assetsBody.data?.assets.items ?? []).map((asset) => [
      asset.address.toLowerCase(),
      { decimals: asset.decimals, priceUsd: asset.price?.usd ?? 0 },
    ]),
  );

  const midnight = new Contract(MIDNIGHT_ADDRESS, MIDNIGHT_ABI, provider);
  return Array.from(firstBlocks.entries()).flatMap(([marketId, firstBlock], index) => {
    const market = marketList[index]!;
    const loanAsset = loanAssets.get(market.loan_token.toLowerCase());
    if (!loanAsset) return [];
    const collaterals = market.collaterals.map((params) => ({
      lltv: BigInt(params.lltv),
      oracle: new Contract(params.oracle, ORACLE_ABI, provider),
    }));
    return [
      {
        marketId,
        firstBlock,
        loanAsset,
        read: async (blockTag: number) => {
          const debt = (await withRateLimitRetry(() =>
            midnight.debt!(marketId, wallet, { blockTag }),
          )) as bigint;
          if (debt === 0n) return null;
          const bitmap = (await withRateLimitRetry(() =>
            midnight.collateralBitmap!(marketId, wallet, { blockTag }),
          )) as bigint;
          let maxBorrow = 0n;
          for (const [i, params] of collaterals.entries()) {
            if (((bitmap >> BigInt(i)) & 1n) === 0n) continue;
            const amount = (await withRateLimitRetry(() =>
              midnight.collateral!(marketId, wallet, i, { blockTag }),
            )) as bigint;
            const price = (await withRateLimitRetry(() =>
              params.oracle.price!({ blockTag }),
            )) as bigint;
            maxBorrow += maxBorrowAssets(amount, price, params.lltv);
          }
          return { maxBorrow, debt };
        },
      },
    ];
  });
}

export type BackfillResult = { samples: number; markets: number };

/**
 * Writes one health factor sample per day per Morpho Blue and Midnight loan, read from archive
 * state. Days where a loan had no debt are skipped. Debt USD uses today's loan-asset price, which
 * is only used to weight the portfolio average. Re-running overwrites earlier samples because
 * sample blocks are fixed multiples of one day of blocks.
 */
export async function backfillMorphoHealthFactor(
  wallet: string,
  provider: JsonRpcProvider,
  db: RateHistoryDb,
  days: number,
  log: (message: string) => void = () => {},
): Promise<BackfillResult> {
  const user = wallet.toLowerCase();
  const markets = [
    ...(await fetchBlueMarkets(user, provider)),
    ...(await fetchMidnightMarkets(user, provider)),
  ];
  log(`Found ${markets.length} Morpho Blue / Midnight market(s) for ${wallet}`);
  if (markets.length === 0) return { samples: 0, markets: 0 };

  const latest = await provider.getBlock('latest');
  if (!latest) throw new Error('Could not read the latest block');

  // Sample blocks are multiples of ~one day of blocks, so re-runs read the same blocks and
  // overwrite their earlier samples instead of adding new ones.
  const blocksPerDay = DAY_MS / 1000 / SECONDS_PER_BLOCK;
  const anchorBlock = Math.floor(latest.number / blocksPerDay) * blocksPerDay;
  let samples = 0;
  for (let day = days - 1; day >= 0; day--) {
    const blockTag = anchorBlock - day * blocksPerDay;
    const active = markets.filter((market) => market.firstBlock <= blockTag);
    if (active.length === 0) continue;

    const block = await withRateLimitRetry(() => provider.getBlock(blockTag));
    if (!block) throw new Error(`Could not read block ${blockTag}`);

    const lines: string[] = [];
    for (const market of active) {
      const state = await market.read(blockTag);
      if (!state) continue;
      const healthFactor = Number(state.maxBorrow) / Number(state.debt);
      const debtUsd =
        (Number(state.debt) / 10 ** market.loanAsset.decimals) * market.loanAsset.priceUsd;
      db.appendHealthFactorSample(
        wallet,
        market.marketId,
        block.timestamp * 1000,
        healthFactor,
        debtUsd,
      );
      samples++;
      lines.push(`${market.marketId.slice(0, 10)} HF ${healthFactor.toFixed(3)}`);
    }
    log(
      `${new Date(block.timestamp * 1000).toISOString().slice(0, 10)} block ${blockTag}: ${lines.join(', ')}`,
    );
  }

  return { samples, markets: markets.length };
}
