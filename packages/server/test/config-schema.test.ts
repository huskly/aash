import assert from 'node:assert/strict';
import test from 'node:test';
import { parseConfigBody } from '../src/configSchema.js';

test('parseConfigBody accepts morphoRescueContract updates', () => {
  const parsed = parseConfigBody({
    watchdog: {
      morphoRescueContract: '0x3333333333333333333333333333333333333333',
    },
  });

  assert.ok('data' in parsed);
  assert.equal(
    parsed.data.watchdog?.morphoRescueContract,
    '0x3333333333333333333333333333333333333333',
  );
});

test('parseConfigBody maps legacy maxTopUpWbtc to maxRepayAmount', () => {
  const parsed = parseConfigBody({
    watchdog: {
      maxTopUpWbtc: 0.75,
    },
  });

  assert.ok('data' in parsed);
  assert.equal(parsed.data.watchdog?.maxRepayAmount, 0.75);
});

test('parseConfigBody accepts valid utilization config', () => {
  const parsed = parseConfigBody({
    utilization: {
      enabled: true,
      defaultThreshold: 0.92,
      cooldownMs: 600_000,
    },
  });

  assert.ok('data' in parsed);
  assert.equal(parsed.data.utilization?.enabled, true);
  assert.equal(parsed.data.utilization?.defaultThreshold, 0.92);
  assert.equal(parsed.data.utilization?.cooldownMs, 600_000);
});

test('parseConfigBody rejects utilization threshold above 1', () => {
  const parsed = parseConfigBody({
    utilization: {
      defaultThreshold: 1.5,
    },
  });

  assert.ok('error' in parsed);
});

test('parseConfigBody rejects utilization threshold below 0', () => {
  const parsed = parseConfigBody({
    utilization: {
      defaultThreshold: -0.1,
    },
  });

  assert.ok('error' in parsed);
});

test('parseConfigBody accepts partial utilization config', () => {
  const parsed = parseConfigBody({
    utilization: {
      enabled: false,
    },
  });

  assert.ok('data' in parsed);
  assert.equal(parsed.data.utilization?.enabled, false);
  assert.equal(parsed.data.utilization?.defaultThreshold, undefined);
});
