import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import {
  computeLoanMetrics,
  computePortfolioSummary,
  type LoanPosition,
  type MorphoVaultPosition,
} from '@aave-monitor/core';
import {
  fetchFromMorphoApi,
  fetchMorphoPositions,
  type RawMorphoMarketPosition,
  type RawMorphoVaultV2Position,
  type RawMorphoVaultPosition,
} from '@aave-monitor/core';

const WALLET = '0x1111111111111111111111111111111111111111';

function makeMorphoApiResponse(
  marketPositions: RawMorphoMarketPosition[],
  vaultPositions: RawMorphoVaultPosition[] = [],
  vaultV2Positions: RawMorphoVaultV2Position[] = [],
) {
  return {
    data: {
      userByAddress: {
        address: WALLET,
        marketPositions,
        vaultV2Positions,
        vaultPositions,
      },
    },
  };
}

function samplePosition(overrides?: Partial<RawMorphoMarketPosition>): RawMorphoMarketPosition {
  return {
    market: {
      uniqueKey: '0xabc123',
      loanAsset: {
        symbol: 'USDC',
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        decimals: 6,
        priceUsd: 1.0,
      },
      collateralAsset: {
        symbol: 'WETH',
        address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        decimals: 18,
        priceUsd: 3000.0,
      },
      oracleAddress: '0x0000000000000000000000000000000000000001',
      irmAddress: '0x0000000000000000000000000000000000000002',
      // 86% LLTV in WAD format
      lltv: '860000000000000000',
      state: {
        utilization: 0.75,
        borrowApy: 0.045,
        supplyApy: 0.032,
        avgBorrowApy: 0.0505,
        avgSupplyApy: 0.0305,
      },
    },
    borrowAssets: '500000000', // 500 USDC (6 decimals)
    borrowAssetsUsd: 500,
    borrowPnlUsd: 12.34,
    supplyAssets: '0',
    supplyAssetsUsd: 0,
    collateral: '1000000000000000000', // 1 WETH (18 decimals)
    ...overrides,
  };
}

function sampleVaultV2Position(
  overrides?: Partial<RawMorphoVaultV2Position>,
): RawMorphoVaultV2Position {
  return {
    vault: {
      address: '0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB',
      name: 'Steakhouse Reservoir USDC',
      symbol: 'steakUSDC',
      asset: {
        symbol: 'USDC',
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        decimals: 6,
        priceUsd: 1,
      },
      avgApy: 0.038,
      avgNetApy: 0.036,
    },
    assets: '2500000000',
    assetsUsd: 2500,
    shares: '2500000000',
    ...overrides,
  };
}

function sampleVaultPosition(overrides?: Partial<RawMorphoVaultPosition>): RawMorphoVaultPosition {
  const v2 = sampleVaultV2Position();
  return {
    vault: {
      ...v2.vault,
      avgApy: undefined,
      avgNetApy: undefined,
      state: {
        apy: 0.038,
        netApy: 0.036,
      },
    },
    state: {
      assets: v2.assets,
      assetsUsd: v2.assetsUsd,
      shares: v2.shares,
    },
    ...overrides,
  };
}

