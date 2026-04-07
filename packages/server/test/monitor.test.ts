import assert from 'node:assert/strict';
import test from 'node:test';
import { Monitor } from '../src/monitor.js';
import type { AlertConfig } from '../src/storage.js';
import type { TelegramClient } from '../src/telegram.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const RPC_URL = 'http://rpc.local';

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
      maxTopUpAmount: 0.5,
      deadlineSeconds: 300,
      rescueContract: '',
      morphoRescueContract: '',
      maxGasGwei: 50,
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
  const telegram = {
    sendMessage: async (chatId: string, text: string) => {
      sentMessages.push({ chatId, text });
      return true;
    },
  } as unknown as TelegramClient;

  const monitor = new Monitor(telegram, createConfig, undefined, undefined, RPC_URL, undefined);
  (monitor.watchdog as { evaluate: (loan: unknown, wallet: string) => Promise<void> }).evaluate =
    async () => {};

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

    await (monitor as unknown as { poll: (options?: { notify: boolean }) => Promise<void> }).poll({
      notify: true,
    });
    assert.equal(sentMessages.length, 0);

    phase = 'critical';
    await (monitor as unknown as { poll: (options?: { notify: boolean }) => Promise<void> }).poll({
      notify: true,
    });

    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0]?.chatId, 'chat-1');
    assert.match(sentMessages[0]!.text, /<b>Loan Alerts<\/b>/);
    assert.match(sentMessages[0]!.text, /Wallet: <code>Main Wallet \(0x1111\.\.\.1111\)<\/code>/);
    assert.match(sentMessages[0]!.text, /Market: proto_mainnet_v3/);
    assert.match(sentMessages[0]!.text, /Market: morpho_WETH_USDC/);
    assert.equal(sentMessages[0]!.text.match(/Wallet:/g)?.length ?? 0, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
