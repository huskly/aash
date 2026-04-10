import { useMemo, useState } from 'react';
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

type SortDirection = 'asc' | 'desc';
type LoanSortKey =
  | 'market'
  | 'collateral'
  | 'borrowed'
  | 'debt'
  | 'healthFactor'
  | 'rate'
  | 'ltv'
  | 'liquidationPrice';

type LoanSortConfig = {
  key: LoanSortKey;
  direction: SortDirection;
};

type LoanSortColumn = {
  key: LoanSortKey;
  label: string;
  align?: 'right';
  defaultDirection: SortDirection;
};

const loanSortColumns = [
  { key: 'market', label: 'Market', defaultDirection: 'asc' },
  { key: 'collateral', label: 'Collateral', defaultDirection: 'asc' },
  { key: 'borrowed', label: 'Borrowed', defaultDirection: 'asc' },
  { key: 'debt', label: 'Debt', align: 'right', defaultDirection: 'desc' },
  { key: 'healthFactor', label: 'HF', align: 'right', defaultDirection: 'asc' },
  { key: 'rate', label: 'Rate', align: 'right', defaultDirection: 'desc' },
  { key: 'ltv', label: 'LTV', align: 'right', defaultDirection: 'desc' },
  { key: 'liquidationPrice', label: 'Liq. Price', align: 'right', defaultDirection: 'asc' },
] satisfies LoanSortColumn[];

function getLoanSortValue(row: LoanRow, key: LoanSortKey): string | number {
  const { loan, metrics } = row;

  switch (key) {
    case 'market':
      return loan.marketName;
    case 'collateral':
      return loan.supplied.map((asset) => asset.symbol).join(', ');
    case 'borrowed':
      return loan.borrowed.map((asset) => asset.symbol).join(' + ');
    case 'debt':
      return metrics.debt;
    case 'healthFactor':
      return metrics.healthFactor;
    case 'rate':
      return metrics.rBorrow;
    case 'ltv':
      return metrics.ltv;
    case 'liquidationPrice':
      return metrics.liqPrice;
  }
}

function compareLoanSortValues(a: string | number, b: string | number, direction: SortDirection) {
  if (typeof a === 'string' && typeof b === 'string') {
    return direction === 'asc' ? a.localeCompare(b) : b.localeCompare(a);
  }

  const aNumber = typeof a === 'number' ? a : Number.NaN;
  const bNumber = typeof b === 'number' ? b : Number.NaN;
  const aFinite = Number.isFinite(aNumber);
  const bFinite = Number.isFinite(bNumber);

  if (!aFinite && !bFinite) return 0;
  if (!aFinite) return 1;
  if (!bFinite) return -1;

  return direction === 'asc' ? aNumber - bNumber : bNumber - aNumber;
}

export function LoanPositionsTable({
  rows,
  selectedLoanId,
  onSelectLoan,
}: {
  rows: LoanRow[];
  selectedLoanId: string;
  onSelectLoan: (loanId: string) => void;
}) {
  const [sortConfig, setSortConfig] = useState<LoanSortConfig>({
    key: 'debt',
    direction: 'desc',
  });
  const sortedRows = useMemo(
    () =>
      rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => {
          const result = compareLoanSortValues(
            getLoanSortValue(a.row, sortConfig.key),
            getLoanSortValue(b.row, sortConfig.key),
            sortConfig.direction,
          );

          return result === 0 ? a.index - b.index : result;
        })
        .map(({ row }) => row),
    [rows, sortConfig],
  );

  function handleSort(column: LoanSortColumn) {
    setSortConfig((current) => {
      if (current.key !== column.key) {
        return { key: column.key, direction: column.defaultDirection };
      }

      return {
        key: column.key,
        direction: current.direction === 'asc' ? 'desc' : 'asc',
      };
    });
  }

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
                {loanSortColumns.map((column) => {
                  const active = sortConfig.key === column.key;
                  const nextDirection =
                    active && sortConfig.direction === 'asc'
                      ? 'descending'
                      : column.defaultDirection === 'asc'
                        ? 'ascending'
                        : 'descending';

                  return (
                    <th
                      key={column.key}
                      className={cn(
                        'px-4 py-2.5 font-medium',
                        column.align === 'right' && 'text-right',
                      )}
                      aria-sort={
                        active
                          ? sortConfig.direction === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      <button
                        type="button"
                        onClick={() => handleSort(column)}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-sm transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          column.align === 'right' && 'justify-end',
                        )}
                        title={`Sort by ${column.label} ${nextDirection}`}
                      >
                        <span>{column.label}</span>
                        {active && (
                          <span aria-hidden="true" className="text-[10px] leading-none">
                            {sortConfig.direction === 'asc' ? '^' : 'v'}
                          </span>
                        )}
                      </button>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sortedRows.map(({ loan, metrics }) => (
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