describe('fetchFromMorphoApi', () => {
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('parses a position into a LoanPosition', async () => {
    const mockResponse = makeMorphoApiResponse([samplePosition()]);
    let callCount = 0;
    const queries: string[] = [];
    globalThis.fetch = async (_url, init) => {
      callCount += 1;
      queries.push(String(JSON.parse(String(init?.body)).query));
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const loans = await fetchFromMorphoApi(WALLET);

    assert.equal(loans.length, 1);
    const loan = loans[0];
    assert.equal(loan.id, '0xabc123');
    assert.equal(loan.marketName, 'morpho_WETH_USDC');
    assert.equal(loan.supplied.length, 1);
    assert.equal(loan.borrowed.length, 1);

    // Collateral
    const collateral = loan.supplied[0];
    assert.equal(collateral.symbol, 'WETH');
    assert.equal(collateral.amount, 1.0);
    assert.equal(collateral.usdPrice, 3000.0);
    assert.equal(collateral.usdValue, 3000.0);
    assert.equal(collateral.collateralEnabled, true);

    // LLTV conversion: 860000000000000000 / 1e18 = 0.86
    assert.ok(Math.abs(collateral.maxLTV - 0.86) < 1e-10);
    assert.ok(Math.abs(collateral.liqThreshold - 0.86) < 1e-10);
    assert.equal(collateral.supplyRate, 0);

    // Borrow
    const borrow = loan.borrowed[0];
    assert.equal(borrow.symbol, 'USDC');
    assert.equal(borrow.amount, 500);
    assert.equal(borrow.usdPrice, 1.0);
    assert.equal(borrow.usdValue, 500);
    assert.equal(borrow.borrowRate, 0.0505);

    // MorphoMarketParams
    assert.ok(loan.morphoMarketParams);
    assert.equal(loan.morphoMarketParams.loanToken, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    assert.equal(
      loan.morphoMarketParams.collateralToken,
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    );
    assert.equal(loan.morphoMarketParams.oracle, '0x0000000000000000000000000000000000000001');
    assert.equal(loan.morphoMarketParams.irm, '0x0000000000000000000000000000000000000002');
    assert.equal(loan.morphoMarketParams.lltv, '860000000000000000');
    assert.equal(loan.marketSupplyApy, 0.0305);
    assert.equal(loan.accruedBorrowInterestUsd, 12.34);
    assert.equal(callCount, 1);
    assert.ok(queries.length >= 1);
    assert.match(queries[0]!, /\bborrowPnl\b/);
    assert.match(queries[0]!, /\bborrowPnlUsd\b/);
  });

  it('filters out dust positions', async () => {
    const dustPosition = samplePosition({
      borrowAssets: '1', // 0.000001 USDC
      collateral: '1', // ~0 WETH
    });
    const mockResponse = makeMorphoApiResponse([dustPosition]);
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const loans = await fetchFromMorphoApi(WALLET);
    assert.equal(loans.length, 0);
  });

  it('returns empty array when user has no positions', async () => {
    const mockResponse = makeMorphoApiResponse([]);
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const loans = await fetchFromMorphoApi(WALLET);
    assert.equal(loans.length, 0);
  });

  it('returns empty array when user not found', async () => {
    const mockResponse = { data: { userByAddress: null } };
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const loans = await fetchFromMorphoApi(WALLET);
    assert.equal(loans.length, 0);
  });

  it('falls back to position-level USD for borrowed assets when priceUsd is null', async () => {
    const pos = samplePosition();
    pos.market.loanAsset.priceUsd = null;
    // borrowAssetsUsd is the position-level fallback
    pos.borrowAssetsUsd = 500;
    const mockResponse = makeMorphoApiResponse([pos]);
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const loans = await fetchFromMorphoApi(WALLET);
    assert.equal(loans.length, 1);
    const loan = loans[0];

    // Borrow: usdValue from borrowAssetsUsd, price back-calculated
    assert.equal(loan.borrowed[0].usdValue, 500);
    assert.equal(loan.borrowed[0].usdPrice, 1); // 500 / 500

    // Collateral: USD value comes from the collateral asset price, not supplyAssetsUsd.
    assert.equal(loan.supplied[0].usdValue, 3000);
    assert.equal(loan.supplied[0].usdPrice, 3000);
  });

  it('parses Morpho replacement fields without deprecated market and asset fields', async () => {
    const pos = samplePosition();
    const replacementPosition: RawMorphoMarketPosition = {
      market: {
        marketId: pos.market.uniqueKey,
        loanAsset: {
          symbol: pos.market.loanAsset.symbol,
          address: pos.market.loanAsset.address,
          decimals: pos.market.loanAsset.decimals,
          price: { usd: pos.market.loanAsset.priceUsd ?? null },
        },
        collateralAsset: {
          symbol: pos.market.collateralAsset!.symbol,
          address: pos.market.collateralAsset!.address,
          decimals: pos.market.collateralAsset!.decimals,
          price: { usd: pos.market.collateralAsset!.priceUsd ?? null },
        },
        oracle: { address: pos.market.oracleAddress! },
        irmAddress: pos.market.irmAddress,
        lltv: pos.market.lltv,
        state: pos.market.state,
      },
      state: {
        borrowAssets: pos.borrowAssets!,
        borrowAssetsUsd: pos.borrowAssetsUsd!,
        borrowPnlUsd: pos.borrowPnlUsd!,
        supplyAssets: pos.supplyAssets!,
        supplyAssetsUsd: pos.supplyAssetsUsd!,
        collateral: pos.collateral!,
      },
    };
    const mockResponse = makeMorphoApiResponse([replacementPosition]);
    const queries: string[] = [];
    globalThis.fetch = async (_url, init) => {
      queries.push(String(JSON.parse(String(init?.body)).query));
      return new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const loans = await fetchFromMorphoApi(WALLET);

    assert.equal(loans.length, 1);
    assert.equal(loans[0].id, '0xabc123');
    assert.equal(loans[0].morphoMarketParams?.oracle, '0x0000000000000000000000000000000000000001');
    assert.equal(loans[0].borrowed[0].usdValue, 500);
    assert.equal(loans[0].supplied[0].usdValue, 3000);
    assert.equal(loans[0].accruedBorrowInterestUsd, 12.34);
    assert.ok(queries.length >= 1);
    assert.doesNotMatch(queries[0]!, /\buniqueKey\b/);
    assert.doesNotMatch(queries[0]!, /\boracleAddress\b/);
    assert.doesNotMatch(queries[0]!, /\bpriceUsd\b/);
    assert.match(queries[0]!, /\bborrowPnl\b/);
    assert.match(queries[0]!, /\bborrowPnlUsd\b/);
  });

  it('throws on API error', async () => {
    globalThis.fetch = async () => new Response('', { status: 500 });

    await assert.rejects(() => fetchFromMorphoApi(WALLET), {
      message: 'Morpho API returned 500',
    });
  });

  it('falls back to spot APYs when historical rate lookup fails', async () => {
    const mockResponse = makeMorphoApiResponse([
      samplePosition({
        market: {
          ...samplePosition().market,
          state: {
            ...samplePosition().market.state,
            avgBorrowApy: null,
            avgSupplyApy: null,
          },
        },
      }),
    ]);
    let callCount = 0;
    globalThis.fetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      return new Response('', { status: 500 });
    };

    const loans = await fetchFromMorphoApi(WALLET);

    assert.equal(loans.length, 1);
    assert.equal(loans[0]?.borrowed[0]?.borrowRate, 0.045);
    assert.equal(loans[0]?.marketSupplyApy, 0.032);
  });

  it('throws on GraphQL error', async () => {
    const mockResponse = { errors: [{ message: 'query too complex' }] };
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    await assert.rejects(() => fetchFromMorphoApi(WALLET), {
      message: 'Morpho API error: query too complex',
    });
  });

  it('returns Morpho vault positions separately from market loans', async () => {
    const mockResponse = makeMorphoApiResponse([samplePosition()], [], [sampleVaultV2Position()]);
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const positions = await fetchMorphoPositions(WALLET);

    assert.equal(positions.marketLoans.length, 1);
    assert.equal(positions.vaultPositions.length, 1);
    const vault = positions.vaultPositions[0];
    assert.equal(vault.kind, 'morpho-vault');
    assert.equal(vault.vaultName, 'Steakhouse Reservoir USDC');
    assert.equal(vault.asset.symbol, 'USDC');
    assert.equal(vault.totalAssets, 2500);
    assert.equal(vault.totalAssetsUsd, 2500);
    assert.equal(vault.netApy, 0.036);
    assert.equal(vault.shares, 2500);
  });

  it('backfills vault USD price when asset price is null', async () => {
    const vaultPosition = sampleVaultPosition({
      vault: {
        ...sampleVaultPosition().vault,
        asset: {
          ...sampleVaultPosition().vault.asset,
          priceUsd: null,
        },
      },
    });
    const mockResponse = makeMorphoApiResponse([], [vaultPosition]);
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const positions = await fetchMorphoPositions(WALLET);
    assert.equal(positions.vaultPositions.length, 1);
    assert.equal(positions.vaultPositions[0].asset.usdPrice, 1);
    assert.equal(positions.vaultPositions[0].asset.usdValue, 2500);
  });

  it('filters out dust vault positions', async () => {
    const mockResponse = makeMorphoApiResponse(
      [],
      [
        sampleVaultPosition({
          state: {
            assets: '1',
            assetsUsd: 0.000001,
            shares: '1',
          },
        }),
      ],
    );
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const positions = await fetchMorphoPositions(WALLET);
    assert.equal(positions.vaultPositions.length, 0);
  });

  it('parses legacy vault position amounts from state', async () => {
    const mockResponse = makeMorphoApiResponse([], [sampleVaultPosition()]);
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const positions = await fetchMorphoPositions(WALLET);
    assert.equal(positions.vaultPositions.length, 1);
    assert.equal(positions.vaultPositions[0].vaultName, 'Steakhouse Reservoir USDC');
    assert.equal(positions.vaultPositions[0].totalAssets, 2500);
    assert.equal(positions.vaultPositions[0].netApy, 0.036);
  });

  it('deduplicates the same vault returned by V2 and legacy APIs', async () => {
    const mockResponse = makeMorphoApiResponse(
      [],
      [sampleVaultPosition()],
      [sampleVaultV2Position()],
    );
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const positions = await fetchMorphoPositions(WALLET);
    assert.equal(positions.vaultPositions.length, 1);
    assert.equal(
      positions.vaultPositions[0].vaultAddress,
      '0xbeef01735c132ada46aa9aa4c54623caa92a64cb',
    );
  });
});

describe('Morpho LoanPosition works with computeLoanMetrics', () => {
  it('computes correct health factor for a Morpho loan', () => {
    const loan: LoanPosition = {
      id: '0xabc123',
      marketName: 'morpho_WETH_USDC',
      borrowed: [
        {
          symbol: 'USDC',
          address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          decimals: 6,
          amount: 500,
          usdPrice: 1.0,
          usdValue: 500,
          collateralEnabled: false,
          maxLTV: 0,
          liqThreshold: 0,
          supplyRate: 0,
          borrowRate: 0.045,
        },
      ],
      supplied: [
        {
          symbol: 'WETH',
          address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
          decimals: 18,
          amount: 1.0,
          usdPrice: 3000.0,
          usdValue: 3000.0,
          collateralEnabled: true,
          maxLTV: 0.86,
          liqThreshold: 0.86,
          supplyRate: 0,
          borrowRate: 0,
        },
      ],
      totalSuppliedUsd: 3000,
      totalBorrowedUsd: 500,
    };

    const metrics = computeLoanMetrics(loan);

    // HF = (3000 * 0.86) / 500 = 5.16
    assert.ok(Math.abs(metrics.healthFactor - 5.16) < 0.01);
    // LTV = 500 / 3000 = 0.1667
    assert.ok(Math.abs(metrics.ltv - 500 / 3000) < 0.001);
    assert.equal(metrics.primaryCollateralSymbol, 'WETH');
    assert.equal(metrics.supplyEarnUSD, 0);
    assert.equal(metrics.borrowCostUSD, 22.5);
    assert.equal(metrics.netEarnUSD, -22.5);
    assert.ok(Math.abs(metrics.netAPYOnEquity - -22.5 / 2500) < 0.0001);
  });
});

describe('computePortfolioSummary with Morpho vaults', () => {
  it('includes vault deposits in asset and carry totals but not loan risk metrics', () => {
    const loan: LoanPosition = {
      id: '0xabc123',
      marketName: 'morpho_WETH_USDC',
      borrowed: [
        {
          symbol: 'USDC',
          address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          decimals: 6,
          amount: 500,
          usdPrice: 1,
          usdValue: 500,
          collateralEnabled: false,
          maxLTV: 0,
          liqThreshold: 0,
          supplyRate: 0,
          borrowRate: 0.045,
        },
      ],
      supplied: [
        {
          symbol: 'WETH',
          address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          decimals: 18,
          amount: 1,
          usdPrice: 3000,
          usdValue: 3000,
          collateralEnabled: true,
          maxLTV: 0.86,
          liqThreshold: 0.86,
          supplyRate: 0,
          borrowRate: 0,
        },
      ],
      totalSuppliedUsd: 3000,
      totalBorrowedUsd: 500,
    };

    const vault: MorphoVaultPosition = {
      id: '0xbeef01735c132ada46aa9aa4c54623caa92a64cb',
      kind: 'morpho-vault',
      protocol: 'morpho',
      vaultAddress: '0xbeef01735c132ada46aa9aa4c54623caa92a64cb',
      vaultName: 'Steakhouse Reservoir USDC',
      vaultSymbol: 'steakUSDC',
      asset: {
        symbol: 'USDC',
        address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        decimals: 6,
        amount: 2500,
        usdPrice: 1,
        usdValue: 2500,
        collateralEnabled: false,
        maxLTV: 0,
        liqThreshold: 0,
        supplyRate: 0.036,
        borrowRate: 0,
      },
      shares: 2500,
      totalAssets: 2500,
      totalAssetsUsd: 2500,
      apy: 0.038,
      netApy: 0.036,
    };

    const summary = computePortfolioSummary(
      [loan],
      [vault],
      new Map([['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 250]]),
    );

    assert.ok(summary);
    assert.equal(summary.loanCount, 1);
    assert.equal(summary.vaultCount, 1);
    assert.equal(summary.totalRiskCollateral, 3000);
    assert.equal(summary.totalVaultAssets, 2500);
    assert.equal(summary.totalAssets, 5500);
    assert.equal(summary.totalDebt, 500);
    assert.equal(summary.totalNetWorth, 5000);
    assert.ok(Math.abs(summary.averageHealthFactor - 5.16) < 0.01);
    assert.ok(Math.abs(summary.borrowPowerUsed - 500 / (3000 * 0.86)) < 0.0001);
    assert.equal(summary.repayCoverage, 0.5);
    const expectedSupplyEarn = 2500 * 0.036;
    assert.ok(Math.abs(summary.totalSupplyEarn - expectedSupplyEarn) < 0.0001);
    assert.ok(Math.abs(summary.totalBorrowCost - 22.5) < 0.0001);
    assert.ok(Math.abs(summary.totalNetEarn - (expectedSupplyEarn - 22.5)) < 0.0001);
    assert.ok(Math.abs(summary.totalLoanNetEarn - -22.5) < 0.0001);
    assert.ok(
      Math.abs(summary.totalLoanNetEarnAfterVaults - (-22.5 + expectedSupplyEarn)) < 0.0001,
    );
  });

  it('supports vault-only portfolios', () => {
    const vault: MorphoVaultPosition = {
      id: '0xbeef01735c132ada46aa9aa4c54623caa92a64cb',
      kind: 'morpho-vault',
      protocol: 'morpho',
      vaultAddress: '0xbeef01735c132ada46aa9aa4c54623caa92a64cb',
      vaultName: 'Steakhouse Reservoir USDC',
      vaultSymbol: 'steakUSDC',
      asset: {
        symbol: 'USDC',
        address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        decimals: 6,
        amount: 2500,
        usdPrice: 1,
        usdValue: 2500,
        collateralEnabled: false,
        maxLTV: 0,
        liqThreshold: 0,
        supplyRate: 0.036,
        borrowRate: 0,
      },
      shares: 2500,
      totalAssets: 2500,
      totalAssetsUsd: 2500,
      apy: 0.038,
      netApy: 0.036,
    };

    const summary = computePortfolioSummary([], [vault], new Map());

    assert.ok(summary);
    assert.equal(summary.totalAssets, 2500);
    assert.equal(summary.totalNetWorth, 2500);
    assert.equal(summary.totalDebt, 0);
    assert.equal(summary.totalVaultAssets, 2500);
    assert.equal(summary.averageHealthFactor, Infinity);
    assert.equal(summary.borrowPowerUsed, 0);
  });
});
