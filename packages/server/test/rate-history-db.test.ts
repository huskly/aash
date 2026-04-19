import assert from 'node:assert/strict';
import test from 'node:test';
import { RateHistoryDb } from '../src/rateHistoryDb.js';

function createDb(): RateHistoryDb {
  return new RateHistoryDb(':memory:');
}

test('appendSample inserts and querySamples returns it', () => {
  const db = createDb();
  db.appendSample('0xABC', 'loan-1', 'proto_mainnet_v3', 1000, 0.035, 0.02);

  const samples = db.querySamples('0xABC', 'loan-1');
  assert.equal(samples.length, 1);
  assert.equal(samples[0].timestamp, 1000);
  assert.equal(samples[0].borrowRate, 0.035);
  assert.equal(samples[0].supplyRate, 0.02);
  db.close();
});

test('wallet addresses are normalized to lowercase', () => {
  const db = createDb();
  db.appendSample('0xABCDEF', 'loan-1', 'market', 1000, 0.03, 0.01);

  const samples = db.querySamples('0xAbCdEf', 'loan-1');
  assert.equal(samples.length, 1);
  db.close();
});

test('querySamples returns empty array for non-existent keys', () => {
  const db = createDb();
  const samples = db.querySamples('0xNONE', 'loan-99');
  assert.deepEqual(samples, []);
  db.close();
});

test('querySamples filters by from/to range', () => {
  const db = createDb();
  db.appendSample('0xabc', 'loan-1', 'market', 1000, 0.03, 0.01);
  db.appendSample('0xabc', 'loan-1', 'market', 2000, 0.04, 0.02);
  db.appendSample('0xabc', 'loan-1', 'market', 3000, 0.05, 0.03);

  const samples = db.querySamples('0xabc', 'loan-1', 1500, 2500);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].timestamp, 2000);
  db.close();
});

test('querySamples returns results sorted by timestamp', () => {
  const db = createDb();
  db.appendSample('0xabc', 'loan-1', 'market', 3000, 0.05, 0.03);
  db.appendSample('0xabc', 'loan-1', 'market', 1000, 0.03, 0.01);
  db.appendSample('0xabc', 'loan-1', 'market', 2000, 0.04, 0.02);

  const samples = db.querySamples('0xabc', 'loan-1');
  assert.deepEqual(
    samples.map((s) => s.timestamp),
    [1000, 2000, 3000],
  );
  db.close();
});

test('multiple loans for same wallet are stored independently', () => {
  const db = createDb();
  db.appendSample('0xabc', 'loan-1', 'market-a', 1000, 0.03, 0.01);
  db.appendSample('0xabc', 'loan-2', 'market-b', 1000, 0.05, 0.02);

  const loan1 = db.querySamples('0xabc', 'loan-1');
  const loan2 = db.querySamples('0xabc', 'loan-2');
  assert.equal(loan1.length, 1);
  assert.equal(loan2.length, 1);
  assert.equal(loan1[0].borrowRate, 0.03);
  assert.equal(loan2[0].borrowRate, 0.05);
  db.close();
});

test('prune removes samples older than maxAge and keeps recent ones', () => {
  const db = createDb();
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;

  db.appendSample('0xabc', 'loan-1', 'market', now - 10 * oneDay, 0.03, 0.01);
  db.appendSample('0xabc', 'loan-1', 'market', now - 5 * oneDay, 0.04, 0.02);
  db.appendSample('0xabc', 'loan-1', 'market', now - 1 * oneDay, 0.05, 0.03);

  const deleted = db.prune(7 * oneDay);
  assert.equal(deleted, 1);

  const remaining = db.querySamples('0xabc', 'loan-1');
  assert.equal(remaining.length, 2);
  db.close();
});

test('querySamples filters with from-only', () => {
  const db = createDb();
  db.appendSample('0xabc', 'loan-1', 'market', 1000, 0.03, 0.01);
  db.appendSample('0xabc', 'loan-1', 'market', 2000, 0.04, 0.02);
  db.appendSample('0xabc', 'loan-1', 'market', 3000, 0.05, 0.03);

  const samples = db.querySamples('0xabc', 'loan-1', 1500);
  assert.equal(samples.length, 2);
  assert.deepEqual(
    samples.map((s) => s.timestamp),
    [2000, 3000],
  );
  db.close();
});

test('querySamples filters with to-only', () => {
  const db = createDb();
  db.appendSample('0xabc', 'loan-1', 'market', 1000, 0.03, 0.01);
  db.appendSample('0xabc', 'loan-1', 'market', 2000, 0.04, 0.02);
  db.appendSample('0xabc', 'loan-1', 'market', 3000, 0.05, 0.03);

  const samples = db.querySamples('0xabc', 'loan-1', undefined, 2500);
  assert.equal(samples.length, 2);
  assert.deepEqual(
    samples.map((s) => s.timestamp),
    [1000, 2000],
  );
  db.close();
});

test('duplicate samples with same wallet/loan/timestamp are silently ignored', () => {
  const db = createDb();
  db.appendSample('0xabc', 'loan-1', 'market', 1000, 0.03, 0.01);
  db.appendSample('0xabc', 'loan-1', 'market', 1000, 0.05, 0.02);

  const samples = db.querySamples('0xabc', 'loan-1');
  assert.equal(samples.length, 1);
  assert.equal(samples[0].borrowRate, 0.03);
  db.close();
});
