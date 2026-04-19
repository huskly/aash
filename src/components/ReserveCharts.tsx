import { useMemo, useState } from 'react';
import {
  buildVariableBorrowCurve,
  type InterestRateCurvePoint,
  type ReserveTelemetry,
} from '@aave-monitor/core';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';

export type BorrowRateSample = {
  timestamp: string;
  variableBorrowRate: number;
  utilizationRate: number;
};

type HistoryWindow = '24h' | '7d' | '30d' | '90d' | '180d';

const HISTORY_WINDOWS: Array<{ value: HistoryWindow; label: string; durationMs: number }> = [
  { value: '24h', label: '24h', durationMs: 24 * 60 * 60 * 1000 },
  { value: '7d', label: '7d', durationMs: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: '30d', durationMs: 30 * 24 * 60 * 60 * 1000 },
  { value: '90d', label: '90d', durationMs: 90 * 24 * 60 * 60 * 1000 },
  { value: '180d', label: '6m', durationMs: 180 * 24 * 60 * 60 * 1000 },
];

function fmtPct(value: number, digits = 2): string {
  const scale = 10 ** digits;
  const truncated = Math.trunc(value * 100 * scale) / scale;
  return `${truncated.toFixed(digits)}%`;
}

const CHART_COLORS = {
  borrow: '#e255bc',
  supply: 'rgba(226, 236, 244, 0.65)',
  current: 'rgba(40, 153, 255, 0.9)',
  optimal: 'rgba(40, 153, 255, 0.6)',
  grid: 'rgba(139, 158, 179, 0.15)',
  axis: 'rgba(139, 158, 179, 0.85)',
  average: 'rgba(226, 236, 244, 0.55)',
};

const CHART_STYLE = {
  background: 'transparent',
  fontSize: 12,
  fontFamily: 'inherit',
};

function PctTooltip({
  active,
  payload,
  label,
  labelFormatter,
}: {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string | number;
  labelFormatter?: (label: string | number) => string;
}) {
  if (!active || !payload?.length) return null;
  const displayLabel = labelFormatter ? labelFormatter(label ?? '') : String(label ?? '');
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg">
      {displayLabel && <p className="mb-1 font-medium text-muted-foreground">{displayLabel}</p>}
      {payload.map((entry) => (
        <p key={entry.name} style={{ color: entry.color }} className="font-semibold">
          {entry.name}: {fmtPct(entry.value)}
        </p>
      ))}
    </div>
  );
}

