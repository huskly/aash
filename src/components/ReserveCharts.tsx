import { useMemo, useState } from 'react';
import {
  buildVariableBorrowCurve,
  isMidnightLoan,
  type InterestRateCurvePoint,
  type LoanPosition,
  type ReserveTelemetry,
} from '@aave-monitor/core';
import {
  LineChart,
  Line,
  Bar,
  ComposedChart,
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
import { Stat } from './Stat';
import { fmtUsd } from './chartFormat';
import type { InterestSnapshot } from '../api/aaveMonitor';
import { SensitiveBlock, SensitiveValue } from './dashboard/privacy';

export type BorrowRateSample = {
  timestamp: string;
  variableBorrowRate: number;
  utilizationRate: number;
};

type HistoryWindow = '24h' | '7d' | '30d' | '90d' | '180d';
type LoanChartTab = 'model' | 'borrowApr' | 'dailyInterest';

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
  return (
    <Card>
      <CardHeader>
        <CardTitle>Interest Rate Model</CardTitle>
      </CardHeader>
      <UtilizationCurveContent reserve={reserve} />
    </Card>
  );
}

function UtilizationCurveContent({ reserve }: { reserve: ReserveTelemetry }) {
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
  return (
    <Card>
      <CardHeader>
        <CardTitle>Interest Rate Model</CardTitle>
      </CardHeader>
      <MorphoIrmContent
        borrowRate={borrowRate}
        utilizationRate={utilizationRate}
        lltv={lltv}
        supplyApy={supplyApy}
      />
    </Card>
  );
}

function MorphoIrmContent({
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
  );
}

export function BorrowRateHistoryCard({
  samples,
  reserve,
  currentTimeMs,
  title = 'Borrow APR History',
  description = 'Sampled from reserve telemetry by the server and tracked over time.',
  rateLabel = 'Borrow APR',
  emptyMessage = 'Borrow APR history needs at least two reserve snapshots. Keep the dashboard running and refreshing to build the chart over time.',
}: {
  samples: BorrowRateSample[];
  reserve: ReserveTelemetry | null;
  currentTimeMs: number;
  title?: string;
  description?: string;
  rateLabel?: string;
  emptyMessage?: string;
}) {
  const [windowValue, setWindowValue] = useState<HistoryWindow>('180d');

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{title}</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
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
      <BorrowRateHistoryContent
        currentTimeMs={currentTimeMs}
        emptyMessage={emptyMessage}
        rateLabel={rateLabel}
        reserve={reserve}
        samples={samples}
        windowValue={windowValue}
      />
    </Card>
  );
}

function BorrowRateHistoryContent({
  samples,
  reserve,
  currentTimeMs,
  windowValue,
  rateLabel,
  emptyMessage,
}: {
  samples: BorrowRateSample[];
  reserve: ReserveTelemetry | null;
  currentTimeMs: number;
  windowValue: HistoryWindow;
  rateLabel: string;
  emptyMessage: string;
}) {
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
                        {rateLabel}: {fmtPct(Number(point?.value ?? 0))}
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
                type="natural"
                dataKey="borrowRate"
                name={rateLabel}
                stroke={CHART_COLORS.borrow}
                strokeWidth={2.5}
                dot={false}
                isAnimationActive={false}
                activeDot={{ r: 5, fill: CHART_COLORS.borrow, stroke: '#0a1220', strokeWidth: 2 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </>
      ) : (
        <div className="rounded-lg border border-border bg-accent px-4 py-5 text-sm text-muted-foreground">
          {emptyMessage}
        </div>
      )}
    </CardContent>
  );
}

type InterestHistoryWindow = '7d' | '30d' | '90d' | '180d';

const INTEREST_WINDOWS: Array<{ value: InterestHistoryWindow; label: string; durationMs: number }> =
  [
    { value: '7d', label: '7d', durationMs: 7 * 24 * 60 * 60 * 1000 },
    { value: '30d', label: '30d', durationMs: 30 * 24 * 60 * 60 * 1000 },
    { value: '90d', label: '90d', durationMs: 90 * 24 * 60 * 60 * 1000 },
    { value: '180d', label: '6m', durationMs: 180 * 24 * 60 * 60 * 1000 },
  ];

