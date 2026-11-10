import { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  LineChart,
  Line,
  Bar,
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Stat } from './Stat';
import { fmtUsd } from './chartFormat';
import type { HealthFactorSample, InterestSnapshot, PortfolioSnapshot } from '../api/aaveMonitor';
import { HealthFactorHistoryChart } from './HealthFactorHistoryChart';
import { SensitiveBlock, SensitiveValue } from './dashboard/privacy';
import type { BorrowRateSample } from './ReserveCharts';
import { buildBorrowRateMovingAveragePoints } from '../lib/portfolioBorrowRateHistory';
import { buildBorrowInterestMovingAveragePoints } from '../lib/portfolioInterestHistory';

type HistoryWindow = '24h' | '7d' | '30d' | '90d' | '180d';
type HistoryTab = 'portfolio' | 'healthFactor' | 'borrowApr' | 'borrowInterest';

const HISTORY_WINDOWS: Array<{ value: HistoryWindow; label: string; durationMs: number }> = [
  { value: '24h', label: '24h', durationMs: 24 * 60 * 60 * 1000 },
  { value: '7d', label: '7d', durationMs: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: '30d', durationMs: 30 * 24 * 60 * 60 * 1000 },
  { value: '90d', label: '90d', durationMs: 90 * 24 * 60 * 60 * 1000 },
  { value: '180d', label: '6m', durationMs: 180 * 24 * 60 * 60 * 1000 },
];

const COLORS = {
  assets: '#5cd3a8',
  debt: '#e255bc',
  borrow: '#f0b44c',
  average: '#8b9eb3',
  grid: 'rgba(139, 158, 179, 0.15)',
  axis: 'rgba(139, 158, 179, 0.85)',
};

const CHART_STYLE = {
  background: 'transparent',
  fontSize: 12,
  fontFamily: 'inherit',
};

function fmtPct(value: number, digits = 2): string {
  const scale = 10 ** digits;
  const truncated = Math.trunc(value * 100 * scale) / scale;
  return `${truncated.toFixed(digits)}%`;
}

