import {
  healthLabel,
  type Computed,
  type LoanPosition,
  type MorphoVaultPosition,
} from '@aave-monitor/core';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { cn } from '../../lib/utils';
import { fmtAmount, fmtPct, fmtUSD, toBadgeVariant } from '../../lib/formatters';

export type LoanRow = {
  loan: LoanPosition;
  metrics: Computed;
};

export function LoanPositionsTable({
  rows,
  selectedLoanId,
  onSelectLoan,
}: {
  rows: LoanRow[];
  selectedLoanId: string;
  onSelectLoan: (loanId: string) => void;
}) {
  if (rows.length === 0) return null;

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Loan Positions</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Market</th>
                <th className="px-4 py-2.5 font-medium">Collateral</th>
                <th className="px-4 py-2.5 font-medium">Borrowed</th>
                <th className="px-4 py-2.5 font-medium text-right">Debt</th>
                <th className="px-4 py-2.5 font-medium text-right">HF</th>
                <th className="px-4 py-2.5 font-medium text-right">Rate</th>
                <th className="px-4 py-2.5 font-medium text-right">LTV</th>
                <th className="px-4 py-2.5 font-medium text-right">Liq. Price</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ loan, metrics }) => (
                <tr
                  key={loan.id}
                  onClick={() => onSelectLoan(loan.id)}
                  className={cn(
                    'cursor-pointer border-b border-border transition-colors hover:bg-accent/50',
                    loan.id === selectedLoanId && 'bg-accent',
                  )}
                >
                  <td className="px-4 py-3 font-medium">{loan.marketName}</td>
                  <td className="px-4 py-3">{loan.supplied.map((a) => a.symbol).join(', ')}</td>
                  <td className="px-4 py-3">{loan.borrowed.map((a) => a.symbol).join(' + ')}</td>
                  <td className="px-4 py-3 text-right font-semibold tabular-nums">
                    {fmtUSD(metrics.debt, 0)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Badge variant={toBadgeVariant(healthLabel(metrics.healthFactor).tone)}>
                      {Number.isFinite(metrics.healthFactor)
                        ? metrics.healthFactor.toFixed(2)
                        : '∞'}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtPct(metrics.rBorrow)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtPct(metrics.ltv)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {metrics.assetLiquidations.length === 0
                      ? '—'
                      : metrics.assetLiquidations.length === 1
                        ? fmtUSD(metrics.assetLiquidations[0]!.liqPrice, 2)
                        : metrics.assetLiquidations
                            .map((asset) => `${asset.symbol}: ${fmtUSD(asset.liqPrice, 0)}`)
                            .join(' | ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

export function VaultPositionsTable({ vaults }: { vaults: MorphoVaultPosition[] }) {
  if (vaults.length === 0) return null;

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle>Morpho Vault Positions</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Vault</th>
                <th className="px-4 py-2.5 font-medium">Asset</th>
                <th className="px-4 py-2.5 font-medium text-right">Deposited</th>
                <th className="px-4 py-2.5 font-medium text-right">Value</th>
                <th className="px-4 py-2.5 font-medium text-right">Net APY</th>
                <th className="px-4 py-2.5 font-medium text-right">Shares</th>
              </tr>
            </thead>
            <tbody>
              {vaults.map((vault) => (
                <VaultRow key={vault.id} vault={vault} />
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function VaultRow({ vault }: { vault: MorphoVaultPosition }) {
  return (
    <tr className="border-b border-border">
      <td className="px-4 py-3 font-medium">
        <div className="flex flex-col gap-0.5">
          <span>{vault.vaultName}</span>
          <span className="text-xs text-muted-foreground">{vault.vaultSymbol}</span>
        </div>
      </td>
      <td className="px-4 py-3">{vault.asset.symbol}</td>
      <td className="px-4 py-3 text-right tabular-nums">{fmtAmount(vault.totalAssets)}</td>
      <td className="px-4 py-3 text-right font-semibold tabular-nums">
        {fmtUSD(vault.totalAssetsUsd, 0)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">{fmtPct(vault.netApy)}</td>
      <td className="px-4 py-3 text-right tabular-nums">{fmtAmount(vault.shares)}</td>
    </tr>
  );
}
