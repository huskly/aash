import assert from 'node:assert/strict';
import test from 'node:test';
import type { LoanPosition, MorphoVaultPosition } from '@aave-monitor/core';
import { Watchdog } from '../src/watchdog.js';
import type { WatchdogConfig } from '../src/storage.js';
import type { TelegramClient } from '../src/telegram.js';

const WALLET = '0x1111111111111111111111111111111111111111';
const RESCUE_CONTRACT = '0x2222222222222222222222222222222222222222';
const VAULT_WITHDRAW_CONTRACT = '0x3333333333333333333333333333333333333333';
const VAULT_ADDRESS = '0x4444444444444444444444444444444444444444';
const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const PROJECTED_HF_WAD = 1_900_000_000_000_000_000n;

type WatchdogReceipt = { status: number; hash: string };
type WaitableTransaction = {
  wait: () => Promise<WatchdogReceipt>;
};
type TestVaultWithdrawCapacity = {
  vault: MorphoVaultPosition;
  capacityRaw: bigint;
  maxWithdrawRaw: bigint;
  maxRedeemRaw: bigint;
  shareBalanceRaw: bigint;
  shareAssetValueRaw: bigint;
  source: 'maxWithdraw' | 'maxRedeem' | 'shareBalanceFallback' | 'none';
};
type WatchdogInternals = {
  getTokenBalance: (...args: unknown[]) => Promise<bigint>;
  getTokenAllowance: (...args: unknown[]) => Promise<bigint>;
  getVaultWithdrawCapacity: (...args: unknown[]) => Promise<TestVaultWithdrawCapacity>;
  getVaultPreviewWithdraw: (...args: unknown[]) => Promise<bigint>;
  findRequiredAmountRawGeneric: (...args: unknown[]) => Promise<bigint | null>;
  previewResultingHf: (...args: unknown[]) => Promise<bigint>;
  previewResultingHfMorpho: (...args: unknown[]) => Promise<bigint>;
  getGasPriceGwei: (...args: unknown[]) => Promise<number>;
  getEthBalance: (...args: unknown[]) => Promise<number>;
  submitRescueTransaction: (...args: unknown[]) => Promise<string>;
  submitVaultWithdrawTransaction: (...args: unknown[]) => Promise<string>;
  waitForReceiptOrReplacement: (
    tx: WaitableTransaction,
    expectedTo: string,
    expectedData: string,
  ) => Promise<WatchdogReceipt>;
  cooldowns: Map<string, number>;
};

function getWatchdogInternals(watchdog: Watchdog): WatchdogInternals {
  return watchdog as unknown as WatchdogInternals;
}

function createConfig(overrides: Partial<WatchdogConfig> = {}): WatchdogConfig {
  return {
    enabled: true,
    dryRun: false,
    triggerHF: 1.65,
    targetHF: 1.9,
    minResultingHF: 1.85,
    cooldownMs: 30 * 60 * 1000,
    maxRepayAmount: 500,
    deadlineSeconds: 300,
    rescueContract: RESCUE_CONTRACT,
    morphoRescueContract: '',
    maxGasGwei: 50,
    preRescueEnabled: false,
    preRescueTriggerHF: 1.7,
    vaultWithdrawContract: '',
    maxVaultWithdrawAmount: 500,
    ...overrides,
  };
}