export function InterestAccrualHistoryCard({
  hideSensitiveValues = false,
  snapshots,
  kind,
  title,
  description,
  currentTimeMs,
}: {
  hideSensitiveValues?: boolean;
  snapshots: InterestSnapshot[];
  kind: 'loan' | 'vault';
  title?: string;
  description?: string;
  currentTimeMs: number;
}) {
  const [windowValue, setWindowValue] = useState<InterestHistoryWindow>('30d');

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>
            {title ?? (kind === 'loan' ? 'Daily Borrow Interest' : 'Daily Earnings')}
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {description ??
              (kind === 'loan'
                ? 'Daily borrow interest accrued, derived from Morpho cumulative PnL.'
                : 'Daily supply earnings, derived from Morpho cumulative vault PnL.')}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-1">
          {INTEREST_WINDOWS.map((entry) => (
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
      <InterestAccrualHistoryContent
        currentTimeMs={currentTimeMs}
        hideSensitiveValues={hideSensitiveValues}
        kind={kind}
        snapshots={snapshots}
        windowValue={windowValue}
      />
    </Card>
  );
}

export function LoanPositionChartsCard({
  hideSensitiveValues,
  borrowRateHistory,
  loanInterestHistory,
  currentTimeMs,
  reserveTelemetry,
  reserveTelemetryError,
  selectedLoan,
}: {
  hideSensitiveValues: boolean;
  borrowRateHistory: BorrowRateSample[];
  loanInterestHistory: InterestSnapshot[];
  currentTimeMs: number;
  reserveTelemetry: ReserveTelemetry | null;
  reserveTelemetryError: string;
  selectedLoan: LoanPosition | null;
}) {
  const [activeTab, setActiveTab] = useState<LoanChartTab>('model');
  const [windowValue, setWindowValue] = useState<HistoryWindow>('180d');
  const isMorphoLoan = selectedLoan?.marketName.startsWith('morpho_') ?? false;
  const isFixedRateLoan = selectedLoan ? isMidnightLoan(selectedLoan) : false;
  const description =
    activeTab === 'model'
      ? 'Current utilization mapped against the market borrow APR curve.'
      : activeTab === 'borrowApr'
        ? 'Borrow APR sampled from reserve telemetry by the server and tracked over time.'
        : isFixedRateLoan
          ? 'Daily borrow interest, spread in equal daily amounts until maturity.'
          : 'Daily borrow interest accrued, derived from Morpho cumulative PnL.';

  const primaryBorrow =
    selectedLoan?.borrowed.reduce<LoanPosition['borrowed'][number] | null>(
      (max, borrowed) => (!max || borrowed.usdValue > max.usdValue ? borrowed : max),
      null,
    ) ?? null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Loan Position Charts</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <div className="grid justify-items-end gap-2">
          <div className="flex rounded-lg border border-border bg-secondary p-1">
            <Button
              type="button"
              size="sm"
              variant={activeTab === 'model' ? 'default' : 'ghost'}
              onClick={() => setActiveTab('model')}
            >
              Rate Model
            </Button>
            <Button
              type="button"
              size="sm"
              variant={activeTab === 'borrowApr' ? 'default' : 'ghost'}
              onClick={() => setActiveTab('borrowApr')}
            >
              Borrow APR
            </Button>
            <Button
              type="button"
              size="sm"
              variant={activeTab === 'dailyInterest' ? 'default' : 'ghost'}
              onClick={() => setActiveTab('dailyInterest')}
            >
              Daily Interest
            </Button>
          </div>
          {activeTab !== 'model' ? (
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
          ) : null}
        </div>
      </CardHeader>

      {activeTab === 'model' ? (
        reserveTelemetry ? (
          <UtilizationCurveContent reserve={reserveTelemetry} />
        ) : isFixedRateLoan ? (
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Fixed-rate Midnight loan: the rate is locked until maturity, so there is no rate
              model.
            </p>
          </CardContent>
        ) : isMorphoLoan && primaryBorrow ? (
          <MorphoIrmContent
            borrowRate={primaryBorrow.borrowRate}
            utilizationRate={selectedLoan?.utilizationRate ?? 0}
            lltv={selectedLoan?.supplied[0]?.liqThreshold ?? 0}
            supplyApy={selectedLoan?.marketSupplyApy}
          />
        ) : (
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {reserveTelemetryError || 'Interest rate model telemetry is not available.'}
            </p>
          </CardContent>
        )
      ) : activeTab === 'borrowApr' ? (
        <BorrowRateHistoryContent
          currentTimeMs={currentTimeMs}
          emptyMessage="Borrow APR history needs at least two reserve snapshots. Keep the dashboard running and refreshing to build the chart over time."
          rateLabel="Borrow APR"
          reserve={reserveTelemetry}
          samples={borrowRateHistory}
          windowValue={windowValue}
        />
      ) : (
        <InterestAccrualHistoryContent
          currentTimeMs={currentTimeMs}
          hideSensitiveValues={hideSensitiveValues}
          kind="loan"
          snapshots={loanInterestHistory}
          windowValue={windowValue}
        />
      )}
    </Card>
  );
}

function InterestAccrualHistoryContent({
  hideSensitiveValues,
  snapshots,
  kind,
  currentTimeMs,
  windowValue,
}: {
  hideSensitiveValues: boolean;
  snapshots: InterestSnapshot[];
  kind: 'loan' | 'vault';
  currentTimeMs: number;
  windowValue: HistoryWindow | InterestHistoryWindow;
}) {
  const filteredSnapshots = useMemo(() => {
    const selected = [...HISTORY_WINDOWS, ...INTEREST_WINDOWS].find(
      (entry) => entry.value === windowValue,
    );
    if (!selected) return snapshots;
    const cutoff = currentTimeMs - selected.durationMs;
    return snapshots.filter((s) => s.timestamp >= cutoff);
  }, [currentTimeMs, snapshots, windowValue]);

  const { data, totalDelta, avgDelta, maxDelta, endCumulative } = useMemo(() => {
    if (filteredSnapshots.length === 0) {
      return { data: [], totalDelta: 0, avgDelta: 0, maxDelta: 0, endCumulative: 0 };
    }
    const normalizeInterestUsd = kind === 'loan' ? Math.abs : (value: number) => value;
    // Recompute deltas within the filtered window (first row is baseline, delta=0).
    const points = filteredSnapshots.map((s, i) => ({
      timestamp: s.timestamp,
      deltaUsd:
        i === 0
          ? 0
          : normalizeInterestUsd(s.cumulativeUsd - (filteredSnapshots[i - 1]?.cumulativeUsd ?? 0)),
      cumulativeUsd: normalizeInterestUsd(s.cumulativeUsd),
    }));
    const deltasAfterFirst = points.slice(1).map((p) => p.deltaUsd);
    const total = deltasAfterFirst.reduce((sum, v) => sum + v, 0);
    const avg = deltasAfterFirst.length > 0 ? total / deltasAfterFirst.length : 0;
    const max = deltasAfterFirst.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    const end = points[points.length - 1]?.cumulativeUsd ?? 0;
    return { data: points, totalDelta: total, avgDelta: avg, maxDelta: max, endCumulative: end };
  }, [filteredSnapshots, kind]);

  const xTickFormatter = useMemo(() => {
    return (v: number) => new Date(v).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }, []);

  const barColor = kind === 'loan' ? CHART_COLORS.borrow : '#5cd3a8';
  const totalLabel = kind === 'loan' ? 'Accrued (window)' : 'Earned (window)';

  return (
    <CardContent className="grid gap-4">
      {data.length >= 2 ? (
        <>
          <div className="grid gap-1 sm:grid-cols-3">
            <Stat
              label={totalLabel}
              value={
                <SensitiveValue hidden={hideSensitiveValues}>{fmtUsd(totalDelta)}</SensitiveValue>
              }
            />
            <Stat
              label="Daily avg"
              value={
                <SensitiveValue hidden={hideSensitiveValues}>{fmtUsd(avgDelta)}</SensitiveValue>
              }
            />
            <Stat
              label="Max day"
              value={
                <SensitiveValue hidden={hideSensitiveValues}>{fmtUsd(maxDelta)}</SensitiveValue>
              }
            />
          </div>

          <SensitiveBlock hidden={hideSensitiveValues}>
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart
                data={data}
                style={CHART_STYLE}
                margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
                barCategoryGap="24%"
                barGap={0}
              >
                <CartesianGrid strokeDasharray="5 5" stroke={CHART_COLORS.grid} vertical={false} />
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={xTickFormatter}
                  tick={{ fill: CHART_COLORS.axis, fontSize: 12 }}
                  tickLine={false}
                  axisLine={{ stroke: CHART_COLORS.grid }}
                  minTickGap={30}
                />
                <YAxis
                  yAxisId="delta"
                  tickFormatter={(v: number) => fmtUsd(v)}
                  tick={{ fill: CHART_COLORS.axis, fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  width={60}
                />
                <YAxis
                  yAxisId="cumulative"
                  orientation="right"
                  tickFormatter={(v: number) => fmtUsd(v)}
                  tick={{ fill: CHART_COLORS.axis, fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  width={60}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const p = payload[0];
                    const ts = p?.payload?.timestamp as number | undefined;
                    const delta = Number(p?.payload?.deltaUsd ?? 0);
                    const cumulative = Number(p?.payload?.cumulativeUsd ?? 0);
                    return (
                      <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg">
                        {ts && (
                          <p className="mb-1 font-medium text-muted-foreground">
                            {new Date(ts).toLocaleDateString([], {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })}
                          </p>
                        )}
                        <p style={{ color: barColor }} className="font-semibold">
                          {kind === 'loan' ? 'Interest' : 'Earnings'}: {fmtUsd(delta)}
                        </p>
                        <p className="text-muted-foreground">Cumulative: {fmtUsd(cumulative)}</p>
                      </div>
                    );
                  }}
                  cursor={{ fill: 'rgba(139, 158, 179, 0.15)' }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <ReferenceLine yAxisId="delta" y={0} stroke={CHART_COLORS.grid} />
                <Bar
                  yAxisId="delta"
                  dataKey="deltaUsd"
                  name="Daily"
                  fill={barColor}
                  radius={[3, 3, 0, 0]}
                />
                <Line
                  yAxisId="cumulative"
                  type="monotone"
                  dataKey="cumulativeUsd"
                  name="Cumulative"
                  stroke={CHART_COLORS.supply}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </SensitiveBlock>
          <p className="text-xs text-muted-foreground">
            Cumulative at end of window:{' '}
            <SensitiveValue hidden={hideSensitiveValues}>{fmtUsd(endCumulative)}</SensitiveValue>
          </p>
        </>
      ) : (
        <div className="rounded-lg border border-border bg-accent px-4 py-5 text-sm text-muted-foreground">
          Need at least two daily snapshots to chart interest. Keep the server running — snapshots
          are recorded on every monitor poll and aggregated per day for display.
        </div>
      )}
    </CardContent>
  );
}
