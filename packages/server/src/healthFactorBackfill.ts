import { Contract, JsonRpcProvider } from 'ethers';
import type { RateHistoryDb } from './rateHistoryDb.js';

const MORPHO_API_URL = 'https://api.morpho.org/graphql';
const MORPHO_BLUE_ADDRESS = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
const VIRTUAL_SHARES = 10n ** 6n;
const ORACLE_PRICE_SCALE = 10n ** 36n;
const WAD = 10n ** 18n;
const SECONDS_PER_BLOCK = 12;
const DAY_MS = 24 * 60 * 60 * 1000;

const MORPHO_BLUE_ABI = [
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
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
        }
      }
      pageInfo {
        countTotal
      }
    }
  }
`;

export type WalletMorphoMarket = {
  marketId: string;
  oracle: string;
  lltv: bigint;
  firstBlock: number;
};

type MarketTransactionsResponse = {
  data?: {
    marketTransactions: {
      items: Array<{
        blockNumber: string | number;
        market: { marketId: string; lltv: string; oracle: { address: string } | null };
      }>;
      pageInfo: { countTotal: number };
    };
  };
  errors?: Array<{ message: string }>;
};

/** Every Morpho Blue market the wallet has ever interacted with, including closed positions. */
export async function fetchWalletMorphoMarkets(wallet: string): Promise<WalletMorphoMarket[]> {
  const markets = new Map<string, WalletMorphoMarket>();
  for (let skip = 0; ; skip += 500) {
    const response = await fetch(MORPHO_API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: WALLET_MARKETS_QUERY, variables: { wallet, skip } }),
    });
    if (!response.ok) throw new Error(`Morpho API returned ${response.status}`);
    const body = (await response.json()) as MarketTransactionsResponse;
    if (!body.data) throw new Error(body.errors?.[0]?.message ?? 'Morpho API returned no data');

    const { items, pageInfo } = body.data.marketTransactions;
    for (const item of items) {
      const { marketId, lltv, oracle } = item.market;
      if (!oracle || markets.has(marketId)) continue;
      markets.set(marketId, {
        marketId,
        oracle: oracle.address,
        lltv: BigInt(lltv),
        firstBlock: Number(item.blockNumber),
      });
    }
    if (skip + items.length >= pageInfo.countTotal || items.length === 0) break;
  }
  return Array.from(markets.values());
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

/** Same formula Morpho Blue uses for liquidation: collateral at oracle price × LLTV / debt. */
export function morphoHealthFactor(
  collateral: bigint,
  oraclePrice: bigint,
  lltv: bigint,
  borrowAssets: bigint,
): number {
  const maxBorrow = (((collateral * oraclePrice) / ORACLE_PRICE_SCALE) * lltv) / WAD;
  return Number(maxBorrow) / Number(borrowAssets);
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

export type BackfillResult = { samples: number; markets: number };

/**
 * Writes one health factor sample per day per open Morpho Blue loan, read from archive state.
 * Days where a loan had no debt are skipped. Re-running is safe: samples already in the DB for
 * the same block timestamp are ignored.
 */
export async function backfillMorphoHealthFactor(
  wallet: string,
  provider: JsonRpcProvider,
  db: RateHistoryDb,
  days: number,
  log: (message: string) => void = () => {},
): Promise<BackfillResult> {
  const markets = await fetchWalletMorphoMarkets(wallet);
  log(`Found ${markets.length} Morpho Blue market(s) for ${wallet}`);
  if (markets.length === 0) return { samples: 0, markets: 0 };

  const morpho = new Contract(MORPHO_BLUE_ADDRESS, MORPHO_BLUE_ABI, provider);
  const latest = await provider.getBlock('latest');
  if (!latest) throw new Error('Could not read the latest block');

  let samples = 0;
  for (let day = days; day >= 1; day--) {
    // Post-merge slots are 12s; missed slots make this land slightly later, which is fine
    // because the real block timestamp is what gets stored.
    const blockTag = latest.number - Math.round((day * DAY_MS) / 1000 / SECONDS_PER_BLOCK);
    const active = markets.filter((market) => market.firstBlock <= blockTag);
    if (active.length === 0) continue;

    const block = await withRateLimitRetry(() => provider.getBlock(blockTag));
    if (!block) throw new Error(`Could not read block ${blockTag}`);

    const results: Array<{ marketId: string; healthFactor: number }> = [];
    for (const market of active) {
      const position = await withRateLimitRetry(() =>
        morpho.position!(market.marketId, wallet.toLowerCase(), { blockTag }),
      );
      const borrowShares = position.borrowShares as bigint;
      if (borrowShares === 0n) continue;
      const state = await withRateLimitRetry(() => morpho.market!(market.marketId, { blockTag }));
      const oracle = new Contract(market.oracle, ORACLE_ABI, provider);
      const price = (await withRateLimitRetry(() => oracle.price!({ blockTag }))) as bigint;
      const borrowAssets = morphoBorrowAssets(
        borrowShares,
        state.totalBorrowAssets as bigint,
        state.totalBorrowShares as bigint,
      );
      results.push({
        marketId: market.marketId,
        healthFactor: morphoHealthFactor(
          position.collateral as bigint,
          price,
          market.lltv,
          borrowAssets,
        ),
      });
    }

    for (const result of results) {
      db.appendHealthFactorSample(
        wallet,
        result.marketId,
        block.timestamp * 1000,
        result.healthFactor,
      );
      samples++;
    }
    log(
      `${new Date(block.timestamp * 1000).toISOString().slice(0, 10)} block ${blockTag}: ` +
        results
          .map((result) => `${result.marketId.slice(0, 10)} HF ${result.healthFactor.toFixed(3)}`)
          .join(', '),
    );
  }

  return { samples, markets: markets.length };
}
