import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_POLLING_CONFIG,
  DEFAULT_WATCHDOG_CONFIG,
  DEFAULT_ZONES,
  type PollingConfig,
  type WatchdogConfig as CoreWatchdogConfig,
  type ZoneName,
} from '@aave-monitor/core';

export type WalletConfig = {
  address: string;
  label?: string;
  enabled: boolean;
};

export type ZoneConfig = {
  name: ZoneName;
  minHF: number;
  maxHF: number;
};

export type WatchdogConfig = CoreWatchdogConfig;

export type AlertConfig = {
  wallets: WalletConfig[];
  telegram: {
    chatId: string;
    enabled: boolean;
  };
  polling: PollingConfig;
  zones: ZoneConfig[];
  watchdog: WatchdogConfig;
};

const DEFAULT_CONFIG: AlertConfig = {
  wallets: [],
  telegram: {
    chatId: '',
    enabled: false,
  },
  polling: { ...DEFAULT_POLLING_CONFIG },
  zones: [
    { name: 'safe', minHF: 2.2, maxHF: Infinity },
    { name: 'comfort', minHF: 1.9, maxHF: 2.2 },
    { name: 'watch', minHF: 1.6, maxHF: 1.9 },
    { name: 'alert', minHF: 1.3, maxHF: 1.6 },
    { name: 'action', minHF: 1.15, maxHF: 1.3 },
    { name: 'critical', minHF: 0, maxHF: 1.15 },
  ],
  watchdog: { ...DEFAULT_WATCHDOG_CONFIG },
};

function parseEnvFloat(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function applyWatchdogEnvOverrides(watchdog: WatchdogConfig): void {
  const triggerHF = parseEnvFloat('WATCHDOG_TRIGGER_HF');
  if (triggerHF !== undefined) watchdog.triggerHF = triggerHF;

  const targetHF = parseEnvFloat('WATCHDOG_TARGET_HF');
  if (targetHF !== undefined) watchdog.targetHF = targetHF;

  const minResultingHF = parseEnvFloat('WATCHDOG_MIN_RESULTING_HF');
  if (minResultingHF !== undefined) watchdog.minResultingHF = minResultingHF;

  const maxTopUpWbtc = parseEnvFloat('WATCHDOG_MAX_TOP_UP_WBTC');
  if (maxTopUpWbtc !== undefined) watchdog.maxTopUpWbtc = maxTopUpWbtc;

  const deadlineSeconds = parseEnvFloat('WATCHDOG_DEADLINE_SECONDS');
  if (deadlineSeconds !== undefined) watchdog.deadlineSeconds = deadlineSeconds;

  const rescueContract = process.env['WATCHDOG_RESCUE_CONTRACT']?.trim();
  if (rescueContract) watchdog.rescueContract = rescueContract;

  const morphoRescueContract = process.env['WATCHDOG_MORPHO_RESCUE_CONTRACT']?.trim();
  if (morphoRescueContract) watchdog.morphoRescueContract = morphoRescueContract;
}

function mergeWatchdogConfig(config: Partial<WatchdogConfig> | undefined): WatchdogConfig {
  return {
    ...DEFAULT_WATCHDOG_CONFIG,
    ...config,
  };
}

function normalizeZones(zones: AlertConfig['zones']): AlertConfig['zones'] {
  const thresholdsByName = new Map(
    zones.map((zone) => [
      zone.name,
      {
        minHF: zone.minHF,
        maxHF: Number.isFinite(zone.maxHF) ? zone.maxHF : Infinity,
      },
    ]),
  );

  return DEFAULT_ZONES.map((zone) => {
    const override = thresholdsByName.get(zone.name);
    if (!override) {
      return {
        name: zone.name,
        minHF: zone.minHF,
        maxHF: zone.maxHF,
      };
    }

    return {
      name: zone.name,
      minHF: override.minHF,
      maxHF: override.maxHF,
    };
  });
}

export class ConfigStorage {
  private config: AlertConfig;
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.config = this.load();
  }

  private load(): AlertConfig {
    try {
      if (!existsSync(this.filePath)) {
        const config = structuredClone(DEFAULT_CONFIG);
        applyWatchdogEnvOverrides(config.watchdog);
        return config;
      }
      const raw = readFileSync(this.filePath, 'utf-8');
      const config = JSON.parse(raw) as AlertConfig;
      // JSON.stringify turns Infinity into null; restore it on load
      if (config.zones) config.zones = normalizeZones(config.zones);
      // Merge with defaults to support older/partial persisted configs.
      config.watchdog = mergeWatchdogConfig(config.watchdog);
      applyWatchdogEnvOverrides(config.watchdog);
      return config;
    } catch {
      const config = structuredClone(DEFAULT_CONFIG);
      applyWatchdogEnvOverrides(config.watchdog);
      return config;
    }
  }

  save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.filePath, JSON.stringify(this.config, null, 2), 'utf-8');
  }

  get(): AlertConfig {
    return this.config;
  }

  update(
    partial: Partial<Omit<AlertConfig, 'watchdog'>> & { watchdog?: Partial<WatchdogConfig> },
  ): AlertConfig {
    if (partial.wallets !== undefined) this.config.wallets = partial.wallets;
    if (partial.telegram !== undefined) this.config.telegram = partial.telegram;
    if (partial.polling !== undefined) this.config.polling = partial.polling;
    if (partial.zones !== undefined) this.config.zones = normalizeZones(partial.zones);
    if (partial.watchdog !== undefined) {
      this.config.watchdog = mergeWatchdogConfig({
        ...this.config.watchdog,
        ...partial.watchdog,
      });
    }
    this.save();
    return this.config;
  }
}
