import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider } from 'ethers';
import { backfillMorphoHealthFactor } from '../healthFactorBackfill.js';
import { RateHistoryDb } from '../rateHistoryDb.js';

const USAGE =
  'Usage: ARCHIVE_RPC_URL=<url> backfill-health-factor <wallet> [--days <n>] [--db <path>]';

function parseArgs(argv: string[]): { wallet: string; days: number; dbPath: string } {
  const args = [...argv];
  let wallet = '';
  let days = 180;
  let dbPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'rates.db');

  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === '--days') {
      days = Number(args.shift());
      if (!Number.isInteger(days) || days <= 0)
        throw new Error('--days expects a positive integer.');
    } else if (arg === '--db') {
      dbPath = args.shift() ?? '';
    } else if (/^0x[a-fA-F0-9]{40}$/.test(arg) && !wallet) {
      wallet = arg;
    } else {
      throw new Error(`Unexpected argument '${arg}'.\n${USAGE}`);
    }
  }
  if (!wallet || !dbPath) throw new Error(USAGE);
  return { wallet, days, dbPath };
}

const { wallet, days, dbPath } = parseArgs(process.argv.slice(2));
const rpcUrl = process.env.ARCHIVE_RPC_URL;
if (!rpcUrl) throw new Error(`ARCHIVE_RPC_URL is not set.\n${USAGE}`);

const db = new RateHistoryDb(dbPath);
try {
  const result = await backfillMorphoHealthFactor(
    wallet,
    new JsonRpcProvider(rpcUrl, 1, { staticNetwork: true, batchMaxCount: 1 }),
    db,
    days,
    console.log,
  );
  console.log(`Wrote ${result.samples} samples across ${result.markets} market(s) to ${dbPath}`);
} finally {
  db.close();
}
