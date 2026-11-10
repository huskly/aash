import assert from 'node:assert/strict';
import test from 'node:test';
import { RateHistoryDb, computeInterestDeltas } from '../src/rateHistoryDb.js';

function createDb(): RateHistoryDb {
  return new RateHistoryDb(':memory:');
}

test('appendInterestSnapshot round-trips through queryInterestSnapshots', () => {
  const db = createDb();
  db.appendInterestSnapshot('0xABC', 'loan-1', 'loan', 'morpho_WETH_USDC', 1000, 12.5);

  const rows = db.queryInterestSnapshots('0xabc', 'loan-1', 'loan');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].timestamp, 1000);
  assert.equal(rows[0].cumulativeUsd, 12.5);
  assert.equal(rows[0].label, 'morpho_WETH_USDC');
  db.close();
});

test('snapshots are scoped by (wallet, positionId, kind)', () => {
  const db = createDb();
  db.appendInterestSnapshot('0xabc', 'same-id', 'loan', null, 1000, 1);
  db.appendInterestSnapshot('0xabc', 'same-id', 'vault', null, 1000, 2);

  const loans = db.queryInterestSnapshots('0xabc', 'same-id', 'loan');
  const vaults = db.queryInterestSnapshots('0xabc', 'same-id', 'vault');
  assert.equal(loans.length, 1);
  assert.equal(vaults.length, 1);
  assert.equal(loans[0].cumulativeUsd, 1);
  assert.equal(vaults[0].cumulativeUsd, 2);
  db.close();
});

test('duplicate (wallet, positionId, kind, timestamp) is ignored', () => {
  const db = createDb();
  db.appendInterestSnapshot('0xabc', 'loan-1', 'loan', null, 1000, 1);
  db.appendInterestSnapshot('0xabc', 'loan-1', 'loan', null, 1000, 2);
  const rows = db.queryInterestSnapshots('0xabc', 'loan-1', 'loan');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cumulativeUsd, 1);
  db.close();
});

test('queryInterestSnapshots filters by from/to range and sorts ascending', () => {
  const db = createDb();
  db.appendInterestSnapshot('0xabc', 'loan-1', 'loan', null, 3000, 3);
  db.appendInterestSnapshot('0xabc', 'loan-1', 'loan', null, 1000, 1);
  db.appendInterestSnapshot('0xabc', 'loan-1', 'loan', null, 2000, 2);

  const all = db.queryInterestSnapshots('0xabc', 'loan-1', 'loan');
  assert.deepEqual(
    all.map((r) => r.timestamp),
    [1000, 2000, 3000],
  );

  const ranged = db.queryInterestSnapshots('0xabc', 'loan-1', 'loan', 1500, 2500);
  assert.equal(ranged.length, 1);
  assert.equal(ranged[0].timestamp, 2000);
  db.close();
});

test('computeInterestDeltas returns empty for empty input', () => {
  assert.deepEqual(computeInterestDeltas([]), []);
});

test('computeInterestDeltas sets first row delta to 0', () => {
  const rows = computeInterestDeltas([{ timestamp: 1000, cumulativeUsd: 10, label: 'm' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deltaUsd, 0);
  assert.equal(rows[0].cumulativeUsd, 10);
  assert.equal(rows[0].label, 'm');
});

test('computeInterestDeltas computes signed per-row deltas', () => {
  const rows = computeInterestDeltas([
    { timestamp: 1000, cumulativeUsd: 10, label: null },
    { timestamp: 2000, cumulativeUsd: 15, label: null },
    { timestamp: 3000, cumulativeUsd: 12, label: null },
    { timestamp: 4000, cumulativeUsd: 20, label: null },
  ]);
  assert.deepEqual(
    rows.map((r) => r.deltaUsd),
    [0, 5, -3, 8],
  );
});

test('queryInterestSnapshots with bucket=day returns one row per UTC day (latest)', () => {
  const db = createDb();
  const day = 24 * 60 * 60 * 1000;
  // Day 0 (UTC): three samples, last one wins
  db.appendInterestSnapshot('0xabc', 'loan-1', 'loan', null, 1_000, 1);
  db.appendInterestSnapshot('0xabc', 'loan-1', 'loan', null, 2_000, 2);
  db.appendInterestSnapshot('0xabc', 'loan-1', 'loan', null, 3_000, 3);
  // Day 1: two samples
  db.appendInterestSnapshot('0xabc', 'loan-1', 'loan', null, day + 1_000, 10);
  db.appendInterestSnapshot('0xabc', 'loan-1', 'loan', null, day + 5_000, 12);
  // Day 2: one sample
  db.appendInterestSnapshot('0xabc', 'loan-1', 'loan', null, 2 * day + 500, 15);

  const rows = db.queryInterestSnapshots('0xabc', 'loan-1', 'loan', undefined, undefined, 'day');
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => [r.timestamp, r.cumulativeUsd]),
    [
      [3_000, 3],
      [day + 5_000, 12],
      [2 * day + 500, 15],
    ],
  );

  // A mid-day repay (cumulative drops) on day 1 should still surface the
  // last-of-day value, even if it's lower than earlier samples.
  db.appendInterestSnapshot('0xabc', 'loan-1', 'loan', null, day + 10_000, 0);
  const afterRepay = db.queryInterestSnapshots(
    '0xabc',
    'loan-1',
    'loan',
    undefined,
    undefined,
    'day',
  );
  const day1 = afterRepay.find((r) => r.timestamp === day + 10_000);
  assert.ok(day1, 'expected latest day-1 row');
  assert.equal(day1.cumulativeUsd, 0);
  db.close();
});

test('prune also removes old interest snapshots', () => {
  const db = createDb();
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  db.appendInterestSnapshot('0xabc', 'loan-1', 'loan', null, now - 200 * day, 1);
  db.appendInterestSnapshot('0xabc', 'loan-1', 'loan', null, now - 5 * day, 2);

  const deleted = db.prune(180 * day);
  assert.equal(deleted, 1);

  const rows = db.queryInterestSnapshots('0xabc', 'loan-1', 'loan');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cumulativeUsd, 2);
  db.close();
});

test('queryInterestPositionIds keeps closed positions and separates kinds and wallets', () => {
  const db = createDb();
  db.appendInterestSnapshot('0xABC', 'closed-loan', 'loan', null, 1_000, -10);
  db.appendInterestSnapshot('0xabc', 'open-loan', 'loan', null, 2_000, 5);
  db.appendInterestSnapshot('0xabc', 'vault-1', 'vault', null, 2_000, 5);
  db.appendInterestSnapshot('0xdef', 'other-loan', 'loan', null, 2_000, 5);

  assert.deepEqual(db.queryInterestPositionIds('0xabc', 'loan').sort(), [
    'closed-loan',
    'open-loan',
  ]);
  db.close();
});
