import assert from 'node:assert/strict';
import test from 'node:test';
import type { LoanPosition } from '@aave-monitor/core';
import { computeRescueAdjustedHF } from '../src/rescueMetrics.js';

function createLoan(): LoanPosition {
  return {
    id: 'loan-1',
    marketName: 'proto_mainnet_v3',
    totalSuppliedUsd: 2000,
    totalBorrowedUsd: 1000,
    supplied: [
      {
        symbol: 'WETH',
        address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        decimals: 18,
        amount: 1,
        usdPrice: 2000,
        usdValue: 2000,
        collateralEnabled: true,
        maxLTV: 0.75,
        liqThreshold: 0.8,
        supplyRate: 0,
        borrowRate: 0,
      },
    ],
    borrowed: [
      {
        symbol: 'USDC',
        address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        decimals: 6,
        amount: 1000,
        usdPrice: 1,
        usdValue: 1000,
        collateralEnabled: false,
        maxLTV: 0,
        liqThreshold: 0,
        supplyRate: 0,
        borrowRate: 0,
      },
    ],
  };
}

test('computeRescueAdjustedHF uses matching wallet debt-token balances as repay capacity', () => {
  const adjustedHF = computeRescueAdjustedHF(
    createLoan(),
    new Map([['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 250]]),
  );

  assert.equal(adjustedHF, 1600 / 750);
});

test('computeRescueAdjustedHF caps repay capacity at the loan debt amount', () => {
  const adjustedHF = computeRescueAdjustedHF(
    createLoan(),
    new Map([['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 5000]]),
  );

  assert.equal(adjustedHF, Infinity);
});

test('computeRescueAdjustedHF ignores wallet balances of unrelated assets', () => {
  const adjustedHF = computeRescueAdjustedHF(
    createLoan(),
    new Map([['0xdac17f958d2ee523a2206206994597c13d831ec7', 250]]),
  );

  assert.equal(adjustedHF, 1.6);
});
