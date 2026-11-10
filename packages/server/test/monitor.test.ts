import assert from 'node:assert/strict';
import test from 'node:test';
import { Monitor, type BorrowRateAlertState } from '../src/monitor.js';
import { logger } from '../src/logger.js';
import { RateHistoryDb } from '../src/rateHistoryDb.js';
import type { AlertConfig } from '../src/storage.js';
import type { TelegramClient } from '../src/telegram.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const RPC_URL = 'http://rpc.local';

type MonitorInternals = {
  poll: (options?: { notify: boolean }) => Promise<void>;
  watchdog: {
    evaluate: (loan: unknown, wallet: string) => Promise<void>;
  };
  states: Map<
    string,
    {
      stuckSince: number | null;
      lastNotifiedAt: number;
    }
  >;
  borrowRateStates: Map<string, BorrowRateAlertState>;
};

function getMonitorInternals(monitor: Monitor): MonitorInternals {
  return monitor as unknown as MonitorInternals;
}

function stubWatchdogEvaluate(monitor: Monitor) {
  getMonitorInternals(monitor).watchdog.evaluate = async () => {};
}

const stubTelemetryFetcher = async () => {
  throw new Error('telemetry stubbed in tests');
};

function createTelegramStub(
  sentMessages?: Array<{ chatId: string; text: string }>,
): TelegramClient {
  return {
    sendMessage: async (chatId: string, text: string) => {
      sentMessages?.push({ chatId, text });
      return true;
    },
  } as TelegramClient;
}

async function pollMonitor(monitor: Monitor, notify: boolean) {
  await getMonitorInternals(monitor).poll({ notify });
}

function createConfig(): AlertConfig {
  return {
    wallets: [{ address: WALLET, label: 'Main Wallet', enabled: true }],
    telegram: { chatId: 'chat-1', enabled: true },
    polling: {
      intervalMs: 5 * 60 * 1000,
      debounceChecks: 2,
      reminderIntervalMs: 30 * 60 * 1000,
      cooldownMs: 30 * 60 * 1000,
    },
    zones: [
      { name: 'safe', minHF: 2.2, maxHF: Infinity },
      { name: 'comfort', minHF: 1.9, maxHF: 2.2 },
      { name: 'watch', minHF: 1.6, maxHF: 1.9 },
      { name: 'alert', minHF: 1.3, maxHF: 1.6 },
      { name: 'action', minHF: 1.15, maxHF: 1.3 },
      { name: 'critical', minHF: 0, maxHF: 1.15 },
    ],
    watchdog: {
      enabled: false,
      dryRun: true,
      triggerHF: 1.65,
      targetHF: 1.9,
      minResultingHF: 1.85,
      cooldownMs: 30 * 60 * 1000,
      maxRepayAmount: 500,
      deadlineSeconds: 300,
      rescueContract: '',
      morphoRescueContract: '',
      maxGasGwei: 50,
    },
    borrowRate: {
      enabled: false,
      cooldownMs: 30 * 60 * 1000,
    },
  };
}

function createAaveReserves(debtUsdc: number) {
  return [
    {
      currentATokenBalance: String(1e18),
      currentTotalDebt: '0',
      usageAsCollateralEnabledOnUser: true,
      reserve: {
        symbol: 'ETH',
        decimals: 18,
        underlyingAsset: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        baseLTVasCollateral: '7500',
        reserveLiquidationThreshold: '8000',
        liquidityRate: '0',
        variableBorrowRate: '0',
      },
    },
    {
      currentATokenBalance: '0',
      currentTotalDebt: String(debtUsdc * 1e6),
      usageAsCollateralEnabledOnUser: false,
      reserve: {
        symbol: 'USDC',
        decimals: 6,
        underlyingAsset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        baseLTVasCollateral: '0',
        reserveLiquidationThreshold: '0',
        liquidityRate: '0',
        variableBorrowRate: '0',
      },
    },
  ];
}

