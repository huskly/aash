import {
  isMidnightLoan,
  type Computed,
  type LoanPosition,
  type ReserveTelemetry,
} from '@aave-monitor/core';
import type { BorrowRateSample } from '../ReserveCharts';
import type { WatchdogConfigState } from '../../hooks/useWatchdogConfig';
import { fmtPct } from '../../lib/formatters';

const RATES_DRIFT_PP_THRESHOLD = 2.0;
const DEPEG_THRESHOLD = 0.005;
const ORACLE_UTILIZATION_WATCH = 0.95;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const STABLECOIN_SYMBOLS = new Set([
  'USDC',
  'USDT',
  'DAI',
  'LUSD',
  'FRAX',
  'USDE',
  'SUSDE',
  'CRVUSD',
  'GHO',
  'PYUSD',
  'USDS',
]);

export type ChecklistState = 'ok' | 'watch' | 'unknown';
export type ChecklistStatus = { state: ChecklistState; detail: string };

function isStablecoin(symbol: string): boolean {
  return STABLECOIN_SYMBOLS.has(symbol.toUpperCase());
}

export function evaluateHealthFactor(computed: Computed): ChecklistStatus {
  if (computed.alertHF) {
    return {
      state: 'watch',
      detail: `Health factor ${computed.healthFactor.toFixed(2)} — below safe threshold`,
    };
  }
  const hf = Number.isFinite(computed.healthFactor) ? computed.healthFactor.toFixed(2) : '∞';
  return { state: 'ok', detail: `Health factor ${hf} — comfortably above 1.0` };
}

export function evaluateLtv(computed: Computed): ChecklistStatus {
  const ltv = fmtPct(computed.ltv);
  const lt = fmtPct(computed.lt);
  if (computed.alertLTV) {
    return { state: 'watch', detail: `LTV ${ltv} near liquidation threshold ${lt}` };
  }
  return { state: 'ok', detail: `LTV ${ltv} vs liquidation threshold ${lt}` };
}

export function evaluateRatesDrift(
  history: BorrowRateSample[],
  computed: Computed,
): ChecklistStatus {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const recent = history.filter((s) => Date.parse(s.timestamp) >= cutoff);
  if (recent.length < 2) {
    return { state: 'unknown', detail: 'Insufficient history to assess drift' };
  }
  const avg = recent.reduce((sum, s) => sum + s.variableBorrowRate, 0) / recent.length;
  const latest = recent.at(-1)?.variableBorrowRate ?? computed.rBorrow;
  const deltaPp = (latest - avg) * 100;
  const absPp = Math.abs(deltaPp);
  const sign = deltaPp >= 0 ? '+' : '−';
  const deltaStr = `${sign}${absPp.toFixed(1)}pp`;
  if (absPp >= RATES_DRIFT_PP_THRESHOLD) {
    return {
      state: 'watch',
      detail: `Borrow APY ${fmtPct(latest)} — drifted ${deltaStr} vs 7-day avg`,
    };
  }
  return { state: 'ok', detail: `Borrow APY ${fmtPct(latest)}, ${deltaStr} vs 7-day avg` };
}

export function evaluateDepeg(loan: LoanPosition | null): ChecklistStatus {
  if (!loan) return { state: 'unknown', detail: 'No position selected' };
  const assets = [...loan.borrowed, ...loan.supplied].filter((a) => isStablecoin(a.symbol));
  if (assets.length === 0) {
    return { state: 'ok', detail: 'No stablecoins in this position' };
  }
  let worst = assets[0]!;
  let worstDev = Math.abs((worst.usdPrice ?? 1) - 1);
  for (const a of assets) {
    const dev = Math.abs((a.usdPrice ?? 1) - 1);
    if (dev > worstDev) {
      worst = a;
      worstDev = dev;
    }
  }
  const worstPrice = worst.usdPrice ?? 1;
  const signedPct = ((worstPrice - 1) * 100).toFixed(2);
  if (worstDev > DEPEG_THRESHOLD) {
    return {
      state: 'watch',
      detail: `${worst.symbol} at $${worstPrice.toFixed(4)} (${signedPct}% off peg)`,
    };
  }
  return { state: 'ok', detail: `All stables within 0.5% of $1 (${assets.length} checked)` };
}

export function evaluateOracleMarket(
  telemetry: ReserveTelemetry | null,
  loan: LoanPosition | null,
): ChecklistStatus {
  if (loan && !loan.marketName.startsWith('proto_')) {
    return { state: 'unknown', detail: 'Telemetry not available for Morpho markets' };
  }
  if (!telemetry) {
    return { state: 'unknown', detail: 'Reserve telemetry unavailable' };
  }
  const utilPct = fmtPct(telemetry.utilizationRate);
  if (telemetry.utilizationRate >= ORACLE_UTILIZATION_WATCH) {
    return {
      state: 'watch',
      detail: `${telemetry.symbol} reserve util ${utilPct} — withdrawals may slip`,
    };
  }
  return { state: 'ok', detail: `${telemetry.symbol} reserve util ${utilPct}` };
}

export function evaluateAutomation(
  watchdogState: WatchdogConfigState,
  loan: LoanPosition | null,
): ChecklistStatus {
  const { watchdog, loading, error } = watchdogState;
  if (loading && !watchdog) {
    return { state: 'unknown', detail: 'Loading watchdog status…' };
  }
  if (error) {
    return { state: 'unknown', detail: `Watchdog status unavailable: ${error}` };
  }
  if (!watchdog) {
    return { state: 'unknown', detail: 'Watchdog config not returned by server' };
  }
  if (!watchdog.enabled) {
    return { state: 'watch', detail: 'Watchdog disabled' };
  }
  if (loan && isMidnightLoan(loan)) {
    return { state: 'watch', detail: 'Watchdog does not cover Midnight fixed-rate loans' };
  }
  const isMorpho = !!loan?.morphoMarketParams;
  const rescue = isMorpho ? watchdog.morphoRescueContract : watchdog.rescueContract;
  const protocolLabel = isMorpho ? 'Morpho' : 'Aave';
  if (!rescue || rescue === ZERO_ADDRESS) {
    return { state: 'watch', detail: `No rescue contract configured for ${protocolLabel}` };
  }
  if (!(watchdog.triggerHF > 0) || !(watchdog.targetHF > 0)) {
    return { state: 'watch', detail: 'Watchdog trigger/target HF not configured' };
  }
  return {
    state: 'ok',
    detail: `Watchdog on (${protocolLabel}) — trigger HF ${watchdog.triggerHF.toFixed(
      2,
    )}, target ${watchdog.targetHF.toFixed(2)}`,
  };
}
