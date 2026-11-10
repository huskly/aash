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

export type InterestDeltaRow = {
  timestamp: number;
  cumulativeUsd: number;
  deltaUsd: number;
  label: string | null;
};

export type HealthFactorSample = {
  timestamp: number; // epoch ms
  healthFactor: number;
};

export type PortfolioSnapshot = {
  timestamp: number;
  totalDebt: number;
  totalAssets: number;
  netWorth: number;
};

/**
 * Convert an ascending list of cumulative interest snapshots into rows carrying
 * both the cumulative value and the delta from the previous row. The first row
 * has `deltaUsd = 0` since there is no prior baseline in the series.
 */
export function computeInterestDeltas(rows: InterestSnapshot[]): InterestDeltaRow[] {
  return rows.map((row, index) => ({
    timestamp: row.timestamp,
    cumulativeUsd: row.cumulativeUsd,
    deltaUsd: index === 0 ? 0 : row.cumulativeUsd - (rows[index - 1]?.cumulativeUsd ?? 0),
    label: row.label,
  }));
}

export class RateHistoryDb {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private queryStmt: Database.Statement;
  private queryFromStmt: Database.Statement;
  private queryToStmt: Database.Statement;
  private queryRangeStmt: Database.Statement;
  private pruneStmt: Database.Statement;
  private insertInterestStmt: Database.Statement;
  private queryInterestStmt: Database.Statement;
  private queryInterestFromStmt: Database.Statement;
  private queryInterestToStmt: Database.Statement;
  private queryInterestRangeStmt: Database.Statement;
  private queryInterestDailyStmt: Database.Statement;
  private queryInterestDailyFromStmt: Database.Statement;
  private queryInterestDailyToStmt: Database.Statement;
  private queryInterestDailyRangeStmt: Database.Statement;
  private queryInterestPositionIdsStmt: Database.Statement;
  private pruneInterestStmt: Database.Statement;
  private insertPortfolioStmt: Database.Statement;
  private queryPortfolioStmt: Database.Statement;
  private queryPortfolioFromStmt: Database.Statement;
  private queryPortfolioToStmt: Database.Statement;
  private queryPortfolioRangeStmt: Database.Statement;
  private queryPortfolioDailyStmt: Database.Statement;
  private queryPortfolioDailyFromStmt: Database.Statement;
  private queryPortfolioDailyToStmt: Database.Statement;
  private queryPortfolioDailyRangeStmt: Database.Statement;
  private prunePortfolioStmt: Database.Statement;
  private insertHealthFactorStmt: Database.Statement;
  private queryHealthFactorStmt: Database.Statement;
  private queryPortfolioHealthFactorStmt: Database.Statement;
  private pruneHealthFactorStmt: Database.Statement;

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

