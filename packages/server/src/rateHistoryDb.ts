import Database from 'better-sqlite3';

export type RateSample = {
  timestamp: number; // epoch ms
  borrowRate: number; // weighted decimal, e.g. 0.0325 = 3.25%
  supplyRate: number;
  utilizationRate: number | null;
};

export type InterestKind = 'loan' | 'vault';

export type InterestSnapshot = {
  timestamp: number; // epoch ms
  cumulativeUsd: number;
  label: string | null;
};

export class RateHistoryDb {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private queryStmt: Database.Statement;
  private queryFromStmt: Database.Statement;
  private queryToStmt: Database.Statement;
  private queryRangeStmt: Database.Statement;
  private pruneStmt: Database.Statement;
  private insertInterestStmt: Database.Statement;
  private lastInterestTsStmt: Database.Statement;
  private queryInterestStmt: Database.Statement;
  private queryInterestFromStmt: Database.Statement;
  private queryInterestToStmt: Database.Statement;
  private queryInterestRangeStmt: Database.Statement;
  private pruneInterestStmt: Database.Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rate_samples (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet      TEXT    NOT NULL,
        loan_id     TEXT    NOT NULL,
        market      TEXT    NOT NULL,
        timestamp   INTEGER NOT NULL,
        borrow_rate REAL    NOT NULL,
        supply_rate REAL    NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_samples_unique
        ON rate_samples (wallet, loan_id, timestamp);
    `);

    // Migration: add utilization_rate column if it doesn't exist yet.
    const tableInfo = this.db.prepare('PRAGMA table_info(rate_samples)').all() as Array<{
      name: string;
    }>;
    const hasUtilizationRate = tableInfo.some((column) => column.name === 'utilization_rate');
    if (!hasUtilizationRate) {
      this.db.exec('ALTER TABLE rate_samples ADD COLUMN utilization_rate REAL');
    }

    const cols = 'timestamp, borrow_rate, supply_rate, utilization_rate';

    this.insertStmt = this.db.prepare(
      'INSERT OR IGNORE INTO rate_samples (wallet, loan_id, market, timestamp, borrow_rate, supply_rate, utilization_rate) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    this.queryStmt = this.db.prepare(
      `SELECT ${cols} FROM rate_samples WHERE wallet = ? AND loan_id = ? ORDER BY timestamp ASC`,
    );
    this.queryFromStmt = this.db.prepare(
      `SELECT ${cols} FROM rate_samples WHERE wallet = ? AND loan_id = ? AND timestamp >= ? ORDER BY timestamp ASC`,
    );
    this.queryToStmt = this.db.prepare(
      `SELECT ${cols} FROM rate_samples WHERE wallet = ? AND loan_id = ? AND timestamp <= ? ORDER BY timestamp ASC`,
    );
    this.queryRangeStmt = this.db.prepare(
      `SELECT ${cols} FROM rate_samples WHERE wallet = ? AND loan_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC`,
    );
    this.pruneStmt = this.db.prepare('DELETE FROM rate_samples WHERE timestamp < ?');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS interest_snapshots (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet         TEXT    NOT NULL,
        position_id    TEXT    NOT NULL,
        kind           TEXT    NOT NULL,
        label          TEXT,
        timestamp      INTEGER NOT NULL,
        cumulative_usd REAL    NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_interest_unique
        ON interest_snapshots (wallet, position_id, kind, timestamp);
      CREATE INDEX IF NOT EXISTS idx_interest_lookup
        ON interest_snapshots (wallet, position_id, kind, timestamp DESC);
    `);

