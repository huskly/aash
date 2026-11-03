export type {
  AaveMarket,
  AssetLiquidation,
  AssetPosition,
  BadgeTone,
  Computed,
  FetchState,
  InterestRateCurvePoint,
  LoanPosition,
  MorphoMarketParams,
  MorphoVaultPosition,
  PortfolioSummary,
  PollingConfig,
  RawUserReserve,
  RawUserReserveWithMarket,
  ReserveTelemetry,
  BorrowRateConfig,
  WatchdogConfig,
} from './types.js';

export {
  AAVE_MARKETS,
  COINGECKO_IDS_BY_SYMBOL,
  BORROW_RATE_ALERT_THRESHOLD,
  DEFAULT_BORROW_RATE_CONFIG,
  DEFAULT_POLLING_CONFIG,
  DEFAULT_WATCHDOG_CONFIG,
  ETHEREUM_ADDRESS_REGEX,
  STABLECOIN_CONTRACTS,
  STABLECOIN_SYMBOLS,
  USER_RESERVES_QUERY,
} from './constants.js';

export {
  fetchStablecoinBalances,
  fetchTokenBalances,
  type TokenBalanceTarget,
} from './balances.js';

export {
  clamp,
  computeLoanMetrics,
  computePortfolioSummary,
  fromBps,
  fromRay,
  healthLabel,
  n,
  parseBalance,
  portfolioHealthFactorBand,
  weightedAverage,
} from './metrics.js';

export {
  buildVariableBorrowCurve,
  computeVariableBorrowRateAtUtilization,
} from './interestRate.js';

export { buildLoanPositions, fetchFromAaveSubgraph } from './aave.js';

export {
  fetchFromMorphoApi,
  fetchMidnightLoans,
  fetchMorphoPositions,
  isMidnightLoan,
  midnightAccruedInterest,
  buildMidnightLoans,
  type RawMidnightMarket,
  type RawMidnightPosition,
  type RawMorphoMarketPosition,
  type RawMorphoVaultPosition,
} from './morpho.js';

export { fetchUsdPrices } from './prices.js';

export {
  classifyZone,
  DEFAULT_ZONES,
  isImproving,
  isWorsening,
  type Zone,
  type ZoneName,
} from './zones.js';
