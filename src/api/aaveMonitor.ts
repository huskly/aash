import { type AssetPosition, type ReserveTelemetry } from '@aave-monitor/core';

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
