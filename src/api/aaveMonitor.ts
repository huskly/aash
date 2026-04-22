import { type AssetPosition, type ReserveTelemetry } from '@aave-monitor/core';
import type { BorrowRateSample } from '../components/ReserveCharts';

type RateHistoryResponse = {
  samples: Array<{ timestamp: number; borrowRate: number; supplyRate: number }>;
};

export async function fetchBorrowRateHistory(
  wallet: string,
  loanId: string,
  fromMs?: number,
  toMs?: number,
): Promise<BorrowRateSample[]> {
  const params = new URLSearchParams({ wallet, loanId });
  if (fromMs != null) params.set('from', String(fromMs));
  if (toMs != null) params.set('to', String(toMs));

  const res = await fetch(`/api/rates/history?${params.toString()}`);
  if (!res.ok) return [];

  const data = (await res.json()) as RateHistoryResponse;
  return data.samples.map((s) => ({
    timestamp: new Date(s.timestamp).toISOString(),
    variableBorrowRate: s.borrowRate,
    utilizationRate: 0,
  }));
}

export type InterestSnapshot = {
  timestamp: number;
  cumulativeUsd: number;
  deltaUsd: number;
  label: string | null;
};

export async function fetchInterestHistory(
  wallet: string,
  positionId: string,
  kind: 'loan' | 'vault',
  fromMs?: number,
  toMs?: number,
): Promise<InterestSnapshot[]> {
  const params = new URLSearchParams({ wallet, positionId, kind });
  if (fromMs != null) params.set('from', String(fromMs));
  if (toMs != null) params.set('to', String(toMs));

  const res = await fetch(`/api/interest/history?${params.toString()}`);
  if (!res.ok) return [];

  const data = (await res.json()) as { snapshots: InterestSnapshot[] };
  return data.snapshots;
}

export async function fetchWalletAssetBalances(
  wallet: string,
  assets: AssetPosition[],
): Promise<Map<string, number>> {
  const tokens = Array.from(
    new Map(
      assets.map((asset) => [
        asset.address.toLowerCase(),
        { address: asset.address.toLowerCase(), decimals: asset.decimals },
      ]),
    ).values(),
  );
  if (tokens.length === 0) return new Map();

  const res = await fetch(`/api/balances/${wallet}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tokens }),
  });
  if (!res.ok) return new Map();
  const data = (await res.json()) as Record<string, number>;
  return new Map(Object.entries(data).map(([address, amount]) => [address.toLowerCase(), amount]));
}

export async function fetchReserveTelemetry(
  marketName: string,
  assetAddress: string,
  symbol: string,
): Promise<ReserveTelemetry> {
  const params = new URLSearchParams({
    market: marketName,
    asset: assetAddress,
    symbol,
  });
  const res = await fetch(`/api/reserves/telemetry?${params.toString()}`);
  if (!res.ok) {
    throw new Error('Reserve telemetry is unavailable. Start the API server to enable the charts.');
  }

  return (await res.json()) as ReserveTelemetry;
}
