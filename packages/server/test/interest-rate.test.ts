import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVariableBorrowCurve,
  computeVariableBorrowRateAtUtilization,
  type ReserveTelemetry,
} from '@aave-monitor/core';

const RESERVE: ReserveTelemetry = {
  marketName: 'proto_mainnet_v3',
  assetAddress: '0x0000000000000000000000000000000000000001',
  symbol: 'USDC',
  availableLiquidity: 1_000_000,
  totalDebt: 2_000_000,
  utilizationRate: 0.75,
  variableBorrowRate: 0.03,
  baseVariableBorrowRate: 0,
  variableRateSlope1: 0.04,
  variableRateSlope2: 1,
  optimalUsageRatio: 0.92,
  lastUpdateTimestamp: '2026-03-25T00:00:00.000Z',
};

test('computeVariableBorrowRateAtUtilization follows the slope below optimal usage', () => {
  const rate = computeVariableBorrowRateAtUtilization(0.46, RESERVE);

  assert.ok(Math.abs(rate - 0.02) < 1e-12);
});

test('computeVariableBorrowRateAtUtilization accelerates after optimal usage', () => {
  const rate = computeVariableBorrowRateAtUtilization(0.96, RESERVE);

  assert.ok(Math.abs(rate - 0.54) < 1e-12);
});

test('buildVariableBorrowCurve includes the kink point explicitly', () => {
  const curve = buildVariableBorrowCurve(RESERVE, 4);

  assert.equal(curve[0]?.utilizationRate, 0);
  assert.equal(curve.at(-1)?.utilizationRate, 1);
  assert.ok(curve.some((point) => point.utilizationRate === RESERVE.optimalUsageRatio));
});
