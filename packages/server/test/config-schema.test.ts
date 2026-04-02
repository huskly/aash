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

test('parseConfigBody maps legacy maxTopUpWbtc to maxTopUpAmount', () => {
  const parsed = parseConfigBody({
    watchdog: {
      maxTopUpWbtc: 0.75,
    },
  });

  assert.ok('data' in parsed);
  assert.equal(parsed.data.watchdog?.maxTopUpAmount, 0.75);
});
