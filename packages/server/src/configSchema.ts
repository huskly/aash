import { z } from 'zod';
import type { UtilizationConfig } from '@aave-monitor/core';
import type { AlertConfig, WatchdogConfig } from './storage.js';

const partialWatchdogConfigSchema = z
  .object({
    enabled: z.boolean(),
    dryRun: z.boolean(),
    triggerHF: z.number().positive(),
    targetHF: z.number().positive(),
    minResultingHF: z.number().positive(),
    cooldownMs: z.number().positive(),
    maxRepayAmount: z.number().positive(),
    maxTopUpAmount: z.number().positive(),
    maxTopUpWbtc: z.number().positive(),
    deadlineSeconds: z.number().int().positive(),
    rescueContract: z.string(),
    morphoRescueContract: z.string(),
    maxGasGwei: z.number().positive(),
  })
  .partial()
  .transform(({ maxTopUpWbtc, maxTopUpAmount, maxRepayAmount, ...watchdog }) => ({
    ...watchdog,
    ...(maxRepayAmount !== undefined
      ? { maxRepayAmount }
      : maxTopUpAmount !== undefined
        ? { maxRepayAmount: maxTopUpAmount }
        : maxTopUpWbtc !== undefined
          ? { maxRepayAmount: maxTopUpWbtc }
          : {}),
  }));

export const partialAlertConfigSchema = z
  .object({
    wallets: z.array(
      z.object({
        address: z.string(),
        label: z.string().optional(),
        enabled: z.boolean(),
      }),
    ),
    telegram: z.object({
      chatId: z.string(),
      enabled: z.boolean(),
    }),
    polling: z.object({
      intervalMs: z.number().positive(),
      debounceChecks: z.number().positive(),
      reminderIntervalMs: z.number().positive(),
      cooldownMs: z.number().positive(),
    }),
    zones: z.array(
      z.object({
        name: z.enum(['safe', 'comfort', 'watch', 'alert', 'action', 'critical']),
        minHF: z.number(),
        maxHF: z.union([z.number(), z.null()]).transform((value) => value ?? Infinity),
      }),
    ),
    watchdog: partialWatchdogConfigSchema,
    utilization: z
      .object({
        enabled: z.boolean(),
        defaultThreshold: z.number().min(0).max(1),
        cooldownMs: z.number().positive(),
      })
      .partial(),
  })
  .partial();

export type ConfigUpdate = Partial<Omit<AlertConfig, 'watchdog' | 'utilization'>> & {
  watchdog?: Partial<WatchdogConfig>;
  utilization?: Partial<UtilizationConfig>;
};

export function parseConfigBody(body: unknown): { data: ConfigUpdate } | { error: string } {
  const result = partialAlertConfigSchema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    if (!issue) {
      return { error: 'Invalid request body' };
    }
    const path = issue.path.join('.');
    const message = path ? `${path}: ${issue.message}` : issue.message;
    return { error: message };
  }
  return { data: result.data };
}
