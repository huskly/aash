import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Send, Settings, Trash2, X } from 'lucide-react';
import {
  BORROW_RATE_ALERT_THRESHOLD,
  DEFAULT_BORROW_RATE_CONFIG,
  DEFAULT_POLLING_CONFIG,
  DEFAULT_WATCHDOG_CONFIG,
  DEFAULT_ZONES,
  type BorrowRateConfig,
  type PollingConfig,
  type WatchdogConfig,
  type Zone,
} from '@aave-monitor/core';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Separator } from './ui/separator';
import { useToast } from './ui/toast-context';
import { HfSlider } from './HfSlider';
import { ZoneSlider } from './ZoneSlider';

type WalletConfig = {
  address: string;
  label?: string;
  enabled: boolean;
};

type ZoneConfig = {
  name: Zone['name'];
  minHF: number;
  maxHF: number;
};

type AlertConfig = {
  wallets: WalletConfig[];
  telegram: { chatId: string; enabled: boolean };
  polling: PollingConfig;
  zones: ZoneConfig[];
  watchdog: WatchdogConfig;
  borrowRate: BorrowRateConfig;
};

const DEFAULT_ZONE_CONFIG: ZoneConfig[] = DEFAULT_ZONES.map(({ name, minHF, maxHF }) => ({
  name,
  minHF,
  maxHF,
}));

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validateConfig(config: AlertConfig): string | null {
  const { watchdog } = config;

  if (!isPositiveFinite(watchdog.triggerHF)) {
    return 'Watchdog trigger HF must be a positive number.';
  }

  if (!isPositiveFinite(watchdog.targetHF)) {
    return 'Watchdog target HF must be a positive number.';
  }

  if (watchdog.targetHF <= watchdog.triggerHF) {
    return 'Watchdog target HF must be greater than trigger HF.';
  }

  if (!isPositiveFinite(watchdog.minResultingHF)) {
    return 'Watchdog minimum resulting HF must be a positive number.';
  }

  if (watchdog.minResultingHF <= watchdog.triggerHF) {
    return 'Watchdog minimum resulting HF must be greater than trigger HF.';
  }

  if (watchdog.minResultingHF > watchdog.targetHF) {
    return 'Watchdog minimum resulting HF must be less than or equal to target HF.';
  }

  if (!isPositiveFinite(watchdog.cooldownMs)) {
    return 'Watchdog cooldown must be a positive number.';
  }

  if (!isPositiveFinite(watchdog.maxRepayAmount)) {
    return 'Watchdog max repay amount must be a positive number.';
  }

  if (!isPositiveFinite(watchdog.deadlineSeconds)) {
    return 'Watchdog deadline seconds must be a positive number.';
  }

  const hasValidAaveContract = /^0x[a-fA-F0-9]{40}$/.test(watchdog.rescueContract);
  const hasValidMorphoContract = /^0x[a-fA-F0-9]{40}$/.test(watchdog.morphoRescueContract);

  if (watchdog.rescueContract && !hasValidAaveContract) {
    return 'Aave Watchdog rescue contract must be a valid Ethereum address.';
  }

  if (watchdog.morphoRescueContract && !hasValidMorphoContract) {
    return 'Morpho rescue contract must be a valid Ethereum address.';
  }

  if (watchdog.enabled && !hasValidAaveContract && !hasValidMorphoContract) {
    return 'Enable watchdog only after configuring at least one rescue contract.';
  }

  if (!isPositiveFinite(watchdog.maxGasGwei)) {
    return 'Watchdog max gas must be a positive number.';
  }

  if (!isPositiveFinite(watchdog.preRescueTriggerHF)) {
    return 'Pre-rescue trigger HF must be a positive number.';
  }
  if (watchdog.preRescueTriggerHF <= watchdog.triggerHF) {
    return 'Pre-rescue trigger HF must be greater than trigger HF.';
  }
  if (!isPositiveFinite(watchdog.maxVaultWithdrawAmount)) {
    return 'Watchdog max vault withdraw amount must be a positive number.';
  }
  if (
    watchdog.vaultWithdrawContract &&
    !/^0x[a-fA-F0-9]{40}$/.test(watchdog.vaultWithdrawContract)
  ) {
    return 'Vault withdraw contract must be a valid Ethereum address.';
  }
  if (watchdog.preRescueEnabled && !/^0x[a-fA-F0-9]{40}$/.test(watchdog.vaultWithdrawContract)) {
    return 'Enable pre-rescue only after configuring the vault withdraw contract.';
  }

  return null;
}