function createMorphoPayload(debtUsdc: number) {
  return {
    data: {
      userByAddress: {
        address: WALLET.toLowerCase(),
        marketPositions: [
          {
            market: {
              uniqueKey: 'morpho-loan-1',
              loanAsset: {
                symbol: 'USDC',
                address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
                decimals: 6,
                priceUsd: 1,
              },
              collateralAsset: {
                symbol: 'WETH',
                address: '0xC02aaA39b223FE8D0A0E5C4F27eAD9083C756Cc2',
                decimals: 18,
                priceUsd: 2000,
              },
              oracleAddress: '0x0000000000000000000000000000000000000001',
              irmAddress: '0x0000000000000000000000000000000000000002',
              lltv: '800000000000000000',
              state: {
                utilization: 0.5,
                borrowApy: 0,
                supplyApy: 0,
              },
            },
            borrowAssets: String(debtUsdc * 1e6),
            borrowAssetsUsd: debtUsdc,
            supplyAssets: '0',
            supplyAssetsUsd: 2000,
            collateral: String(1e18),
          },
        ],
      },
    },
  };
}

test('groups multiple loan alerts for the same wallet into one telegram message', async () => {
  const sentMessages: Array<{ chatId: string; text: string }> = [];
  const telegram = createTelegramStub(sentMessages);

  const monitor = new Monitor(
    telegram,
    createConfig,
    undefined,
    undefined,
    RPC_URL,
    undefined,
    undefined,
    stubTelemetryFetcher,
  );
  stubWatchdogEvaluate(monitor);

  let phase: 'initial' | 'critical' = 'initial';
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);

      if (href.includes('coingecko.com/api/v3/simple/price')) {
        return new Response(
          JSON.stringify({
            ethereum: { usd: 2000 },
            weth: { usd: 2000 },
            'usd-coin': { usd: 1 },
          }),
          { status: 200 },
        );
      }

      if (href === RPC_URL) {
        const requests = JSON.parse(String(init?.body)) as Array<{ id: number }>;
        return new Response(
          JSON.stringify(requests.map((request) => ({ id: request.id, result: '0x0' }))),
          { status: 200 },
        );
      }

      if (href.includes('api.morpho.org/graphql')) {
        return new Response(JSON.stringify(createMorphoPayload(phase === 'initial' ? 500 : 1800)), {
          status: 200,
        });
      }

      if (
        href.includes('aave/protocol-v3') ||
        href.includes('Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g')
      ) {
        return new Response(
          JSON.stringify({
            data: {
              userReserves: createAaveReserves(phase === 'initial' ? 500 : 1800),
            },
          }),
          { status: 200 },
        );
      }

      if (href.includes('5vxMbXRhG1oQr55MWC5j6qg78waWujx1wjeuEWDA6j3')) {
        return new Response(JSON.stringify({ data: { userReserves: [] } }), { status: 200 });
      }

      throw new Error(`Unhandled fetch URL: ${href}`);
    }) as typeof fetch;

    await pollMonitor(monitor, true);
    assert.equal(sentMessages.length, 0);

    phase = 'critical';
    await pollMonitor(monitor, true);

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0]?.chatId, 'chat-1');
    assert.match(sentMessages[0]!.text, /<b>Loan Alerts<\/b>/);
    assert.match(sentMessages[0]!.text, /Wallet: <code>Main Wallet \(0x1111\.\.\.1111\)<\/code>/);
    assert.match(sentMessages[0]!.text, /Market: proto_mainnet_v3/);
    assert.match(sentMessages[0]!.text, /Market: morpho_WETH_USDC/);
    assert.match(sentMessages[0]!.text, /Borrow rate: <b>0\.00%<\/b>/);
    assert.equal(sentMessages[0]!.text.match(/Wallet:/g)?.length ?? 0, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('wallet reminder digest includes all non-safe loans when any loan is due', async () => {
  const sentMessages: Array<{ chatId: string; text: string }> = [];
  const telegram = createTelegramStub(sentMessages);

  const monitor = new Monitor(
    telegram,
    createConfig,
    undefined,
    undefined,
    RPC_URL,
    undefined,
    undefined,
    stubTelemetryFetcher,
  );
  stubWatchdogEvaluate(monitor);

  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);

      if (href.includes('coingecko.com/api/v3/simple/price')) {
        return new Response(
          JSON.stringify({
            ethereum: { usd: 2000 },
            weth: { usd: 2000 },
            'usd-coin': { usd: 1 },
          }),
          { status: 200 },
        );
      }

      if (href === RPC_URL) {
        const requests = JSON.parse(String(init?.body)) as Array<{ id: number }>;
        return new Response(
          JSON.stringify(requests.map((request) => ({ id: request.id, result: '0x0' }))),
          { status: 200 },
        );
      }

      if (href.includes('api.morpho.org/graphql')) {
        return new Response(JSON.stringify(createMorphoPayload(1000)), { status: 200 });
      }

      if (
        href.includes('aave/protocol-v3') ||
        href.includes('Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g')
      ) {
        return new Response(
          JSON.stringify({
            data: {
              userReserves: createAaveReserves(800),
            },
          }),
          { status: 200 },
        );
      }

      if (href.includes('5vxMbXRhG1oQr55MWC5j6qg78waWujx1wjeuEWDA6j3')) {
        return new Response(JSON.stringify({ data: { userReserves: [] } }), { status: 200 });
      }

      throw new Error(`Unhandled fetch URL: ${href}`);
    }) as typeof fetch;

    await pollMonitor(monitor, true);
    assert.equal(sentMessages.length, 0);

    const states = getMonitorInternals(monitor).states;
    const now = Date.now();
    const aaveState = states.get(`${WALLET}-proto_mainnet_v3`);
    const morphoState = states.get(`${WALLET}-morpho-loan-1`);

    assert.ok(aaveState);
    assert.ok(morphoState);

    aaveState.stuckSince = now - 60 * 60 * 1000;
    morphoState.stuckSince = now - 50 * 60 * 1000;
    aaveState.lastNotifiedAt = now - 31 * 60 * 1000;
    morphoState.lastNotifiedAt = now - 10 * 60 * 1000;

    await pollMonitor(monitor, true);

    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0]!.text, /<b>Loan Alerts<\/b>/);
    assert.match(sentMessages[0]!.text, /Reminder 1/);
    assert.match(sentMessages[0]!.text, /Reminder 2/);
    assert.match(sentMessages[0]!.text, /Market: proto_mainnet_v3/);
    assert.match(sentMessages[0]!.text, /Market: morpho_WETH_USDC/);
    assert.match(sentMessages[0]!.text, /Borrow rate: <b>0\.00%<\/b>/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('monitor status tracks wallet debt-token balances for repay coverage', async () => {
  const telegram = createTelegramStub();

  const monitor = new Monitor(
    telegram,
    createConfig,
    undefined,
    undefined,
    RPC_URL,
    undefined,
    undefined,
    stubTelemetryFetcher,
  );
  stubWatchdogEvaluate(monitor);

  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);

      if (href.includes('coingecko.com/api/v3/simple/price')) {
        return new Response(
          JSON.stringify({
            ethereum: { usd: 2000 },
            'usd-coin': { usd: 1 },
          }),
          { status: 200 },
        );
      }

      if (href === RPC_URL) {
        const requests = JSON.parse(String(init?.body)) as Array<{ id: number }>;
        return new Response(
          JSON.stringify(
            requests.map((request) => ({
              id: request.id,
              result: request.id === 0 ? '0xee6b280' : '0x0',
            })),
          ),
          { status: 200 },
        );
      }

      if (href.includes('api.morpho.org/graphql')) {
        return new Response(JSON.stringify({ data: { userByAddress: { marketPositions: [] } } }), {
          status: 200,
        });
      }

      if (
        href.includes('aave/protocol-v3') ||
        href.includes('Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g')
      ) {
        return new Response(
          JSON.stringify({
            data: {
              userReserves: createAaveReserves(1000),
            },
          }),
          { status: 200 },
        );
      }

      if (href.includes('5vxMbXRhG1oQr55MWC5j6qg78waWujx1wjeuEWDA6j3')) {
        return new Response(JSON.stringify({ data: { userReserves: [] } }), { status: 200 });
      }

      throw new Error(`Unhandled fetch URL: ${href}`);
    }) as typeof fetch;

    await pollMonitor(monitor, false);

    const state = monitor
      .getStatus()
      .states.find((entry) => entry.marketName === 'proto_mainnet_v3');
    assert.ok(state);
    assert.equal(state.healthFactor, 1.6);
    assert.equal(state.borrowRate, 0);
    assert.equal(monitor.getStatus().totalWalletBorrowedAssetUsd, 250);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('monitor logs normalize mixed-case symbols and reuse per-loan usdPrice values', async () => {
  const telegram = createTelegramStub();

  const monitor = new Monitor(
    telegram,
    createConfig,
    undefined,
    undefined,
    RPC_URL,
    undefined,
    undefined,
    stubTelemetryFetcher,
  );
  stubWatchdogEvaluate(monitor);

  const originalFetch = globalThis.fetch;
  const originalInfo = logger.info.bind(logger);
  const entries: Array<{ msg: string; payload: Record<string, unknown> }> = [];

  logger.info = ((payload: unknown, msg?: unknown) => {
    if (typeof msg === 'string' && payload && typeof payload === 'object') {
      entries.push({ msg, payload: payload as Record<string, unknown> });
    }
    return logger;
  }) as typeof logger.info;

  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);

      if (href.includes('coingecko.com/api/v3/simple/price')) {
        return new Response(
          JSON.stringify({
            'coinbase-wrapped-btc': { usd: 71462 },
            'wrapped-bitcoin': { usd: 71206 },
          }),
          { status: 200 },
        );
      }

      if (href === RPC_URL) {
        const requests = JSON.parse(String(init?.body)) as Array<{ id: number }>;
        return new Response(
          JSON.stringify(requests.map((request) => ({ id: request.id, result: '0x0' }))),
          { status: 200 },
        );
      }

      if (href.includes('api.morpho.org/graphql')) {
        return new Response(
          JSON.stringify({
            data: {
              userByAddress: {
                address: WALLET.toLowerCase(),
                marketPositions: [
                  {
                    market: {
                      uniqueKey: 'morpho-loan-wsteth',
                      loanAsset: {
                        symbol: 'USDC',
                        address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
                        decimals: 6,
                        priceUsd: 1,
                      },
                      collateralAsset: {
                        symbol: 'wstETH',
                        address: '0x7f39c581f595b53c5cb5bbd1b7ffac31c4d2d2e2',
                        decimals: 18,
                        priceUsd: 3012.5,
                      },
                      oracleAddress: '0x0000000000000000000000000000000000000001',
                      irmAddress: '0x0000000000000000000000000000000000000002',
                      lltv: '800000000000000000',
                      state: {
                        utilization: 0.5,
                        borrowApy: 0,
                        supplyApy: 0,
                      },
                    },
                    borrowAssets: String(1000 * 1e6),
                    borrowAssetsUsd: 1000,
                    supplyAssets: '0',
                    supplyAssetsUsd: 3012.5,
                    collateral: String(1e18),
                  },
                ],
              },
            },
          }),
          { status: 200 },
        );
      }

      if (
        href.includes('aave/protocol-v3') ||
        href.includes('Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g')
      ) {
        return new Response(
          JSON.stringify({
            data: {
              userReserves: [
                {
                  currentATokenBalance: String(1e8),
                  currentTotalDebt: '0',
                  usageAsCollateralEnabledOnUser: true,
                  reserve: {
                    symbol: 'cbBTC',
                    decimals: 8,
                    underlyingAsset: '0xcbbtc000000000000000000000000000000000000',
                    baseLTVasCollateral: '7500',
                    reserveLiquidationThreshold: '8000',
                    liquidityRate: '0',
                    variableBorrowRate: '0',
                  },
                },
                {
                  currentATokenBalance: '0',
                  currentTotalDebt: String(500 * 1e8),
                  usageAsCollateralEnabledOnUser: false,
                  reserve: {
                    symbol: 'WBTC',
                    decimals: 8,
                    underlyingAsset: '0xwbtc000000000000000000000000000000000000',
                    baseLTVasCollateral: '0',
                    reserveLiquidationThreshold: '0',
                    liquidityRate: '0',
                    variableBorrowRate: '0',
                  },
                },
              ],
            },
          }),
          { status: 200 },
        );
      }

      if (href.includes('5vxMbXRhG1oQr55MWC5j6qg78waWujx1wjeuEWDA6j3')) {
        return new Response(JSON.stringify({ data: { userReserves: [] } }), { status: 200 });
      }

      throw new Error(`Unhandled fetch URL: ${href}`);
    }) as typeof fetch;

    await pollMonitor(monitor, false);

    const pricesResolved = entries.find((entry) => entry.msg === 'Prices resolved');
    assert.ok(pricesResolved);
    assert.equal(pricesResolved.payload.resolved, 2);
    assert.equal(pricesResolved.payload.total, 2);
    assert.equal('missing' in pricesResolved.payload, false);

    const loanStatusEntries = entries.filter((entry) => entry.msg === 'Loan status');
    assert.equal(loanStatusEntries.length, 2);
    assert.equal(
      loanStatusEntries.some((entry) => entry.payload.collaterals === 'CBBTC=$71462'),
      true,
    );
    assert.equal(
      loanStatusEntries.some((entry) => entry.payload.collaterals === 'WSTETH=$3012.5'),
      true,
    );
  } finally {
    logger.info = originalInfo;
    globalThis.fetch = originalFetch;
  }
});

