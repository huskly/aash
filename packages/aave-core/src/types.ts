export type BadgeTone = 'neutral' | 'positive' | 'warning' | 'danger';

export type PollingConfig = {
  intervalMs: number;
  debounceChecks: number;
  reminderIntervalMs: number;
  cooldownMs: number;
};

export type WatchdogConfig = {
  enabled: boolean;
  dryRun: boolean;
  triggerHF: number;
  targetHF: number;
  minResultingHF: number;
  cooldownMs: number;
  maxRepayAmount: number;
  deadlineSeconds: number;
  rescueContract: string;
  morphoRescueContract: string;
  maxGasGwei: number;
};

export type RawUserReserve = {
  currentATokenBalance: string;
  currentTotalDebt: string;
  usageAsCollateralEnabledOnUser: boolean;
  reserve: {
    symbol: string;
    decimals: number;
    underlyingAsset: string;
    baseLTVasCollateral: string;
    reserveLiquidationThreshold: string;
    liquidityRate: string;
    variableBorrowRate: string;
  };
};

export type AssetPosition = {
  symbol: string;
  address: string;
  decimals: number;
  amount: number;
  usdPrice: number;
  usdValue: number;
  collateralEnabled: boolean;
  maxLTV: number;
  liqThreshold: number;
  supplyRate: number;
  borrowRate: number;
};

export type MorphoMarketParams = {
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltv: string;
};

export type MorphoVaultPosition = {
  id: string;
  kind: 'morpho-vault';
  protocol: 'morpho';
  vaultAddress: string;
  vaultName: string;
  vaultSymbol: string;
  asset: AssetPosition;
  shares: number;
  totalAssets: number;
  totalAssetsUsd: number;
  apy: number;
  netApy: number;
};

export type LoanPosition = {
  id: string;
  marketName: string;
  borrowed: AssetPosition[];
  supplied: AssetPosition[];
  totalSuppliedUsd: number;
  totalBorrowedUsd: number;
  /** Borrow interest accrued in USD for this position when available from the upstream protocol API. */
  accruedBorrowInterestUsd?: number;
  morphoMarketParams?: MorphoMarketParams;
  /** Current market utilization rate (0–1). Populated for Morpho markets; undefined for Aave. */
  utilizationRate?: number;
  /** Current market supply APY. Populated for Morpho markets; undefined for Aave. */
  marketSupplyApy?: number;
};

export type RawUserReserveWithMarket = RawUserReserve & { __marketName: string };

export type FetchState = {
  wallet: string;
  loans: LoanPosition[];
  vaults: MorphoVaultPosition[];
  lastUpdated: string;
};

export type Computed = {
  units: number;
  px: number;
  debt: number;
  collateralUSD: number;
  equity: number;
  ltv: number;
  leverage: number;
  healthFactor: number;
  liqPrice: number;
  collateralUSDAtLiq: number;
  ltvAtLiq: number;
  priceDropToLiq: number;
  supplyEarnUSD: number;
  borrowCostUSD: number;
  netEarnUSD: number;
  netAPYOnEquity: number;
  maxBorrowByLTV: number;
  borrowHeadroom: number;
  borrowPowerUsed: number;
  equityMoveFor10Pct: number;
  collateralBufferUSD: number;
  adjustedHF: number;
  alertHF: boolean;
  alertLTV: boolean;
  ltvMax: number;
  lt: number;
  rSupply: number;
  rBorrow: number;
  primaryCollateralSymbol: string;
  assetLiquidations: AssetLiquidation[];
};

export type PortfolioSummary = {
  loanCount: number;
  vaultCount: number;
  positionCount: number;
  totalDebt: number;
  totalAccruedBorrowInterest: number;
  totalRiskCollateral: number;
  totalVaultAssets: number;
  totalAssets: number;
  totalNetWorth: number;
  totalSupplyEarn: number;
  totalBorrowCost: number;
  totalNetEarn: number;
  totalLoanNetEarn: number;
  totalLoanNetEarnAfterVaults: number;
  averageHealthFactor: number;
  averageSupplyApy: number;
  averageBorrowApy: number;
  portfolioNetApy: number;
  portfolioNetApyOnDebt: number;
  borrowPowerUsed: number;
  repayCoverage: number;
  walletBorrowedAssetUsd: number;
};

export type AssetLiquidation = {
  symbol: string;
  liqPrice: number;
  priceDropToLiq: number;
  currentPrice: number;
};

export type AdjustedHFResult = {
  adjustedHF: number;
  adjustedCollateralUSD: number;
  adjustedLt: number;
  sameAssetSuppliedUSD: number;
  sameAssetSuppliedAmount: number;
  debt: number;
};

export type AaveMarket = {
  readonly marketName: string;
  readonly graphSubgraphId: string;
  readonly fallbackEndpoints: readonly string[];
};

export type ReserveTelemetry = {
  marketName: string;
  assetAddress: string;
  symbol: string;
  availableLiquidity: number;
  totalDebt: number;
  utilizationRate: number;
  variableBorrowRate: number;
  baseVariableBorrowRate: number;
  variableRateSlope1: number;
  variableRateSlope2: number;
  optimalUsageRatio: number;
  lastUpdateTimestamp: string;
};

export type InterestRateCurvePoint = {
  utilizationRate: number;
  variableBorrowRate: number;
};

export type UtilizationConfig = {
  enabled: boolean;
  /** Default trigger threshold (0–1). Used when on-chain optimalUsageRatio unavailable. */
  defaultThreshold: number;
  /** Cooldown between alerts for same asset (ms). */
  cooldownMs: number;
};