function normalizeConfig(config: Partial<AlertConfig> | null | undefined): AlertConfig {
  const configuredZones = config?.zones ?? DEFAULT_ZONE_CONFIG;
  const thresholdsByName = new Map(
    configuredZones.map((zone) => [
      zone.name,
      {
        minHF: zone.minHF,
        maxHF: Number.isFinite(zone.maxHF) ? zone.maxHF : Infinity,
      },
    ]),
  );
  const zones = DEFAULT_ZONE_CONFIG.map((zone) => {
    const override = thresholdsByName.get(zone.name);
    if (!override) return zone;
    return { ...zone, minHF: override.minHF, maxHF: override.maxHF };
  });

  return {
    wallets: config?.wallets ?? [],
    telegram: {
      chatId: config?.telegram?.chatId ?? '',
      enabled: config?.telegram?.enabled ?? false,
    },
    polling: {
      ...DEFAULT_POLLING_CONFIG,
      ...(config?.polling ?? {}),
    },
    zones,
    watchdog: {
      ...DEFAULT_WATCHDOG_CONFIG,
      ...(config?.watchdog ?? {}),
    },
    borrowRate: {
      ...DEFAULT_BORROW_RATE_CONFIG,
      ...(config?.borrowRate ?? {}),
    },
  };
}

