import {
  computeLoanMetrics,
  DEFAULT_R_DEPLOY,
  type LoanPosition,
  type MorphoMarketParams,
} from '@aave-monitor/core';
import { formatUnits, Interface, JsonRpcProvider, parseUnits, Wallet } from 'ethers';
import type { WatchdogConfig } from './storage.js';
import type { TelegramClient } from './telegram.js';
import { logger } from './logger.js';

const ERC20_INTERFACE = new Interface([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);

const RESCUE_INTERFACE = new Interface([
  'function rescue((address user,address asset,uint256 amount,uint256 minResultingHF,uint256 deadline) params)',
  'function previewResultingHF(address user, address asset, uint256 amount) view returns (uint256)',
]);

const MORPHO_RESCUE_INTERFACE = new Interface([
  'function rescue((address user,(address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams,uint256 amount,uint256 minResultingHF,uint256 deadline) params)',
  'function previewResultingHF((address loanToken,address collateralToken,address oracle,address irm,uint256 lltv) marketParams, address user, uint256 amount) view returns (uint256)',
]);

const MIN_ETH_FOR_GAS = 0.005;
export type WatchdogLogEntry = {
  timestamp: number;
  loanId: string;
  wallet: string;
  protocol: 'aave' | 'morpho';
  action: 'dry-run' | 'rescue' | 'skipped';
  reason: string;
  healthFactor: number;
  repayAmount: number;
  repayAssetSymbol: string;
  projectedHF: number;
  txHash?: string;
};

export class Watchdog {
  private cooldowns = new Map<string, number>();
  private readonly log: WatchdogLogEntry[] = [];
  private readonly maxLogEntries = 50;
  private provider?: JsonRpcProvider;
  private wallet?: Wallet;

  constructor(
    private readonly telegram: TelegramClient,
    private readonly getChatId: () => string | null,
    private readonly getConfig: () => WatchdogConfig,
    private readonly rpcUrl: string,
    private readonly privateKey: string | undefined,
  ) {}

  getLog(): WatchdogLogEntry[] {
    return [...this.log];
  }

  getStatusSummary(): {
    enabled: boolean;
    dryRun: boolean;
    hasPrivateKey: boolean;
    triggerHF: number;
    targetHF: number;
    minResultingHF: number;
    aaveRescueContract: string;
    morphoRescueContract: string;
    recentActions: number;
  } {
    const config = this.getConfig();
    return {
      enabled: config.enabled,
      dryRun: config.dryRun,
      hasPrivateKey: Boolean(this.privateKey),
      triggerHF: config.triggerHF,
      targetHF: config.targetHF,
      minResultingHF: config.minResultingHF,
      aaveRescueContract: config.rescueContract,
      morphoRescueContract: config.morphoRescueContract,
      recentActions: this.log.length,
    };
  }

  async evaluate(loan: LoanPosition, walletAddress: string): Promise<void> {
    const isMorpho = loan.marketName.startsWith('morpho_');
    const isAave = loan.marketName.startsWith('proto_');
    if (!isMorpho && !isAave) return;
    const protocol = isMorpho ? 'morpho' : 'aave';

    const config = this.getConfig();

    if (!config.enabled) return;

    const healthFactor = computeLoanMetrics(loan, DEFAULT_R_DEPLOY).healthFactor;
    if (!Number.isFinite(healthFactor) || healthFactor >= config.triggerHF) {
      return;
    }

    // Resolve protocol-specific rescue contract and debt token info.
    // For Aave, pick the borrowed asset with the largest USD value — repaying
    // the biggest debt component gives the most HF improvement per dollar.
    const primaryDebt = isMorpho
      ? loan.borrowed[0]
      : loan.borrowed.length > 1
        ? loan.borrowed.reduce((a, b) => (b.usdValue > a.usdValue ? b : a))
        : loan.borrowed[0];
    const debtToken = isMorpho
      ? (loan.morphoMarketParams?.loanToken ?? primaryDebt?.address)
      : primaryDebt?.address;
    const debtDecimals = primaryDebt?.decimals ?? 6;
    const morphoParams = isMorpho ? loan.morphoMarketParams : undefined;
    const debtSymbol = primaryDebt?.symbol ?? 'USDC';
    const rescueContract = isMorpho
      ? config.morphoRescueContract.trim()
      : config.rescueContract.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(rescueContract)) {
      this.addLog({
        timestamp: Date.now(),
        loanId: loan.id,
        wallet: walletAddress,
        protocol,
        action: 'skipped',
        reason: `Invalid or missing ${isMorpho ? 'morphoRescueContract' : 'rescueContract'} in watchdog config`,
        healthFactor,
        repayAmount: 0,
        repayAssetSymbol: debtSymbol,
        projectedHF: healthFactor,
      });
      return;
    }
    if (isMorpho && (!debtToken || !morphoParams)) {
      this.addLog({
        timestamp: Date.now(),
        loanId: loan.id,
        wallet: walletAddress,
        protocol,
        action: 'skipped',
        reason: 'Morpho loan missing debt token or market params',
        healthFactor,
        repayAmount: 0,
        repayAssetSymbol: debtSymbol,
        projectedHF: healthFactor,
      });
      return;
    }

    const now = Date.now();
    const stateKey = `${walletAddress}-${loan.id}`;
    const lastAction = this.cooldowns.get(stateKey) ?? 0;
    if (now - lastAction < config.cooldownMs) {
      const remainingMs = config.cooldownMs - (now - lastAction);
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        protocol,
        action: 'skipped',
        reason: `Cooldown active: ${Math.round(remainingMs / 1000)}s remaining`,
        healthFactor,
        repayAmount: 0,
        repayAssetSymbol: debtSymbol,
        projectedHF: healthFactor,
      });
      return;
    }

    let repayAmount: number;
    let projectedHF: number;
    let amountRaw: bigint;
    const provider = this.getProvider();
    const minHFWad = this.toWad(config.minResultingHF);

    // Build protocol-specific preview/submit helpers
    const previewFn = isMorpho
      ? (amount: bigint) =>
          this.previewResultingHFMorpho(
            provider,
            rescueContract,
            walletAddress,
            amount,
            morphoParams!,
          )
      : (amount: bigint) =>
          this.previewResultingHF(provider, rescueContract, walletAddress, debtToken!, amount);

    try {
      const [walletBalanceRaw, allowanceRaw] = await Promise.all([
        this.getTokenBalance(provider, debtToken!, walletAddress),
        this.getTokenAllowance(provider, debtToken!, walletAddress, rescueContract),
      ]);

      const maxRepayRaw = parseUnits(config.maxRepayAmount.toFixed(debtDecimals), debtDecimals);
      const availableRaw = minBigInt(walletBalanceRaw, allowanceRaw, maxRepayRaw);
      if (availableRaw <= 0n) {
        this.addLog({
          timestamp: now,
          loanId: loan.id,
          wallet: walletAddress,
          protocol,
          action: 'skipped',
          reason: `No available ${debtSymbol} (balance/allowance/maxRepay all exhausted)`,
          healthFactor,
          repayAmount: 0,
          repayAssetSymbol: debtSymbol,
          projectedHF: healthFactor,
        });
        await this.notify(
          `🚨 <b>Watchdog: ${debtSymbol} unavailable</b>\n\n` +
            `Loan: ${loan.id} (${loan.marketName})\n` +
            `HF: <b>${healthFactor.toFixed(4)}</b>\n` +
            `Wallet ${debtSymbol}: ${formatUnits(walletBalanceRaw, debtDecimals)}\n` +
            `Allowance ${debtSymbol}: ${formatUnits(allowanceRaw, debtDecimals)}`,
        );
        return;
      }

      const targetHFWad = this.toWad(config.targetHF);

      let computedAmount = await this.findRequiredAmountRawGeneric(
        previewFn,
        targetHFWad,
        availableRaw,
      );

      if (computedAmount === null) {
        computedAmount = await this.findRequiredAmountRawGeneric(previewFn, minHFWad, availableRaw);
      }

      if (computedAmount === null || computedAmount <= 0n) {
        this.addLog({
          timestamp: now,
          loanId: loan.id,
          wallet: walletAddress,
          protocol,
          action: 'skipped',
          reason: `Insufficient ${debtSymbol} to achieve minimum resulting HF`,
          healthFactor,
          repayAmount: 0,
          repayAssetSymbol: debtSymbol,
          projectedHF: healthFactor,
        });
        await this.notify(
          `🚨 <b>Watchdog: Rescue not feasible</b>\n\n` +
            `Loan: ${loan.id} (${loan.marketName})\n` +
            `Current HF: <b>${healthFactor.toFixed(4)}</b>\n` +
            `Max usable ${debtSymbol}: ${formatUnits(availableRaw, debtDecimals)}\n` +
            `Min resulting HF: ${config.minResultingHF}`,
        );
        return;
      }

      amountRaw = computedAmount;

      const projectedHFWad = await previewFn(amountRaw);

      if (projectedHFWad < minHFWad) {
        this.addLog({
          timestamp: now,
          loanId: loan.id,
          wallet: walletAddress,
          protocol,
          action: 'skipped',
          reason: 'Projected HF below minimum resulting HF threshold',
          healthFactor,
          repayAmount: this.toFormattedAmount(amountRaw, debtDecimals),
          repayAssetSymbol: debtSymbol,
          projectedHF: this.wadToNumber(projectedHFWad),
        });
        return;
      }

      repayAmount = this.toFormattedAmount(amountRaw, debtDecimals);
      projectedHF = this.wadToNumber(projectedHFWad);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        protocol,
        action: 'skipped',
        reason: `On-chain call failed: ${message}`,
        healthFactor,
        repayAmount: 0,
        repayAssetSymbol: debtSymbol,
        projectedHF: healthFactor,
      });
      await this.notify(
        `❌ <b>Watchdog: On-chain call failed</b>\n\n` +
          `Loan: ${loan.id} (${loan.marketName})\n` +
          `HF: <b>${healthFactor.toFixed(4)}</b>\n` +
          `Error: ${message}`,
      );
      return;
    }

    if (config.dryRun) {
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        protocol,
        action: 'dry-run',
        reason: `Would submit atomic rescue with ${repayAmount.toFixed(2)} ${debtSymbol}`,
        healthFactor,
        repayAmount,
        repayAssetSymbol: debtSymbol,
        projectedHF,
      });
      this.cooldowns.set(stateKey, now);
      await this.notify(
        `🧪 <b>Watchdog DRY RUN</b>\n\n` +
          `Loan: ${loan.id} (${loan.marketName})\n` +
          `Current HF: <b>${healthFactor.toFixed(4)}</b> (trigger: ${config.triggerHF})\n` +
          `Target HF: ${config.targetHF}\n` +
          `Min resulting HF: ${config.minResultingHF}\n\n` +
          `Would repay: <b>${repayAmount.toFixed(2)} ${debtSymbol}</b>\n` +
          `Projected HF: <b>${projectedHF.toFixed(4)}</b>`,
      );
      return;
    }

    if (!this.privateKey) {
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        protocol,
        action: 'skipped',
        reason: 'No private key configured for live rescue execution',
        healthFactor,
        repayAmount,
        repayAssetSymbol: debtSymbol,
        projectedHF,
      });
      return;
    }

    const gasPriceGwei = await this.getGasPriceGwei(provider);
    if (gasPriceGwei > config.maxGasGwei) {
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        protocol,
        action: 'skipped',
        reason: `Gas price ${gasPriceGwei.toFixed(1)} gwei exceeds max ${config.maxGasGwei} gwei`,
        healthFactor,
        repayAmount,
        repayAssetSymbol: debtSymbol,
        projectedHF,
      });
      await this.notify(
        `⛽ <b>Watchdog: Gas too high</b>\n\n` +
          `Current: ${gasPriceGwei.toFixed(1)} gwei (max: ${config.maxGasGwei})\n` +
          `Skipping rescue for ${repayAmount.toFixed(2)} ${debtSymbol}`,
      );
      return;
    }

    const ethBalance = await this.getEthBalance(provider, walletAddress);
    if (ethBalance < MIN_ETH_FOR_GAS) {
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        protocol,
        action: 'skipped',
        reason: `Insufficient ETH for gas: ${ethBalance.toFixed(6)} ETH`,
        healthFactor,
        repayAmount,
        repayAssetSymbol: debtSymbol,
        projectedHF,
      });
      await this.notify(
        `⛽ <b>Watchdog: Insufficient ETH for gas</b>\n\n` +
          `Balance: ${ethBalance.toFixed(6)} ETH\n` +
          `Skipping rescue for ${repayAmount.toFixed(2)} ${debtSymbol}`,
      );
      return;
    }

    const deadline = Math.floor(Date.now() / 1000) + config.deadlineSeconds;
    try {
      const txHash = isMorpho
        ? await this.submitMorphoRescueTransaction(
            walletAddress,
            rescueContract,
            morphoParams!,
            amountRaw,
            minHFWad,
            deadline,
          )
        : await this.submitRescueTransaction(
            walletAddress,
            rescueContract,
            debtToken!,
            amountRaw,
            minHFWad,
            deadline,
          );

      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        protocol,
        action: 'rescue',
        reason: `Rescue submitted with ${repayAmount.toFixed(2)} ${debtSymbol}`,
        healthFactor,
        repayAmount,
        repayAssetSymbol: debtSymbol,
        projectedHF,
        txHash,
      });
      this.cooldowns.set(stateKey, Date.now());

      await this.notify(
        `✅ <b>Watchdog: Atomic rescue executed</b>\n\n` +
          `Loan: ${loan.id} (${loan.marketName})\n` +
          `Repay: <b>${repayAmount.toFixed(2)} ${debtSymbol}</b>\n` +
          `Projected HF: <b>${projectedHF.toFixed(4)}</b>\n` +
          `Tx: <code>${txHash}</code>`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.addLog({
        timestamp: now,
        loanId: loan.id,
        wallet: walletAddress,
        protocol,
        action: 'skipped',
        reason: `Rescue tx failed: ${message}`,
        healthFactor,
        repayAmount,
        repayAssetSymbol: debtSymbol,
        projectedHF,
      });
      this.cooldowns.set(stateKey, Date.now());

      await this.notify(
        `❌ <b>Watchdog: Rescue failed</b>\n\n` +
          `Loan: ${loan.id} (${loan.marketName})\n` +
          `Repay attempted: <b>${repayAmount.toFixed(2)} ${debtSymbol}</b>\n` +
          `Error: ${message}`,
      );
    }
  }

  private async findRequiredAmountRawGeneric(
    previewFn: (amount: bigint) => Promise<bigint>,
    targetHF: bigint,
    maxAmount: bigint,
  ): Promise<bigint | null> {
    if (maxAmount <= 0n) return null;

    // HF(amount) is monotonically increasing (more repay → higher HF) but
    // hyperbolic, not linear: HF = C / (D - x). We use a bounded binary
    // search to find the minimum amount that meets targetHF.
    const [currentHF, maxHF] = await Promise.all([previewFn(0n), previewFn(maxAmount)]);

    if (currentHF >= targetHF) return 0n;
    if (maxHF < targetHF) return null;

    let lo = 0n;
    let hi = maxAmount;
    // Each iteration halves the search range via one read-only eth_call.
    // Scale iterations to the bit-width of maxAmount so precision reaches
    // ~1 base unit even for large 18-decimal ranges.
    let bits = 0;
    for (let v = maxAmount; v > 0n; v >>= 1n) bits++;
    const MAX_ITERATIONS = Math.min(bits, 64);
    for (let i = 0; i < MAX_ITERATIONS && lo < hi; i++) {
      const mid = (lo + hi) / 2n;
      const midHF = await previewFn(mid);
      if (midHF >= targetHF) {
        hi = mid;
      } else {
        lo = mid + 1n;
      }
    }

    return hi;
  }

  private async previewResultingHF(
    provider: JsonRpcProvider,
    rescueContract: string,
    user: string,
    debtTokenAddress: string,
    amountRaw: bigint,
  ): Promise<bigint> {
    const data = RESCUE_INTERFACE.encodeFunctionData('previewResultingHF', [
      user,
      debtTokenAddress,
      amountRaw,
    ]);
    const result = await provider.call({ to: rescueContract, data });
    const [hf] = RESCUE_INTERFACE.decodeFunctionResult('previewResultingHF', result);
    return BigInt(hf);
  }

  private async submitRescueTransaction(
    from: string,
    rescueContract: string,
    debtTokenAddress: string,
    amountRaw: bigint,
    minResultingHF: bigint,
    deadline: number,
  ): Promise<string> {
    const wallet = this.getWallet();
    if (wallet.address.toLowerCase() !== from.toLowerCase()) {
      throw new Error(
        `Signer address mismatch: private key controls ${wallet.address} but expected ${from}. ` +
          `The configured private key must correspond to the monitored wallet address.`,
      );
    }

    const data = RESCUE_INTERFACE.encodeFunctionData('rescue', [
      {
        user: from,
        asset: debtTokenAddress,
        amount: amountRaw,
        minResultingHF,
        deadline,
      },
    ]);

    const tx = await wallet.sendTransaction({ to: rescueContract, data });
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      throw new Error(`Transaction reverted: ${tx.hash}`);
    }

    return tx.hash;
  }

  private async previewResultingHFMorpho(
    provider: JsonRpcProvider,
    rescueContract: string,
    user: string,
    amountRaw: bigint,
    morphoParams: MorphoMarketParams,
  ): Promise<bigint> {
    const marketParamsTuple = {
      loanToken: morphoParams.loanToken,
      collateralToken: morphoParams.collateralToken,
      oracle: morphoParams.oracle,
      irm: morphoParams.irm,
      lltv: BigInt(morphoParams.lltv),
    };
    const data = MORPHO_RESCUE_INTERFACE.encodeFunctionData('previewResultingHF', [
      marketParamsTuple,
      user,
      amountRaw,
    ]);
    const result = await provider.call({ to: rescueContract, data });
    const [hf] = MORPHO_RESCUE_INTERFACE.decodeFunctionResult('previewResultingHF', result);
    return BigInt(hf);
  }

  private async submitMorphoRescueTransaction(
    from: string,
    rescueContract: string,
    morphoParams: MorphoMarketParams,
    amountRaw: bigint,
    minResultingHF: bigint,
    deadline: number,
  ): Promise<string> {
    const wallet = this.getWallet();
    if (wallet.address.toLowerCase() !== from.toLowerCase()) {
      throw new Error(
        `Signer address mismatch: private key controls ${wallet.address} but expected ${from}. ` +
          `The configured private key must correspond to the monitored wallet address.`,
      );
    }

    const marketParamsTuple = {
      loanToken: morphoParams.loanToken,
      collateralToken: morphoParams.collateralToken,
      oracle: morphoParams.oracle,
      irm: morphoParams.irm,
      lltv: BigInt(morphoParams.lltv),
    };

    const data = MORPHO_RESCUE_INTERFACE.encodeFunctionData('rescue', [
      {
        user: from,
        marketParams: marketParamsTuple,
        amount: amountRaw,
        minResultingHF,
        deadline,
      },
    ]);

    const tx = await wallet.sendTransaction({ to: rescueContract, data });
    const receipt = await tx.wait();
    if (!receipt || receipt.status === 0) {
      throw new Error(`Transaction reverted: ${tx.hash}`);
    }

    return tx.hash;
  }

  private async getTokenBalance(
    provider: JsonRpcProvider,
    token: string,
    owner: string,
  ): Promise<bigint> {
    const data = ERC20_INTERFACE.encodeFunctionData('balanceOf', [owner]);
    const result = await provider.call({ to: token, data });
    const [balance] = ERC20_INTERFACE.decodeFunctionResult('balanceOf', result);
    return BigInt(balance);
  }

  private async getTokenAllowance(
    provider: JsonRpcProvider,
    token: string,
    owner: string,
    spender: string,
  ): Promise<bigint> {
    const data = ERC20_INTERFACE.encodeFunctionData('allowance', [owner, spender]);
    const result = await provider.call({ to: token, data });
    const [allowance] = ERC20_INTERFACE.decodeFunctionResult('allowance', result);
    return BigInt(allowance);
  }

  private async getGasPriceGwei(provider: JsonRpcProvider): Promise<number> {
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? 0n;
    return Number(gasPrice) / 1e9;
  }

  private async getEthBalance(provider: JsonRpcProvider, address: string): Promise<number> {
    const balance = await provider.getBalance(address);
    return Number(balance) / 1e18;
  }

  private getProvider(): JsonRpcProvider {
    if (!this.provider) {
      this.provider = new JsonRpcProvider(this.rpcUrl);
    }
    return this.provider;
  }

  private getWallet(): Wallet {
    if (!this.privateKey) {
      throw new Error('No private key configured');
    }
    if (!this.wallet) {
      this.wallet = new Wallet(this.privateKey, this.getProvider());
    }
    return this.wallet;
  }

  private toFormattedAmount(value: bigint, decimals: number): number {
    return Number(formatUnits(value, decimals));
  }

  private toWad(value: number): bigint {
    // Round to 4 decimal places to avoid floating-point artifacts like 1.849999999999999956
    return parseUnits(value.toFixed(4), 18);
  }

  private wadToNumber(value: bigint): number {
    return Number(formatUnits(value, 18));
  }

  private async notify(message: string): Promise<void> {
    const chatId = this.getChatId();
    if (chatId) {
      await this.telegram.sendMessage(chatId, message);
    }
  }

  private addLog(entry: WatchdogLogEntry): void {
    this.log.unshift(entry);
    if (this.log.length > this.maxLogEntries) {
      this.log.length = this.maxLogEntries;
    }
    logger.info(
      {
        action: entry.action,
        protocol: entry.protocol,
        reason: entry.reason,
        loan: entry.loanId,
        healthFactor: Number(entry.healthFactor.toFixed(4)),
        repayAmount: entry.repayAmount,
        repayAssetSymbol: entry.repayAssetSymbol,
        ...(entry.txHash && { txHash: entry.txHash }),
      },
      'Watchdog log entry',
    );
  }
}

function minBigInt(...values: bigint[]): bigint {
  return values.reduce((min, value) => (value < min ? value : min));
}
