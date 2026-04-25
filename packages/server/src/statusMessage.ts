import { formatDistanceToNowStrict } from 'date-fns';
import { classifyZone, DEFAULT_ZONES, type Zone } from '@aave-monitor/core';
import type { AlertConfig } from './storage.js';
import type { MonitorStatus } from './monitor.js';

function hydrateZones(configuredZones: AlertConfig['zones']): Zone[] {
  const thresholdsByName = new Map(
    configuredZones.map((zone) => [zone.name, { minHF: zone.minHF, maxHF: zone.maxHF }]),
  );

  return DEFAULT_ZONES.map((zone) => {
    const override = thresholdsByName.get(zone.name);
    if (!override) return zone;
    return { ...zone, minHF: override.minHF, maxHF: override.maxHF };
  });
}

export function formatStatusMessage(
  status: MonitorStatus,
  configuredZones: AlertConfig['zones'],
): string {
  const MIN_POSITION_USD = 0.01;
  const fmtUsd = (value: number): string =>
    `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const fmtPct = (value: number): string => `${(value * 100).toFixed(2)}%`;
  const fmtBorrowRate = (value: number): string => (Number.isFinite(value) ? fmtPct(value) : 'N/A');
  const fmtUtilization = (value?: number): string =>
    value !== undefined && Number.isFinite(value) ? fmtPct(value) : 'N/A';
  const fmtDateWithRelative = (value: number): string =>
    `${new Date(value).toLocaleString()} (${formatDistanceToNowStrict(value, { addSuffix: true })})`;
  const visibleStates = status.states.filter(
    (state) => state.debtUsd >= MIN_POSITION_USD || state.collateralUsd >= MIN_POSITION_USD,
  );
  const visibleVaults = status.vaults.filter((vault) => vault.totalAssetsUsd >= MIN_POSITION_USD);

  if (!status.running) {
    return 'Monitor is not running.';
  }

  if (visibleStates.length === 0 && visibleVaults.length === 0) {
    const lastPoll = status.lastPollAt
      ? `\nLast poll: ${new Date(status.lastPollAt).toLocaleString()}`
      : '';
    return `No active positions found.${lastPoll}`;
  }

  const lines: string[] = [];

  if (visibleStates.length > 0) {
    const totals = visibleStates.reduce(
      (acc, state) => {
        acc.debt += state.debtUsd;
        acc.collateral += state.collateralUsd;
        acc.maxBorrowByLtv += state.maxBorrowByLtvUsd;
        acc.equity += state.equityUsd;
        acc.netEarn += state.netEarnUsd;
        return acc;
      },
      { debt: 0, collateral: 0, maxBorrowByLtv: 0, equity: 0, netEarn: 0 },
    );
    const portfolioNetApy = totals.equity > 0 ? totals.netEarn / totals.equity : 0;
    const repayCoverage = totals.debt > 0 ? status.totalWalletBorrowedAssetUsd / totals.debt : 0;
    const borrowPowerUsed = totals.maxBorrowByLtv > 0 ? totals.debt / totals.maxBorrowByLtv : 0;
    const finiteHealthFactors = visibleStates
      .map((state) => state.healthFactor)
      .filter((healthFactor) => Number.isFinite(healthFactor));
    const averageHealthFactor =
      finiteHealthFactors.length > 0
        ? finiteHealthFactors.reduce((sum, healthFactor) => sum + healthFactor, 0) /
          finiteHealthFactors.length
        : Infinity;
    const avgHealthFactorLabel = Number.isFinite(averageHealthFactor)
      ? averageHealthFactor.toFixed(2)
      : '∞';
    const averageZone = classifyZone(averageHealthFactor, hydrateZones(configuredZones));

    lines.push(
      '<b>Loan Status</b>',
      '',
      `<b>Portfolio</b>`,
      `${averageZone.emoji} Avg HF <b>${avgHealthFactorLabel}</b>`,
      `Net APY: <b>${fmtPct(portfolioNetApy)}</b>`,
      `Total collateral: <b>${fmtUsd(totals.collateral)}</b>`,
      `Total debt: <b>${fmtUsd(totals.debt)}</b>`,
      `Borrow power used: <b>${fmtPct(borrowPowerUsed)}</b>`,
      `Repay coverage: <b>${fmtUsd(status.totalWalletBorrowedAssetUsd)}</b> (${fmtPct(repayCoverage)})`,
      '',
    );

    for (const state of visibleStates) {
      const addr = `${state.wallet.slice(0, 6)}...${state.wallet.slice(-4)}`;
      const hf = Number.isFinite(state.healthFactor) ? state.healthFactor.toFixed(2) : '∞';
      const adjHf = Number.isFinite(state.adjustedHF) ? state.adjustedHF.toFixed(2) : '∞';
      lines.push(
        `${state.currentZone.emoji} <code>${addr}</code> · ${state.marketName}`,
        `   HF: <b>${hf}</b> · Adjusted HF: <b>${adjHf}</b> · Rate: <b>${fmtBorrowRate(state.borrowRate)}</b> · Utilization: <b>${fmtUtilization(state.utilizationRate)}</b> · Zone: ${state.currentZone.label}`,
        '',
      );
    }
  }

  if (visibleVaults.length > 0) {
    lines.push('<b>Vault Positions</b>', '');
    for (const vault of visibleVaults) {
      const deposited = vault.totalAssets.toLocaleString(undefined, { maximumFractionDigits: 4 });
      lines.push(
        `🏦 <b>${vault.vaultName}</b> (${vault.asset.symbol})`,
        `   Deposited: <b>${deposited} ${vault.asset.symbol}</b> · Value: <b>${fmtUsd(vault.totalAssetsUsd)}</b> · Net APY: <b>${fmtPct(vault.netApy)}</b>`,
        '',
      );
    }
  }

  if (status.lastPollAt) {
    lines.push(`Last updated: ${fmtDateWithRelative(status.lastPollAt)}`);
  }
  if (status.lastError) {
    lines.push(`Last error: ${status.lastError}`);
  }

  return lines.join('\n');
}
