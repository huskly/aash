import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { Interface, parseUnits } from 'ethers';
import type { LoanPosition, MorphoMarketParams } from '@aave-monitor/core';
import { Watchdog } from '../src/watchdog.js';
import type { WatchdogConfig } from '../src/storage.js';
import type { TelegramClient } from '../src/telegram.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const RESCUE_CONTRACT = '0x2222222222222222222222222222222222222222';
const MORPHO_RESCUE_CONTRACT = '0x3333333333333333333333333333333333333333';
const WBTC_CONTRACT = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
const WETH_CONTRACT = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC_CONTRACT = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

const ERC20_INTERFACE = new Interface([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const RESCUE_INTERFACE = new Interface([
  'function rescue((address user,address asset,uint256 amount,uint256 minResultingHf,uint256 deadline) params)',
  'function previewResultingHf(address user, address asset, uint256 amount) view returns (uint256)',
]);

type WatchdogInternals = {
  provider?: unknown;
};

function createConfig(overrides: Partial<WatchdogConfig> = {}): WatchdogConfig {
  return {
    enabled: true,
    dryRun: true,
    triggerHF: 1.65,
    targetHF: 1.9,
    minResultingHF: 1.85,
    cooldownMs: 30 * 60 * 1000,
    maxRepayAmount: 500,
    deadlineSeconds: 300,
    rescueContract: RESCUE_CONTRACT,
    morphoRescueContract: '',
    maxGasGwei: 50,
    ...overrides,
  };
}

function createLoan(overrides: Partial<LoanPosition> = {}): LoanPosition {
  // Default loan: HF = 3200 * 0.75 / 1600 = 1.5 (below triggerHF=1.65)
  return {
    id: 'loan-1',
    marketName: 'proto_mainnet_v3',
    borrowed: [
      {
        symbol: 'USDC',
        address: USDC_CONTRACT,
        decimals: 6,
        amount: 1600,
        usdPrice: 1,
        usdValue: 1600,
        collateralEnabled: false,
        maxLTV: 0,
        liqThreshold: 0,
        supplyRate: 0,
        borrowRate: 0.05,
      },
    ],
    supplied: [
      {
        symbol: 'WBTC',
        address: WBTC_CONTRACT,
        decimals: 8,
        amount: 0.08,
        usdPrice: 40_000,
        usdValue: 3_200,
        collateralEnabled: true,
        maxLTV: 0.7,
        liqThreshold: 0.75,
        supplyRate: 0,
        borrowRate: 0,
      },
    ],
    totalSuppliedUsd: 3_200,
    totalBorrowedUsd: 1_600,
    ...overrides,
  };
}

/**
 * Create a fake provider that intercepts eth_call and responds based on the
 * ABI-encoded function selector in the data payload.
 * Now checks debt token (USDC) balance/allowance instead of collateral.
 */
function createMockProvider(opts: {
  debtTokenBalance: bigint;
  debtTokenAllowance: bigint;
  /** Maps amount (bigint) to resulting HF (bigint, in 1e18 wad) */
  previewHF: (amount: bigint) => bigint;
  gasPriceGwei?: number;
  ethBalance?: number;
  debtTokenAddress?: string;
}) {
  const debtToken = opts.debtTokenAddress ?? USDC_CONTRACT;
  const balanceOfSelector = ERC20_INTERFACE.getFunction('balanceOf')!.selector;
  const allowanceSelector = ERC20_INTERFACE.getFunction('allowance')!.selector;
  const previewSelector = RESCUE_INTERFACE.getFunction('previewResultingHf')!.selector;

  return {
    call: async (tx: { to: string; data: string }) => {
      const selector = tx.data.slice(0, 10);

      if (tx.to.toLowerCase() === debtToken.toLowerCase()) {
        if (selector === balanceOfSelector) {
          return ERC20_INTERFACE.encodeFunctionResult('balanceOf', [opts.debtTokenBalance]);
        }
        if (selector === allowanceSelector) {
          return ERC20_INTERFACE.encodeFunctionResult('allowance', [opts.debtTokenAllowance]);
        }
      }

      if (tx.to.toLowerCase() === RESCUE_CONTRACT.toLowerCase() && selector === previewSelector) {
        const decoded = RESCUE_INTERFACE.decodeFunctionData('previewResultingHf', tx.data);
        const amount = BigInt(decoded[2]);
        return RESCUE_INTERFACE.encodeFunctionResult('previewResultingHf', [
          opts.previewHF(amount),
        ]);
      }

      throw new Error(`Unexpected call: to=${tx.to} selector=${selector}`);
    },
    getFeeData: async () => ({
      gasPrice: BigInt(Math.round((opts.gasPriceGwei ?? 10) * 1e9)),
    }),
    getBalance: async () => BigInt(Math.round((opts.ethBalance ?? 1) * 1e18)),
  };
}

function createWatchdog(
  config: WatchdogConfig,
  options: { privateKey?: string | null; chatId?: string | null } = {},
): { watchdog: Watchdog; messages: string[] } {
  const messages: string[] = [];
  const telegram: TelegramClient = {
    async sendMessage(_chatId: string, text: string): Promise<boolean> {
      messages.push(text);
      return true;
    },
  };

  return {
    watchdog: new Watchdog(
      telegram,
      () => (options.chatId !== undefined ? options.chatId : '123'),
      () => config,
      'http://localhost:8545',
      options.privateKey === undefined ? '0xabc' : (options.privateKey ?? undefined),
    ),
    messages,
  };
}

function createWatchdogWithTelegram(
  config: WatchdogConfig,
  telegram: TelegramClient,
  options: { privateKey?: string | null; chatId?: string | null } = {},
) {
  return new Watchdog(
    telegram,
    () => (options.chatId !== undefined ? options.chatId : '123'),
    () => config,
    'http://localhost:8545',
    options.privateKey === undefined ? '0xabc' : (options.privateKey ?? undefined),
  );
}

function getWatchdogInternals(watchdog: Watchdog): WatchdogInternals {
  return watchdog as unknown as WatchdogInternals;
}

function injectProvider(watchdog: Watchdog, provider: ReturnType<typeof createMockProvider>) {
  // Inject the mock provider so evaluate() uses it instead of creating a real one
  getWatchdogInternals(watchdog).provider = provider;
}

// ─── findRequiredAmountRaw integration tests ────────────────────────────────

describe('findRequiredAmountRaw (via evaluate)', () => {
  test('interpolates correct USDC repay amount for target HF', async () => {
    const currentHFWad = parseUnits('1.5', 18); // HF at amount=0
    const maxRepay = parseUnits('500', 6); // 500 USDC

    // Linear model: HF(a) = 1.5 + (2.1 - 1.5) * (a / maxRepay) = 1.5 + 0.6 * a/maxRepay
    // For targetHF=1.9: a = maxRepay * (1.9 - 1.5) / (2.1 - 1.5) = maxRepay * 2/3
    const maxHFWad = parseUnits('2.1', 18);
    const slope = maxHFWad - currentHFWad; // 0.6e18

    const provider = createMockProvider({
      debtTokenBalance: maxRepay,
      debtTokenAllowance: maxRepay,
      previewHF: (amount: bigint) => {
        if (amount === 0n) return currentHFWad;
        // Linear: currentHF + slope * amount / maxRepay
        return currentHFWad + (slope * amount) / maxRepay;
      },
    });

    const { watchdog } = createWatchdog(createConfig({ dryRun: true }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log.length, 1);
    assert.equal(log[0]?.action, 'dry-run');

    // Expected: ~333.33 USDC (2/3 of 500, +1 unit for round-up)
    const repay = log[0]!.repayAmount;
    assert.ok(repay > 333, `Expected ~333 USDC, got ${repay}`);
    assert.ok(repay < 340, `Expected ~333 USDC, got ${repay}`);

    // Projected HF should be >= targetHF (1.9)
    assert.ok(log[0]!.projectedHF >= 1.9, `Projected HF ${log[0]!.projectedHF} < 1.9`);
  });

  test('falls back to minResultingHF when targetHF is unreachable', async () => {
    const currentHFWad = parseUnits('1.5', 18);
    const maxRepay = parseUnits('100', 6); // only 100 USDC available

    // With 100 USDC max, HF only reaches 1.88 — below targetHF=1.9 but above minResultingHF=1.85
    const maxHFWad = parseUnits('1.88', 18);

    const provider = createMockProvider({
      debtTokenBalance: maxRepay,
      debtTokenAllowance: maxRepay,
      previewHF: (amount: bigint) => {
        if (amount === 0n) return currentHFWad;
        const slope = maxHFWad - currentHFWad; // 0.38e18
        return currentHFWad + (slope * amount) / maxRepay;
      },
    });

    const { watchdog } = createWatchdog(createConfig({ dryRun: true }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log.length, 1);
    assert.equal(log[0]?.action, 'dry-run');

    // Should have used minResultingHF=1.85 as fallback target
    // amount = maxRepay * (1.85 - 1.5) / (1.88 - 1.5) = maxRepay * 0.35/0.38 ≈ 92.1 USDC
    const repay = log[0]!.repayAmount;
    assert.ok(repay > 90, `Expected ~92 USDC, got ${repay}`);
    assert.ok(repay < 100, `Expected ~92 USDC, got ${repay}`);
  });

  test('skips when even maxAmount cannot reach minResultingHF', async () => {
    const currentHFWad = parseUnits('1.5', 18);
    const maxRepay = parseUnits('10', 6); // tiny amount

    // Even full 10 USDC only reaches 1.52 — way below minResultingHF=1.85
    const provider = createMockProvider({
      debtTokenBalance: maxRepay,
      debtTokenAllowance: maxRepay,
      previewHF: (amount: bigint) => {
        if (amount === 0n) return currentHFWad;
        const maxHFWad = parseUnits('1.52', 18);
        const slope = maxHFWad - currentHFWad;
        return currentHFWad + (slope * amount) / maxRepay;
      },
    });

    const { watchdog, messages } = createWatchdog(createConfig({ dryRun: true }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log.length, 1);
    assert.equal(log[0]?.action, 'skipped');
    assert.match(log[0]?.reason ?? '', /Insufficient USDC to achieve minimum resulting HF/);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /Rescue not feasible/);
  });

  test('skips with 0 amount when on-chain HF already meets target', async () => {
    const currentHFWad = parseUnits('2.0', 18); // already above targetHF=1.9
    const maxRepay = parseUnits('500', 6);

    const provider = createMockProvider({
      debtTokenBalance: maxRepay,
      debtTokenAllowance: maxRepay,
      previewHF: (amount: bigint) => {
        if (amount === 0n) return currentHFWad;
        return currentHFWad + (parseUnits('0.5', 18) * amount) / maxRepay;
      },
    });

    // Loan-level HF < triggerHF so evaluate doesn't exit early,
    // but on-chain previewResultingHF(0) already exceeds target.
    // findRequiredAmountRaw returns 0n → evaluate treats as "insufficient" and skips.
    const { watchdog } = createWatchdog(createConfig({ dryRun: true }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log.length, 1);
    assert.equal(log[0]?.action, 'skipped');
    assert.match(log[0]?.reason ?? '', /Insufficient USDC/);
  });
});

// ─── Full evaluate integration tests with mock provider ─────────────────────

describe('evaluate integration with mock provider', () => {
  test('skips when USDC balance is zero', async () => {
    const provider = createMockProvider({
      debtTokenBalance: 0n,
      debtTokenAllowance: parseUnits('1000', 6),
      previewHF: () => parseUnits('1.5', 18),
    });

    const { watchdog, messages } = createWatchdog(createConfig({ dryRun: true }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log[0]?.action, 'skipped');
    assert.match(log[0]?.reason ?? '', /No available USDC/);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /USDC unavailable/);
  });

  test('skips when USDC allowance is zero', async () => {
    const provider = createMockProvider({
      debtTokenBalance: parseUnits('1000', 6),
      debtTokenAllowance: 0n,
      previewHF: () => parseUnits('1.5', 18),
    });

    const { watchdog, messages } = createWatchdog(createConfig({ dryRun: true }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log[0]?.action, 'skipped');
    assert.match(log[0]?.reason ?? '', /No available USDC/);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /USDC unavailable/);
  });

  test('uses min of balance, allowance, and maxRepay as available amount', async () => {
    const balance = parseUnits('300', 6); // 300 USDC — this is the limiting factor
    const allowance = parseUnits('1000', 6);
    const currentHFWad = parseUnits('1.5', 18);

    // With balance as limit (300 USDC), max achievable HF = 2.1
    const maxHFAtBalance = parseUnits('2.1', 18);

    const provider = createMockProvider({
      debtTokenBalance: balance,
      debtTokenAllowance: allowance,
      previewHF: (amount: bigint) => {
        if (amount === 0n) return currentHFWad;
        // Linear: 1.5 + 0.6 * amount / 300_USDC
        const slope = maxHFAtBalance - currentHFWad;
        return currentHFWad + (slope * amount) / balance;
      },
    });

    const { watchdog } = createWatchdog(createConfig({ dryRun: true, maxRepayAmount: 500 }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log[0]?.action, 'dry-run');

    // amount = balance * (1.9 - 1.5) / (2.1 - 1.5) = 300 * 2/3 = 200 USDC
    const repay = log[0]!.repayAmount;
    assert.ok(repay > 199, `Expected ~200 USDC, got ${repay}`);
    assert.ok(repay < 210, `Expected ~200 USDC, got ${repay}`);
  });

  test('skips when projected HF is below minResultingHF', async () => {
    const maxRepay = parseUnits('500', 6);
    const currentHFWad = parseUnits('1.5', 18);
    let previewCallCount = 0;

    const provider = createMockProvider({
      debtTokenBalance: maxRepay,
      debtTokenAllowance: maxRepay,
      previewHF: (amount: bigint) => {
        previewCallCount++;
        if (amount === 0n) return currentHFWad;
        if (amount === maxRepay) return parseUnits('2.1', 18);
        // Call 3 = verification inside findRequiredAmountRaw → return value that passes
        if (previewCallCount <= 3) return parseUnits('1.9', 18);
        // Call 4 = final check in evaluate() → return low value (non-linear reality)
        return parseUnits('1.8', 18);
      },
    });

    const { watchdog } = createWatchdog(createConfig({ dryRun: true }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log[0]?.action, 'skipped');
    assert.match(log[0]?.reason ?? '', /Projected HF below minimum/);
  });

  test('live mode skips when gas price exceeds max', async () => {
    const maxRepay = parseUnits('500', 6);
    const currentHFWad = parseUnits('1.5', 18);

    const provider = createMockProvider({
      debtTokenBalance: maxRepay,
      debtTokenAllowance: maxRepay,
      previewHF: (amount: bigint) => {
        if (amount === 0n) return currentHFWad;
        return parseUnits('2.0', 18);
      },
      gasPriceGwei: 100, // exceeds maxGasGwei=50
      ethBalance: 1,
    });

    const { watchdog, messages } = createWatchdog(createConfig({ dryRun: false }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log[0]?.action, 'skipped');
    assert.match(log[0]?.reason ?? '', /Gas price.*exceeds max/);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /Gas too high/);
  });

  test('live mode skips when ETH balance is insufficient for gas', async () => {
    const maxRepay = parseUnits('500', 6);
    const currentHFWad = parseUnits('1.5', 18);

    const provider = createMockProvider({
      debtTokenBalance: maxRepay,
      debtTokenAllowance: maxRepay,
      previewHF: (amount: bigint) => {
        if (amount === 0n) return currentHFWad;
        return parseUnits('2.0', 18);
      },
      gasPriceGwei: 10,
      ethBalance: 0.001, // below MIN_ETH_FOR_GAS = 0.005
    });

    const { watchdog, messages } = createWatchdog(createConfig({ dryRun: false }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log[0]?.action, 'skipped');
    assert.match(log[0]?.reason ?? '', /Insufficient ETH for gas/);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /Insufficient ETH for gas/);
  });

  test('does not trigger when HF is above triggerHF', async () => {
    // Loan with HF = 4800 * 0.75 / 1600 = 2.25 (above triggerHF=1.65)
    const healthyLoan = createLoan({
      supplied: [
        {
          symbol: 'WBTC',
          address: WBTC_CONTRACT,
          decimals: 8,
          amount: 0.12,
          usdPrice: 40_000,
          usdValue: 4_800,
          collateralEnabled: true,
          maxLTV: 0.7,
          liqThreshold: 0.75,
          supplyRate: 0,
          borrowRate: 0,
        },
      ],
      totalSuppliedUsd: 4_800,
    });

    const provider = createMockProvider({
      debtTokenBalance: parseUnits('1000', 6),
      debtTokenAllowance: parseUnits('1000', 6),
      previewHF: () => {
        throw new Error('Should not be called');
      },
    });

    const { watchdog } = createWatchdog(createConfig({ dryRun: true }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(healthyLoan, WALLET);

    // No log entries — evaluate returned early
    assert.equal(watchdog.getLog().length, 0);
  });

  test('does not trigger when watchdog is disabled', async () => {
    const provider = createMockProvider({
      debtTokenBalance: parseUnits('1000', 6),
      debtTokenAllowance: parseUnits('1000', 6),
      previewHF: () => {
        throw new Error('Should not be called');
      },
    });

    const { watchdog } = createWatchdog(createConfig({ enabled: false }));
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    assert.equal(watchdog.getLog().length, 0);
  });

  test('no notification sent when getChatId returns null', async () => {
    const maxRepay = parseUnits('500', 6);

    const provider = createMockProvider({
      debtTokenBalance: maxRepay,
      debtTokenAllowance: maxRepay,
      previewHF: (amount: bigint) => {
        if (amount === 0n) return parseUnits('1.5', 18);
        return parseUnits('2.0', 18);
      },
    });

    const messages: string[] = [];
    const telegram: TelegramClient = {
      async sendMessage(_chatId: string, text: string): Promise<boolean> {
        messages.push(text);
        return true;
      },
    };

    const watchdog = createWatchdogWithTelegram(createConfig({ dryRun: true }), telegram, {
      chatId: null,
    });
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log[0]?.action, 'dry-run');
    // No messages sent since getChatId returns null
    assert.equal(messages.length, 0);
  });
});

// ─── Morpho rescue integration tests ──────────────────────────────────────────

const MORPHO_RESCUE_INTERFACE = new Interface([
  'function rescue((address user,(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 amount,uint256 minResultingHf,uint256 deadline) params)',
  'function previewResultingHf((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams, address user, uint256 amount) view returns (uint256)',
]);

const SAMPLE_MORPHO_MARKET_PARAMS: MorphoMarketParams = {
  loanToken: USDC_CONTRACT.toLowerCase(),
  collateralToken: WETH_CONTRACT.toLowerCase(),
  oracle: '0x0000000000000000000000000000000000000001',
  irm: '0x0000000000000000000000000000000000000002',
  lltv: '860000000000000000',
};

function createMorphoLoan(overrides: Partial<LoanPosition> = {}): LoanPosition {
  // HF = 3000 * 0.86 / 1600 = 1.6125 (below triggerHF=1.65)
  return {
    id: '0xabc123',
    marketName: 'morpho_WETH_USDC',
    borrowed: [
      {
        symbol: 'USDC',
        address: USDC_CONTRACT,
        decimals: 6,
        amount: 1600,
        usdPrice: 1,
        usdValue: 1600,
        collateralEnabled: false,
        maxLTV: 0,
        liqThreshold: 0,
        supplyRate: 0,
        borrowRate: 0.045,
      },
    ],
    supplied: [
      {
        symbol: 'WETH',
        address: WETH_CONTRACT,
        decimals: 18,
        amount: 1.0,
        usdPrice: 3000,
        usdValue: 3000,
        collateralEnabled: true,
        maxLTV: 0.86,
        liqThreshold: 0.86,
        supplyRate: 0.032,
        borrowRate: 0,
      },
    ],
    totalSuppliedUsd: 3000,
    totalBorrowedUsd: 1600,
    morphoMarketParams: SAMPLE_MORPHO_MARKET_PARAMS,
    ...overrides,
  };
}

function createMorphoMockProvider(opts: {
  debtTokenBalance: bigint;
  debtTokenAllowance: bigint;
  previewHF: (amount: bigint) => bigint;
  gasPriceGwei?: number;
  ethBalance?: number;
}) {
  const balanceOfSelector = ERC20_INTERFACE.getFunction('balanceOf')!.selector;
  const allowanceSelector = ERC20_INTERFACE.getFunction('allowance')!.selector;
  const previewSelector = MORPHO_RESCUE_INTERFACE.getFunction('previewResultingHf')!.selector;

  return {
    call: async (tx: { to: string; data: string }) => {
      const selector = tx.data.slice(0, 10);

      // Debt token (USDC) calls
      if (tx.to.toLowerCase() === USDC_CONTRACT.toLowerCase()) {
        if (selector === balanceOfSelector) {
          return ERC20_INTERFACE.encodeFunctionResult('balanceOf', [opts.debtTokenBalance]);
        }
        if (selector === allowanceSelector) {
          return ERC20_INTERFACE.encodeFunctionResult('allowance', [opts.debtTokenAllowance]);
        }
      }

      // Morpho rescue contract preview call
      if (
        tx.to.toLowerCase() === MORPHO_RESCUE_CONTRACT.toLowerCase() &&
        selector === previewSelector
      ) {
        const decoded = MORPHO_RESCUE_INTERFACE.decodeFunctionData('previewResultingHf', tx.data);
        const amount = BigInt(decoded[2]);
        return MORPHO_RESCUE_INTERFACE.encodeFunctionResult('previewResultingHf', [
          opts.previewHF(amount),
        ]);
      }

      throw new Error(`Unexpected call: to=${tx.to} selector=${selector}`);
    },
    getFeeData: async () => ({
      gasPrice: BigInt(Math.round((opts.gasPriceGwei ?? 10) * 1e9)),
    }),
    getBalance: async () => BigInt(Math.round((opts.ethBalance ?? 1) * 1e18)),
  };
}

describe('Morpho rescue via evaluate', () => {
  test('dry-run for Morpho loan computes correct debt repay amount', async () => {
    const currentHFWad = parseUnits('1.5', 18);
    const maxRepay = parseUnits('500', 6); // 500 USDC
    const maxHFWad = parseUnits('2.1', 18);
    const slope = maxHFWad - currentHFWad;

    const provider = createMorphoMockProvider({
      debtTokenBalance: maxRepay,
      debtTokenAllowance: maxRepay,
      previewHF: (amount: bigint) => {
        if (amount === 0n) return currentHFWad;
        return currentHFWad + (slope * amount) / maxRepay;
      },
    });

    const { watchdog } = createWatchdog(
      createConfig({
        dryRun: true,
        morphoRescueContract: MORPHO_RESCUE_CONTRACT,
        maxRepayAmount: 500,
      }),
    );
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createMorphoLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log.length, 1);
    assert.equal(log[0]?.action, 'dry-run');
    assert.ok(log[0]!.projectedHF >= 1.9, `Projected HF ${log[0]!.projectedHF} < 1.9`);
  });

  test('skips Morpho loan when morphoRescueContract is not configured', async () => {
    const { watchdog } = createWatchdog(createConfig({ dryRun: true, morphoRescueContract: '' }));

    await watchdog.evaluate(createMorphoLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log.length, 1);
    assert.equal(log[0]?.action, 'skipped');
    assert.match(log[0]?.reason ?? '', /Invalid or missing morphoRescueContract/);
  });

  test('Morpho rescue dry-run sends notification', async () => {
    const provider = createMorphoMockProvider({
      debtTokenBalance: parseUnits('1000', 6),
      debtTokenAllowance: parseUnits('1000', 6),
      previewHF: (amount: bigint) =>
        amount === 0n ? parseUnits('1.5', 18) : parseUnits('1.9', 18),
    });

    const { watchdog, messages } = createWatchdog(
      createConfig({ dryRun: true, morphoRescueContract: MORPHO_RESCUE_CONTRACT }),
    );
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createMorphoLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log.length, 1);
    assert.equal(log[0]?.action, 'dry-run');
    assert.match(log[0]?.reason ?? '', /Would submit atomic rescue/);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /Watchdog DRY RUN/);
  });

  test('skips Morpho loan missing morphoMarketParams', async () => {
    const loanWithoutParams = createMorphoLoan();
    delete loanWithoutParams.morphoMarketParams;

    const { watchdog } = createWatchdog(
      createConfig({ dryRun: true, morphoRescueContract: MORPHO_RESCUE_CONTRACT }),
    );

    await watchdog.evaluate(loanWithoutParams, WALLET);

    const log = watchdog.getLog();
    assert.equal(log.length, 1);
    assert.equal(log[0]?.action, 'skipped');
    assert.match(log[0]?.reason ?? '', /missing debt token or market params/);
  });

  test('Morpho rescue uses debt token (USDC) not collateral token', async () => {
    const currentHFWad = parseUnits('1.5', 18);
    const maxRepay = parseUnits('500', 6);

    const provider = createMorphoMockProvider({
      debtTokenBalance: maxRepay,
      debtTokenAllowance: maxRepay,
      previewHF: (amount: bigint) => {
        if (amount === 0n) return currentHFWad;
        return parseUnits('2.0', 18);
      },
    });

    const { watchdog, messages } = createWatchdog(
      createConfig({ dryRun: true, morphoRescueContract: MORPHO_RESCUE_CONTRACT }),
    );
    injectProvider(watchdog, provider);

    await watchdog.evaluate(createMorphoLoan(), WALLET);

    const log = watchdog.getLog();
    assert.equal(log[0]?.action, 'dry-run');
    // Verify the notification mentions USDC (debt token) in the repay line
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /USDC/);
    // The "Would repay" line should reference USDC, not WETH
    assert.match(messages[0]!, /Would repay.*USDC/);
  });
});
