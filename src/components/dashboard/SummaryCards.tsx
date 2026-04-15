import { healthLabel, type PortfolioSummary } from '@aave-monitor/core';
import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { MetricTooltip } from '../MetricTooltip';
import { cn } from '../../lib/utils';
import { fmtPct, fmtUSD, toBadgeVariant } from '../../lib/formatters';

const TOP_LEVEL_PRIVACY_STORAGE_KEY = 'aave-monitor:hide-top-level-values';

function getInitialHideTopLevelValues(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    return window.localStorage.getItem(TOP_LEVEL_PRIVACY_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function PortfolioSummaryCard({ portfolio }: { portfolio: PortfolioSummary }) {
  const [hideTopLevelValues, setHideTopLevelValues] = useState(getInitialHideTopLevelValues);

  useEffect(() => {
    try {
      window.localStorage.setItem(TOP_LEVEL_PRIVACY_STORAGE_KEY, String(hideTopLevelValues));
    } catch {
      // Ignore storage errors so the dashboard still works when storage is unavailable.
    }
  }, [hideTopLevelValues]);

  return (
    <Card className="mt-4">
      <CardContent className="pt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-4">
          <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
            <div>
              <MetricTooltip description="Total debt is the sum of borrowed USD value across all active loan positions.">
                <p className="text-xs text-muted-foreground">Total Debt</p>
                <p
                  className={cn(
                    'text-4xl font-bold tracking-tight tabular-nums transition-[filter] duration-200',
                    hideTopLevelValues && 'select-none blur-sm',
                  )}
                  aria-label={hideTopLevelValues ? 'Total Debt hidden' : undefined}
                >
                  {fmtUSD(portfolio.totalDebt, 0)}
                </p>
              </MetricTooltip>
            </div>
            <MetricTooltip
              description="Total assets are risk collateral from loan positions plus USD value held in Morpho vault deposits."
              className="text-left"
            >
              <div>
                <p className="text-xs text-muted-foreground">Total Assets</p>
                <p
                  className={cn(
                    'text-xl font-semibold tabular-nums transition-[filter] duration-200',
                    hideTopLevelValues && 'select-none blur-sm',
                  )}
                  aria-label={hideTopLevelValues ? 'Total Assets hidden' : undefined}
                >
                  {fmtUSD(portfolio.totalAssets, 0)}
                </p>
              </div>
            </MetricTooltip>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground"
              onClick={() => setHideTopLevelValues((currentValue) => !currentValue)}
              aria-label={hideTopLevelValues ? 'Show top-level amounts' : 'Hide top-level amounts'}
              aria-pressed={hideTopLevelValues}
              title={hideTopLevelValues ? 'Show top-level amounts' : 'Hide top-level amounts'}
            >
              {hideTopLevelValues ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <MetricTooltip description="HF is the average of finite per-loan health factors, with each loan calculated as risk collateral times liquidation threshold divided by debt.">
              <Badge
                variant={toBadgeVariant(healthLabel(portfolio.averageHealthFactor).tone)}
                className="text-sm"
              >
                HF{' '}
                {Number.isFinite(portfolio.averageHealthFactor)
                  ? portfolio.averageHealthFactor.toFixed(2)
                  : '∞'}
              </Badge>
            </MetricTooltip>
            <MetricTooltip description="Net APY is annual net earnings divided by net worth after adding loan supply income and vault income, then subtracting borrow cost.">
              <Badge
                variant={
                  portfolio.portfolioNetApy >= 0
                    ? 'positive'
                    : portfolio.portfolioNetApy > -0.03
                      ? 'warning'
                      : 'destructive'
                }
                className="text-sm"
              >
                Net APY {fmtPct(portfolio.portfolioNetApy)}
              </Badge>
            </MetricTooltip>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <PortfolioMetric
            description="Risk collateral is the sum of supplied collateral USD value across loan positions only."
            label="Risk collateral"
            value={fmtUSD(portfolio.totalRiskCollateral, 0)}
          />
          <PortfolioMetric
            description="Vault deposits are the sum of Morpho vault position values in USD."
            label="Vault deposits"
            value={fmtUSD(portfolio.totalVaultAssets, 0)}
          />
          <PortfolioMetric
            description="Net worth is loan collateral minus loan debt, plus Morpho vault deposit value."
            label="Net worth"
            value={fmtUSD(portfolio.totalNetWorth, 0)}
          />
          <PortfolioMetric
            description="Net earnings are annual loan supply income plus vault income minus annual borrow cost."
            label="Net earnings"
            value={`${fmtUSD(portfolio.totalNetEarn, 0)}/yr`}
          />
          <PortfolioMetric
            description="Net borrow cost is the gross annual borrow interest cost across loan positions before supply or vault income offsets."
            label="Net borrow cost"
            value={`${fmtUSD(portfolio.totalBorrowCost, 0)}/yr`}
          />
          <PortfolioMetric
            description="Accrued interest is the sum of outstanding loan accrued interest reported by the upstream protocol APIs, where available."
            label="Accrued interest"
            value={fmtUSD(portfolio.totalAccruedBorrowInterest, 2)}
          />
          <PortfolioMetric
            description="Borrow power used is total debt divided by the sum of each loan's collateral value times its weighted max LTV."
            label="Borrow power used"
            value={fmtPct(portfolio.borrowPowerUsed)}
          />
          <PortfolioMetric
            description="Supply APY is annual loan supply income plus vault income divided by total assets."
            label="Supply APY"
            value={fmtPct(portfolio.averageSupplyApy)}
          />
          <PortfolioMetric
            description="Borrow APY is annual borrow cost divided by total debt."
            label="Borrow APY"
            value={fmtPct(portfolio.averageBorrowApy)}
          />
          <PortfolioMetric
            description="Net APY on debt is annual net earnings divided by total debt."
            label="Net APY (debt)"
            value={fmtPct(portfolio.portfolioNetApyOnDebt)}
          />
          <MetricTooltip description="Repay coverage is wallet-held borrowed-asset USD value divided by total debt.">
            Repay coverage{' '}
            <span
              className={cn(
                'font-semibold tabular-nums',
                portfolio.repayCoverage >= 0.1
                  ? 'text-positive'
                  : portfolio.repayCoverage >= 0.05
                    ? 'text-warning'
                    : 'text-destructive',
              )}
            >
              {fmtPct(portfolio.repayCoverage)}
            </span>
          </MetricTooltip>
        </div>
      </CardContent>
    </Card>
  );
}

function PortfolioMetric({
  description,
  label,
  value,
}: {
  description: string;
  label: string;
  value: string;
}) {
  return (
    <MetricTooltip description={description}>
      {label} <span className="font-semibold tabular-nums text-foreground">{value}</span>
    </MetricTooltip>
  );
}
