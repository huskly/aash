import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import {
  buildMidnightLoans,
  computeLoanMetrics,
  fetchMidnightLoans,
  isMidnightLoan,
  midnightAccruedInterest,
  type RawMidnightMarket,
  type RawMidnightPosition,
} from '@aave-monitor/core';

const WALLET = '0x1111111111111111111111111111111111111111';
const MARKET_ID = '0xcf447db8cff164867b02edbf7ee7af06d241d4f3a44b34d6e3a3ea872ddea5d6';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const CBBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
const CREATED_AT = 1_793_676_791;
const DAY = 24 * 60 * 60;
const MATURITY = CREATED_AT + 50 * DAY;

function samplePosition(overrides?: Partial<RawMidnightPosition>): RawMidnightPosition {
  return {
    chain_id: 1,
    market_id: MARKET_ID,
    created_at: CREATED_AT,
    loan_token: USDC,
    maturity: MATURITY,
    type: 'borrow',
    // Owes 101,000 USDC at maturity for 100,000 USDC received.
    debt: '101000000000',
    cost_basis: '100000000000000000000000000000',
    effective_apr: 0.073,
    collaterals: [{ token: CBBTC, amount: '300000000' }],
    ...overrides,
  };
}

const sampleMarket: RawMidnightMarket = {
  market_id: MARKET_ID,
  collaterals: [
    { token: USDC, lltv: '980000000000000000', oracle: '0x01' },
    { token: CBBTC, lltv: '860000000000000000', oracle: '0x02' },
  ],
};

const assets = new Map([
  [USDC.toLowerCase(), { symbol: 'USDC', address: USDC, decimals: 6, price: { usd: 1 } }],
  [CBBTC.toLowerCase(), { symbol: 'cbBTC', address: CBBTC, decimals: 8, price: { usd: 80000 } }],
]);
const markets = new Map([[MARKET_ID, sampleMarket]]);

describe('midnightAccruedInterest', () => {
  it('spreads interest in equal daily amounts until maturity', () => {
    const pos = samplePosition();
    assert.equal(midnightAccruedInterest(pos, CREATED_AT * 1000), 0);
    assert.equal(midnightAccruedInterest(pos, (CREATED_AT + DAY) * 1000), 20_000_000);
    assert.equal(midnightAccruedInterest(pos, (CREATED_AT + 25 * DAY) * 1000), 500_000_000);
    assert.equal(midnightAccruedInterest(pos, (MATURITY + 10 * DAY) * 1000), 1_000_000_000);
  });
});

describe('buildMidnightLoans', () => {
  it('builds a fixed-rate loan owing the maturity amount', () => {
    const [loan] = buildMidnightLoans(
      [samplePosition()],
      markets,
      assets,
      (CREATED_AT + 10 * DAY) * 1000,
    );

    assert.ok(loan);
    assert.equal(loan.id, MARKET_ID);
    assert.equal(loan.marketName, 'midnight_CBBTC_USDC_2026-12-23');
    assert.ok(isMidnightLoan(loan));
    assert.equal(loan.morphoMarketParams, undefined);
    assert.equal(loan.totalBorrowedUsd, 101_000);
    assert.equal(loan.totalSuppliedUsd, 240_000);
    assert.equal(loan.borrowed[0]?.borrowRate, 0.073);
    assert.equal(loan.supplied[0]?.liqThreshold, 0.86);
    assert.equal(loan.supplied[0]?.supplyRate, 0);
    assert.equal(loan.accruedBorrowInterestUsd, 200);

    const metrics = computeLoanMetrics(loan);
    assert.ok(Math.abs(metrics.healthFactor - (240_000 * 0.86) / 101_000) < 1e-9);
  });

  it('skips lend positions and keeps collateral-only positions', () => {
    const loans = buildMidnightLoans(
      [
        samplePosition({ type: 'lend', debt: '0', collaterals: [] }),
        samplePosition({ type: 'collateral_only', debt: '0', cost_basis: null }),
      ],
      markets,
      assets,
      CREATED_AT * 1000,
    );

    assert.equal(loans.length, 1);
    assert.equal(loans[0]?.borrowed.length, 0);
    assert.equal(loans[0]?.accruedBorrowInterestUsd, undefined);
  });
});

describe('fetchMidnightLoans', () => {
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('loads positions, market params and asset prices from the Morpho APIs', async () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const urls: string[] = [];
    globalThis.fetch = async (url) => {
      const href = String(url);
      urls.push(href);
      if (href.includes(`/v0/midnight/users/${WALLET}/positions`)) {
        return json({ cursor: null, data: [samplePosition()] });
      }
      if (href.includes(`/v0/midnight/markets/${MARKET_ID}`)) {
        return json({ data: sampleMarket });
      }
      return json({ data: { assets: { items: Array.from(assets.values()) } } });
    };

    const loans = await fetchMidnightLoans(WALLET);

    assert.equal(loans.length, 1);
    assert.equal(loans[0]?.marketName, 'midnight_CBBTC_USDC_2026-12-23');
    assert.ok(urls.some((url) => url.includes('chain_ids=1')));
  });

  it('throws when the Midnight API is unavailable', async () => {
    globalThis.fetch = async () => new Response('', { status: 503 });
    await assert.rejects(() => fetchMidnightLoans(WALLET), {
      message: 'Morpho Midnight API returned 503',
    });
  });
});