export function PortfolioHistoryCard({
  hideSensitiveValues,
  samples,
  healthFactorSamples,
  borrowRateSamples,
  borrowInterestSnapshots,
  borrowPositionCount,
  currentTimeMs,
}: {
  hideSensitiveValues: boolean;
  samples: PortfolioSnapshot[];
  healthFactorSamples: HealthFactorSample[];
  borrowRateSamples: BorrowRateSample[];
  borrowInterestSnapshots: InterestSnapshot[];
  borrowPositionCount: number;
  currentTimeMs: number;
}) {
  const [windowValue, setWindowValue] = useState<HistoryWindow>('30d');
  const [activeTab, setActiveTab] = useState<HistoryTab>('portfolio');

  const windowCutoffMs =
    currentTimeMs -
    (HISTORY_WINDOWS.find((entry) => entry.value === windowValue)?.durationMs ?? Infinity);

  const filtered = useMemo(
    () => samples.filter((s) => s.timestamp >= windowCutoffMs),
    [samples, windowCutoffMs],
  );

  const { data, maxValue, latest } = useMemo(() => {
    if (filtered.length === 0) {
      return { data: [], maxValue: 1, latest: null as PortfolioSnapshot | null };
    }
    const points = filtered.map((s) => ({
      timestamp: s.timestamp,
      totalAssets: s.totalAssets,
      totalDebt: s.totalDebt,
      assetStack: Math.max(s.totalAssets - s.totalDebt, 0),
      netWorth: s.netWorth,
    }));
    const max = Math.max(...points.map((p) => Math.max(p.totalAssets, p.totalDebt)), 1);
    return {
      data: points,
      maxValue: max * 1.1,
      latest: filtered[filtered.length - 1] ?? null,
    };
  }, [filtered]);

  const {
    data: borrowRateData,
    movingAverageRate,
    lastRate,
    maxRate,
  } = useMemo(() => {
    if (borrowRateSamples.length === 0) {
      return {
        data: [],
        movingAverageRate: 0,
        lastRate: 0,
        maxRate: 0.02,
      };
    }

    const selected = HISTORY_WINDOWS.find((entry) => entry.value === windowValue);
    const cutoff = selected ? currentTimeMs - selected.durationMs : Number.NEGATIVE_INFINITY;
    const points = buildBorrowRateMovingAveragePoints(borrowRateSamples);
    const visiblePoints = points.filter((point) => point.timestamp >= cutoff);
    const lastPoint = visiblePoints.at(-1);
    const max = Math.max(
      ...visiblePoints.flatMap((point) => [point.borrowRate, point.borrowRateMovingAverage]),
      0.02,
    );

    return {
      data: visiblePoints,
      movingAverageRate: lastPoint?.borrowRateMovingAverage ?? 0,
      lastRate: lastPoint?.borrowRate ?? 0,
      maxRate: max * 1.1,
    };
  }, [borrowRateSamples, currentTimeMs, windowValue]);

  const borrowRateYTicks = useMemo(() => {
    const step = maxRate / 4;
    return Array.from({ length: 5 }, (_, i) => Math.round(i * step * 10000) / 10000);
  }, [maxRate]);

  const {
    data: borrowInterestData,
    totalBorrowInterest,
    maxBorrowInterest,
    endBorrowInterestCumulative,
    latestBorrowInterestMovingAverage,
  } = useMemo(() => {
    if (borrowInterestSnapshots.length === 0) {
      return {
        data: [],
        totalBorrowInterest: 0,
        maxBorrowInterest: 0,
        endBorrowInterestCumulative: 0,
        latestBorrowInterestMovingAverage: 0,
      };
    }

    const selected = HISTORY_WINDOWS.find((entry) => entry.value === windowValue);
    const cutoff = selected ? currentTimeMs - selected.durationMs : Number.NEGATIVE_INFINITY;
    const points = buildBorrowInterestMovingAveragePoints(borrowInterestSnapshots).filter(
      (point) => point.timestamp >= cutoff,
    );
    const deltas = points.map((point) => point.deltaUsd);
    const total = deltas.reduce((sum, value) => sum + value, 0);
    const max = deltas.reduce((currentMax, value) => Math.max(currentMax, value), 0);
    const end = points[points.length - 1]?.cumulativeUsd ?? 0;
    const latestMovingAverage = points[points.length - 1]?.deltaUsdMovingAverage ?? 0;

    return {
      data: points,
      totalBorrowInterest: total,
      maxBorrowInterest: max,
      endBorrowInterestCumulative: end,
      latestBorrowInterestMovingAverage: latestMovingAverage,
    };
  }, [borrowInterestSnapshots, currentTimeMs, windowValue]);

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

  const borrowRateXTickFormatter = useMemo(() => {
    if (borrowRateData.length < 2) return (v: number) => String(v);
    const spanMs =
      borrowRateData[borrowRateData.length - 1]!.timestamp - borrowRateData[0]!.timestamp;
    const oneDayMs = 24 * 60 * 60 * 1000;
    if (spanMs <= oneDayMs) {
      return (v: number) =>
        new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return (v: number) => new Date(v).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }, [borrowRateData]);

  const borrowInterestXTickFormatter = useMemo(() => {
    return (v: number) => new Date(v).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }, []);

  const description =
    activeTab === 'portfolio'
      ? 'Total assets and total debt snapshotted on each poll.'
      : activeTab === 'healthFactor'
        ? 'Debt-weighted health factor across loan positions, sampled hourly.'
        : activeTab === 'borrowApr'
          ? 'Debt-weighted borrow APR history combined across all open loan positions.'
          : 'Daily borrow interest aggregated across all open loan positions.';

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>Portfolio History</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <div className="grid justify-items-end gap-2">
          <div className="flex rounded-lg border border-border bg-secondary p-1">
            <Button
              type="button"
              size="sm"
              variant={activeTab === 'portfolio' ? 'default' : 'ghost'}
              onClick={() => setActiveTab('portfolio')}
            >
              Assets & Debt
            </Button>
            <Button
              type="button"
              size="sm"
              variant={activeTab === 'healthFactor' ? 'default' : 'ghost'}
              onClick={() => setActiveTab('healthFactor')}
            >
              Health Factor
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
              variant={activeTab === 'borrowInterest' ? 'default' : 'ghost'}
              onClick={() => setActiveTab('borrowInterest')}
            >
              Daily Interest
            </Button>
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
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {activeTab === 'portfolio' && filtered.length >= 2 ? (
          <>
            <div className="grid gap-1 sm:grid-cols-3">
              <Stat
                label="Total Assets"
                value={
                  <SensitiveValue hidden={hideSensitiveValues}>
                    {fmtUsd(latest?.totalAssets ?? 0)}
                  </SensitiveValue>
                }
              />
              <Stat
                label="Total Debt"
                value={
                  <SensitiveValue hidden={hideSensitiveValues}>
                    {fmtUsd(latest?.totalDebt ?? 0)}
                  </SensitiveValue>
                }
              />
              <Stat
                label="Net Worth"
                value={
                  <SensitiveValue hidden={hideSensitiveValues}>
                    {fmtUsd(latest?.netWorth ?? 0)}
                  </SensitiveValue>
                }
              />
            </div>

            <SensitiveBlock hidden={hideSensitiveValues}>
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart
                  data={data}
                  style={CHART_STYLE}
                  margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
                >
                  <defs>
                    <linearGradient id="portfolioDebtArea" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.debt} stopOpacity={0.55} />
                      <stop offset="95%" stopColor={COLORS.debt} stopOpacity={0.18} />
                    </linearGradient>
                    <linearGradient id="portfolioAssetsArea" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={COLORS.assets} stopOpacity={0.55} />
                      <stop offset="95%" stopColor={COLORS.assets} stopOpacity={0.18} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="5 5" stroke={COLORS.grid} vertical={false} />
                  <XAxis
                    dataKey="timestamp"
                    type="number"
                    scale="time"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={xTickFormatter}
                    tick={{ fill: COLORS.axis, fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: COLORS.grid }}
                    minTickGap={60}
                  />
                  <YAxis
                    domain={[0, maxValue]}
                    tickFormatter={(v) => fmtUsd(v)}
                    tick={{ fill: COLORS.axis, fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    width={80}
                  />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const ts = payload[0]?.payload?.timestamp as number | undefined;
                      const point = payload[0]?.payload as
                        { totalAssets?: number; totalDebt?: number } | undefined;
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
                          {payload.map((entry) => (
                            <p
                              key={entry.name}
                              style={{ color: entry.color }}
                              className="font-semibold"
                            >
                              {entry.name}:{' '}
                              {fmtUsd(
                                entry.dataKey === 'assetStack'
                                  ? Number(point?.totalAssets ?? 0)
                                  : Number(point?.totalDebt ?? entry.value ?? 0),
                              )}
                            </p>
                          ))}
                        </div>
                      );
                    }}
                    cursor={{ stroke: 'rgba(139, 158, 179, 0.4)', strokeWidth: 1 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12, color: COLORS.axis }} />
                  <Area
                    type="monotone"
                    dataKey="totalDebt"
                    name="Total Debt"
                    stackId="portfolio"
                    stroke={COLORS.debt}
                    fill="url(#portfolioDebtArea)"
                    fillOpacity={1}
                    dot={false}
                    activeDot={{ r: 5, fill: COLORS.debt, stroke: '#0a1220', strokeWidth: 2 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="assetStack"
                    name="Total Assets"
                    stackId="portfolio"
                    stroke={COLORS.assets}
                    fill="url(#portfolioAssetsArea)"
                    fillOpacity={1}
                    dot={false}
                    activeDot={{ r: 5, fill: COLORS.assets, stroke: '#0a1220', strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </SensitiveBlock>
          </>
        ) : activeTab === 'portfolio' ? (
          <div className="rounded-lg border border-border bg-accent px-4 py-5 text-sm text-muted-foreground">
            No portfolio history yet — data accrues on each poll.
          </div>
        ) : activeTab === 'healthFactor' ? (
          <HealthFactorHistoryChart
            samples={healthFactorSamples}
            cutoffMs={windowCutoffMs}
            statLabel="Latest Weighted HF"
            emptyMessage="Health factor history needs at least two samples from loan positions. Keep the server running so samples can accrue on monitor polls."
          />
        ) : activeTab === 'borrowApr' && borrowRateData.length >= 2 ? (
          <>
            <div className="grid gap-1 sm:grid-cols-3">
              <Stat label="Latest APR" value={fmtPct(lastRate)} />
              <Stat label="7d Avg APR" value={fmtPct(movingAverageRate)} />
              <Stat label="Open Positions" value={borrowPositionCount.toLocaleString()} />
            </div>

            <ResponsiveContainer width="100%" height={280}>
              <LineChart
                data={borrowRateData}
                style={CHART_STYLE}
                margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
              >
                <CartesianGrid strokeDasharray="5 5" stroke={COLORS.grid} vertical={false} />
                <XAxis
                  dataKey="timestamp"
                  type="number"
                  scale="time"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={borrowRateXTickFormatter}
                  tick={{ fill: COLORS.axis, fontSize: 12 }}
                  tickLine={false}
                  axisLine={{ stroke: COLORS.grid }}
                  minTickGap={60}
                />
                <YAxis
                  domain={[0, maxRate]}
                  tickFormatter={(v) => fmtPct(v, 0)}
                  ticks={borrowRateYTicks}
                  tick={{ fill: COLORS.axis, fontSize: 12 }}
                  tickLine={false}
                  axisLine={false}
                  width={40}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const borrowPoint =
                      payload.find((entry) => entry.dataKey === 'borrowRate') ?? payload[0];
                    const averagePoint = payload.find(
                      (entry) => entry.dataKey === 'borrowRateMovingAverage',
                    );
                    const ts = borrowPoint?.payload?.timestamp as number | undefined;
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
                        <p style={{ color: COLORS.borrow }} className="font-semibold">
                          Borrow APR: {fmtPct(Number(borrowPoint?.value ?? 0))}
                        </p>
                        {averagePoint && (
                          <p style={{ color: COLORS.average }} className="font-semibold">
                            7d Avg APR: {fmtPct(Number(averagePoint.value ?? 0))}
                          </p>
                        )}
                      </div>
                    );
                  }}
                  cursor={{ stroke: 'rgba(139, 158, 179, 0.4)', strokeWidth: 1 }}
                />
                <Line
                  type="natural"
                  dataKey="borrowRate"
                  name="Borrow APR"
                  stroke={COLORS.borrow}
                  strokeWidth={2.5}
                  dot={false}
                  isAnimationActive={false}
                  activeDot={{ r: 5, fill: COLORS.borrow, stroke: '#0a1220', strokeWidth: 2 }}
                />
                <Line
                  type="monotone"
                  dataKey="borrowRateMovingAverage"
                  name="7d Avg APR"
                  stroke={COLORS.average}
                  strokeWidth={2}
                  strokeDasharray="6 5"
                  dot={false}
                  isAnimationActive={false}
                  activeDot={{ r: 4, fill: COLORS.average, stroke: '#0a1220', strokeWidth: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </>
        ) : activeTab === 'borrowApr' ? (
          <div className="rounded-lg border border-border bg-accent px-4 py-5 text-sm text-muted-foreground">
            Combined borrow APR history needs at least two samples from open loan positions. Keep
            the dashboard running and refreshing to build the chart over time.
          </div>
        ) : borrowInterestData.length >= 2 ? (
          <>
            <div className="grid gap-1 sm:grid-cols-3">
              <Stat
                label="Accrued (window)"
                value={
                  <SensitiveValue hidden={hideSensitiveValues}>
                    {fmtUsd(totalBorrowInterest)}
                  </SensitiveValue>
                }
              />
              <Stat
                label="7d Avg"
                value={
                  <SensitiveValue hidden={hideSensitiveValues}>
                    {fmtUsd(latestBorrowInterestMovingAverage)}
                  </SensitiveValue>
                }
              />
              <Stat
                label="Max day"
                value={
                  <SensitiveValue hidden={hideSensitiveValues}>
                    {fmtUsd(maxBorrowInterest)}
                  </SensitiveValue>
                }
              />
            </div>

            <SensitiveBlock hidden={hideSensitiveValues}>
              <ResponsiveContainer width="100%" height={280}>
                <ComposedChart
                  data={borrowInterestData}
                  style={CHART_STYLE}
                  margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
                  barCategoryGap="24%"
                  barGap={0}
                >
                  <CartesianGrid strokeDasharray="5 5" stroke={COLORS.grid} vertical={false} />
                  <XAxis
                    dataKey="timestamp"
                    tickFormatter={borrowInterestXTickFormatter}
                    tick={{ fill: COLORS.axis, fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: COLORS.grid }}
                    minTickGap={30}
                  />
                  <YAxis
                    yAxisId="delta"
                    tickFormatter={(v: number) => fmtUsd(v)}
                    tick={{ fill: COLORS.axis, fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    width={60}
                  />
                  <YAxis
                    yAxisId="cumulative"
                    orientation="right"
                    tickFormatter={(v: number) => fmtUsd(v)}
                    tick={{ fill: COLORS.axis, fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    width={60}
                  />
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const point = payload[0];
                      const ts = point?.payload?.timestamp as number | undefined;
                      const delta = Number(point?.payload?.deltaUsd ?? 0);
                      const movingAverage = Number(point?.payload?.deltaUsdMovingAverage ?? 0);
                      const cumulative = Number(point?.payload?.cumulativeUsd ?? 0);
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
                          <p style={{ color: COLORS.borrow }} className="font-semibold">
                            Interest: {fmtUsd(delta)}
                          </p>
                          <p style={{ color: COLORS.average }} className="font-semibold">
                            7d Avg: {fmtUsd(movingAverage)}
                          </p>
                          <p className="text-muted-foreground">Cumulative: {fmtUsd(cumulative)}</p>
                        </div>
                      );
                    }}
                    cursor={{ fill: 'rgba(139, 158, 179, 0.15)' }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <ReferenceLine yAxisId="delta" y={0} stroke={COLORS.grid} />
                  <Bar
                    yAxisId="delta"
                    dataKey="deltaUsd"
                    name="Daily"
                    fill={COLORS.borrow}
                    radius={[3, 3, 0, 0]}
                  />
                  <Line
                    yAxisId="delta"
                    type="monotone"
                    dataKey="deltaUsdMovingAverage"
                    name="7d Avg"
                    stroke={COLORS.average}
                    strokeWidth={2}
                    strokeDasharray="6 5"
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                  <Line
                    yAxisId="cumulative"
                    type="monotone"
                    dataKey="cumulativeUsd"
                    name="Cumulative"
                    stroke={COLORS.assets}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </SensitiveBlock>
            <p className="text-xs text-muted-foreground">
              Cumulative at end of window:{' '}
              <SensitiveValue hidden={hideSensitiveValues}>
                {fmtUsd(endBorrowInterestCumulative)}
              </SensitiveValue>
            </p>
          </>
        ) : (
          <div className="rounded-lg border border-border bg-accent px-4 py-5 text-sm text-muted-foreground">
            Combined daily borrow interest needs at least two daily snapshots from open loan
            positions. Keep the server running so snapshots can accrue on monitor polls.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
