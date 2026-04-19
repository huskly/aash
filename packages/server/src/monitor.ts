import {
  type AssetLiquidation,
  type AssetPosition,
  type LoanPosition,
  type ReserveTelemetry,
  type Zone,
  type ZoneName,
  classifyZone,
  isWorsening,
  isImproving,
  fetchFromAaveSubgraph,
  fetchFromMorphoApi,
  fetchTokenBalances,
  fetchUsdPrices,
  buildLoanPositions,
  computeLoanMetrics,
  DEFAULT_ZONES,
} from '@aave-monitor/core';
import { intervalToDuration } from 'date-fns';
import type { AlertConfig } from './storage.js';
import type { TelegramClient } from './telegram.js';
import { Watchdog, type WatchdogLogEntry } from './watchdog.js';
import { logger } from './logger.js';
import { computeRescueAdjustedHF } from './rescueMetrics.js';
import { fetchReserveTelemetry } from './reserveTelemetry.js';
import type { RateHistoryDb } from './rateHistoryDb.js';

export type LoanAlertState = {
  loanId: string;
  marketName: string;
  wallet: string;
  healthFactor: number;
  adjustedHF: number;
  borrowRate: number;
  debtUsd: number;
  collateralUsd: number;
  maxBorrowByLtvUsd: number;
  equityUsd: number;
  netEarnUsd: number;
  currentZone: Zone;
  lastNotifiedZone: ZoneName | null;
  lastNotifiedAt: number;
  consecutiveChecks: number;
  stuckSince: number | null;
};

export type UtilizationAlertState = {
  wallet: string;
  loanId: string;
  marketName: string;
  assetAddress: string;
  assetSymbol: string;
  /** Whether we have already sent an "exceeded" alert */
  alerted: boolean;
  /** Timestamp of last utilization alert sent */
  lastNotifiedAt: number;
  /** Last observed utilization rate (0–1) */
  lastUtilization: number;
  /** The threshold that was used (from on-chain optimalUsageRatio or config default) */
  threshold: number;
};

export type MonitorStatus = {
  running: boolean;
  states: LoanAlertState[];
  utilizationStates: UtilizationAlertState[];
  totalWalletBorrowedAssetUsd: number;
  lastPollAt: number | null;
  lastError: string | null;
  watchdogLog: WatchdogLogEntry[];
};

type WalletNotification = {
  kind:
    | 'transition'
    | 'recovery'
    | 'all-clear'
    | 'reminder'
    | 'utilization-high'
    | 'utilization-normalized';
  message: string;
};

type ReminderDigestEntry = {
  state: LoanAlertState;
  message: string;
};

export class Monitor {
  private states = new Map<string, LoanAlertState>();
  private utilizationStates = new Map<string, UtilizationAlertState>();
  private timerId: ReturnType<typeof setInterval> | null = null;
  private walletBorrowedAssetUsd = new Map<string, number>();
  private lastPollAt: number | null = null;
  private lastError: string | null = null;
  private running = false;
  private lastSampleAt = new Map<string, number>();
  readonly watchdog: Watchdog;

  constructor(
    private readonly telegram: TelegramClient,
    private readonly getConfig: () => AlertConfig,
    private readonly graphApiKey: string | undefined,
    private readonly coingeckoApiKey: string | undefined,
    private readonly rpcUrl: string,
    privateKey: string | undefined,
    private readonly rateHistoryDb?: RateHistoryDb,
  ) {
    this.watchdog = new Watchdog(
      telegram,
      () => {
        const config = this.getConfig();
        return config.telegram.enabled && config.telegram.chatId ? config.telegram.chatId : null;
      },
      () => this.getConfig().watchdog,
      rpcUrl,
      privateKey,
    );
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const config = this.getConfig();
    this.timerId = setInterval(() => {
      void this.poll();
    }, config.polling.intervalMs);
    void this.poll();
    logger.info({ intervalMs: config.polling.intervalMs }, 'Monitor started');
  }

  stop(): void {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.running = false;
    logger.info('Monitor stopped');
  }

  restart(): void {
    this.stop();
    this.start();
  }

