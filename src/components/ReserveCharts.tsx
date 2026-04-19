import { useMemo, useState } from 'react';
import {
  buildVariableBorrowCurve,
  type InterestRateCurvePoint,
  type ReserveTelemetry,
} from '@aave-monitor/core';
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

const SVG_WIDTH = 760;
const SVG_HEIGHT = 280;
const PADDING = { top: 16, right: 18, bottom: 36, left: 48 };

function fmtPct(value: number, digits = 2): string {
  const scale = 10 ** digits;
  const truncated = Math.trunc(value * 100 * scale) / scale;
  return `${truncated.toFixed(digits)}%`;
}

function createLinePath(
  points: InterestRateCurvePoint[],
  maxY: number,
  xSelector: (point: InterestRateCurvePoint) => number,
  ySelector: (point: InterestRateCurvePoint) => number,
): string {
  const chartWidth = SVG_WIDTH - PADDING.left - PADDING.right;
  const chartHeight = SVG_HEIGHT - PADDING.top - PADDING.bottom;

  return points
    .map((point, index) => {
      const x = PADDING.left + xSelector(point) * chartWidth;
      const y = PADDING.top + chartHeight - (ySelector(point) / maxY) * chartHeight;
      return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
}

function xToSvg(value: number): number {
  const chartWidth = SVG_WIDTH - PADDING.left - PADDING.right;
  return PADDING.left + value * chartWidth;
}

function yToSvg(value: number, maxY: number): number {
  const chartHeight = SVG_HEIGHT - PADDING.top - PADDING.bottom;
  return PADDING.top + chartHeight - (value / maxY) * chartHeight;
}

export function UtilizationCurveCard({ reserve }: { reserve: ReserveTelemetry }) {
  const curve = useMemo(() => buildVariableBorrowCurve(reserve, 64), [reserve]);
  const maxRate = useMemo(() => {
    const curveMax = Math.max(
      ...curve.map((point) => point.variableBorrowRate),
      reserve.variableBorrowRate,
    );
    return Math.max(curveMax * 1.12, 0.05);
  }, [curve, reserve.variableBorrowRate]);
  const curvePath = useMemo(
    () =>
      createLinePath(
        curve,
        maxRate,
        (point) => point.utilizationRate,
        (point) => point.variableBorrowRate,
      ),
    [curve, maxRate],
  );

  const currentX = xToSvg(reserve.utilizationRate);
  const optimalX = xToSvg(reserve.optimalUsageRatio);
  const currentY = yToSvg(reserve.variableBorrowRate, maxRate);
  const optimalY = yToSvg(
    curve.find((point) => Math.abs(point.utilizationRate - reserve.optimalUsageRatio) < 0.001)
      ?.variableBorrowRate ?? reserve.variableBorrowRate,
    maxRate,
  );
  const yTicks = [0, maxRate / 2, maxRate];

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

        <svg
          viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
          className="w-full overflow-visible"
          role="img"
          aria-label={`Aave utilization curve for ${reserve.symbol || reserve.assetAddress}`}
        >
          <rect
            x={PADDING.left}
            y={PADDING.top}
            width={SVG_WIDTH - PADDING.left - PADDING.right}
            height={SVG_HEIGHT - PADDING.top - PADDING.bottom}
            rx="12"
            fill="transparent"
          />
          {yTicks.map((tick) => {
            const y = yToSvg(tick, maxRate);
            return (
              <g key={tick}>
                <line
                  x1={PADDING.left}
                  x2={SVG_WIDTH - PADDING.right}
                  y1={y}
                  y2={y}
                  stroke="rgba(139, 158, 179, 0.22)"
                  strokeDasharray="5 5"
                />
                <text
                  x={PADDING.left - 12}
                  y={y + 4}
                  fill="rgba(139, 158, 179, 0.85)"
                  fontSize="12"
                  textAnchor="end"
                >
                  {fmtPct(tick, 0)}
                </text>
              </g>
            );
          })}
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
            <text
              key={tick}
              x={xToSvg(tick)}
              y={SVG_HEIGHT - 10}
              fill="rgba(139, 158, 179, 0.85)"
              fontSize="12"
              textAnchor={tick === 0 ? 'start' : tick === 1 ? 'end' : 'middle'}
            >
              {fmtPct(tick, 0)}
            </text>
          ))}

          <path d={curvePath} fill="none" stroke="#e255bc" strokeWidth="3" strokeLinecap="round" />

          <line
            x1={optimalX}
            x2={optimalX}
            y1={PADDING.top}
            y2={SVG_HEIGHT - PADDING.bottom}
            stroke="rgba(40, 153, 255, 0.8)"
            strokeDasharray="4 4"
          />
          <line
            x1={currentX}
            x2={currentX}
            y1={PADDING.top}
            y2={SVG_HEIGHT - PADDING.bottom}
            stroke="rgba(40, 153, 255, 0.8)"
            strokeDasharray="4 4"
          />

          <circle
            cx={currentX}
            cy={currentY}
            r="5"
            fill="#e255bc"
            stroke="#0a1220"
            strokeWidth="2"
          />

          <text
            x={Math.min(currentX + 8, SVG_WIDTH - PADDING.right - 8)}
            y={Math.max(currentY - 12, PADDING.top + 12)}
            fill="rgba(226, 236, 244, 0.95)"
            fontSize="12"
          >
            Current {fmtPct(reserve.utilizationRate)}
          </text>
          <text
            x={Math.min(optimalX + 8, SVG_WIDTH - PADDING.right - 8)}
            y={Math.max(optimalY - 12, PADDING.top + 28)}
            fill="rgba(139, 158, 179, 0.95)"
            fontSize="12"
          >
            Optimal {fmtPct(reserve.optimalUsageRatio)}
          </text>
        </svg>
      </CardContent>
    </Card>
  );
}