function createLoanWithHF(targetHF: number): LoanPosition {
  // HF = liqThreshold * suppliedUsd / borrowedUsd. With lt=0.75, supplied=3200:
  // borrowedUsd = 0.75 * 3200 / targetHF
  const borrowedUsd = (0.75 * 3200) / targetHF;
  return {
    id: 'loan-1',
    marketName: 'proto_mainnet_v3',
    borrowed: [
      {
        symbol: 'USDC',
        address: USDC_ADDRESS,
        decimals: 6,
        amount: borrowedUsd,
        usdPrice: 1,
        usdValue: borrowedUsd,
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
        address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
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
    totalBorrowedUsd: borrowedUsd,
  };
}

function createVault(overrides: Partial<MorphoVaultPosition> = {}): MorphoVaultPosition {
  return {
    id: 'vault-1',
    kind: 'morpho-vault',
    protocol: 'morpho',
    vaultAddress: VAULT_ADDRESS,
    vaultName: 'Gauntlet USDC Prime',
    vaultSymbol: 'gtUSDC',
    asset: {
      symbol: 'USDC',
      address: USDC_ADDRESS,
      decimals: 6,
      amount: 1000,
      usdPrice: 1,
      usdValue: 1000,
      collateralEnabled: false,
      maxLTV: 0,
      liqThreshold: 0,
      supplyRate: 0,
      borrowRate: 0,
    },
    shares: 1000,
    totalAssets: 1000,
    totalAssetsUsd: 1000,
    apy: 0.05,
    netApy: 0.05,
    ...overrides,
  };
}

function createLoan(): LoanPosition {
  return {
    id: 'loan-1',
    marketName: 'proto_mainnet_v3',
    borrowed: [
      {
        symbol: 'USDC',
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
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
        address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
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
      () => options.chatId ?? '123',
      () => config,
      'http://localhost:8545',
      options.privateKey === undefined ? '0xabc' : (options.privateKey ?? undefined),
    ),
    messages,
  };
}

function stubEvaluation(
  watchdog: Watchdog,
  overrides: Partial<WatchdogInternals> = {},
): WatchdogInternals {
  const internals = getWatchdogInternals(watchdog);
  Object.assign(internals, {
    getTokenBalance: async () => 100_000_000n,
    getTokenAllowance: async () => 100_000_000n,
    findRequiredAmountRawGeneric: async () => 1_000_000n,
    previewResultingHf: async (...args: unknown[]) => {
      const amount = args.at(-1);
      return typeof amount === 'bigint' && amount > 0n
        ? PROJECTED_HF_WAD
        : 1_500_000_000_000_000_000n;
    },
    getGasPriceGwei: async () => 10,
    getEthBalance: async () => 1,
    submitRescueTransaction: async () => '0xabc123',
    ...overrides,
  });
  return internals;
}

test('dry-run logs planned atomic rescue and applies cooldown', async () => {
  const { watchdog, messages } = createWatchdog(createConfig({ dryRun: true }));
  const targetHFWad = 1_900_000_000_000_000_000n;

  stubEvaluation(watchdog, {
    findRequiredAmountRawGeneric: async () => 2_500_000n,
    previewResultingHf: async (...args: unknown[]) => {
      const amount = args.at(-1);
      return typeof amount === 'bigint' && amount > 0n ? targetHFWad : 1_500_000_000_000_000_000n;
    },
  });

  await watchdog.evaluate(createLoan(), WALLET);

  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /Watchdog DRY RUN/);
  assert.match(messages[0]!, /Borrow rate: <b>5\.00%<\/b>/);
  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'dry-run');
  assert.equal(log[0]?.repayAmount, 2.5);
  assert.equal(log[0]?.repayAssetSymbol, 'USDC');
});

test('live mode skips when private key is missing', async () => {
  const { watchdog } = createWatchdog(createConfig({ dryRun: false }), { privateKey: null });

  stubEvaluation(watchdog, {
    previewResultingHf: async () => PROJECTED_HF_WAD,
  });

  await watchdog.evaluate(createLoan(), WALLET);

  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'skipped');
  assert.match(log[0]?.reason ?? '', /No executor private key configured/);
});

test('live mode allows executor key to differ from monitored wallet', async () => {
  const { watchdog, messages } = createWatchdog(createConfig({ dryRun: false }), {
    privateKey: '0x59c6995e998f97a5a0044966f0945382d7d6a4b5d1c4fdbb3c4c7d6c7e9f4b6a',
  });

  stubEvaluation(watchdog, {
    previewResultingHf: async () => PROJECTED_HF_WAD,
    submitRescueTransaction: async () => '0xexecutor',
  });

  await watchdog.evaluate(createLoan(), WALLET);

  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'rescue');
  assert.equal(log[0]?.txHash, '0xexecutor');
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /Borrow rate: <b>5\.00%<\/b>/);
});

test('live mode executes rescue and records tx hash', async () => {
  const { watchdog, messages } = createWatchdog(createConfig({ dryRun: false }));

  stubEvaluation(watchdog, {
    previewResultingHf: async () => PROJECTED_HF_WAD,
    submitRescueTransaction: async () => '0xabc123',
  });

  await watchdog.evaluate(createLoan(), WALLET);

  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'rescue');
  assert.equal(log[0]?.txHash, '0xabc123');
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /Atomic rescue executed/);
  assert.match(messages[0]!, /Borrow rate: <b>5\.00%<\/b>/);
});