export function ServerSettings() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="icon"
        onClick={() => setOpen(true)}
        aria-label="Server settings"
      >
        <Settings size={16} />
      </Button>
      {open ? <ServerSettingsPanel onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ServerSettingsPanel({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<AlertConfig | null>(null);
  const [backendAvailable, setBackendAvailable] = useState(true);
  const [error, setError] = useState('');
  const [testStatus, setTestStatus] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [showZones, setShowZones] = useState(false);
  const [showPolling, setShowPolling] = useState(false);
  const [showWatchdog, setShowWatchdog] = useState(false);
  const [showBorrowRate, setShowBorrowRate] = useState(false);
  const [showNotificationSettings, setShowNotificationSettings] = useState(false);
  const [newWalletAddress, setNewWalletAddress] = useState('');
  const [newWalletLabel, setNewWalletLabel] = useState('');
  const { pushToast } = useToast();

  const fetchConfig = useCallback(async () => {
    try {
      const response = await fetch(`/api/config`);
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!contentType.includes('application/json')) {
        throw new Error('Config API returned non-JSON response');
      }
      const data = (await response.json()) as Partial<AlertConfig>;
      setConfig(normalizeConfig(data));
      setBackendAvailable(true);
      setError('');
    } catch {
      setConfig(normalizeConfig(null));
      setBackendAvailable(false);
      setError(
        'Monitor server is not running. Start `yarn dev:all` (or `yarn dev:server`) for live config.',
      );
    }
  }, []);

  useEffect(() => {
    void fetchConfig(); // eslint-disable-line react-hooks/set-state-in-effect -- fetch-on-mount
  }, [fetchConfig]);

  const saveConfig = async (updated: AlertConfig) => {
    if (!backendAvailable) {
      const message =
        'Monitor server is offline. Start `yarn dev:all` (or `yarn dev:server`) to save settings.';
      setError(message);
      pushToast({ title: message, variant: 'error' });
      return;
    }

    const validationError = validateConfig(updated);
    if (validationError) {
      setError(validationError);
      pushToast({ title: validationError, variant: 'error' });
      return;
    }

    try {
      const response = await fetch(`/api/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(updated),
      });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const payload = (await response.json()) as { error?: string };
          if (payload.error) message = payload.error;
        } catch {
          // Ignore parse failures and fallback to HTTP status.
        }
        throw new Error(message);
      }
      const data = (await response.json()) as AlertConfig;
      setConfig(normalizeConfig(data));
      setError('');
      pushToast({ title: 'Server settings saved.', variant: 'success' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save config';
      setError(message);
      pushToast({ title: message, variant: 'error' });
    }
  };

  const applyConfigUpdate = (
    updater: (current: AlertConfig) => AlertConfig,
    options?: { persist?: boolean },
  ) => {
    if (!config) return;
    const updated = updater(config);
    setConfig(updated);
    if (options?.persist) {
      void saveConfig(updated);
    }
  };

  const updateTelegram = (
    patch: Partial<AlertConfig['telegram']>,
    options?: { persist?: boolean },
  ) => {
    applyConfigUpdate(
      (current) => ({
        ...current,
        telegram: { ...current.telegram, ...patch },
      }),
      options,
    );
  };

  const updateWatchdog = (
    patch: Partial<AlertConfig['watchdog']>,
    options?: { persist?: boolean },
  ) => {
    applyConfigUpdate(
      (current) => ({
        ...current,
        watchdog: { ...current.watchdog, ...patch },
      }),
      options,
    );
  };

  const updateBorrowRate = (
    patch: Partial<AlertConfig['borrowRate']>,
    options?: { persist?: boolean },
  ) => {
    applyConfigUpdate(
      (current) => ({
        ...current,
        borrowRate: { ...current.borrowRate, ...patch },
      }),
      options,
    );
  };

  const updatePolling = (
    patch: Partial<AlertConfig['polling']>,
    options?: { persist?: boolean },
  ) => {
    applyConfigUpdate(
      (current) => ({
        ...current,
        polling: { ...current.polling, ...patch },
      }),
      options,
    );
  };

  const sendTest = async () => {
    if (!backendAvailable) {
      setTestStatus('error');
      setError('Monitor server is offline. Telegram test requires the backend.');
      return;
    }

    setTestStatus('sending');
    try {
      const response = await fetch(`/api/telegram/test`, { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setTestStatus('success');
      setTimeout(() => setTestStatus('idle'), 3000);
    } catch {
      setTestStatus('error');
      setTimeout(() => setTestStatus('idle'), 3000);
    }
  };

  const addWallet = () => {
    if (!config || !newWalletAddress.trim()) return;
    applyConfigUpdate(
      (current) => ({
        ...current,
        wallets: [
          ...current.wallets,
          {
            address: newWalletAddress.trim(),
            label: newWalletLabel.trim() || undefined,
            enabled: true,
          },
        ],
      }),
      { persist: true },
    );
    setNewWalletAddress('');
    setNewWalletLabel('');
  };

  const removeWallet = (index: number) => {
    applyConfigUpdate(
      (current) => ({
        ...current,
        wallets: current.wallets.filter((_, i) => i !== index),
      }),
      { persist: true },
    );
  };

  const toggleWallet = (index: number) => {
    applyConfigUpdate(
      (current) => ({
        ...current,
        wallets: current.wallets.map((w, i) => (i === index ? { ...w, enabled: !w.enabled } : w)),
      }),
      { persist: true },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-16 backdrop-blur-sm">
      <Card className="relative max-h-[80vh] w-full max-w-[540px] overflow-y-auto">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="inline-flex items-center gap-2">
              <Settings size={18} /> Server Settings
            </CardTitle>
            <Button type="button" variant="ghost" size="icon" onClick={onClose}>
              <X size={16} />
            </Button>
          </div>
        </CardHeader>

        <CardContent>
          {error ? <p className="mb-3 text-sm text-destructive">{error}</p> : null}

          {config ? (
            <div className="grid gap-4">
              <section>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 text-left text-sm font-semibold"
                  onClick={() => setShowNotificationSettings(!showNotificationSettings)}
                >
                  {showNotificationSettings ? (
                    <ChevronDown size={16} />
                  ) : (
                    <ChevronRight size={16} />
                  )}
                  Notification Settings
                </button>
                {showNotificationSettings ? (
                  <div className="mt-3 grid gap-4">
                    <section className="grid gap-3">
                      <h3 className="text-sm font-semibold">Telegram</h3>

                      <label className="grid gap-1.5 text-sm">
                        <span className="text-muted-foreground">Chat ID</span>
                        <Input
                          value={config.telegram.chatId}
                          onChange={(e) => updateTelegram({ chatId: e.target.value })}
                          onBlur={(e) =>
                            updateTelegram({ chatId: e.target.value }, { persist: true })
                          }
                          placeholder="e.g. 123456789"
                        />
                      </label>

                      <div className="flex items-center gap-3">
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={config.telegram.enabled}
                            onChange={() =>
                              updateTelegram(
                                { enabled: !config.telegram.enabled },
                                { persist: true },
                              )
                            }
                            className="accent-primary"
                          />
                          Enable notifications
                        </label>

                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => void sendTest()}
                        >
                          <Send size={14} />
                          {testStatus === 'sending'
                            ? 'Sending...'
                            : testStatus === 'success'
                              ? 'Sent!'
                              : testStatus === 'error'
                                ? 'Failed'
                                : 'Test'}
                        </Button>
                      </div>
                    </section>

                    <Separator />

                    <section className="grid gap-3">
                      <h3 className="text-sm font-semibold">Wallets</h3>

                      {config.wallets.length > 0 ? (
                        <ul className="grid gap-2">
                          {config.wallets.map((w, i) => (
                            <li
                              key={`${w.address}-${i}`}
                              className="flex items-center gap-2 rounded-lg border border-border bg-accent px-3 py-2 text-sm"
                            >
                              <input
                                type="checkbox"
                                checked={w.enabled}
                                onChange={() => toggleWallet(i)}
                                className="accent-primary"
                              />
                              <div className="min-w-0 flex-1">
                                {w.label ? <span className="font-semibold">{w.label} </span> : null}
                                <span className="break-all font-mono text-xs text-muted-foreground">
                                  {w.address}
                                </span>
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => removeWallet(i)}
                              >
                                <Trash2 size={14} />
                              </Button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-sm text-muted-foreground">No wallets configured.</p>
                      )}

                      <div className="flex flex-wrap gap-2">
                        <Input
                          value={newWalletAddress}
                          onChange={(e) => setNewWalletAddress(e.target.value)}
                          placeholder="0x..."
                          className="min-w-[200px] flex-1"
                        />
                        <Input
                          value={newWalletLabel}
                          onChange={(e) => setNewWalletLabel(e.target.value)}
                          placeholder="Label (optional)"
                          className="w-[140px]"
                        />
                        <Button type="button" variant="secondary" size="sm" onClick={addWallet}>
                          <Plus size={14} /> Add
                        </Button>
                      </div>
                    </section>
                  </div>
                ) : null}
              </section>

              <Separator />

              <section>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 text-left text-sm font-semibold"
                  onClick={() => setShowWatchdog(!showWatchdog)}
                >
                  {showWatchdog ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  Watchdog
                </button>
                {showWatchdog ? (
                  <div className="mt-3 grid gap-3">
                    <div className="flex flex-wrap items-center gap-4">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={config.watchdog.enabled}
                          onChange={() =>
                            updateWatchdog({ enabled: !config.watchdog.enabled }, { persist: true })
                          }
                          className="accent-primary"
                        />
                        Enable watchdog
                      </label>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={config.watchdog.dryRun}
                          onChange={() =>
                            updateWatchdog({ dryRun: !config.watchdog.dryRun }, { persist: true })
                          }
                          className="accent-primary"
                        />
                        Dry run mode
                      </label>
                    </div>

                    {!config.watchdog.dryRun ? (
                      <p className="text-xs text-warning">
                        Live mode requires WATCHDOG_PRIVATE_KEY on the server.
                      </p>
                    ) : null}

                    <HfSlider
                      triggerHF={config.watchdog.triggerHF}
                      minResultingHF={config.watchdog.minResultingHF}
                      targetHF={config.watchdog.targetHF}
                      onChange={({ triggerHF, minResultingHF, targetHF }) => {
                        updateWatchdog({ triggerHF, minResultingHF, targetHF });
                      }}
                      onCommit={({ triggerHF, minResultingHF, targetHF }) =>
                        updateWatchdog({ triggerHF, minResultingHF, targetHF }, { persist: true })
                      }
                    />

                    <label className="grid gap-1.5 text-sm">
                      <span className="text-muted-foreground">Action cooldown (minutes)</span>
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        value={Math.round(config.watchdog.cooldownMs / 60_000)}
                        onChange={(e) =>
                          updateWatchdog({ cooldownMs: Number(e.target.value) * 60_000 })
                        }
                        onBlur={(e) =>
                          updateWatchdog(
                            { cooldownMs: Number(e.target.value) * 60_000 },
                            { persist: true },
                          )
                        }
                        className="w-[120px]"
                      />
                    </label>

                    <label className="grid gap-1.5 text-sm">
                      <span className="text-muted-foreground">
                        Max repay per action (debt token)
                      </span>
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        value={config.watchdog.maxRepayAmount}
                        onChange={(e) => updateWatchdog({ maxRepayAmount: Number(e.target.value) })}
                        onBlur={(e) =>
                          updateWatchdog(
                            { maxRepayAmount: Number(e.target.value) },
                            { persist: true },
                          )
                        }
                        className="w-[120px]"
                      />
                    </label>

                    <label className="grid gap-1.5 text-sm">
                      <span className="text-muted-foreground">Rescue tx deadline (seconds)</span>
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        value={Math.round(config.watchdog.deadlineSeconds)}
                        onChange={(e) =>
                          updateWatchdog({ deadlineSeconds: Number(e.target.value) })
                        }
                        onBlur={(e) =>
                          updateWatchdog(
                            { deadlineSeconds: Number(e.target.value) },
                            { persist: true },
                          )
                        }
                        className="w-[120px]"
                      />
                    </label>

                    <label className="grid gap-1.5 text-sm">
                      <span className="text-muted-foreground">Aave rescue contract</span>
                      <Input
                        value={config.watchdog.rescueContract}
                        onChange={(e) => updateWatchdog({ rescueContract: e.target.value.trim() })}
                        onBlur={(e) =>
                          updateWatchdog(
                            { rescueContract: e.target.value.trim() },
                            { persist: true },
                          )
                        }
                        placeholder="0x..."
                        className="font-mono text-xs"
                      />
                    </label>

                    <label className="grid gap-1.5 text-sm">
                      <span className="text-muted-foreground">Morpho rescue contract</span>
                      <Input
                        value={config.watchdog.morphoRescueContract}
                        onChange={(e) =>
                          updateWatchdog({ morphoRescueContract: e.target.value.trim() })
                        }
                        onBlur={(e) =>
                          updateWatchdog(
                            { morphoRescueContract: e.target.value.trim() },
                            { persist: true },
                          )
                        }
                        placeholder="0x..."
                        className="font-mono text-xs"
                      />
                    </label>

                    <label className="grid gap-1.5 text-sm">
                      <span className="text-muted-foreground">Max gas (gwei)</span>
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        value={Math.round(config.watchdog.maxGasGwei)}
                        onChange={(e) => updateWatchdog({ maxGasGwei: Number(e.target.value) })}
                        onBlur={(e) =>
                          updateWatchdog({ maxGasGwei: Number(e.target.value) }, { persist: true })
                        }
                        className="w-[120px]"
                      />
                    </label>

                    <div className="mt-2 grid gap-3 rounded-md border border-border/60 p-3">
                      <div className="text-xs font-semibold uppercase text-muted-foreground">
                        Pre-rescue (Morpho vault withdrawal)
                      </div>
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={config.watchdog.preRescueEnabled}
                          onChange={() =>
                            updateWatchdog(
                              { preRescueEnabled: !config.watchdog.preRescueEnabled },
                              { persist: true },
                            )
                          }
                          className="accent-primary"
                        />
                        Enable pre-rescue vault withdrawal
                      </label>

                      <label className="grid gap-1.5 text-sm">
                        <span className="text-muted-foreground">Pre-rescue trigger HF</span>
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={config.watchdog.preRescueTriggerHF}
                          onChange={(e) =>
                            updateWatchdog({ preRescueTriggerHF: Number(e.target.value) })
                          }
                          onBlur={(e) =>
                            updateWatchdog(
                              { preRescueTriggerHF: Number(e.target.value) },
                              { persist: true },
                            )
                          }
                          className="w-[120px]"
                        />
                      </label>

                      <label className="grid gap-1.5 text-sm">
                        <span className="text-muted-foreground">
                          Max vault withdraw per action (debt token)
                        </span>
                        <Input
                          type="number"
                          min="1"
                          step="1"
                          value={config.watchdog.maxVaultWithdrawAmount}
                          onChange={(e) =>
                            updateWatchdog({ maxVaultWithdrawAmount: Number(e.target.value) })
                          }
                          onBlur={(e) =>
                            updateWatchdog(
                              { maxVaultWithdrawAmount: Number(e.target.value) },
                              { persist: true },
                            )
                          }
                          className="w-[120px]"
                        />
                      </label>

                      <label className="grid gap-1.5 text-sm">
                        <span className="text-muted-foreground">Vault withdraw contract</span>
                        <Input
                          value={config.watchdog.vaultWithdrawContract}
                          onChange={(e) =>
                            updateWatchdog({ vaultWithdrawContract: e.target.value.trim() })
                          }
                          onBlur={(e) =>
                            updateWatchdog(
                              { vaultWithdrawContract: e.target.value.trim() },
                              { persist: true },
                            )
                          }
                          placeholder="0x..."
                          className="font-mono text-xs"
                        />
                      </label>
                    </div>
                  </div>
                ) : null}
              </section>

              <Separator />

              <section>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 text-left text-sm font-semibold"
                  onClick={() => setShowBorrowRate(!showBorrowRate)}
                >
                  {showBorrowRate ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  Borrow Rate Alerts
                </button>
                {showBorrowRate ? (
                  <div className="mt-3 grid gap-3">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={config.borrowRate.enabled}
                        onChange={() =>
                          updateBorrowRate(
                            { enabled: !config.borrowRate.enabled },
                            { persist: true },
                          )
                        }
                        className="accent-primary"
                      />
                      Enable borrow rate alerts
                    </label>

                    <p className="text-xs text-muted-foreground">
                      Alerts when a loan&apos;s weighted borrow rate crosses{' '}
                      <b>{(BORROW_RATE_ALERT_THRESHOLD * 100).toFixed(2)}%</b>.
                    </p>

                    <label className="grid gap-1.5 text-sm">
                      <span className="text-muted-foreground">Alert cooldown (minutes)</span>
                      <Input
                        type="number"
                        min="1"
                        step="1"
                        value={Math.round(config.borrowRate.cooldownMs / 60_000)}
                        onChange={(e) =>
                          updateBorrowRate({ cooldownMs: Number(e.target.value) * 60_000 })
                        }
                        onBlur={(e) =>
                          updateBorrowRate(
                            { cooldownMs: Number(e.target.value) * 60_000 },
                            { persist: true },
                          )
                        }
                        className="w-[100px]"
                      />
                    </label>
                  </div>
                ) : null}
              </section>

              <Separator />

              <section>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 text-left text-sm font-semibold"
                  onClick={() => setShowZones(!showZones)}
                >
                  {showZones ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  Zone Thresholds
                </button>
                {showZones ? (
                  <div className="mt-3">
                    <ZoneSlider
                      zones={config.zones}
                      onChange={(zones) => applyConfigUpdate((current) => ({ ...current, zones }))}
                      onCommit={(zones) =>
                        applyConfigUpdate((current) => ({ ...current, zones }), { persist: true })
                      }
                    />
                  </div>
                ) : null}
              </section>

              <Separator />

              <section>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 text-left text-sm font-semibold"
                  onClick={() => setShowPolling(!showPolling)}
                >
                  {showPolling ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  Polling Settings
                </button>
                {showPolling ? (
                  <div className="mt-3 grid gap-3">
                    <label className="grid gap-1.5 text-sm">
                      <span className="text-muted-foreground">Polling interval (minutes)</span>
                      <Input
                        type="number"
                        min="1"
                        value={Math.round(config.polling.intervalMs / 60_000)}
                        onChange={(e) =>
                          updatePolling({ intervalMs: Number(e.target.value) * 60_000 })
                        }
                        onBlur={(e) =>
                          updatePolling(
                            { intervalMs: Number(e.target.value) * 60_000 },
                            { persist: true },
                          )
                        }
                        className="w-[100px]"
                      />
                    </label>
                    <label className="grid gap-1.5 text-sm">
                      <span className="text-muted-foreground">Debounce checks</span>
                      <Input
                        type="number"
                        min="1"
                        value={config.polling.debounceChecks}
                        onChange={(e) => updatePolling({ debounceChecks: Number(e.target.value) })}
                        onBlur={(e) =>
                          updatePolling(
                            { debounceChecks: Number(e.target.value) },
                            { persist: true },
                          )
                        }
                        className="w-[100px]"
                      />
                    </label>
                    <label className="grid gap-1.5 text-sm">
                      <span className="text-muted-foreground">Reminder interval (minutes)</span>
                      <Input
                        type="number"
                        min="1"
                        value={Math.round(config.polling.reminderIntervalMs / 60_000)}
                        onChange={(e) =>
                          updatePolling({ reminderIntervalMs: Number(e.target.value) * 60_000 })
                        }
                        onBlur={(e) =>
                          updatePolling(
                            { reminderIntervalMs: Number(e.target.value) * 60_000 },
                            { persist: true },
                          )
                        }
                        className="w-[100px]"
                      />
                    </label>
                    <label className="grid gap-1.5 text-sm">
                      <span className="text-muted-foreground">Recovery cooldown (minutes)</span>
                      <Input
                        type="number"
                        min="1"
                        value={Math.round(config.polling.cooldownMs / 60_000)}
                        onChange={(e) =>
                          updatePolling({ cooldownMs: Number(e.target.value) * 60_000 })
                        }
                        onBlur={(e) =>
                          updatePolling(
                            { cooldownMs: Number(e.target.value) * 60_000 },
                            { persist: true },
                          )
                        }
                        className="w-[100px]"
                      />
                    </label>
                  </div>
                ) : null}
              </section>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Loading configuration...</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
