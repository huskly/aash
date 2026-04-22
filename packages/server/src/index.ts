import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { z } from 'zod';
import { fetchTokenBalances, fetchStablecoinBalances } from '@aave-monitor/core';
import { ConfigStorage } from './storage.js';
import { TelegramClient, type TelegramBotCommand } from './telegram.js';
import { Monitor } from './monitor.js';
import {
  formatWatchdogStatusMessage,
  shouldRunMonitor,
  validateWatchdogThresholds,
} from './runtime.js';
import { logger } from './logger.js';
import { fetchReserveTelemetry } from './reserveTelemetry.js';
import { parseConfigBody } from './configSchema.js';
import { formatStatusMessage } from './statusMessage.js';
import { RateHistoryDb } from './rateHistoryDb.js';
import { serializeConfig } from './configResponse.js';

const tokenBalanceRequestSchema = z.object({
  tokens: z.array(
    z.object({
      address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
      decimals: z.number().int().min(0).max(255),
    }),
  ),
});

const reserveTelemetryQuerySchema = z.object({
  market: z.string().min(1),
  asset: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  symbol: z.string().optional(),
});

const rateHistoryQuerySchema = z.object({
  wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  loanId: z.string().min(1),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
});

const interestHistoryQuerySchema = z.object({
  wallet: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  positionId: z.string().min(1),
  kind: z.enum(['loan', 'vault']),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_ENV_PATH = join(__dirname, '..', '..', '..', '.env');

if (existsSync(ROOT_ENV_PATH)) {
  process.loadEnvFile(ROOT_ENV_PATH);
}

const PORT = Number(process.env.PORT ?? 3001);
const RPC_URL = process.env.VITE_RPC_URL ?? process.env.RPC_URL ?? 'https://rpc.mevblocker.io';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const GRAPH_API_KEY = process.env.VITE_THE_GRAPH_API_KEY ?? process.env.THE_GRAPH_API_KEY;
const COINGECKO_API_KEY = process.env.VITE_COINGECKO_API_KEY ?? process.env.COINGECKO_API_KEY;
const WATCHDOG_EXECUTOR_PRIVATE_KEY =
  process.env.WATCHDOG_EXECUTOR_PRIVATE_KEY ?? process.env.WATCHDOG_PRIVATE_KEY;

const configPath = join(__dirname, '..', 'data', 'config.json');
const storage = new ConfigStorage(configPath);
const telegram = new TelegramClient(TELEGRAM_BOT_TOKEN);
const rateHistoryDb = new RateHistoryDb(join(__dirname, '..', 'data', 'rates.db'));
const monitor = new Monitor(
  telegram,
  () => storage.get(),
  GRAPH_API_KEY,
  COINGECKO_API_KEY,
  RPC_URL,
  WATCHDOG_EXECUTOR_PRIVATE_KEY,
  rateHistoryDb,
);

const TELEGRAM_BOT_COMMANDS: TelegramBotCommand[] = [
  { command: 'status', description: 'Show portfolio status and health factors' },
  { command: 'refresh', description: 'Refresh data and show updated status' },
  { command: 'watchdog', description: 'Show watchdog status and recent actions' },
  { command: 'help', description: 'List available commands' },
];

function syncRuntimeServices(options: { restartMonitor?: boolean } = {}): void {
  const { restartMonitor = false } = options;
  const config = storage.get();

  if (TELEGRAM_BOT_TOKEN) {
    void telegram.syncCommands(TELEGRAM_BOT_COMMANDS);
    telegram.startCommandPolling();
  } else {
    telegram.stopCommandPolling();
  }

  if (shouldRunMonitor(config)) {
    if (restartMonitor) {
      monitor.restart();
    } else {
      monitor.start();
    }
  } else {
    monitor.stop();
    logger.info('Monitor not started: no enabled wallets');
  }
}

const app = express();
app.use(express.json());

app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get('/api/config', (_req, res) => {
  res.json(serializeConfig(storage.get()));
});

app.put('/api/config', (req, res) => {
  const parsed = parseConfigBody(req.body);
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const watchdogError = validateWatchdogThresholds(storage.get().watchdog, parsed.data.watchdog);
  if (watchdogError) {
    res.status(400).json({ error: watchdogError });
    return;
  }
  const updated = storage.update(parsed.data);
  syncRuntimeServices({ restartMonitor: true });
  res.json(serializeConfig(updated));
});

app.post('/api/telegram/test', async (_req, res) => {
  const config = storage.get();
  if (!config.telegram.chatId) {
    res.status(400).json({ error: 'No chat ID configured' });
    return;
  }
  if (!TELEGRAM_BOT_TOKEN) {
    res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not set on server' });
    return;
  }

  const success = await telegram.sendMessage(
    config.telegram.chatId,
    '\u{2705} <b>Test notification</b>\n\nAave Loan Monitor is connected and working.',
  );

  if (success) {
    res.json({ ok: true });
  } else {
    res
      .status(502)
      .json({ error: 'Failed to send Telegram message. Check bot token and chat ID.' });
  }
});

app.get('/api/status', (_req, res) => {
  res.json(monitor.getStatus());
});

app.post('/api/status/refresh', async (_req, res) => {
  try {
    const status = await monitor.refreshState();
    res.json(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to refresh monitor state';
    res.status(500).json({ error: message });
  }
});

app.get('/api/balances/:wallet', async (req, res) => {
  const { wallet } = req.params;
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    res.status(400).json({ error: 'Invalid wallet address' });
    return;
  }

  try {
    const balances = await fetchStablecoinBalances(wallet, RPC_URL);
    res.json(Object.fromEntries(balances));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch balances';
    res.status(502).json({ error: message });
  }
});

app.post('/api/balances/:wallet', async (req, res) => {
  const { wallet } = req.params;
  if (!wallet || !/^0x[a-fA-F0-9]{40}$/.test(wallet)) {
    res.status(400).json({ error: 'Invalid wallet address' });
    return;
  }

  const parsed = tokenBalanceRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join('.') ?? 'body';
    res.status(400).json({ error: `${path}: ${issue?.message ?? 'Invalid request body'}` });
    return;
  }

  try {
    const balances = await fetchTokenBalances(
      wallet,
      RPC_URL,
      parsed.data.tokens.map((token) => ({
        key: token.address.toLowerCase(),
        address: token.address,
        decimals: token.decimals,
      })),
    );
    res.json(Object.fromEntries(balances));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch balances';
    res.status(502).json({ error: message });
  }
});

app.get('/api/reserves/telemetry', async (req, res) => {
  const parsed = reserveTelemetryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid market or asset address' });
    return;
  }

  try {
    const telemetry = await fetchReserveTelemetry(parsed.data.market, parsed.data.asset, RPC_URL);
    res.json({
      ...telemetry,
      symbol: parsed.data.symbol?.trim() || telemetry.symbol,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to fetch reserve telemetry';
    res.status(502).json({ error: message });
  }
});

app.get('/api/rates/history', (req, res) => {
  const parsed = rateHistoryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid wallet address or loanId' });
    return;
  }
  const { wallet, loanId, from, to } = parsed.data;
  const samples = rateHistoryDb.querySamples(wallet, loanId, from, to);
  res.json({ samples });
});

app.get('/api/interest/history', (req, res) => {
  const parsed = interestHistoryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query parameters' });
    return;
  }
  const { wallet, positionId, kind, from, to } = parsed.data;
  const rows = rateHistoryDb.queryInterestSnapshots(wallet, positionId, kind, from, to);
  const snapshots = rows.map((row, index) => ({
    timestamp: row.timestamp,
    cumulativeUsd: row.cumulativeUsd,
    deltaUsd: index === 0 ? 0 : row.cumulativeUsd - (rows[index - 1]?.cumulativeUsd ?? 0),
    label: row.label,
  }));
  res.json({ snapshots });
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/watchdog/status', (_req, res) => {
  const summary = monitor.watchdog.getStatusSummary();
  const log = monitor.watchdog.getLog();
  res.json({
    ...summary,
    log,
  });
});