test('waitForReceiptOrReplacement treats successful equivalent replacement as success', async () => {
  const { watchdog } = createWatchdog(createConfig({ dryRun: false }));
  const expectedData = '0xdeadbeef';
  const replacementHash = '0xreplace123';
  const receipt = { status: 1, hash: replacementHash };
  const sentTx = {
    wait: async () => {
      const error = new Error('transaction was replaced') as Error & {
        code: string;
        cancelled: boolean;
        reason: string;
        replacement: { to: string; data: string; receipt: { status: number; hash: string } };
      };
      error.code = 'TRANSACTION_REPLACED';
      error.cancelled = true;
      error.reason = 'replaced';
      error.replacement = {
        to: RESCUE_CONTRACT,
        data: expectedData,
        receipt,
      };
      throw error;
    },
  };

  const resolvedReceipt = await getWatchdogInternals(watchdog).waitForReceiptOrReplacement(
    sentTx,
    RESCUE_CONTRACT,
    expectedData,
  );

  assert.equal(resolvedReceipt.hash, replacementHash);
});

test('cooldown prevents immediate re-execution', async () => {
  const { watchdog } = createWatchdog(createConfig({ dryRun: true }));

  stubEvaluation(watchdog, {
    previewResultingHf: async () => PROJECTED_HF_WAD,
  });

  await watchdog.evaluate(createLoan(), WALLET);
  await watchdog.evaluate(createLoan(), WALLET);

  const log = watchdog.getLog();
  assert.equal(log.length, 2);
  assert.equal(log[0]?.action, 'skipped');
  assert.match(log[0]?.reason ?? '', /Cooldown active/);
});

test('invalid rescue contract produces skipped log entry', async () => {
  const { watchdog } = createWatchdog(createConfig({ rescueContract: '' }));

  await watchdog.evaluate(createLoan(), WALLET);

  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'skipped');
  assert.match(log[0]?.reason ?? '', /Invalid or missing rescueContract/);
});

test('failed rescue tx logs error, sets cooldown, and notifies', async () => {
  const { watchdog, messages } = createWatchdog(createConfig({ dryRun: false }));

  stubEvaluation(watchdog, {
    previewResultingHf: async () => PROJECTED_HF_WAD,
    submitRescueTransaction: async () => {
      throw new Error('Transaction reverted: 0xdead');
    },
  });

  await watchdog.evaluate(createLoan(), WALLET);

  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'skipped');
  assert.match(log[0]?.reason ?? '', /Rescue tx failed/);
  assert.match(log[0]?.reason ?? '', /Transaction reverted/);

  // Cooldown should be set to prevent retry flooding
  const cooldowns = getWatchdogInternals(watchdog).cooldowns;
  assert.equal(cooldowns.has(`${WALLET}-loan-1`), true);

  // Notification should be sent
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /Rescue failed/);
  assert.match(messages[0]!, /Borrow rate: <b>5\.00%<\/b>/);
});

// ---------- Layer 0: pre-rescue vault withdrawal ----------

function stubPreRescueEvaluation(
  watchdog: Watchdog,
  overrides: Partial<WatchdogInternals> = {},
): WatchdogInternals {
  const internals = getWatchdogInternals(watchdog);
  Object.assign(internals, {
    getTokenBalance: async () => 0n, // empty wallet
    getTokenAllowance: async () => 1_000_000_000_000_000_000n,
    getVaultWithdrawCapacity: async (...args: unknown[]) => ({
      vault: args[1] as MorphoVaultPosition,
      capacityRaw: 1_000_000_000n, // 1000 USDC withdrawable
      maxWithdrawRaw: 1_000_000_000n,
      maxRedeemRaw: 0n,
      shareBalanceRaw: 0n,
      shareAssetValueRaw: 0n,
      source: 'maxWithdraw',
    }),
    getVaultPreviewWithdraw: async () => 200_000_000_000_000_000n,
    findRequiredAmountRawGeneric: async () => 200_000_000n, // need 200 USDC (6 decimals)
    previewResultingHf: async () => 1_900_000_000_000_000_000n,
    getGasPriceGwei: async () => 10,
    getEthBalance: async () => 1,
    submitVaultWithdrawTransaction: async () => '0xvaulttx',
    ...overrides,
  });
  return internals;
}