export function UtilizationCurveCard({ reserve }: { reserve: ReserveTelemetry }) {
  const curve = useMemo(() => buildVariableBorrowCurve(reserve, 64), [reserve]);

  const data = useMemo(
    () =>
      curve.map((point: InterestRateCurvePoint) => ({
        utilizationRate: point.utilizationRate,
        borrowRate: point.variableBorrowRate,
      })),
    [curve],
  );

  const maxRate = useMemo(() => {
    const curveMax = Math.max(...curve.map((p: InterestRateCurvePoint) => p.variableBorrowRate));
    return Math.max(curveMax * 1.12, 0.05);
  }, [curve]);

  const yTicks = useMemo(() => {
    const step = maxRate / 4;
    return Array.from({ length: 5 }, (_, i) => Math.round(i * step * 10000) / 10000);
  }, [maxRate]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Interest Rate Model</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1 sm:grid-cols-3">
          <Stat label="Utilization" value={fmtPct(reserve.utilizationRate)} />
          <Stat label="Borrow APR" value={fmtPct(reserve.variableBorrowRate)} />
          <Stat label="Optimal Utilization" value={fmtPct(reserve.optimalUsageRatio)} />
        </div>

        <ResponsiveContainer width="100%" height={280}>
          <LineChart
            data={data}
            style={CHART_STYLE}
            margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
          >
            <CartesianGrid strokeDasharray="5 5" stroke={CHART_COLORS.grid} vertical={false} />
            <XAxis
              dataKey="utilizationRate"
              type="number"
              domain={[0, 1]}
              tickFormatter={(v) => fmtPct(v, 0)}
              ticks={[0, 0.25, 0.5, 0.75, 1]}
              tick={{ fill: CHART_COLORS.axis, fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: CHART_COLORS.grid }}
            />
            <YAxis
              domain={[0, maxRate]}
              tickFormatter={(v) => fmtPct(v, 0)}
              ticks={yTicks}
              tick={{ fill: CHART_COLORS.axis, fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <Tooltip
              content={<PctTooltip labelFormatter={(v) => `Utilization: ${fmtPct(Number(v))}`} />}
              cursor={{ stroke: 'rgba(139, 158, 179, 0.4)', strokeWidth: 1 }}
            />
            <ReferenceLine
              x={reserve.optimalUsageRatio}
              stroke={CHART_COLORS.optimal}
              strokeDasharray="4 4"
              label={{
                value: `Optimal ${fmtPct(reserve.optimalUsageRatio)}`,
                position: 'insideTopRight',
                fill: 'rgba(139, 158, 179, 0.95)',
                fontSize: 11,
                offset: 6,
              }}
            />
            <ReferenceLine
              x={reserve.utilizationRate}
              stroke={CHART_COLORS.current}
              strokeDasharray="4 4"
              label={{
                value: `Current ${fmtPct(reserve.utilizationRate)}`,
                position: 'insideTopLeft',
                fill: 'rgba(226, 236, 244, 0.95)',
                fontSize: 11,
                offset: 6,
              }}
            />
            <Line
              type="monotone"
              dataKey="borrowRate"
              name="Borrow APR"
              stroke={CHART_COLORS.borrow}
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 5, fill: CHART_COLORS.borrow, stroke: '#0a1220', strokeWidth: 2 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

// Morpho Blue AdaptiveCurveIRM constants
const MORPHO_TARGET_UTIL = 0.9;
const MORPHO_CURVE_STEEPNESS = 4;
const MORPHO_IRM_SAMPLES = 80;

function morphoBorrowRate(rateAtTarget: number, u: number): number {
  if (u <= MORPHO_TARGET_UTIL) {
    return rateAtTarget * (u / MORPHO_TARGET_UTIL);
  }
  const err = (u - MORPHO_TARGET_UTIL) / (1 - MORPHO_TARGET_UTIL);
  return rateAtTarget * (1 + MORPHO_CURVE_STEEPNESS * err);
}

function inferMorphoRateAtTarget(borrowRate: number, utilization: number): number {
  if (utilization <= MORPHO_TARGET_UTIL) {
    return utilization > 0 ? borrowRate / (utilization / MORPHO_TARGET_UTIL) : borrowRate;
  }
  const err = (utilization - MORPHO_TARGET_UTIL) / (1 - MORPHO_TARGET_UTIL);
  return borrowRate / (1 + MORPHO_CURVE_STEEPNESS * err);
}

export function MorphoIrmCard({
  borrowRate,
  utilizationRate,
  lltv,
  supplyApy,
}: {
  borrowRate: number;
  utilizationRate: number;
  lltv: number;
  supplyApy?: number;
}) {
  const rateAtTarget = useMemo(
    () => inferMorphoRateAtTarget(borrowRate, utilizationRate),
    [borrowRate, utilizationRate],
  );

  const feeFactor = useMemo(() => {
    if (supplyApy == null || borrowRate <= 0 || utilizationRate <= 0) return null;
    return supplyApy / (borrowRate * utilizationRate);
  }, [supplyApy, borrowRate, utilizationRate]);

  const { data, maxRate } = useMemo(() => {
    const samples = Array.from(
      { length: MORPHO_IRM_SAMPLES + 1 },
      (_, i) => i / MORPHO_IRM_SAMPLES,
    );
    const maxBorrow = morphoBorrowRate(rateAtTarget, 1);
    const maxSupply = feeFactor != null ? maxBorrow * feeFactor : 0;
    const max = Math.max(maxBorrow, maxSupply, 0.02) * 1.12;

    return {
      data: samples.map((u) => ({
        utilizationRate: u,
        borrowRate: morphoBorrowRate(rateAtTarget, u),
        supplyApy:
          feeFactor != null ? morphoBorrowRate(rateAtTarget, u) * u * feeFactor : undefined,
      })),
      maxRate: max,
    };
  }, [rateAtTarget, feeFactor]);

  const yTicks = useMemo(() => {
    const step = maxRate / 4;
    return Array.from({ length: 5 }, (_, i) => Math.round(i * step * 10000) / 10000);
  }, [maxRate]);

  const hasSupply = feeFactor != null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Interest Rate Model</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1 sm:grid-cols-4">
          <Stat label="Target Utilization" value={fmtPct(MORPHO_TARGET_UTIL)} />
          <Stat label="Current Utilization" value={fmtPct(utilizationRate)} />
          <Stat label="Rate at Target" value={fmtPct(rateAtTarget)} />
          <Stat label="Borrow APR" value={fmtPct(borrowRate)} />
        </div>

        <ResponsiveContainer width="100%" height={280}>
          <LineChart
            data={data}
            style={CHART_STYLE}
            margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
          >
            <CartesianGrid strokeDasharray="5 5" stroke={CHART_COLORS.grid} vertical={false} />
            <XAxis
              dataKey="utilizationRate"
              type="number"
              domain={[0, 1]}
              tickFormatter={(v) => fmtPct(v, 0)}
              ticks={[0, 0.25, 0.5, 0.75, 1]}
              tick={{ fill: CHART_COLORS.axis, fontSize: 12 }}
              tickLine={false}
              axisLine={{ stroke: CHART_COLORS.grid }}
            />
            <YAxis
              domain={[0, maxRate]}
              tickFormatter={(v) => fmtPct(v, 0)}
              ticks={yTicks}
              tick={{ fill: CHART_COLORS.axis, fontSize: 12 }}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <Tooltip
              content={<PctTooltip labelFormatter={(v) => `Utilization: ${fmtPct(Number(v))}`} />}
              cursor={{ stroke: 'rgba(139, 158, 179, 0.4)', strokeWidth: 1 }}
            />
            {hasSupply && <Legend wrapperStyle={{ fontSize: 12, color: CHART_COLORS.axis }} />}
            <ReferenceLine
              x={MORPHO_TARGET_UTIL}
              stroke={CHART_COLORS.optimal}
              strokeDasharray="4 4"
              label={{
                value: `Target ${fmtPct(MORPHO_TARGET_UTIL)}`,
                position: 'insideTopRight',
                fill: 'rgba(139, 158, 179, 0.95)',
                fontSize: 11,
                offset: 6,
              }}
            />
            <ReferenceLine
              x={utilizationRate}
              stroke={CHART_COLORS.current}
              strokeDasharray="4 4"
              label={{
                value: `Current ${fmtPct(utilizationRate)}`,
                position: 'insideTopLeft',
                fill: 'rgba(226, 236, 244, 0.95)',
                fontSize: 11,
                offset: 6,
              }}
            />
            {hasSupply && (
              <Line
                type="monotone"
                dataKey="supplyApy"
                name="Supply APY"
                stroke={CHART_COLORS.supply}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: CHART_COLORS.supply, stroke: '#0a1220', strokeWidth: 2 }}
              />
            )}
            <Line
              type="monotone"
              dataKey="borrowRate"
              name="Borrow APR"
              stroke={CHART_COLORS.borrow}
              strokeWidth={2.5}
              dot={false}
              activeDot={{ r: 5, fill: CHART_COLORS.borrow, stroke: '#0a1220', strokeWidth: 2 }}
            />
          </LineChart>
        </ResponsiveContainer>

        <p className="text-xs text-muted-foreground">
          Morpho Adaptive IRM · LLTV {fmtPct(lltv)} · Rate at target adjusts over time based on
          whether utilization stays above or below 90%.
        </p>
      </CardContent>
    </Card>
  );
}

export function BorrowRateHistoryCard({
  samples,
  reserve,
  currentTimeMs,
}: {
  samples: BorrowRateSample[];
  reserve: ReserveTelemetry | null;
  currentTimeMs: number;
}) {
  const [windowValue, setWindowValue] = useState<HistoryWindow>('180d');

  const filteredSamples = useMemo(() => {
    const selectedWindow = HISTORY_WINDOWS.find((entry) => entry.value === windowValue);
    if (!selectedWindow) return samples;
    const cutoff = currentTimeMs - selectedWindow.durationMs;
    return samples.filter((sample) => {
      const timestamp = new Date(sample.timestamp).getTime();
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    });
  }, [currentTimeMs, samples, windowValue]);

  const { data, averageRate, lastRate, maxRate } = useMemo(() => {
    if (filteredSamples.length === 0)
      return { data: [], averageRate: 0, lastRate: 0, maxRate: 0.02 };

    const avg =
      filteredSamples.reduce((sum, s) => sum + s.variableBorrowRate, 0) / filteredSamples.length;
    const last = filteredSamples.at(-1)?.variableBorrowRate ?? 0;
    const max = Math.max(
      ...filteredSamples.map((s) => s.variableBorrowRate),
      reserve?.variableBorrowRate ?? 0,
      0.02,
    );

    return {
      data: filteredSamples.map((s) => ({
        timestamp: new Date(s.timestamp).getTime(),
        borrowRate: s.variableBorrowRate,
      })),
      averageRate: avg,
      lastRate: last,
      maxRate: max * 1.1,
    };
  }, [filteredSamples, reserve?.variableBorrowRate]);

  const yTicks = useMemo(() => {
    const step = maxRate / 4;
    return Array.from({ length: 5 }, (_, i) => Math.round(i * step * 10000) / 10000);
  }, [maxRate]);

  const xTickFormatter = useMemo(() => {
    if (data.length < 2) return (v: number) => String(v);
    const spanMs = data[data.length - 1]!.timestamp - data[0]!.timestamp;
    const oneDayMs = 24 * 60 * 60 * 1000;
    if (spanMs <= oneDayMs) {
      return (v: number) =>
        new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return (v: number) => new Date(v).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }, [data]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Borrow APR History</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Sampled from reserve telemetry by the server and tracked over time.
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {HISTORY_WINDOWS.map((entry) => (
            <Button
              key={entry.value}
              type="button"
              size="sm"
              variant={windowValue === entry.value ? 'default' : 'secondary'}
              onClick={() => setWindowValue(entry.value)}
            >
              {entry.label}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {filteredSamples.length >= 2 ? (
          <>
            <div className="grid gap-1 sm:grid-cols-3">
              <Stat label="Latest APR" value={fmtPct(lastRate)} />
              <Stat label="Average APR" value={fmtPct(averageRate)} />
              <Stat label="Samples" value={filteredSamples.length.toLocaleString()} />
            </div>

            <ResponsiveContainer width="100%" height={280}>
              <LineChart
                data={data}
                style={CHART_STYLE}
                margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
              >
                <CartesianGrid strokeDasharray="5 5" stroke={CHART_COLORS.grid} vertical={false} />
                <XAxis
                  dataKey="timestamp"
                  type="number"
                  scale="time"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={xTickFormatter}
                  tick={{ fill: CHART_COLORS.axis, fontSize: 12 }}
                  tickLine={false}
                  axisLine={{ stroke: CHART_COLORS.grid }}
                  minTickGap={60}
                />
                <YAxis
                  domain={[0, maxRate]}
                  tickFormatter={(v) => fmtPct(v, 0)}
                  ticks={yTicks}
                  tick={{ fill: CHART_COLORS.axis, fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  width={40}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const point = payload[0];
                    const ts = point?.payload?.timestamp as number | undefined;
                    return (
                      <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg">
                        {ts && (
                          <p className="mb-1 font-medium text-muted-foreground">
                            {new Date(ts).toLocaleString([], {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </p>
                        )}
                        <p style={{ color: CHART_COLORS.borrow }} className="font-semibold">
                          Borrow APR: {fmtPct(Number(point?.value ?? 0))}
                        </p>
                      </div>
                    );
                  }}
                  cursor={{ stroke: 'rgba(139, 158, 179, 0.4)', strokeWidth: 1 }}
                />
                <ReferenceLine
                  y={averageRate}
                  stroke={CHART_COLORS.average}
                  strokeDasharray="6 5"
                  label={{
                    value: `Avg ${fmtPct(averageRate)}`,
                    position: 'insideTopRight',
                    fill: 'rgba(226, 236, 244, 0.65)',
                    fontSize: 11,
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="borrowRate"
                  name="Borrow APR"
                  stroke={CHART_COLORS.borrow}
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 5, fill: CHART_COLORS.borrow, stroke: '#0a1220', strokeWidth: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </>
        ) : (
          <div className="rounded-lg border border-border bg-accent px-4 py-5 text-sm text-muted-foreground">
            Borrow APR history needs at least two reserve snapshots. Keep the dashboard running and
            refreshing to build the chart over time.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border bg-accent px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tracking-tight">{value}</p>
    </div>
  );
}