  getStatus(): MonitorStatus {
    return {
      running: this.running,
      states: Array.from(this.states.values()),
      utilizationStates: Array.from(this.utilizationStates.values()),
      totalWalletBorrowedAssetUsd: Array.from(this.walletBorrowedAssetUsd.values()).reduce(
        (sum, value) => sum + value,
        0,
      ),
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      watchdogLog: this.watchdog.getLog(),
    };
  }

  async refreshState(): Promise<MonitorStatus> {
    await this.poll({ notify: false });
    return this.getStatus();
  }

  private async poll(options: { notify: boolean } = { notify: true }): Promise<void> {
    const config = this.getConfig();
    const chatId =
      options.notify && config.telegram.enabled && config.telegram.chatId
        ? config.telegram.chatId
        : null;

    const enabledWallets = config.wallets.filter((w) => w.enabled);
    const enabledAddresses = new Set(enabledWallets.map((wallet) => wallet.address.toLowerCase()));
    for (const [stateKey, state] of Array.from(this.states.entries())) {
      if (!enabledAddresses.has(state.wallet.toLowerCase())) {
        this.states.delete(stateKey);
      }
    }
    for (const existingAddress of Array.from(this.walletBorrowedAssetUsd.keys())) {
      if (!enabledAddresses.has(existingAddress)) {
        this.walletBorrowedAssetUsd.delete(existingAddress);
      }
    }

    if (enabledWallets.length === 0) {
      this.lastPollAt = Date.now();
      this.lastError = null;
      return;
    }

    try {
      for (const wallet of enabledWallets) {
        await this.checkWallet(wallet.address, wallet.label, config, chatId);
      }
      try {
        this.rateHistoryDb?.prune(180 * 24 * 60 * 60 * 1000);
      } catch (err) {
        logger.warn({ err }, 'Failed to prune rate history');
      }
      this.lastPollAt = Date.now();
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Unknown polling error';
      logger.error({ err: this.lastError }, 'Poll error');
    }
  }

  private async checkWallet(
    address: string,
    label: string | undefined,
    config: AlertConfig,
    chatId: string | null,
  ): Promise<void> {
    const reserves = await fetchFromAaveSubgraph(address, this.graphApiKey);
    const symbols = Array.from(new Set(reserves.map((r) => r.reserve.symbol)));
    const prices = await fetchUsdPrices(symbols, this.coingeckoApiKey);
    const normalizeSymbol = (symbol: string) => symbol.toUpperCase();

    const pricedSymbols = symbols.filter((s) => prices.has(normalizeSymbol(s)));
    const missingSymbols = symbols.filter((s) => !prices.has(normalizeSymbol(s)));
    logger.info(
      {
        wallet: this.shortAddr(address),
        resolved: pricedSymbols.length,
        total: symbols.length,
        ...(missingSymbols.length > 0 && { missing: missingSymbols }),
      },
      'Prices resolved',
    );

    const morphoLoans = await fetchFromMorphoApi(address).catch(() => {
      logger.warn({ wallet: this.shortAddr(address) }, 'Morpho positions unavailable');
      return [];
    });
    const loans = [...buildLoanPositions(reserves, prices), ...morphoLoans];

    // Fetch reserve telemetry for Aave loans when utilization alerts are enabled.
    // Deduplicate by (marketName, assetAddress) to avoid redundant RPC calls.
    const telemetryMap = new Map<string, ReserveTelemetry>();
    if (config.utilization.enabled) {
      const telemetryKeys = new Map<string, { marketName: string; assetAddress: string }>();
      for (const loan of loans) {
        if (loan.marketName.startsWith('morpho_')) continue;
        for (const asset of loan.borrowed) {
          const key = `${loan.marketName}:${asset.address.toLowerCase()}`;
          if (!telemetryKeys.has(key)) {
            telemetryKeys.set(key, {
              marketName: loan.marketName,
              assetAddress: asset.address,
            });
          }
        }
      }
      const results = await Promise.allSettled(
        Array.from(telemetryKeys.entries()).map(async ([key, { marketName, assetAddress }]) => {
          const telemetry = await fetchReserveTelemetry(marketName, assetAddress, this.rpcUrl);
          return { key, telemetry };
        }),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          telemetryMap.set(result.value.key, result.value.telemetry);
        } else {
          logger.warn({ err: result.reason }, 'Failed to fetch reserve telemetry');
        }
      }
    }