test('pre-rescue: HF above preRescueTriggerHF does nothing', async () => {
  const { watchdog } = createWatchdog(
    createConfig({
      preRescueEnabled: true,
      vaultWithdrawContract: VAULT_WITHDRAW_CONTRACT,
    }),
  );
  stubPreRescueEvaluation(watchdog);

  await watchdog.evaluate(createLoanWithHF(2.0), WALLET, [createVault()]);

  assert.equal(watchdog.getLog().length, 0);
});

test('pre-rescue: HF below triggerHF falls through to layer 1', async () => {
  const { watchdog } = createWatchdog(
    createConfig({
      dryRun: true,
      preRescueEnabled: true,
      vaultWithdrawContract: VAULT_WITHDRAW_CONTRACT,
    }),
  );
  // Set up layer-1 stubs
  stubEvaluation(watchdog, {
    findRequiredAmountRawGeneric: async () => 2_500_000n,
    previewResultingHf: async (...args: unknown[]) => {
      const amount = args.at(-1);
      return typeof amount === 'bigint' && amount > 0n
        ? 1_900_000_000_000_000_000n
        : 1_500_000_000_000_000_000n;
    },
  });

  await watchdog.evaluate(createLoanWithHF(1.5), WALLET, [createVault()]);

  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'dry-run');
});

test('pre-rescue: HF in buffer band with matching vault triggers vault withdrawal (live)', async () => {
  const { watchdog, messages } = createWatchdog(
    createConfig({
      dryRun: false,
      preRescueEnabled: true,
      vaultWithdrawContract: VAULT_WITHDRAW_CONTRACT,
    }),
  );
  stubPreRescueEvaluation(watchdog);

  await watchdog.evaluate(createLoanWithHF(1.67), WALLET, [createVault()]);

  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'vault-withdraw');
  assert.equal(log[0]?.txHash, '0xvaulttx');
  assert.equal(log[0]?.vaultAddress, VAULT_ADDRESS);
  assert.equal(log[0]?.repayAmount, 200);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /Pre-rescue vault withdrawal/);
});

test('pre-rescue: dry-run logs vault-withdraw-dry-run', async () => {
  const { watchdog, messages } = createWatchdog(
    createConfig({
      dryRun: true,
      preRescueEnabled: true,
      vaultWithdrawContract: VAULT_WITHDRAW_CONTRACT,
    }),
  );
  stubPreRescueEvaluation(watchdog);

  await watchdog.evaluate(createLoanWithHF(1.67), WALLET, [createVault()]);

  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'vault-withdraw-dry-run');
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /Pre-rescue DRY RUN/);
});

test('pre-rescue: skips when wallet already holds enough', async () => {
  const { watchdog } = createWatchdog(
    createConfig({
      dryRun: false,
      preRescueEnabled: true,
      vaultWithdrawContract: VAULT_WITHDRAW_CONTRACT,
    }),
  );
  stubPreRescueEvaluation(watchdog, {
    getTokenBalance: async () => 500_000_000n, // 500 USDC, more than 200 needed
  });

  await watchdog.evaluate(createLoanWithHF(1.67), WALLET, [createVault()]);

  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'skipped');
  assert.match(log[0]?.reason ?? '', /wallet already holds/);
});

test('pre-rescue: skips when no matching vault', async () => {
  const { watchdog } = createWatchdog(
    createConfig({
      dryRun: false,
      preRescueEnabled: true,
      vaultWithdrawContract: VAULT_WITHDRAW_CONTRACT,
    }),
  );
  stubPreRescueEvaluation(watchdog);

  await watchdog.evaluate(createLoanWithHF(1.67), WALLET, []);

  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'skipped');
  assert.match(log[0]?.reason ?? '', /no Morpho vault position matched/);
  assert.equal(log[0]?.diagnostics?.['receivedVaultCount'], 0);
  assert.equal(log[0]?.diagnostics?.['matchingVaultCount'], 0);
});

