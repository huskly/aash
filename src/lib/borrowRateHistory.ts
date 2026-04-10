import { type BorrowRateSample } from '../components/ReserveCharts';

const BORROW_RATE_HISTORY_STORAGE_PREFIX = 'aave-monitor:borrow-apr-history';
const BORROW_RATE_SAMPLE_INTERVAL_MS = 15 * 60 * 1000;
const MAX_BORROW_RATE_SAMPLES = 2_000;

export function buildBorrowRateHistoryKey(marketName: string, assetAddress: string): string {
  return `${BORROW_RATE_HISTORY_STORAGE_PREFIX}:${marketName}:${assetAddress.toLowerCase()}`;
}

export function readBorrowRateHistory(storageKey: string): BorrowRateSample[] {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];

    const parsed = JSON.parse(raw) as BorrowRateSample[];
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (entry) =>
        typeof entry?.timestamp === 'string' &&
        typeof entry?.variableBorrowRate === 'number' &&
        typeof entry?.utilizationRate === 'number',
    );
  } catch {
    return [];
  }
}

export function writeBorrowRateHistory(storageKey: string, samples: BorrowRateSample[]): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(samples));
  } catch {
    // Ignore storage errors.
  }
}

export function appendBorrowRateSample(
  samples: BorrowRateSample[],
  nextSample: BorrowRateSample,
): BorrowRateSample[] {
  const nextTimestamp = new Date(nextSample.timestamp).getTime();
  if (!Number.isFinite(nextTimestamp)) return samples;

  const previous = samples.at(-1);
  if (previous) {
    const previousTimestamp = new Date(previous.timestamp).getTime();
    if (
      Number.isFinite(previousTimestamp) &&
      nextTimestamp - previousTimestamp < BORROW_RATE_SAMPLE_INTERVAL_MS
    ) {
      const updated = [...samples.slice(0, -1), nextSample];
      return updated.slice(-MAX_BORROW_RATE_SAMPLES);
    }
  }

  return [...samples, nextSample].slice(-MAX_BORROW_RATE_SAMPLES);
}