    const borrowedAssets = Array.from(
      new Map(
        loans
          .flatMap((loan) => loan.borrowed)
          .map((asset) => [asset.address.toLowerCase(), asset] satisfies [string, AssetPosition]),
      ).values(),
    );
    const walletBorrowedAssetBalances = await fetchTokenBalances(
      address,
      this.rpcUrl,
      borrowedAssets.map((asset) => ({
        key: asset.address.toLowerCase(),
        address: asset.address,
        decimals: asset.decimals,
      })),
    ).catch(() => {
      logger.warn(
        { wallet: this.shortAddr(address) },
        'Borrowed-asset wallet balances unavailable',
      );
      return new Map<string, number>();
    });
    const walletBorrowedAssetUsd = borrowedAssets.reduce((sum, asset) => {
      const balance = walletBorrowedAssetBalances.get(asset.address.toLowerCase()) ?? 0;
      return sum + balance * asset.usdPrice;
    }, 0);
    this.walletBorrowedAssetUsd.set(address.toLowerCase(), walletBorrowedAssetUsd);

    const now = Date.now();
    const activeStateKeys = new Set<string>();
    const pendingNotifications: WalletNotification[] = [];
    const reminderDigestEntries: ReminderDigestEntry[] = [];
    let shouldSendReminderDigest = false;

    for (const loan of loans) {
      const metrics = computeLoanMetrics(loan);
      const adjustedHF = computeRescueAdjustedHF(loan, walletBorrowedAssetBalances);
      const notificationMetrics = { ...metrics, adjustedHF };
      const zone = classifyZone(metrics.healthFactor, this.hydrateZones(config.zones));
      const stateKey = `${address}-${loan.id}`;
      activeStateKeys.add(stateKey);

      // Record rate sample (throttled to 15-minute intervals).
      // Guarded so DB failures never interrupt core health monitoring.
      if (this.rateHistoryDb) {
        const lastTs = this.lastSampleAt.get(stateKey) ?? 0;
        if (now - lastTs >= 15 * 60 * 1000) {
          try {
            const utilizationForSample = this.resolveUtilization(loan, telemetryMap);
            this.rateHistoryDb.appendSample(
              address,
              loan.id,
              loan.marketName,
              now,
              metrics.rBorrow,
              metrics.rSupply,
              utilizationForSample,
            );
            this.lastSampleAt.set(stateKey, now);
          } catch (err) {
            logger.warn({ err, loan: loan.id }, 'Failed to record rate sample');
          }
        }
      }

      const collateralInfo = loan.supplied
        .map((c) => `${c.symbol}=$${c.usdPrice > 0 ? c.usdPrice : 'MISSING'}`)
        .join(', ');
      logger.info(
        {
          wallet: this.shortAddr(address),
          loan: loan.id,
          healthFactor: Number(metrics.healthFactor.toFixed(4)),
          borrowedUsd: Number(loan.totalBorrowedUsd.toFixed(2)),
          suppliedUsd: Number(loan.totalSuppliedUsd.toFixed(2)),
          zone: zone.name,
          collaterals: collateralInfo,
        },
        'Loan status',
      );

      const existing = this.states.get(stateKey);

      if (!existing) {
        this.states.set(stateKey, {
          loanId: loan.id,
          marketName: loan.marketName,
          wallet: address,
          healthFactor: metrics.healthFactor,
          adjustedHF,
          borrowRate: metrics.rBorrow,
          debtUsd: metrics.debt,
          collateralUsd: metrics.collateralUSD,
          maxBorrowByLtvUsd: metrics.maxBorrowByLTV,
          equityUsd: metrics.equity,
          netEarnUsd: metrics.netEarnUSD,
          currentZone: zone,
          lastNotifiedZone: null,
          lastNotifiedAt: 0,
          consecutiveChecks: 1,
          stuckSince: zone.name !== 'safe' ? now : null,
        });
        continue;
      }

      const previousZone = existing.currentZone;
      existing.marketName = loan.marketName;
      existing.healthFactor = metrics.healthFactor;
      existing.adjustedHF = adjustedHF;
      existing.borrowRate = metrics.rBorrow;
      existing.debtUsd = metrics.debt;
      existing.collateralUsd = metrics.collateralUSD;
      existing.maxBorrowByLtvUsd = metrics.maxBorrowByLTV;
      existing.equityUsd = metrics.equity;
      existing.netEarnUsd = metrics.netEarnUSD;
      existing.currentZone = zone;

      if (zone.name !== 'safe' && existing.stuckSince) {
        reminderDigestEntries.push({
          state: existing,
          message: this.formatReminder(loan, notificationMetrics, zone, now - existing.stuckSince),
        });
      }

      if (zone.name === previousZone.name) {
        existing.consecutiveChecks++;

        if (zone.name !== 'safe' && existing.stuckSince) {
          const stuckDuration = now - existing.stuckSince;
          if (
            chatId &&
            stuckDuration >= config.polling.reminderIntervalMs &&
            now - existing.lastNotifiedAt >= config.polling.reminderIntervalMs
          ) {
            shouldSendReminderDigest = true;
          }
        }
        continue;
      }

      existing.consecutiveChecks = 1;
      existing.stuckSince = zone.name !== 'safe' ? now : null;

      if (isWorsening(previousZone.name, zone.name)) {
        const isCritical = zone.name === 'critical';
        const shouldNotify =
          isCritical || existing.consecutiveChecks >= config.polling.debounceChecks;

        if (chatId && (shouldNotify || isCritical)) {
          pendingNotifications.push({
            kind: 'transition',
            message: this.formatZoneTransition(loan, notificationMetrics, zone, previousZone),
          });
          existing.lastNotifiedZone = zone.name;
          existing.lastNotifiedAt = now;
        }
      } else if (isImproving(previousZone.name, zone.name)) {
        const cooldownElapsed = now - existing.lastNotifiedAt >= config.polling.cooldownMs;
        if (chatId && cooldownElapsed) {
          if (zone.name === 'safe') {
            pendingNotifications.push({
              kind: 'all-clear',
              message: this.formatAllClear(loan, notificationMetrics),
            });
          } else {
            pendingNotifications.push({
              kind: 'recovery',
              message: this.formatRecovery(loan, notificationMetrics, zone, previousZone),
            });
          }
          existing.lastNotifiedZone = zone.name;
          existing.lastNotifiedAt = now;
        }
      }
    }