test('pre-rescue: logs matched vault diagnostics when maxWithdraw is zero', async () => {
  const { watchdog } = createWatchdog(
    createConfig({
      dryRun: false,
      preRescueEnabled: true,
      vaultWithdrawContract: VAULT_WITHDRAW_CONTRACT,
    }),
  );
  stubPreRescueEvaluation(watchdog, {
    getTokenBalance: async () => 143_000n,
    getVaultWithdrawCapacity: async (...args: unknown[]) => ({
      vault: args[1] as MorphoVaultPosition,
      capacityRaw: 0n,
      maxWithdrawRaw: 0n,
      maxRedeemRaw: 0n,
      shareBalanceRaw: 1_000_000_000_000_000_000n,
      shareAssetValueRaw: 1_000_000_000n,
      source: 'none',
    }),
  });

  await watchdog.evaluate(createLoanWithHF(1.67), WALLET, [createVault()]);

  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'skipped');
  assert.match(log[0]?.reason ?? '', /matching Morpho vaults report 0 usable/);
  assert.equal(log[0]?.diagnostics?.['matchingVaultCount'], 1);
  assert.equal(log[0]?.diagnostics?.['walletBalance'], 0.143);
  const vaults = log[0]?.diagnostics?.['vaults'] as Array<Record<string, unknown>>;
  assert.equal(vaults[0]?.['vaultAddress'], VAULT_ADDRESS);
  assert.equal(vaults[0]?.['vaultName'], 'Gauntlet USDC Prime');
  assert.equal(vaults[0]?.['withdrawCapacity'], 0);
  assert.equal(vaults[0]?.['erc4626MaxWithdraw'], 0);
});

test('pre-rescue: uses share asset value fallback when vault max functions are zero', async () => {
  const { watchdog } = createWatchdog(
    createConfig({
      dryRun: false,
      preRescueEnabled: true,
      vaultWithdrawContract: VAULT_WITHDRAW_CONTRACT,
      maxVaultWithdrawAmount: 500,
    }),
  );
  stubPreRescueEvaluation(watchdog, {
    getVaultWithdrawCapacity: async (...args: unknown[]) => ({
      vault: args[1] as MorphoVaultPosition,
      capacityRaw: 1_000_000_000n,
      maxWithdrawRaw: 0n,
      maxRedeemRaw: 0n,
      shareBalanceRaw: 1_000_000_000_000_000_000n,
      shareAssetValueRaw: 1_000_000_000n,
      source: 'shareBalanceFallback',
    }),
  });

  await watchdog.evaluate(createLoanWithHF(1.67), WALLET, [createVault()]);

  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'vault-withdraw');
  assert.equal(log[0]?.repayAmount, 200);
  assert.equal(log[0]?.diagnostics?.['selectedVaultCapacity'], 1000);
  assert.equal(log[0]?.diagnostics?.['selectedVaultCapacitySource'], 'shareBalanceFallback');
});

test('pre-rescue: live mode skips when vault share allowance is insufficient', async () => {
  const { watchdog } = createWatchdog(
    createConfig({
      dryRun: false,
      preRescueEnabled: true,
      vaultWithdrawContract: VAULT_WITHDRAW_CONTRACT,
    }),
  );
  let submitted = false;
  stubPreRescueEvaluation(watchdog, {
    getTokenAllowance: async () => 0n,
    getVaultPreviewWithdraw: async () => 200_000_000_000_000_000n,
    submitVaultWithdrawTransaction: async () => {
      submitted = true;
      return '0xvaulttx';
    },
  });

  await watchdog.evaluate(createLoanWithHF(1.67), WALLET, [createVault()]);

  assert.equal(submitted, false);
  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'skipped');
  assert.match(log[0]?.reason ?? '', /insufficient gtUSDC share allowance/);
  assert.equal(log[0]?.diagnostics?.['shareAllowance'], '0');
});

