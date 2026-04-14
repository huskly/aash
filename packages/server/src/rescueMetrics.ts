import type { LoanPosition } from '@aave-monitor/core';

export function computeRescueAdjustedHF(
  loan: LoanPosition,
  walletBorrowedAssetBalances: Map<string, number>,
): number {
  if (loan.totalBorrowedUsd <= 0) return Infinity;

  const riskAdjustedCollateralUsd = loan.supplied.reduce(
    (sum, asset) => sum + asset.usdValue * asset.liqThreshold,
    0,
  );
  const repayUsd = loan.borrowed.reduce((sum, asset) => {
    const walletBalance = walletBorrowedAssetBalances.get(asset.address.toLowerCase()) ?? 0;
    const repayAmount = Math.min(Math.max(walletBalance, 0), asset.amount);
    return sum + repayAmount * asset.usdPrice;
  }, 0);
  const remainingDebtUsd = Math.max(loan.totalBorrowedUsd - repayUsd, 0);

  return remainingDebtUsd > 0 ? riskAdjustedCollateralUsd / remainingDebtUsd : Infinity;
}