    // Utilization alert pass — independent of HF zone transitions
    const activeUtilKeys = new Set<string>();
    if (config.utilization.enabled) {
      for (const loan of loans) {
        const metrics = computeLoanMetrics(loan);
        for (const borrowedAsset of loan.borrowed) {
          const assetAddr = borrowedAsset.address.toLowerCase();
          let currentUtilization: number | undefined;
          let threshold: number;

          if (loan.marketName.startsWith('morpho_')) {
            currentUtilization = loan.utilizationRate;
            threshold = config.utilization.defaultThreshold;
          } else {
            const telKey = `${loan.marketName}:${assetAddr}`;
            const telemetry = telemetryMap.get(telKey);
            if (telemetry) {
              currentUtilization = telemetry.utilizationRate;
              threshold =
                telemetry.optimalUsageRatio > 0
                  ? telemetry.optimalUsageRatio
                  : config.utilization.defaultThreshold;
            } else {
              continue;
            }
          }

          if (currentUtilization == null) continue;

          const utilKey = `${address}-${loan.id}-${assetAddr}`;
          activeUtilKeys.add(utilKey);
          const existingUtil = this.utilizationStates.get(utilKey);

          if (!existingUtil) {
            const isAbove = currentUtilization >= threshold;
            this.utilizationStates.set(utilKey, {
              wallet: address,
              loanId: loan.id,
              marketName: loan.marketName,
              assetAddress: assetAddr,
              assetSymbol: borrowedAsset.symbol,
              alerted: isAbove,
              lastNotifiedAt: isAbove ? now : 0,
              lastUtilization: currentUtilization,
              threshold,
            });
            if (isAbove && chatId) {
              pendingNotifications.push({
                kind: 'utilization-high',
                message: this.formatUtilizationHigh(
                  loan,
                  borrowedAsset,
                  currentUtilization,
                  threshold,
                  metrics,
                ),
              });
            }
            continue;
          }

          existingUtil.lastUtilization = currentUtilization;
          existingUtil.threshold = threshold;

          if (currentUtilization >= threshold && !existingUtil.alerted) {
            existingUtil.alerted = true;
            if (chatId && now - existingUtil.lastNotifiedAt >= config.utilization.cooldownMs) {
              pendingNotifications.push({
                kind: 'utilization-high',
                message: this.formatUtilizationHigh(
                  loan,
                  borrowedAsset,
                  currentUtilization,
                  threshold,
                  metrics,
                ),
              });
              existingUtil.lastNotifiedAt = now;
            }
          } else if (currentUtilization < threshold && existingUtil.alerted) {
            existingUtil.alerted = false;
            if (chatId && now - existingUtil.lastNotifiedAt >= config.utilization.cooldownMs) {
              pendingNotifications.push({
                kind: 'utilization-normalized',
                message: this.formatUtilizationNormalized(
                  loan,
                  borrowedAsset,
                  currentUtilization,
                  threshold,
                  metrics,
                ),
              });
              existingUtil.lastNotifiedAt = now;
            }
          }
        }
      }
    }

