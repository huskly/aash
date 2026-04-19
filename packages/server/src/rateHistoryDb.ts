import Database from 'better-sqlite3';

export type RateSample = {
  timestamp: number; // epoch ms
  borrowRate: number; // weighted decimal, e.g. 0.0325 = 3.25%
  supplyRate: number;
};

export class RateHistoryDb {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private queryStmt: Database.Statement;
  private queryFromStmt: Database.Statement;
  private queryToStmt: Database.Statement;
  private queryRangeStmt: Database.Statement;
  private pruneStmt: Database.Statement;

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

    this.insertStmt = this.db.prepare(
      'INSERT OR IGNORE INTO rate_samples (wallet, loan_id, market, timestamp, borrow_rate, supply_rate) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.queryStmt = this.db.prepare(
      'SELECT timestamp, borrow_rate, supply_rate FROM rate_samples WHERE wallet = ? AND loan_id = ? ORDER BY timestamp ASC',
    );
    this.queryFromStmt = this.db.prepare(
      'SELECT timestamp, borrow_rate, supply_rate FROM rate_samples WHERE wallet = ? AND loan_id = ? AND timestamp >= ? ORDER BY timestamp ASC',
    );
    this.queryToStmt = this.db.prepare(
      'SELECT timestamp, borrow_rate, supply_rate FROM rate_samples WHERE wallet = ? AND loan_id = ? AND timestamp <= ? ORDER BY timestamp ASC',
    );
    this.queryRangeStmt = this.db.prepare(
      'SELECT timestamp, borrow_rate, supply_rate FROM rate_samples WHERE wallet = ? AND loan_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC',
    );
    this.pruneStmt = this.db.prepare('DELETE FROM rate_samples WHERE timestamp < ?');
  }

  appendSample(
    wallet: string,
    loanId: string,
    market: string,
    timestampMs: number,
    borrowRate: number,
    supplyRate: number,
  ): void {
    this.insertStmt.run(wallet.toLowerCase(), loanId, market, timestampMs, borrowRate, supplyRate);
  }

  querySamples(wallet: string, loanId: string, fromMs?: number, toMs?: number): RateSample[] {
    type Row = { timestamp: number; borrow_rate: number; supply_rate: number };
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
    }));
  }

  prune(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this.pruneStmt.run(cutoff);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