// Morpho Blue AdaptiveCurveIRM constants
const MORPHO_TARGET_UTIL = 0.9;
const MORPHO_CURVE_STEEPNESS = 4;
const MORPHO_IRM_SAMPLES = 80;

// Below target: simple linear from 0 → rateAtTarget (matches Morpho dashboard rendering).
// Above target: steeper slope using the on-chain CURVE_STEEPNESS=4 formula.
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

  // Derive fee factor to draw supply curve: supplyApy = borrowRate * utilization * (1 - fee)
  const feeFactor = useMemo(() => {
    if (supplyApy == null || borrowRate <= 0 || utilizationRate <= 0) return null;
    return supplyApy / (borrowRate * utilizationRate);
  }, [supplyApy, borrowRate, utilizationRate]);

  const { borrowCurvePath, supplyCurvePath, maxRate } = useMemo(() => {
    const samples = Array.from(
      { length: MORPHO_IRM_SAMPLES + 1 },
      (_, i) => i / MORPHO_IRM_SAMPLES,
    );
    const chartWidth = SVG_WIDTH - PADDING.left - PADDING.right;
    const chartHeight = SVG_HEIGHT - PADDING.top - PADDING.bottom;

    const maxBorrow = morphoBorrowRate(rateAtTarget, 1);
    const maxSupply = feeFactor != null ? maxBorrow * feeFactor : 0;
    const max = Math.max(maxBorrow, maxSupply, 0.02) * 1.12;

    const toPath = (rateFn: (u: number) => number) =>
      samples
        .map((u, i) => {
          const x = PADDING.left + u * chartWidth;
          const y = PADDING.top + chartHeight - (rateFn(u) / max) * chartHeight;
          return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
        })
        .join(' ');

    return {
      borrowCurvePath: toPath((u) => morphoBorrowRate(rateAtTarget, u)),
      supplyCurvePath:
        feeFactor != null ? toPath((u) => morphoBorrowRate(rateAtTarget, u) * u * feeFactor) : null,
      maxRate: max,
    };
  }, [rateAtTarget, feeFactor]);

  const currentX = xToSvg(utilizationRate);
  const targetX = xToSvg(MORPHO_TARGET_UTIL);
  const currentBorrowY = yToSvg(borrowRate, maxRate);
  const targetBorrowY = yToSvg(rateAtTarget, maxRate);
  const yTicks = [0, maxRate / 2, maxRate];

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

        <svg
          viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
          className="w-full overflow-visible"
          role="img"
          aria-label="Morpho Adaptive IRM utilization curve"
        >
          {yTicks.map((tick) => {
            const y = yToSvg(tick, maxRate);
            return (
              <g key={tick}>
                <line
                  x1={PADDING.left}
                  x2={SVG_WIDTH - PADDING.right}
                  y1={y}
                  y2={y}
                  stroke="rgba(139, 158, 179, 0.22)"
                  strokeDasharray="5 5"
                />
                <text
                  x={PADDING.left - 12}
                  y={y + 4}
                  fill="rgba(139, 158, 179, 0.85)"
                  fontSize="12"
                  textAnchor="end"
                >
                  {fmtPct(tick, 0)}
                </text>
              </g>
            );
          })}
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
            <text
              key={tick}
              x={xToSvg(tick)}
              y={SVG_HEIGHT - 10}
              fill="rgba(139, 158, 179, 0.85)"
              fontSize="12"
              textAnchor={tick === 0 ? 'start' : tick === 1 ? 'end' : 'middle'}
            >
              {fmtPct(tick, 0)}
            </text>
          ))}

          {/* Supply curve (lower, lighter) */}
          {supplyCurvePath && (
            <path
              d={supplyCurvePath}
              fill="none"
              stroke="rgba(226, 236, 244, 0.45)"
              strokeWidth="2.5"
              strokeLinecap="round"
            />
          )}

          {/* Borrow curve */}
          <path
            d={borrowCurvePath}
            fill="none"
            stroke="#e255bc"
            strokeWidth="3"
            strokeLinecap="round"
          />

          {/* Target utilization dashed line */}
          <line
            x1={targetX}
            x2={targetX}
            y1={PADDING.top}
            y2={SVG_HEIGHT - PADDING.bottom}
            stroke="rgba(40, 153, 255, 0.6)"
            strokeDasharray="4 4"
          />
          {/* Current utilization dashed line */}
          <line
            x1={currentX}
            x2={currentX}
            y1={PADDING.top}
            y2={SVG_HEIGHT - PADDING.bottom}
            stroke="rgba(40, 153, 255, 0.8)"
            strokeDasharray="4 4"
          />

          {/* Current borrow rate dot */}
          <circle
            cx={currentX}
            cy={currentBorrowY}
            r="5"
            fill="#e255bc"
            stroke="#0a1220"
            strokeWidth="2"
          />

          <text
            x={Math.min(currentX + 8, SVG_WIDTH - PADDING.right - 8)}
            y={Math.max(currentBorrowY - 12, PADDING.top + 12)}
            fill="rgba(226, 236, 244, 0.95)"
            fontSize="12"
          >
            Current {fmtPct(utilizationRate)}
          </text>
          <text
            x={Math.min(targetX + 8, SVG_WIDTH - PADDING.right - 8)}
            y={Math.max(targetBorrowY - 12, PADDING.top + 28)}
            fill="rgba(139, 158, 179, 0.95)"
            fontSize="12"
          >
            Target {fmtPct(MORPHO_TARGET_UTIL)}
          </text>
        </svg>

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

  const historyPoints = useMemo<{
    maxRate: number;
    path: string;
    averageRate: number;
    lastRate: number;
  } | null>(() => {
    if (filteredSamples.length === 0) return null;

    const minTime = new Date(filteredSamples[0]?.timestamp ?? '').getTime();
    const maxTime = new Date(filteredSamples.at(-1)?.timestamp ?? '').getTime();
    const span = Math.max(maxTime - minTime, 1);
    const maxRate = Math.max(
      ...filteredSamples.map((sample) => sample.variableBorrowRate),
      reserve?.variableBorrowRate ?? 0,
      0.02,
    );

    return {
      maxRate: maxRate * 1.1,
      path: filteredSamples
        .map((sample, index) => {
          const timestamp = new Date(sample.timestamp).getTime();
          const x =
            PADDING.left +
            ((timestamp - minTime) / span) * (SVG_WIDTH - PADDING.left - PADDING.right);
          const y = yToSvg(sample.variableBorrowRate, maxRate * 1.1);
          return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
        })
        .join(' '),
      averageRate:
        filteredSamples.reduce((sum, sample) => sum + sample.variableBorrowRate, 0) /
        filteredSamples.length,
      lastRate: filteredSamples.at(-1)?.variableBorrowRate ?? 0,
    };
  }, [filteredSamples, reserve?.variableBorrowRate]);

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
        {filteredSamples.length >= 2 && historyPoints ? (
          <>
            <div className="grid gap-1 sm:grid-cols-3">
              <Stat label="Latest APR" value={fmtPct(historyPoints.lastRate)} />
              <Stat label="Average APR" value={fmtPct(historyPoints.averageRate)} />
              <Stat label="Samples" value={filteredSamples.length.toLocaleString()} />
            </div>

            <svg
              viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
              className="w-full overflow-visible"
              role="img"
              aria-label="Borrow APR history"
            >
              {[0, historyPoints.maxRate / 2, historyPoints.maxRate].map((tick) => {
                const y = yToSvg(tick, historyPoints.maxRate);
                return (
                  <g key={tick}>
                    <line
                      x1={PADDING.left}
                      x2={SVG_WIDTH - PADDING.right}
                      y1={y}
                      y2={y}
                      stroke="rgba(139, 158, 179, 0.22)"
                      strokeDasharray="5 5"
                    />
                    <text
                      x={PADDING.left - 12}
                      y={y + 4}
                      fill="rgba(139, 158, 179, 0.85)"
                      fontSize="12"
                      textAnchor="end"
                    >
                      {fmtPct(tick, 0)}
                    </text>
                  </g>
                );
              })}

              <line
                x1={PADDING.left}
                x2={SVG_WIDTH - PADDING.right}
                y1={yToSvg(historyPoints.averageRate, historyPoints.maxRate)}
                y2={yToSvg(historyPoints.averageRate, historyPoints.maxRate)}
                stroke="rgba(226, 236, 244, 0.65)"
                strokeDasharray="6 5"
              />
              <path
                d={historyPoints.path}
                fill="none"
                stroke="#e255bc"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </svg>
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