    if (shouldSendReminderDigest) {
      for (const entry of reminderDigestEntries) {
        pendingNotifications.push({
          kind: 'reminder',
          message: entry.message,
        });
        entry.state.lastNotifiedAt = now;
      }
    }

    if (chatId && pendingNotifications.length > 0) {
      await this.sendNotification(
        chatId,
        this.formatWalletNotification(address, label, pendingNotifications),
      );
    }

    // Watchdog evaluation pass — runs after alerts so notifications always go out first
    for (const loan of loans) {
      await this.watchdog.evaluate(loan, address);
    }

    const walletPrefix = `${address}-`;
    for (const stateKey of Array.from(this.states.keys())) {
      if (stateKey.startsWith(walletPrefix) && !activeStateKeys.has(stateKey)) {
        this.states.delete(stateKey);
      }
    }
    for (const utilKey of Array.from(this.utilizationStates.keys())) {
      if (utilKey.startsWith(walletPrefix) && !activeUtilKeys.has(utilKey)) {
        this.utilizationStates.delete(utilKey);
      }
    }
  }

  private resolveUtilization(
    loan: LoanPosition,
    telemetryMap: Map<string, ReserveTelemetry>,
  ): number | undefined {
    if (loan.marketName.startsWith('morpho_')) {
      return loan.utilizationRate;
    }
    const firstBorrowed = loan.borrowed[0];
    if (!firstBorrowed) return undefined;
    const telKey = `${loan.marketName}:${firstBorrowed.address.toLowerCase()}`;
    return telemetryMap.get(telKey)?.utilizationRate;
  }

  private hydrateZones(configuredZones: AlertConfig['zones'] | undefined): Zone[] {
    if (!configuredZones || configuredZones.length === 0) {
      return DEFAULT_ZONES;
    }

    const thresholdsByName = new Map(
      configuredZones.map((zone) => [zone.name, { minHF: zone.minHF, maxHF: zone.maxHF }]),
    );

    return DEFAULT_ZONES.map((zone) => {
      const override = thresholdsByName.get(zone.name);
      if (!override) return zone;
      return { ...zone, minHF: override.minHF, maxHF: override.maxHF };
    });
  }

  private async sendNotification(chatId: string, message: string): Promise<void> {
    const success = await this.telegram.sendMessage(chatId, message);
    if (!success) {
      logger.error('Failed to send Telegram notification');
    }
  }

  private formatZoneTransition(
    loan: {
      marketName: string;
      borrowed: { symbol: string }[];
      totalBorrowedUsd: number;
      totalSuppliedUsd: number;
    },
    metrics: {
      healthFactor: number;
      adjustedHF: number;
      rBorrow: number;
      assetLiquidations: AssetLiquidation[];
    },
    zone: Zone,
    previousZone: Zone,
  ): string {
    const hf = Number.isFinite(metrics.healthFactor) ? metrics.healthFactor.toFixed(2) : '∞';
    const adjHf = Number.isFinite(metrics.adjustedHF) ? metrics.adjustedHF.toFixed(2) : '∞';

    const lines = [
      `${zone.emoji} <b>${zone.label}</b> — Loan Health Changed`,
      '',
      `Market: ${loan.marketName}`,
      `Borrowed: $${loan.totalBorrowedUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })} ${loan.borrowed.map((b) => b.symbol).join('+')} | Collateral: $${loan.totalSuppliedUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
      '',
      `HF: <b>${hf}</b> · Adjusted HF: <b>${adjHf}</b> · Borrow rate: <b>${this.formatBorrowRate(metrics.rBorrow)}</b>`,
      `Zone: ${zone.emoji} ${zone.label} (was ${previousZone.emoji} ${previousZone.label})`,
      `Action: ${zone.action}`,
      '',
    ];

    for (const al of metrics.assetLiquidations) {
      const liqPrice = Number.isFinite(al.liqPrice) ? `$${al.liqPrice.toFixed(2)}` : 'N/A';
      const distToLiq = (al.priceDropToLiq * 100).toFixed(1);
      lines.push(`Liq price (${al.symbol}): ${liqPrice} (−${distToLiq}%)`);
    }

    return lines.join('\n');
  }

  private formatRecovery(
    loan: { marketName: string; borrowed: { symbol: string }[] },
    metrics: { healthFactor: number; adjustedHF: number; rBorrow: number },
    zone: Zone,
    previousZone: Zone,
  ): string {
    const hf = Number.isFinite(metrics.healthFactor) ? metrics.healthFactor.toFixed(2) : '∞';
    const adjHf = Number.isFinite(metrics.adjustedHF) ? metrics.adjustedHF.toFixed(2) : '∞';

    return [
      `${zone.emoji} <b>IMPROVING</b> — Zone Recovery`,
      '',
      `Market: ${loan.marketName} · ${loan.borrowed.map((b) => b.symbol).join('+')}`,
      `HF: <b>${hf}</b> · Adjusted HF: <b>${adjHf}</b> · Borrow rate: <b>${this.formatBorrowRate(metrics.rBorrow)}</b>`,
      `Zone: ${zone.emoji} ${zone.label} (was ${previousZone.emoji} ${previousZone.label})`,
    ].join('\n');
  }

  private formatAllClear(
    loan: { marketName: string; borrowed: { symbol: string }[] },
    metrics: { healthFactor: number; adjustedHF: number; rBorrow: number },
  ): string {
    const hf = Number.isFinite(metrics.healthFactor) ? metrics.healthFactor.toFixed(2) : '∞';
    const adjHf = Number.isFinite(metrics.adjustedHF) ? metrics.adjustedHF.toFixed(2) : '∞';

    return [
      `\u{1F7E2} <b>ALL CLEAR</b> — Back to Safe`,
      '',
      `Market: ${loan.marketName} · ${loan.borrowed.map((b) => b.symbol).join('+')}`,
      `HF: <b>${hf}</b> · Adjusted HF: <b>${adjHf}</b> · Borrow rate: <b>${this.formatBorrowRate(metrics.rBorrow)}</b>`,
      '',
      `All positions are healthy. Monitoring continues.`,
    ].join('\n');
  }

  private formatReminder(
    loan: { marketName: string; borrowed: { symbol: string }[] },
    metrics: { healthFactor: number; adjustedHF: number; rBorrow: number },
    zone: Zone,
    stuckDurationMs: number,
  ): string {
    const hf = Number.isFinite(metrics.healthFactor) ? metrics.healthFactor.toFixed(2) : '∞';
    const adjHf = Number.isFinite(metrics.adjustedHF) ? metrics.adjustedHF.toFixed(2) : '∞';
    const timeAgo = this.formatTimeAgo(stuckDurationMs);

    return [
      `${zone.emoji} <b>REMINDER</b> — Still in ${zone.label} zone`,
      '',
      `Market: ${loan.marketName} · ${loan.borrowed.map((b) => b.symbol).join('+')}`,
      `HF: <b>${hf}</b> · Adjusted HF: <b>${adjHf}</b> · Borrow rate: <b>${this.formatBorrowRate(metrics.rBorrow)}</b>`,
      `Duration: ${timeAgo} ago`,
      `Action: ${zone.action}`,
    ].join('\n');
  }

  private formatUtilizationHigh(
    loan: { marketName: string },
    asset: { symbol: string },
    utilization: number,
    threshold: number,
    metrics: { healthFactor: number; rBorrow: number },
  ): string {
    const utilPct = (utilization * 100).toFixed(1);
    const threshPct = (threshold * 100).toFixed(1);
    const hf = Number.isFinite(metrics.healthFactor) ? metrics.healthFactor.toFixed(2) : '\u221E';

    return [
      `\u26A0\uFE0F <b>HIGH UTILIZATION</b> \u2014 Rate Spike Risk`,
      '',
      `Market: ${loan.marketName} \u00B7 ${asset.symbol}`,
      `Utilization: <b>${utilPct}%</b> (target: ${threshPct}%)`,
      `HF: <b>${hf}</b> \u00B7 Borrow rate: <b>${this.formatBorrowRate(metrics.rBorrow)}</b>`,
      '',
      `Utilization above target \u2014 borrow rates may spike sharply.`,
    ].join('\n');
  }

  private formatUtilizationNormalized(
    loan: { marketName: string },
    asset: { symbol: string },
    utilization: number,
    threshold: number,
    metrics: { healthFactor: number; rBorrow: number },
  ): string {
    const utilPct = (utilization * 100).toFixed(1);
    const threshPct = (threshold * 100).toFixed(1);
    const hf = Number.isFinite(metrics.healthFactor) ? metrics.healthFactor.toFixed(2) : '\u221E';

    return [
      `\u2705 <b>UTILIZATION NORMALIZED</b>`,
      '',
      `Market: ${loan.marketName} \u00B7 ${asset.symbol}`,
      `Utilization: <b>${utilPct}%</b> (target: ${threshPct}%)`,
      `HF: <b>${hf}</b> \u00B7 Borrow rate: <b>${this.formatBorrowRate(metrics.rBorrow)}</b>`,
      '',
      `Utilization back below target \u2014 borrow rates returning to normal.`,
    ].join('\n');
  }

  private formatWalletNotification(
    address: string,
    label: string | undefined,
    notifications: WalletNotification[],
  ): string {
    const walletLabel = label ? `${label} (${this.shortAddr(address)})` : this.shortAddr(address);
    const title = notifications.length === 1 ? '<b>Loan Alert</b>' : '<b>Loan Alerts</b>';

    return [
      title,
      `Wallet: <code>${walletLabel}</code>`,
      '',
      ...notifications.flatMap((notification, index) => [
        ...(notifications.length > 1
          ? [`<b>${this.notificationLabel(notification.kind, index)}</b>`]
          : []),
        notification.message,
        ...(index < notifications.length - 1 ? [''] : []),
      ]),
    ].join('\n');
  }

  private notificationLabel(kind: WalletNotification['kind'], index: number): string {
    const base =
      kind === 'transition'
        ? 'Loan Health Change'
        : kind === 'recovery'
          ? 'Recovery'
          : kind === 'all-clear'
            ? 'All Clear'
            : kind === 'utilization-high'
              ? 'High Utilization'
              : kind === 'utilization-normalized'
                ? 'Utilization Normalized'
                : 'Reminder';
    return `${base} ${index + 1}`;
  }

  private formatTimeAgo(durationMs: number): string {
    if (!Number.isFinite(durationMs) || durationMs <= 0) return '<1m';

    const {
      days = 0,
      hours = 0,
      minutes = 0,
    } = intervalToDuration({
      start: 0,
      end: durationMs,
    });

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);

    if (parts.length === 0) {
      return '<1m';
    }

    return parts.slice(0, 2).join(' ');
  }

  private shortAddr(address: string): string {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  }

  private formatBorrowRate(rate: number): string {
    return Number.isFinite(rate) ? `${(rate * 100).toFixed(2)}%` : 'N/A';
  }
}
