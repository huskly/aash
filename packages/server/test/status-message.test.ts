import assert from 'node:assert/strict';
import test from 'node:test';
import { formatStatusMessage } from '../src/statusMessage.js';
import type { MonitorStatus } from '../src/monitor.js';

const zones = [
  { name: 'safe', minHF: 2.2, maxHF: Infinity },
  { name: 'comfort', minHF: 1.9, maxHF: 2.2 },
  { name: 'watch', minHF: 1.6, maxHF: 1.9 },
  { name: 'alert', minHF: 1.3, maxHF: 1.6 },
  { name: 'action', minHF: 1.15, maxHF: 1.3 },
  { name: 'critical', minHF: 0, maxHF: 1.15 },
] as const;

test('formatStatusMessage shows human-readable market names instead of loan ids', () => {
  const status: MonitorStatus = {
    running: true,
    states: [
      {
        loanId: '0x3a85e619751152991742810df6ec69ce473daef99e28a64ab2340d7b7ccfee49',
        marketName: 'morpho_cbBTC_USDC',
        wallet: '0x1111111111111111111111111111111111117405',
        healthFactor: 1.97,
        adjustedHF: 1.97,
        borrowRate: 0.0512,
        utilizationRate: 0.82,
        debtUsd: 1000,
        collateralUsd: 2500,
        maxBorrowByLtvUsd: 1500,
        equityUsd: 1500,
        netEarnUsd: 0,
        currentZone: { name: 'comfort', label: 'COMFORT', emoji: '🟢', action: 'Monitor' },
        lastNotifiedZone: null,
        lastNotifiedAt: 0,
        consecutiveChecks: 1,
        stuckSince: null,
      },
    ],
    vaults: [],
    totalWalletBorrowedAssetUsd: 28,
    lastPollAt: null,
    lastError: null,
    watchdogLog: [],
  };

  const message = formatStatusMessage(status, [...zones]);
  assert.match(message, /morpho_cbBTC_USDC/);
  assert.doesNotMatch(
    message,
    /0x3a85e619751152991742810df6ec69ce473daef99e28a64ab2340d7b7ccfee49/,
  );
});

test('formatStatusMessage reports repay coverage from wallet balances matching borrowed assets', () => {
  const status: MonitorStatus = {
    running: true,
    states: [
      {
        loanId: 'loan-1',
        marketName: 'proto_mainnet_v3',
        wallet: '0x1111111111111111111111111111111111117405',
        healthFactor: 1.97,
        adjustedHF: 1.97,
        borrowRate: 0.05,
        utilizationRate: 0.25,
        debtUsd: 1000,
        collateralUsd: 2500,
        maxBorrowByLtvUsd: 1500,
        equityUsd: 1500,
        netEarnUsd: 0,
        currentZone: { name: 'comfort', label: 'COMFORT', emoji: '🟢', action: 'Monitor' },
        lastNotifiedZone: null,
        lastNotifiedAt: 0,
        consecutiveChecks: 1,
        stuckSince: null,
      },
    ],
    vaults: [],
    totalWalletBorrowedAssetUsd: 250,
    lastPollAt: null,
    lastError: null,
    watchdogLog: [],
  };

  const message = formatStatusMessage(status, [...zones]);
  assert.match(message, /Repay coverage: <b>\$250<\/b> \(25\.00%\)/);
});

test('formatStatusMessage shows rescue-adjusted HF when wallet can repay part of the debt', () => {
  const status: MonitorStatus = {
    running: true,
    states: [
      {
        loanId: 'loan-1',
        marketName: 'proto_mainnet_v3',
        wallet: '0x1111111111111111111111111111111111117405',
        healthFactor: 1.6,
        adjustedHF: 2.1333333333333333,
        borrowRate: 0.05,
        utilizationRate: 0.875,
        debtUsd: 1000,
        collateralUsd: 2000,
        maxBorrowByLtvUsd: 1500,
        equityUsd: 1000,
        netEarnUsd: 0,
        currentZone: { name: 'watch', label: 'WATCH', emoji: '🟡', action: 'Monitor closely' },
        lastNotifiedZone: null,
        lastNotifiedAt: 0,
        consecutiveChecks: 1,
        stuckSince: null,
      },
    ],
    vaults: [],
    totalWalletBorrowedAssetUsd: 250,
    lastPollAt: null,
    lastError: null,
    watchdogLog: [],
  };

  const message = formatStatusMessage(status, [...zones]);
  assert.match(
    message,
    /HF: <b>1\.60<\/b> · Adjusted HF: <b>2\.13<\/b> · Rate: <b>5\.00%<\/b> · Utilization: <b>87\.50%<\/b> · Zone: WATCH/,
  );
});

test('formatStatusMessage shows utilization as N/A when unavailable', () => {
  const status: MonitorStatus = {
    running: true,
    states: [
      {
        loanId: 'loan-1',
        marketName: 'proto_mainnet_v3',
        wallet: '0x1111111111111111111111111111111111117405',
        healthFactor: 1.97,
        adjustedHF: 1.97,
        borrowRate: 0.05,
        debtUsd: 1000,
        collateralUsd: 2500,
        maxBorrowByLtvUsd: 1500,
        equityUsd: 1500,
        netEarnUsd: 0,
        currentZone: { name: 'comfort', label: 'COMFORT', emoji: '🟢', action: 'Monitor' },
        lastNotifiedZone: null,
        lastNotifiedAt: 0,
        consecutiveChecks: 1,
        stuckSince: null,
      },
    ],
    vaults: [],
    totalWalletBorrowedAssetUsd: 250,
    lastPollAt: null,
    lastError: null,
    watchdogLog: [],
  };

  const message = formatStatusMessage(status, [...zones]);
  assert.match(message, /Rate: <b>5\.00%<\/b> · Utilization: <b>N\/A<\/b> · Zone: COMFORT/);
});
