import { AaveV3Ethereum, AaveV3EthereumLido } from '@bgd-labs/aave-address-book';
import { fromRay, parseBalance, type ReserveTelemetry } from '@aave-monitor/core';
import { Contract, JsonRpcProvider } from 'ethers';

const AAVE_PROTOCOL_DATA_PROVIDER_ABI = [
  'function getReserveConfigurationData(address asset) view returns (uint256 decimals,uint256 ltv,uint256 liquidationThreshold,uint256 liquidationBonus,uint256 reserveFactor,bool usageAsCollateralEnabled,bool borrowingEnabled,bool stableBorrowRateEnabled,bool isActive,bool isFrozen)',
  'function getReserveData(address asset) view returns (uint256 unbacked,uint256 accruedToTreasuryScaled,uint256 totalAToken,uint256 totalStableDebt,uint256 totalVariableDebt,uint256 liquidityRate,uint256 variableBorrowRate,uint256 stableBorrowRate,uint256 averageStableBorrowRate,uint256 liquidityIndex,uint256 variableBorrowIndex,uint40 lastUpdateTimestamp)',
  'function getInterestRateStrategyAddress(address asset) view returns (address)',
] as const;

const DEFAULT_INTEREST_RATE_STRATEGY_V2_ABI = [
  'function getInterestRateData(address asset) view returns (uint256 optimalUsageRatio,uint256 baseVariableBorrowRate,uint256 variableRateSlope1,uint256 variableRateSlope2)',
] as const;

type AaveMarketContractAddresses = {
  AAVE_PROTOCOL_DATA_PROVIDER: string;
};

type ReserveConfigurationData = {
  decimals: bigint;
};

type ReserveData = {
  unbacked: bigint;
  totalAToken: bigint;
  totalStableDebt: bigint;
  totalVariableDebt: bigint;
  variableBorrowRate: bigint;
  lastUpdateTimestamp: bigint;
};

type InterestRateData = {
  optimalUsageRatio: bigint;
  baseVariableBorrowRate: bigint;
  variableRateSlope1: bigint;
  variableRateSlope2: bigint;
};

const MARKET_ADDRESSES: Record<string, AaveMarketContractAddresses> = {
  proto_mainnet_v3: AaveV3Ethereum,
  proto_lido_v3: AaveV3EthereumLido,
};

const providers = new Map<string, JsonRpcProvider>();

function getProvider(rpcUrl: string): JsonRpcProvider {
  const cached = providers.get(rpcUrl);
  if (cached) return cached;

  const provider = new JsonRpcProvider(rpcUrl);
  providers.set(rpcUrl, provider);
  return provider;
}

export async function fetchReserveTelemetry(
  marketName: string,
  assetAddress: string,
  rpcUrl: string,
): Promise<ReserveTelemetry> {
  const market = MARKET_ADDRESSES[marketName];
  if (!market) {
    throw new Error(`Unsupported Aave market: ${marketName}`);
  }

  const provider = getProvider(rpcUrl);
  const reserveAddress = assetAddress.toLowerCase();
  const dataProvider = new Contract(
    market.AAVE_PROTOCOL_DATA_PROVIDER,
    AAVE_PROTOCOL_DATA_PROVIDER_ABI,
    provider,
  ) as Contract & {
    getReserveConfigurationData(asset: string): Promise<ReserveConfigurationData>;
    getReserveData(asset: string): Promise<ReserveData>;
    getInterestRateStrategyAddress(asset: string): Promise<string>;
  };

  const [configData, reserveData, strategyAddress] = await Promise.all([
    dataProvider.getReserveConfigurationData(reserveAddress),
    dataProvider.getReserveData(reserveAddress),
    dataProvider.getInterestRateStrategyAddress(reserveAddress),
  ]);

  const strategy = new Contract(
    strategyAddress,
    DEFAULT_INTEREST_RATE_STRATEGY_V2_ABI,
    provider,
  ) as Contract & {
    getInterestRateData(asset: string): Promise<InterestRateData>;
  };
  const interestRateData = await strategy.getInterestRateData(reserveAddress);

  const decimals = Number(configData.decimals);
  const totalDebtRaw = reserveData.totalStableDebt + reserveData.totalVariableDebt;
  const availableLiquidityRaw =
    reserveData.totalAToken - totalDebtRaw - reserveData.unbacked > 0n
      ? reserveData.totalAToken - totalDebtRaw - reserveData.unbacked
      : 0n;
  const totalDebt = parseBalance(totalDebtRaw.toString(), decimals);
  const availableLiquidity = parseBalance(availableLiquidityRaw.toString(), decimals);
  const utilizationRate =
    totalDebt + availableLiquidity > 0 ? totalDebt / (totalDebt + availableLiquidity) : 0;

  return {
    marketName,
    assetAddress: reserveAddress,
    symbol: '',
    availableLiquidity,
    totalDebt,
    utilizationRate,
    variableBorrowRate: fromRay(reserveData.variableBorrowRate.toString()),
    baseVariableBorrowRate: fromRay(interestRateData.baseVariableBorrowRate.toString()),
    variableRateSlope1: fromRay(interestRateData.variableRateSlope1.toString()),
    variableRateSlope2: fromRay(interestRateData.variableRateSlope2.toString()),
    optimalUsageRatio: fromRay(interestRateData.optimalUsageRatio.toString()),
    lastUpdateTimestamp: new Date(Number(reserveData.lastUpdateTimestamp) * 1000).toISOString(),
  };
}
