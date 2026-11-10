import assert from 'node:assert/strict';
import test from 'node:test';
import { maxBorrowAssets, morphoBorrowAssets } from '../src/healthFactorBackfill.js';

test('morphoBorrowAssets rounds up with virtual shares', () => {
  // 1e6 virtual shares per asset at a 1:1 exchange rate.
  assert.equal(morphoBorrowAssets(1_000_000n, 999n, 999_000_000n), 1n);
  assert.equal(morphoBorrowAssets(1_500_000n, 999n, 999_000_000n), 2n);
});

test('maxBorrowAssets values collateral at the oracle price × LLTV', () => {
  // 1 WETH (18 decimals) at $2000 against USDC (6 decimals): price scale is 1e36 × 1e6 / 1e18.
  const oraclePrice = 2000n * 10n ** 24n;
  assert.equal(maxBorrowAssets(10n ** 18n, oraclePrice, 86n * 10n ** 16n), 1720n * 10n ** 6n);
});