test('pre-rescue: capacity calc uses wallet + vault (does not under-skip)', async () => {
  // Scenario from review feedback: need 800 USDC, wallet has 400, maxVaultWithdraw=500.
  // Old behavior wrongly skipped because 500 alone didn't reach target HF.
  // New behavior must run findRequiredAmount with bound = min(wallet+vault, maxRepay)
  // = min(400 + 500, 500 default maxRepay) = 500, and search returns 500 which is
  // achievable. Wallet 400 < needed 500 → withdraw shortfall 100.
  const { watchdog } = createWatchdog(
    createConfig({
      dryRun: false,
      preRescueEnabled: true,
      vaultWithdrawContract: VAULT_WITHDRAW_CONTRACT,
      maxVaultWithdrawAmount: 500,
      maxRepayAmount: 500,
    }),
  );
  let boundSeen: bigint | null = null;
  stubPreRescueEvaluation(watchdog, {
    getTokenBalance: async () => 400_000_000n, // 400 USDC in wallet
    getVaultWithdrawCapacity: async (...args: unknown[]) => ({
      vault: args[1] as MorphoVaultPosition,
      capacityRaw: 10_000_000_000n, // plenty in vault
      maxWithdrawRaw: 10_000_000_000n,
      maxRedeemRaw: 0n,
      shareBalanceRaw: 0n,
      shareAssetValueRaw: 0n,
      source: 'maxWithdraw',
    }),
    findRequiredAmountRawGeneric: async (...args: unknown[]) => {
      boundSeen = args[2] as bigint;
      return 500_000_000n; // need 500 total
    },
  });

  await watchdog.evaluate(createLoanWithHF(1.67), WALLET, [createVault()]);

  assert.equal(boundSeen, 500_000_000n);
  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'vault-withdraw');
  assert.equal(log[0]?.repayAmount, 100); // shortfall = 500 - 400
});

test('pre-rescue: caps withdrawal at ERC-4626 maxWithdraw', async () => {
  // Vault reports totalAssets=10_000 via Morpho API but maxWithdraw returns
  // only 75 USDC for this user. The withdrawal must respect maxWithdraw.
  const { watchdog } = createWatchdog(
    createConfig({
      dryRun: false,
      preRescueEnabled: true,
      vaultWithdrawContract: VAULT_WITHDRAW_CONTRACT,
      maxVaultWithdrawAmount: 500,
    }),
  );
  let capturedAmount: bigint | null = null;
  stubPreRescueEvaluation(watchdog, {
    getVaultWithdrawCapacity: async (...args: unknown[]) => ({
      vault: args[1] as MorphoVaultPosition,
      capacityRaw: 75_000_000n, // 75 USDC withdrawable
      maxWithdrawRaw: 75_000_000n,
      maxRedeemRaw: 0n,
      shareBalanceRaw: 0n,
      shareAssetValueRaw: 0n,
      source: 'maxWithdraw',
    }),
    findRequiredAmountRawGeneric: async () => 75_000_000n, // capped at capacity=75
    submitVaultWithdrawTransaction: async (...args: unknown[]) => {
      capturedAmount = args[3] as bigint;
      return '0xvaulttx';
    },
  });

  await watchdog.evaluate(createLoanWithHF(1.67), WALLET, [createVault({ totalAssets: 10_000 })]);

  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'vault-withdraw');
  assert.equal(log[0]?.repayAmount, 75);
  assert.equal(capturedAmount, 75_000_000n);
});

test('pre-rescue: disabled flag bypasses layer 0 entirely', async () => {
  const { watchdog } = createWatchdog(
    createConfig({
      preRescueEnabled: false,
      vaultWithdrawContract: VAULT_WITHDRAW_CONTRACT,
    }),
  );

  await watchdog.evaluate(createLoanWithHF(1.67), WALLET, [createVault()]);

  // HF=1.67 is above triggerHF=1.65 so layer 1 also skips. With preRescue off, no log.
  assert.equal(watchdog.getLog().length, 0);
});

test('pre-rescue: caps withdrawal at maxVaultWithdrawAmount', async () => {
  const { watchdog } = createWatchdog(
    createConfig({
      dryRun: false,
      preRescueEnabled: true,
      vaultWithdrawContract: VAULT_WITHDRAW_CONTRACT,
      maxVaultWithdrawAmount: 50,
    }),
  );
  let capturedAmount: bigint | null = null;
  stubPreRescueEvaluation(watchdog, {
    findRequiredAmountRawGeneric: async () => 50_000_000n, // capped by maxVaultWithdrawRaw=50_000_000n
    submitVaultWithdrawTransaction: async (...args: unknown[]) => {
      capturedAmount = args[3] as bigint;
      return '0xvaulttx';
    },
  });

  await watchdog.evaluate(createLoanWithHF(1.67), WALLET, [createVault({ totalAssets: 10_000 })]);

  const log = watchdog.getLog();
  assert.equal(log[0]?.action, 'vault-withdraw');
  assert.equal(log[0]?.repayAmount, 50);
  assert.equal(capturedAmount, 50_000_000n);
});