// --- Borrow rate alert tests ---

function createMorphoPayloadWithBorrowApy(borrowApy: number) {
  return {
    data: {
      userByAddress: {
        address: WALLET.toLowerCase(),
        marketPositions: [
          {
            market: {
              uniqueKey: 'morpho-rate-1',
              loanAsset: {
                symbol: 'USDC',
                address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
                decimals: 6,
                priceUsd: 1,
              },
              collateralAsset: {
                symbol: 'WETH',
                address: '0xC02aaA39b223FE8D0A0E5C4F27eAD9083C756Cc2',
                decimals: 18,
                priceUsd: 2000,
              },
              oracleAddress: '0x0000000000000000000000000000000000000001',
              irmAddress: '0x0000000000000000000000000000000000000002',
              lltv: '800000000000000000',
              state: {
                utilization: 0.5,
                borrowApy,
                supplyApy: 0,
              },
            },
            borrowAssets: String(500 * 1e6),
            borrowAssetsUsd: 500,
            supplyAssets: '0',
            supplyAssetsUsd: 2000,
            collateral: String(1e18),
          },
        ],
      },
    },
  };
}

function createBorrowRateConfig(overrides: Partial<AlertConfig['borrowRate']> = {}): AlertConfig {
  return {
    ...createConfig(),
    borrowRate: {
      enabled: true,
      cooldownMs: 30 * 60 * 1000,
      ...overrides,
    },
  };
}

