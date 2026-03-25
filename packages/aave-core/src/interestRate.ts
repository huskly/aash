import { clamp } from './metrics.js';
import type { InterestRateCurvePoint, ReserveTelemetry } from './types.js';

export function computeVariableBorrowRateAtUtilization(
  utilizationRate: number,
  reserve: Pick<
    ReserveTelemetry,
    'baseVariableBorrowRate' | 'variableRateSlope1' | 'variableRateSlope2' | 'optimalUsageRatio'
  >,
): number {
  const u = clamp(utilizationRate, 0, 1);
  const optimal = clamp(reserve.optimalUsageRatio, 0.0001, 0.9999);

  if (u <= optimal) {
    return reserve.baseVariableBorrowRate + (u / optimal) * reserve.variableRateSlope1;
  }

  const excessUsage = (u - optimal) / (1 - optimal);
  return (
    reserve.baseVariableBorrowRate +
    reserve.variableRateSlope1 +
    excessUsage * reserve.variableRateSlope2
  );
}

export function buildVariableBorrowCurve(
  reserve: Pick<
    ReserveTelemetry,
    'baseVariableBorrowRate' | 'variableRateSlope1' | 'variableRateSlope2' | 'optimalUsageRatio'
  >,
  segments = 48,
): InterestRateCurvePoint[] {
  const safeSegments = Math.max(2, Math.floor(segments));
  const points: InterestRateCurvePoint[] = [];

  for (let index = 0; index <= safeSegments; index += 1) {
    const utilizationRate = index / safeSegments;
    points.push({
      utilizationRate,
      variableBorrowRate: computeVariableBorrowRateAtUtilization(utilizationRate, reserve),
    });
  }

  const optimalUsageRatio = clamp(reserve.optimalUsageRatio, 0, 1);
  if (!points.some((point) => Math.abs(point.utilizationRate - optimalUsageRatio) < 0.0001)) {
    points.push({
      utilizationRate: optimalUsageRatio,
      variableBorrowRate: computeVariableBorrowRateAtUtilization(optimalUsageRatio, reserve),
    });
  }

  return [...points].sort(
    (left: InterestRateCurvePoint, right: InterestRateCurvePoint) =>
      left.utilizationRate - right.utilizationRate,
  );
}
