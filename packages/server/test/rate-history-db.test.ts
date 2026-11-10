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

test('appendSample with utilization stores and returns it', () => {
  const db = createDb();
  db.appendSample('0xabc', 'loan-1', 'market', 1000, 0.03, 0.01, 0.85);

  const samples = db.querySamples('0xabc', 'loan-1');
  assert.equal(samples.length, 1);
  assert.equal(samples[0].utilizationRate, 0.85);
  db.close();
});

test('appendSample without utilization stores null', () => {
  const db = createDb();
  db.appendSample('0xabc', 'loan-1', 'market', 1000, 0.03, 0.01);

  const samples = db.querySamples('0xabc', 'loan-1');
  assert.equal(samples.length, 1);
  assert.equal(samples[0].utilizationRate, null);
  db.close();
});

test('appendPortfolioSnapshot + queryPortfolioSnapshots round-trip', () => {
  const db = createDb();
  db.appendPortfolioSnapshot('0xABC', 1000, 50_000, 120_000, 70_000);
  db.appendPortfolioSnapshot('0xabc', 2000, 55_000, 125_000, 70_000);

  const samples = db.queryPortfolioSnapshots('0xAbC');
  assert.equal(samples.length, 2);
  assert.equal(samples[0].timestamp, 1000);
  assert.equal(samples[0].totalDebt, 50_000);
  assert.equal(samples[0].totalAssets, 120_000);
  assert.equal(samples[0].netWorth, 70_000);
  assert.equal(samples[1].timestamp, 2000);
  db.close();
});

test('queryPortfolioSnapshots day bucket returns one row per UTC day', () => {
  const db = createDb();
  const oneDay = 86_400_000;
  // Two samples on day 0, one on day 1, one on day 2.
  db.appendPortfolioSnapshot('0xabc', 1_000, 10, 100, 90);
  db.appendPortfolioSnapshot('0xabc', 2_000, 20, 110, 90);
  db.appendPortfolioSnapshot('0xabc', oneDay + 1_000, 30, 120, 90);
  db.appendPortfolioSnapshot('0xabc', 2 * oneDay + 1_000, 40, 130, 90);

  const daily = db.queryPortfolioSnapshots('0xabc', undefined, undefined, 'day');
  assert.equal(daily.length, 3);
  // Latest timestamp on day 0 is 2_000 with totalDebt=20.
  assert.equal(daily[0].timestamp, 2_000);
  assert.equal(daily[0].totalDebt, 20);
  db.close();
});

test('queryPortfolioSnapshots filters by range', () => {
  const db = createDb();
  db.appendPortfolioSnapshot('0xabc', 1000, 10, 100, 90);
  db.appendPortfolioSnapshot('0xabc', 2000, 20, 110, 90);
  db.appendPortfolioSnapshot('0xabc', 3000, 30, 120, 90);

  const samples = db.queryPortfolioSnapshots('0xabc', 1500, 2500);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].timestamp, 2000);
  db.close();
});

test('prune removes portfolio snapshots older than maxAge', () => {
  const db = createDb();
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  db.appendPortfolioSnapshot('0xabc', now - 10 * oneDay, 10, 100, 90);
  db.appendPortfolioSnapshot('0xabc', now - 1 * oneDay, 20, 110, 90);

  const deleted = db.prune(7 * oneDay);
  assert.equal(deleted, 1);

  const remaining = db.queryPortfolioSnapshots('0xabc');
  assert.equal(remaining.length, 1);
  db.close();
});

test('health factor samples round-trip per position and skip infinite values', () => {
  const db = createDb();
  db.appendHealthFactorSample('0xABC', 'loan-1', 1000, 1.8, 100);
  db.appendHealthFactorSample('0xabc', 'loan-1', 2000, 1.7, 100);
  db.appendHealthFactorSample('0xabc', 'loan-1', 3000, Infinity, 0);
  db.appendHealthFactorSample('0xabc', 'loan-2', 1000, 2.5, 100);

  assert.deepEqual(db.queryHealthFactorSamples('0xAbC', 'loan-1'), [
    { timestamp: 1000, healthFactor: 1.8 },
    { timestamp: 2000, healthFactor: 1.7 },
  ]);
  assert.deepEqual(db.queryHealthFactorSamples('0xabc', 'loan-1', 1500), [
    { timestamp: 2000, healthFactor: 1.7 },
  ]);
  db.close();
});

test('re-appending a health factor sample overwrites it', () => {
  const db = createDb();
  db.appendHealthFactorSample('0xabc', 'loan-1', 1000, 1.8, 100);
  db.appendHealthFactorSample('0xabc', 'loan-1', 1000, 1.9, 200);

  assert.deepEqual(db.queryHealthFactorSamples('0xabc', 'loan-1'), [
    { timestamp: 1000, healthFactor: 1.9 },
  ]);
  db.close();
});

test('portfolio health factor debt-weights each loan latest sample per hour', () => {
  const db = createDb();
  const hour = 60 * 60 * 1000;
  db.appendHealthFactorSample('0xabc', 'loan-1', 1000, 1.5, 100);
  db.appendHealthFactorSample('0xabc', 'loan-1', 2000, 1.6, 100);
  db.appendHealthFactorSample('0xabc', 'loan-2', 1500, 2.4, 300);
  db.appendHealthFactorSample('0xabc', 'loan-2', hour + 1000, 2.2, 300);

  const samples = db.queryPortfolioHealthFactor('0xabc');
  assert.equal(samples.length, 2);
  assert.equal(samples[0].timestamp, 2000);
  assert.ok(Math.abs(samples[0].healthFactor - (1.6 * 100 + 2.4 * 300) / 400) < 1e-9);
  assert.deepEqual(samples[1], { timestamp: hour + 1000, healthFactor: 2.2 });
  db.close();
});

test('portfolio health factor skips samples without recorded debt', () => {
  const db = new RateHistoryDb(':memory:');
  // Simulate a row written before the debt_usd column existed.
  (db as unknown as { db: { prepare: (sql: string) => { run: () => void } } }).db
    .prepare(
      "INSERT INTO health_factor_samples (wallet, position_id, timestamp, health_factor) VALUES ('0xabc', 'loan-1', 1000, 1.2)",
    )
    .run();
  db.appendHealthFactorSample('0xabc', 'loan-2', 1500, 2.0, 100);

  assert.deepEqual(db.queryPortfolioHealthFactor('0xabc'), [
    { timestamp: 1500, healthFactor: 2.0 },
  ]);
  db.close();
});

test('prune removes old health factor samples', () => {
  const db = createDb();
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  db.appendHealthFactorSample('0xabc', 'loan-1', now - 10 * oneDay, 1.8, 100);
  db.appendHealthFactorSample('0xabc', 'loan-1', now - oneDay, 1.9, 100);

  assert.equal(db.prune(7 * oneDay), 1);
  assert.equal(db.queryHealthFactorSamples('0xabc', 'loan-1').length, 1);
  db.close();
});