    // Day-bucketed variants: one row per UTC day, carrying the latest
    // cumulative value for that day. Relies on SQLite's "bare column" rule
    // for MAX() — the non-aggregated columns come from the row with MAX(timestamp).
    const dayBucket = 'CAST(timestamp / 86400000 AS INTEGER)';
    const dailyCols = `MAX(timestamp) AS timestamp, cumulative_usd, label`;
    this.queryInterestDailyStmt = this.db.prepare(
      `SELECT ${dailyCols} FROM interest_snapshots WHERE wallet = ? AND position_id = ? AND kind = ? GROUP BY ${dayBucket} ORDER BY timestamp ASC`,
    );
    this.queryInterestDailyFromStmt = this.db.prepare(
      `SELECT ${dailyCols} FROM interest_snapshots WHERE wallet = ? AND position_id = ? AND kind = ? AND timestamp >= ? GROUP BY ${dayBucket} ORDER BY timestamp ASC`,
    );
    this.queryInterestDailyToStmt = this.db.prepare(
      `SELECT ${dailyCols} FROM interest_snapshots WHERE wallet = ? AND position_id = ? AND kind = ? AND timestamp <= ? GROUP BY ${dayBucket} ORDER BY timestamp ASC`,
    );
    this.queryInterestDailyRangeStmt = this.db.prepare(
      `SELECT ${dailyCols} FROM interest_snapshots WHERE wallet = ? AND position_id = ? AND kind = ? AND timestamp >= ? AND timestamp <= ? GROUP BY ${dayBucket} ORDER BY timestamp ASC`,
    );
    this.queryInterestPositionIdsStmt = this.db.prepare(
      'SELECT DISTINCT position_id FROM interest_snapshots WHERE wallet = ? AND kind = ?',
    );
    this.pruneInterestStmt = this.db.prepare('DELETE FROM interest_snapshots WHERE timestamp < ?');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS portfolio_snapshots (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet       TEXT    NOT NULL,
        timestamp    INTEGER NOT NULL,
        total_debt   REAL    NOT NULL,
        total_assets REAL    NOT NULL,
        net_worth    REAL    NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_portfolio_snapshots_unique
        ON portfolio_snapshots (wallet, timestamp);
    `);

    const portfolioCols = 'timestamp, total_debt, total_assets, net_worth';
    this.insertPortfolioStmt = this.db.prepare(
      'INSERT OR IGNORE INTO portfolio_snapshots (wallet, timestamp, total_debt, total_assets, net_worth) VALUES (?, ?, ?, ?, ?)',
    );
    this.queryPortfolioStmt = this.db.prepare(
      `SELECT ${portfolioCols} FROM portfolio_snapshots WHERE wallet = ? ORDER BY timestamp ASC`,
    );
    this.queryPortfolioFromStmt = this.db.prepare(
      `SELECT ${portfolioCols} FROM portfolio_snapshots WHERE wallet = ? AND timestamp >= ? ORDER BY timestamp ASC`,
    );
    this.queryPortfolioToStmt = this.db.prepare(
      `SELECT ${portfolioCols} FROM portfolio_snapshots WHERE wallet = ? AND timestamp <= ? ORDER BY timestamp ASC`,
    );
    this.queryPortfolioRangeStmt = this.db.prepare(
      `SELECT ${portfolioCols} FROM portfolio_snapshots WHERE wallet = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC`,
    );

    const portfolioDayBucket = 'CAST(timestamp / 86400000 AS INTEGER)';
    const portfolioDailyCols = `MAX(timestamp) AS timestamp, total_debt, total_assets, net_worth`;
    this.queryPortfolioDailyStmt = this.db.prepare(
      `SELECT ${portfolioDailyCols} FROM portfolio_snapshots WHERE wallet = ? GROUP BY ${portfolioDayBucket} ORDER BY timestamp ASC`,
    );
    this.queryPortfolioDailyFromStmt = this.db.prepare(
      `SELECT ${portfolioDailyCols} FROM portfolio_snapshots WHERE wallet = ? AND timestamp >= ? GROUP BY ${portfolioDayBucket} ORDER BY timestamp ASC`,
    );
    this.queryPortfolioDailyToStmt = this.db.prepare(
      `SELECT ${portfolioDailyCols} FROM portfolio_snapshots WHERE wallet = ? AND timestamp <= ? GROUP BY ${portfolioDayBucket} ORDER BY timestamp ASC`,
    );
    this.queryPortfolioDailyRangeStmt = this.db.prepare(
      `SELECT ${portfolioDailyCols} FROM portfolio_snapshots WHERE wallet = ? AND timestamp >= ? AND timestamp <= ? GROUP BY ${portfolioDayBucket} ORDER BY timestamp ASC`,
    );
    this.prunePortfolioStmt = this.db.prepare(
      'DELETE FROM portfolio_snapshots WHERE timestamp < ?',
    );

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS health_factor_samples (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet        TEXT    NOT NULL,
        position_id   TEXT    NOT NULL,
        timestamp     INTEGER NOT NULL,
        health_factor REAL    NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_health_factor_unique
        ON health_factor_samples (wallet, position_id, timestamp);
    `);
    const healthFactorTableInfo = this.db
      .prepare('PRAGMA table_info(health_factor_samples)')
      .all() as Array<{ name: string }>;
    if (!healthFactorTableInfo.some((column) => column.name === 'debt_usd')) {
      this.db.exec('ALTER TABLE health_factor_samples ADD COLUMN debt_usd REAL');
    }
    this.insertHealthFactorStmt = this.db.prepare(`
      INSERT INTO health_factor_samples (wallet, position_id, timestamp, health_factor, debt_usd)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (wallet, position_id, timestamp)
      DO UPDATE SET health_factor = excluded.health_factor, debt_usd = excluded.debt_usd
    `);
    this.queryHealthFactorStmt = this.db.prepare(
      'SELECT timestamp, health_factor FROM health_factor_samples WHERE wallet = ? AND position_id = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC',
    );
    // Portfolio HF is the debt-weighted average of loan HFs. Each loan contributes its latest
    // sample per hour; samples without a recorded debt (written before debt was stored) are left
    // out of the average.
    this.queryPortfolioHealthFactorStmt = this.db.prepare(`
      SELECT MAX(timestamp) AS timestamp, SUM(health_factor * debt_usd) / SUM(debt_usd) AS health_factor
      FROM (
        SELECT MAX(timestamp) AS timestamp, health_factor, debt_usd, CAST(timestamp / 3600000 AS INTEGER) AS hour
        FROM health_factor_samples
        WHERE wallet = ? AND timestamp >= ? AND timestamp <= ?
        GROUP BY position_id, hour
      )
      WHERE debt_usd > 0
      GROUP BY hour
      ORDER BY timestamp ASC
    `);
    this.pruneHealthFactorStmt = this.db.prepare(
      'DELETE FROM health_factor_samples WHERE timestamp < ?',
    );
  }

  /** Debt-free positions have an infinite HF and are not recorded. */
  appendHealthFactorSample(
    wallet: string,
    positionId: string,
    timestampMs: number,
    healthFactor: number,
    debtUsd: number,
  ): void {
    if (!Number.isFinite(healthFactor)) return;
    this.insertHealthFactorStmt.run(
      wallet.toLowerCase(),
      positionId,
      timestampMs,
      healthFactor,
      debtUsd,
    );
  }

  queryHealthFactorSamples(
    wallet: string,
    positionId: string,
    fromMs = 0,
    toMs = Number.MAX_SAFE_INTEGER,
  ): HealthFactorSample[] {
    const rows = this.queryHealthFactorStmt.all(
      wallet.toLowerCase(),
      positionId,
      fromMs,
      toMs,
    ) as Array<{ timestamp: number; health_factor: number }>;
    return rows.map((r) => ({ timestamp: r.timestamp, healthFactor: r.health_factor }));
  }

  queryPortfolioHealthFactor(
    wallet: string,
    fromMs = 0,
    toMs = Number.MAX_SAFE_INTEGER,
  ): HealthFactorSample[] {
    const rows = this.queryPortfolioHealthFactorStmt.all(
      wallet.toLowerCase(),
      fromMs,
      toMs,
    ) as Array<{ timestamp: number; health_factor: number }>;
    return rows.map((r) => ({ timestamp: r.timestamp, healthFactor: r.health_factor }));
  }

  appendPortfolioSnapshot(
    wallet: string,
    timestampMs: number,
    totalDebt: number,
    totalAssets: number,
    netWorth: number,
  ): void {
    this.insertPortfolioStmt.run(
      wallet.toLowerCase(),
      timestampMs,
      totalDebt,
      totalAssets,
      netWorth,
    );
  }

  queryPortfolioSnapshots(
    wallet: string,
    fromMs?: number,
    toMs?: number,
    bucket: 'raw' | 'day' = 'raw',
  ): PortfolioSnapshot[] {
    type Row = {
      timestamp: number;
      total_debt: number;
      total_assets: number;
      net_worth: number;
    };
    const w = wallet.toLowerCase();
    const stmts =
      bucket === 'day'
        ? {
            all: this.queryPortfolioDailyStmt,
            from: this.queryPortfolioDailyFromStmt,
            to: this.queryPortfolioDailyToStmt,
            range: this.queryPortfolioDailyRangeStmt,
          }
        : {
            all: this.queryPortfolioStmt,
            from: this.queryPortfolioFromStmt,
            to: this.queryPortfolioToStmt,
            range: this.queryPortfolioRangeStmt,
          };
    let rows: Row[];
    if (fromMs != null && toMs != null) {
      rows = stmts.range.all(w, fromMs, toMs) as Row[];
    } else if (fromMs != null) {
      rows = stmts.from.all(w, fromMs) as Row[];
    } else if (toMs != null) {
      rows = stmts.to.all(w, toMs) as Row[];
    } else {
      rows = stmts.all.all(w) as Row[];
    }
    return rows.map((r) => ({
      timestamp: r.timestamp,
      totalDebt: r.total_debt,
      totalAssets: r.total_assets,
      netWorth: r.net_worth,
    }));
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

  queryInterestSnapshots(
    wallet: string,
    positionId: string,
    kind: InterestKind,
    fromMs?: number,
    toMs?: number,
    bucket: 'raw' | 'day' = 'raw',
  ): InterestSnapshot[] {
    type Row = { timestamp: number; cumulative_usd: number; label: string | null };
    const w = wallet.toLowerCase();
    const stmts =
      bucket === 'day'
        ? {
            all: this.queryInterestDailyStmt,
            from: this.queryInterestDailyFromStmt,
            to: this.queryInterestDailyToStmt,
            range: this.queryInterestDailyRangeStmt,
          }
        : {
            all: this.queryInterestStmt,
            from: this.queryInterestFromStmt,
            to: this.queryInterestToStmt,
            range: this.queryInterestRangeStmt,
          };
    let rows: Row[];
    if (fromMs != null && toMs != null) {
      rows = stmts.range.all(w, positionId, kind, fromMs, toMs) as Row[];
    } else if (fromMs != null) {
      rows = stmts.from.all(w, positionId, kind, fromMs) as Row[];
    } else if (toMs != null) {
      rows = stmts.to.all(w, positionId, kind, toMs) as Row[];
    } else {
      rows = stmts.all.all(w, positionId, kind) as Row[];
    }
    return rows.map((r) => ({
      timestamp: r.timestamp,
      cumulativeUsd: r.cumulative_usd,
      label: r.label,
    }));
  }

  /** Every position with recorded interest, including ones that have since been closed. */
  queryInterestPositionIds(wallet: string, kind: InterestKind): string[] {
    const rows = this.queryInterestPositionIdsStmt.all(wallet.toLowerCase(), kind) as Array<{
      position_id: string;
    }>;
    return rows.map((r) => r.position_id);
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
    const portfolioResult = this.prunePortfolioStmt.run(cutoff);
    const healthFactorResult = this.pruneHealthFactorStmt.run(cutoff);
    return (
      result.changes + interestResult.changes + portfolioResult.changes + healthFactorResult.changes
    );
  }

  close(): void {
    this.db.close();
  }
}