function mockFetchForMorphoBorrowApy(borrowApy: number) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.includes('coingecko.com/api/v3/simple/price')) {
      return new Response(JSON.stringify({ ethereum: { usd: 2000 }, 'usd-coin': { usd: 1 } }), {
        status: 200,
      });
    }
    if (href === RPC_URL) {
      const requests = JSON.parse(String(init?.body)) as Array<{ id: number }>;
      return new Response(
        JSON.stringify(requests.map((request) => ({ id: request.id, result: '0x0' }))),
        { status: 200 },
      );
    }
    if (href.includes('api.morpho.org/graphql')) {
      return new Response(JSON.stringify(createMorphoPayloadWithBorrowApy(borrowApy)), {
        status: 200,
      });
    }
    if (
      href.includes('aave/protocol-v3') ||
      href.includes('Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g') ||
      href.includes('5vxMbXRhG1oQr55MWC5j6qg78waWujx1wjeuEWDA6j3')
    ) {
      return new Response(JSON.stringify({ data: { userReserves: [] } }), { status: 200 });
    }
    throw new Error(`Unhandled fetch URL: ${href}`);
  }) as typeof fetch;
}

function getBorrowRateStates(monitor: Monitor): Map<string, BorrowRateAlertState> {
  return getMonitorInternals(monitor).borrowRateStates;
}

