import { useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { HealthFactorSample } from '../api/aaveMonitor';
import { Stat } from './Stat';

const COLORS = {
  line: '#5cd3a8',
  grid: 'rgba(139, 158, 179, 0.15)',
  axis: 'rgba(139, 158, 179, 0.85)',
};

// Same thresholds and colors as the portfolio HF bands on the summary card.
const HF_BANDS = [
  { value: 2.2, color: '#84cc16' },
  { value: 1.8, color: '#f59e0b' },
  { value: 1.5, color: '#ef4444' },
];

const CHART_STYLE = {
  background: 'transparent',
  fontSize: 12,
  fontFamily: 'inherit',
};

export function HealthFactorHistoryChart({
  samples,
  cutoffMs,
  statLabel,
  emptyMessage,
}: {
  samples: HealthFactorSample[];
  cutoffMs: number;
  statLabel: string;
  emptyMessage: string;
}) {
  const { data, latest, minimum, average, domain } = useMemo(() => {
    const visible = samples.filter((sample) => sample.timestamp >= cutoffMs);
    const values = visible.map((sample) => sample.healthFactor);
    const min = Math.min(...values);
    const max = Math.max(...values);
    return {
      data: visible,
      latest: values.at(-1) ?? 0,
      minimum: min,
      average: values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1),
      domain: [
        Math.floor(Math.min(min, 1.5) * 0.95 * 10) / 10,
        Math.ceil(Math.max(max, 2.2) * 1.05 * 10) / 10,
      ],
    };
  }, [cutoffMs, samples]);

  const xTickFormatter = useMemo(() => {
    const spanMs = data.length >= 2 ? data[data.length - 1]!.timestamp - data[0]!.timestamp : 0;
    if (spanMs <= 24 * 60 * 60 * 1000) {
      return (v: number) =>
        new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return (v: number) => new Date(v).toLocaleDateString([], { month: 'short', day: 'numeric' });
  }, [data]);

  if (data.length < 2) {
    return (
      <div className="rounded-lg border border-border bg-accent px-4 py-5 text-sm text-muted-foreground">
        {emptyMessage}
      </div>
    );
  }

  return (
    <>
      <div className="grid gap-1 sm:grid-cols-3">
        <Stat label={statLabel} value={latest.toFixed(2)} />
        <Stat label="Lowest (window)" value={minimum.toFixed(2)} />
        <Stat label="Average (window)" value={average.toFixed(2)} />
      </div>

      <ResponsiveContainer width="100%" height={280}>
        <LineChart
          data={data}
          style={CHART_STYLE}
          margin={{ top: 8, right: 16, bottom: 8, left: 8 }}
        >
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
            domain={domain}
            tickFormatter={(v: number) => v.toFixed(1)}
            tick={{ fill: COLORS.axis, fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            width={40}
          />
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const point = payload[0]?.payload as HealthFactorSample | undefined;
              if (!point) return null;
              return (
                <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-lg">
                  <p className="mb-1 font-medium text-muted-foreground">
                    {new Date(point.timestamp).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                  <p style={{ color: COLORS.line }} className="font-semibold">
                    Health Factor: {point.healthFactor.toFixed(3)}
                  </p>
                </div>
              );
            }}
            cursor={{ stroke: 'rgba(139, 158, 179, 0.4)', strokeWidth: 1 }}
          />
          {HF_BANDS.map((band) => (
            <ReferenceLine
              key={band.value}
              y={band.value}
              stroke={band.color}
              strokeOpacity={0.6}
              strokeDasharray="6 5"
              label={{
                value: band.value.toFixed(1),
                position: 'insideTopRight',
                fill: band.color,
                fontSize: 11,
              }}
            />
          ))}
          <Line
            type="monotone"
            dataKey="healthFactor"
            name="Health Factor"
            stroke={COLORS.line}
            strokeWidth={2.5}
            dot={false}
            isAnimationActive={false}
            activeDot={{ r: 5, fill: COLORS.line, stroke: '#0a1220', strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </>
  );
}