// --- Telegram bot commands ---

telegram.onCommand('status', async (chatId) => {
  const status = monitor.getStatus();
  await telegram.sendMessage(chatId, formatStatusMessage(status, storage.get().zones));
});

telegram.onCommand('refresh', async (chatId) => {
  await telegram.sendMessage(chatId, 'Refreshing loan data...');
  try {
    const status = await monitor.refreshState();
    await telegram.sendMessage(chatId, formatStatusMessage(status, storage.get().zones));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await telegram.sendMessage(chatId, `Refresh failed: ${message}`);
  }
});

telegram.onCommand('watchdog', async (chatId) => {
  const summary = monitor.watchdog.getStatusSummary();
  const log = monitor.watchdog.getLog();
  await telegram.sendMessage(chatId, formatWatchdogStatusMessage(summary, log));
});

telegram.onCommand('help', async (chatId) => {
  await telegram.sendMessage(
    chatId,
    [
      '<b>Aave Loan Monitor</b>',
      '',
      ...TELEGRAM_BOT_COMMANDS.map((command) => `/${command.command} — ${command.description}`),
    ].join('\n'),
  );
});

// Serve frontend static files (built by Vite, copied into /app/public in Docker)
const publicDir = join(__dirname, '..', '..', '..', 'public');
if (existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get('/{*splat}', (_req, res) => {
    res.sendFile(join(publicDir, 'index.html'));
  });
}

app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Aave monitor server listening');
  syncRuntimeServices();
});