test('borrow rate alert: first observation above threshold with chat on sends alert', async () => {
  const sentMessages: Array<{ chatId: string; text: string }> = [];
  const telegram = createTelegramStub(sentMessages);

  const config = createBorrowRateConfig();
  const monitor = new Monitor(
    telegram,
    () => config,
    undefined,
    undefined,
    RPC_URL,
    undefined,
    undefined,
    stubTelemetryFetcher,
  );
  stubWatchdogEvaluate(monitor);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = mockFetchForMorphoBorrowApy(0.06);

    await pollMonitor(monitor, true);

    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0]!.text, /HIGH BORROW RATE/);
    assert.match(sentMessages[0]!.text, /6\.00%/);

    const states = getBorrowRateStates(monitor);
    assert.equal(states.size, 1);
    const state = Array.from(states.values())[0]!;
    assert.equal(state.alerted, true);
    assert.ok(state.lastNotifiedAt > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('borrow rate alert: first observation above threshold with chat off does not mark as alerted', async () => {
  const telegram = createTelegramStub();

  const config = createBorrowRateConfig();
  config.telegram.enabled = false;
  const monitor = new Monitor(
    telegram,
    () => config,
    undefined,
    undefined,
    RPC_URL,
    undefined,
    undefined,
    stubTelemetryFetcher,
  );
  stubWatchdogEvaluate(monitor);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = mockFetchForMorphoBorrowApy(0.06);

    await pollMonitor(monitor, true);

    const states = getBorrowRateStates(monitor);
    assert.equal(states.size, 1);
    const state = Array.from(states.values())[0]!;
    assert.equal(state.alerted, false);
    assert.equal(state.lastNotifiedAt, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('borrow rate alert: below→above transition sends high alert, above→below sends normalized', async () => {
  const sentMessages: Array<{ chatId: string; text: string }> = [];
  const telegram = createTelegramStub(sentMessages);

  const config = createBorrowRateConfig({ cooldownMs: 0 });
  const monitor = new Monitor(
    telegram,
    () => config,
    undefined,
    undefined,
    RPC_URL,
    undefined,
    undefined,
    stubTelemetryFetcher,
  );
  stubWatchdogEvaluate(monitor);

  const originalFetch = globalThis.fetch;
  try {
    // First poll: below threshold (3%)
    globalThis.fetch = mockFetchForMorphoBorrowApy(0.03);
    await pollMonitor(monitor, true);
    assert.equal(sentMessages.length, 0);

    // Second poll: above threshold (6%) → should alert
    globalThis.fetch = mockFetchForMorphoBorrowApy(0.06);
    await pollMonitor(monitor, true);
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0]!.text, /HIGH BORROW RATE/);

    // Third poll: back below (4%) → should send normalized
    globalThis.fetch = mockFetchForMorphoBorrowApy(0.04);
    await pollMonitor(monitor, true);
    assert.equal(sentMessages.length, 2);
    assert.match(sentMessages[1]!.text, /BORROW RATE NORMALIZED/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('borrow rate alert: below→above with cooldown active defers alert to next eligible poll', async () => {
  const sentMessages: Array<{ chatId: string; text: string }> = [];
  const telegram = createTelegramStub(sentMessages);

  const config = createBorrowRateConfig({ cooldownMs: 999_999_999 });
  const monitor = new Monitor(
    telegram,
    () => config,
    undefined,
    undefined,
    RPC_URL,
    undefined,
    undefined,
    stubTelemetryFetcher,
  );
  stubWatchdogEvaluate(monitor);

  const originalFetch = globalThis.fetch;
  try {
    // First poll at 3%: below threshold, initializes state with lastNotifiedAt=0
    globalThis.fetch = mockFetchForMorphoBorrowApy(0.03);
    await pollMonitor(monitor, true);

    const states = getBorrowRateStates(monitor);
    const state = Array.from(states.values())[0]!;
    state.lastNotifiedAt = Date.now();

    // Second poll at 6%: above threshold but cooldown is active
    globalThis.fetch = mockFetchForMorphoBorrowApy(0.06);
    await pollMonitor(monitor, true);

    assert.equal(sentMessages.length, 0);
    assert.equal(state.alerted, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('borrow rate alert: wallet disable cleans up borrow rate states', async () => {
  const telegram = createTelegramStub();

  const config = createBorrowRateConfig();
  const monitor = new Monitor(
    telegram,
    () => config,
    undefined,
    undefined,
    RPC_URL,
    undefined,
    undefined,
    stubTelemetryFetcher,
  );
  stubWatchdogEvaluate(monitor);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = mockFetchForMorphoBorrowApy(0.03);
    await pollMonitor(monitor, true);

    const states = getBorrowRateStates(monitor);
    assert.equal(states.size, 1);

    config.wallets[0]!.enabled = false;
    await pollMonitor(monitor, true);

    assert.equal(states.size, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('monitor records a health factor sample for each loan', async () => {
  const rateHistoryDb = new RateHistoryDb(':memory:');
  const monitor = new Monitor(
    createTelegramStub(),
    createConfig,
    undefined,
    undefined,
    RPC_URL,
    undefined,
    rateHistoryDb,
    stubTelemetryFetcher,
  );
  stubWatchdogEvaluate(monitor);

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = mockFetchForMorphoBorrowApy(0.03);
    await pollMonitor(monitor, false);

    const samples = rateHistoryDb.queryPortfolioHealthFactor(WALLET);
    assert.equal(samples.length, 1);
    assert.ok(Math.abs(samples[0]!.healthFactor - (2000 * 0.8) / 500) < 1e-6);
  } finally {
    globalThis.fetch = originalFetch;
    rateHistoryDb.close();
  }
});
