import assert from 'node:assert/strict';
import test from 'node:test';
import { RateHistoryDb } from '../src/rateHistoryDb.js';

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

test('getLastInterestSnapshotTs returns the most recent timestamp', () => {
  const db = createDb();
  assert.equal(db.getLastInterestSnapshotTs('0xabc', 'loan-1', 'loan'), undefined);

  db.appendInterestSnapshot('0xabc', 'loan-1', 'loan', null, 1000, 1);
  db.appendInterestSnapshot('0xabc', 'loan-1', 'loan', null, 3000, 3);
  db.appendInterestSnapshot('0xabc', 'loan-1', 'loan', null, 2000, 2);

  assert.equal(db.getLastInterestSnapshotTs('0xabc', 'loan-1', 'loan'), 3000);
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