    const interestCols = 'timestamp, cumulative_usd, label';
    this.insertInterestStmt = this.db.prepare(
      'INSERT OR IGNORE INTO interest_snapshots (wallet, position_id, kind, label, timestamp, cumulative_usd) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.lastInterestTsStmt = this.db.prepare(
      'SELECT timestamp FROM interest_snapshots WHERE wallet = ? AND position_id = ? AND kind = ? ORDER BY timestamp DESC LIMIT 1',
    );
    this.queryInterestStmt = this.db.prepare(
      `SELECT ${interestCols} FROM interest_snapshots WHERE wallet = ? AND position_id = ? AND kind = ? ORDER BY timestamp ASC`,
    );
    this.queryInterestFromStmt = this.db.prepare(
      `SELECT ${interestCols} FROM interest_snapshots WHERE wallet = ? AND position_id = ? AND kind = ? AND timestamp >= ? ORDER BY timestamp ASC`,
    );
    this.queryInterestToStmt = this.db.prepare(
      `SELECT ${interestCols} FROM interest_snapshots WHERE wallet = ? AND position_id = ? AND kind = ? AND timestamp <= ? ORDER BY timestamp ASC`,
    );
    this.queryInterestRangeStmt = this.db.prepare(
      `SELECT ${interestCols} FROM interest_snapshots WHERE wallet = ? AND position_id = ? AND kind = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC`,
    );
    this.pruneInterestStmt = this.db.prepare('DELETE FROM interest_snapshots WHERE timestamp < ?');
  }

  appendInterestSnapshot(
    wallet: string,
    positionId: string,
    kind: InterestKind,
    label: string | null,
    timestampMs: number,
    cumulativeUsd: number,
  ): void {
    this.insertInterestStmt.run(
      wallet.toLowerCase(),
      positionId,
      kind,
      label,
      timestampMs,
      cumulativeUsd,
    );
  }

  getLastInterestSnapshotTs(
    wallet: string,
    positionId: string,
    kind: InterestKind,
  ): number | undefined {
    const row = this.lastInterestTsStmt.get(wallet.toLowerCase(), positionId, kind) as
      | { timestamp: number }
      | undefined;
    return row?.timestamp;
  }

  queryInterestSnapshots(
    wallet: string,
    positionId: string,
    kind: InterestKind,
    fromMs?: number,
    toMs?: number,
  ): InterestSnapshot[] {
    type Row = { timestamp: number; cumulative_usd: number; label: string | null };
    const w = wallet.toLowerCase();
    let rows: Row[];
    if (fromMs != null && toMs != null) {
      rows = this.queryInterestRangeStmt.all(w, positionId, kind, fromMs, toMs) as Row[];
    } else if (fromMs != null) {
      rows = this.queryInterestFromStmt.all(w, positionId, kind, fromMs) as Row[];
    } else if (toMs != null) {
      rows = this.queryInterestToStmt.all(w, positionId, kind, toMs) as Row[];
    } else {
      rows = this.queryInterestStmt.all(w, positionId, kind) as Row[];
    }
    return rows.map((r) => ({
      timestamp: r.timestamp,
      cumulativeUsd: r.cumulative_usd,
      label: r.label,
    }));
  }

  appendSample(
    wallet: string,
    loanId: string,
    market: string,
    timestampMs: number,
    borrowRate: number,
    supplyRate: number,
    utilizationRate?: number,
  ): void {
    this.insertStmt.run(
      wallet.toLowerCase(),
      loanId,
      market,
      timestampMs,
      borrowRate,
      supplyRate,
      utilizationRate ?? null,
    );
  }

  querySamples(wallet: string, loanId: string, fromMs?: number, toMs?: number): RateSample[] {
    type Row = {
      timestamp: number;
      borrow_rate: number;
      supply_rate: number;
      utilization_rate: number | null;
    };
    const w = wallet.toLowerCase();
    let rows: Row[];
    if (fromMs != null && toMs != null) {
      rows = this.queryRangeStmt.all(w, loanId, fromMs, toMs) as Row[];
    } else if (fromMs != null) {
      rows = this.queryFromStmt.all(w, loanId, fromMs) as Row[];
    } else if (toMs != null) {
      rows = this.queryToStmt.all(w, loanId, toMs) as Row[];
    } else {
      rows = this.queryStmt.all(w, loanId) as Row[];
    }
    return rows.map((r) => ({
      timestamp: r.timestamp,
      borrowRate: r.borrow_rate,
      supplyRate: r.supply_rate,
      utilizationRate: r.utilization_rate,
    }));
  }

  prune(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.pruneStmt.run(cutoff);
    const interestResult = this.pruneInterestStmt.run(cutoff);
    return result.changes + interestResult.changes;
  }

  close(): void {
    this.db.close();
  }
}
