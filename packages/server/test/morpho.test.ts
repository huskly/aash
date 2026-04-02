import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import { computeLoanMetrics, DEFAULT_R_DEPLOY, type LoanPosition } from '@aave-monitor/core';
import { fetchFromMorphoApi, type RawMorphoMarketPosition } from '@aave-monitor/core';

const WALLET = '0x1111111111111111111111111111111111111111';

function makeMorphoApiResponse(positions: RawMorphoMarketPosition[]) {
  return {
    data: {
      userByAddress: {
        address: WALLET,
        marketPositions: positions,
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
      },
    },
    borrowAssets: '500000000', // 500 USDC (6 decimals)
    borrowAssetsUsd: 500,
    supplyAssets: '0',
    supplyAssetsUsd: 0,
    collateral: '1000000000000000000', // 1 WETH (18 decimals)
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
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

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
    assert.equal(collateral.supplyRate, 0.032);

    // Borrow
    const borrow = loan.borrowed[0];
    assert.equal(borrow.symbol, 'USDC');
    assert.equal(borrow.amount, 500);
    assert.equal(borrow.usdPrice, 1.0);
    assert.equal(borrow.usdValue, 500);
    assert.equal(borrow.borrowRate, 0.045);

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

  it('falls back to position-level USD when priceUsd is null', async () => {
    const pos = samplePosition();
    pos.market.loanAsset.priceUsd = null;
    pos.market.collateralAsset!.priceUsd = null;
    // borrowAssetsUsd is the position-level fallback
    pos.borrowAssetsUsd = 500;
    pos.supplyAssetsUsd = 3000;
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

    // Collateral: usdValue from supplyAssetsUsd fallback, price back-calculated
    assert.equal(loan.supplied[0].usdValue, 3000);
    assert.equal(loan.supplied[0].usdPrice, 3000); // 3000 / 1
  });

  it('throws on API error', async () => {
    globalThis.fetch = async () => new Response('', { status: 500 });

    await assert.rejects(() => fetchFromMorphoApi(WALLET), {
      message: 'Morpho API returned 500',
    });
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
          supplyRate: 0.032,
          borrowRate: 0,
        },
      ],
      totalSuppliedUsd: 3000,
      totalBorrowedUsd: 500,
    };

    const metrics = computeLoanMetrics(loan, DEFAULT_R_DEPLOY);

    // HF = (3000 * 0.86) / 500 = 5.16
    assert.ok(Math.abs(metrics.healthFactor - 5.16) < 0.01);
    // LTV = 500 / 3000 = 0.1667
    assert.ok(Math.abs(metrics.ltv - 500 / 3000) < 0.001);
    assert.equal(metrics.primaryCollateralSymbol, 'WETH');
  });
});
