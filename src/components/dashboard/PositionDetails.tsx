import { AlertTriangle, Info, ShieldCheck } from 'lucide-react';
import { clamp, healthLabel, type Computed, type LoanPosition } from '@aave-monitor/core';
import {
  BorrowRateHistoryCard,
  InterestAccrualHistoryCard,
  MorphoIrmCard,
  type BorrowRateSample,
  UtilizationCurveCard,
} from '../ReserveCharts';
import type { InterestSnapshot } from '../../api/aaveMonitor';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Separator } from '../ui/separator';
import { fmtAmount, fmtPct, fmtUSD, toBadgeVariant } from '../../lib/formatters';
import { type ReserveTelemetry } from '@aave-monitor/core';

export function SelectedLoanLabel({ loan }: { loan: LoanPosition | null }) {
  if (!loan) return null;

  return (
    <p className="mt-4 text-sm text-muted-foreground">
      Showing details for{' '}
      <span className="font-semibold text-foreground">
        {loan.marketName} · {loan.borrowed.map((borrowed) => borrowed.symbol).join(' + ')}
      </span>
    </p>
  );
}

export function PositionDetailsSection({
  borrowRateHistory,
  loanInterestHistory,
  computed,
  now,
  reserveTelemetry,
  reserveTelemetryError,
  selectedLoan,
}: {
  borrowRateHistory: BorrowRateSample[];
  loanInterestHistory: InterestSnapshot[];
  computed: Computed;
  now: number;
  reserveTelemetry: ReserveTelemetry | null;
  reserveTelemetryError: string;
  selectedLoan: LoanPosition | null;
}) {
  const isMorphoLoan = selectedLoan?.marketName.startsWith('morpho_') ?? false;
  return (
    <section className="mt-2 grid gap-4 [grid-template-columns:minmax(320px,0.95fr)_minmax(0,2fr)] max-[980px]:grid-cols-1">
      <PositionSnapshotCard computed={computed} selectedLoan={selectedLoan} />

      <div className="grid gap-4">
        <StatusCard computed={computed} />

        {reserveTelemetry ? (
          <UtilizationCurveCard reserve={reserveTelemetry} />
        ) : selectedLoan?.marketName.startsWith('morpho_') ? (
          <MorphoIrmCard
            borrowRate={
              selectedLoan.borrowed.reduce((max, b) => (b.usdValue > max.usdValue ? b : max))
                .borrowRate
            }
            utilizationRate={selectedLoan.utilizationRate ?? 0}
            lltv={selectedLoan.supplied[0]?.liqThreshold ?? 0}
            supplyApy={selectedLoan.marketSupplyApy}
          />
        ) : reserveTelemetryError ? (
          <Card>
            <CardHeader>
              <CardTitle>Interest Rate Model</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{reserveTelemetryError}</p>
            </CardContent>
          </Card>
        ) : null}

        <BorrowRateHistoryCard
          currentTimeMs={now}
          samples={borrowRateHistory}
          reserve={reserveTelemetry}
        />

        {isMorphoLoan ? (
          <InterestAccrualHistoryCard
            kind="loan"
            snapshots={loanInterestHistory}
            currentTimeMs={now}
          />
        ) : null}

        <MetricsGrid computed={computed} selectedLoan={selectedLoan} />
        <MonitoringChecklistCard computed={computed} />
        <SensitivityCard computed={computed} />
      </div>
    </section>
  );
}

function PositionSnapshotCard({
  computed,
  selectedLoan,
}: {
  computed: Computed;
  selectedLoan: LoanPosition | null;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2">
          Position Snapshot <Info size={16} className="text-muted-foreground" />
        </CardTitle>
      </CardHeader>
      <CardContent>
        <AssetList
          assets={selectedLoan?.borrowed ?? []}
          emptyLabel="No borrowed assets"
          label="Borrowed assets"
        />
        <StaticField label="Market" value={selectedLoan?.marketName ?? '—'} />
        <StaticField label="Debt (USD)" value={fmtUSD(computed.debt, 0)} />
        <Separator />

        <AssetList
          assets={selectedLoan?.supplied ?? []}
          emptyLabel="No supplied collateral assets"
          label="Supplied collateral assets"
        />

        <StaticField label="Collateral value (USD)" value={fmtUSD(computed.collateralUSD, 0)} />
        <Separator />

        <TwoColumn>
          <StaticField label="Max LTV (weighted)" value={fmtPct(computed.ltvMax)} />
          <StaticField label="Liquidation threshold (weighted)" value={fmtPct(computed.lt)} />
        </TwoColumn>

        <Separator />

        <TwoColumn>
          <StaticField label="Supply APY (weighted)" value={fmtPct(computed.rSupply)} />
          <StaticField label="Borrow APY" value={fmtPct(computed.rBorrow)} />
        </TwoColumn>
      </CardContent>
    </Card>
  );
}

function AssetList({
  assets,
  emptyLabel,
  label,
}: {
  assets: LoanPosition['borrowed'];
  emptyLabel: string;
  label: string;
}) {
  return (
    <div className="grid min-w-0 gap-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <ul className="grid list-none gap-1.5">
        {assets.length === 0 ? (
          <li className="rounded-lg border border-border bg-accent px-3 py-2 text-muted-foreground">
            {emptyLabel}
          </li>
        ) : (
          assets.map((asset) => (
            <li
              key={`${asset.address}-${asset.symbol}`}
              className="flex justify-between gap-2.5 rounded-lg border border-border bg-accent px-3 py-2 max-[980px]:flex-col max-[980px]:items-start"
            >
              <span className="font-medium">{asset.symbol}</span>
              <span className="text-muted-foreground">
                {fmtAmount(asset.amount)} | {fmtUSD(asset.usdValue, 0)}
              </span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function StatusCard({ computed }: { computed: Computed }) {
  const status = healthLabel(computed.healthFactor);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-2">
          Status
          <Badge variant={toBadgeVariant(status.tone)}>{status.label}</Badge>
          {computed.healthFactor < 1.5 ? (
            <AlertTriangle size={16} className="text-destructive" />
          ) : (
            <ShieldCheck size={16} className="text-positive" />
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid-cols-3 max-[980px]:grid-cols-1">
        <KpiCard
          title="Health Factor (HF)"
          value={Number.isFinite(computed.healthFactor) ? computed.healthFactor.toFixed(2) : '∞'}
          caption="Liquidation when HF < 1.0"
        />
        <KpiCard
          title="Adjusted HF"
          value={Number.isFinite(computed.adjustedHF) ? computed.adjustedHF.toFixed(2) : '∞'}
          caption="Excludes same-asset collateral (watchdog view)"
        />
        <LiquidationKpi computed={computed} />
        <KpiCard title="Equity" value={fmtUSD(computed.equity, 0)} caption="Collateral - Debt" />
      </CardContent>
    </Card>
  );
}

function LiquidationKpi({ computed }: { computed: Computed }) {
  const singleLiq = computed.assetLiquidations[0];
  if (computed.assetLiquidations.length <= 1) {
    return (
      <KpiCard
        title={`Liquidation Price (${computed.primaryCollateralSymbol})`}
        value={
          singleLiq && Number.isFinite(singleLiq.liqPrice) ? fmtUSD(singleLiq.liqPrice, 2) : '—'
        }
        caption={
          singleLiq ? `Price drop to liq: ${fmtPct(clamp(singleLiq.priceDropToLiq, 0, 1), 1)}` : ''
        }
      />
    );
  }

  return (
    <div className="rounded-lg border border-border bg-accent p-3">
      <span className="mb-1.5 block text-xs text-muted-foreground">Liquidation Prices</span>
      <ul className="grid list-none gap-1">
        {computed.assetLiquidations.map((liquidation) => (
          <li key={liquidation.symbol} className="flex items-center justify-between gap-2 text-sm">
            <span className="text-muted-foreground">{liquidation.symbol}</span>
            <span className="text-right">
              {Number.isFinite(liquidation.liqPrice)
                ? `${fmtUSD(liquidation.liqPrice, 2)} (-${fmtPct(clamp(liquidation.priceDropToLiq, 0, 1), 1)})`
                : 'N/A'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MetricsGrid({
  computed,
  selectedLoan,
}: {
  computed: Computed;
  selectedLoan: LoanPosition | null;
}) {
  return (
    <div className="grid grid-cols-2 gap-4 max-[980px]:grid-cols-1">
      <Card>
        <CardHeader>
          <CardTitle>Main Metrics</CardTitle>
        </CardHeader>
        <CardContent>
          <Row label="Collateral value" value={fmtUSD(computed.collateralUSD, 0)} />
          <Row label="Debt" value={fmtUSD(computed.debt, 0)} />
          <Row label="LTV" value={fmtPct(computed.ltv)} />
          <Row
            label="Leverage (C/E)"
            value={Number.isFinite(computed.leverage) ? `${computed.leverage.toFixed(2)}x` : '∞'}
          />
          <Row label="Borrow power used" value={fmtPct(computed.borrowPowerUsed)} />
          <Row label="Borrow headroom" value={fmtUSD(computed.borrowHeadroom, 0)} />
          <Row
            label="Liq. price"
            value={Number.isFinite(computed.liqPrice) ? fmtUSD(computed.liqPrice, 2) : '—'}
          />
          <Row
            label="Utilization"
            value={
              selectedLoan?.utilizationRate == null ? '—' : fmtPct(selectedLoan.utilizationRate)
            }
          />
          <Separator />
          <Row label="Liquidation threshold" value={fmtPct(computed.lt)} />
          <Row label="LTV at liquidation" value={fmtPct(computed.ltvAtLiq)} />
          <Row label="Collateral buffer" value={fmtUSD(computed.collateralBufferUSD, 0)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Carry / Net APY</CardTitle>
        </CardHeader>
        <CardContent>
          <Row label="Supply APY" value={fmtPct(computed.rSupply)} />
          <Row label="Borrow APY" value={fmtPct(computed.rBorrow)} />
          <Separator />
          <Row label="Supply earnings (annual)" value={fmtUSD(computed.supplyEarnUSD, 0)} />
          <Row label="Borrow cost (annual)" value={fmtUSD(computed.borrowCostUSD, 0)} />
          <Separator />
          <Row label="Net earnings (annual)" value={fmtUSD(computed.netEarnUSD, 0)} />
          <Row label="Net APY (on equity)" value={fmtPct(computed.netAPYOnEquity)} />
          <p className="text-xs text-muted-foreground">
            Net APY is ROE: (supply - borrow) / equity.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function MonitoringChecklistCard({ computed }: { computed: Computed }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Monitoring Checklist</CardTitle>
      </CardHeader>
      <CardContent className="grid-cols-3 max-[980px]:grid-cols-1">
        <ChecklistItem
          title="Health Factor"
          ok={!computed.alertHF}
          detail="Keep HF comfortably above 1.0; many traders target 1.7-2.5+."
        />
        <ChecklistItem
          title="LTV vs LT"
          ok={!computed.alertLTV}
          detail="As LTV approaches liquidation threshold, small price moves can liquidate you."
        />
        <ChecklistItem
          title="Rates drift"
          ok
          detail="Borrow/supply APYs are variable; net carry can flip quickly during volatility."
        />
        <ChecklistItem
          title="Stablecoin depeg"
          ok
          detail="USDC/USDT are usually close to $1, but depegs can distort debt value."
        />
        <ChecklistItem
          title="Oracle / market"
          ok
          detail="Liquidations depend on oracle price; liquidity + slippage matters in crashes."
        />
        <ChecklistItem
          title="Automation"
          ok
          detail="Consider alerts (HF, price, LTV) and an emergency delever playbook."
        />
      </CardContent>
    </Card>
  );
}

function SensitivityCard({ computed }: { computed: Computed }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sensitivity</CardTitle>
      </CardHeader>
      <CardContent className="grid-cols-3 max-[980px]:grid-cols-1">
        <KpiCard
          title="Equity move for +/-10% price"
          value={Number.isFinite(computed.leverage) ? fmtPct(computed.equityMoveFor10Pct, 1) : '—'}
          caption="Approx = leverage x 10%"
        />
        <KpiCard
          title="Max borrow (by LTV)"
          value={fmtUSD(computed.maxBorrowByLTV, 0)}
          caption="Based on weighted collateral LTV"
        />
        <KpiCard
          title="Collateral needed at HF=1"
          value={fmtUSD(computed.collateralUSDAtLiq, 0)}
          caption="= Debt / liquidation threshold"
        />
      </CardContent>
    </Card>
  );
}

function TwoColumn({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

function StaticField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="grid min-w-0 gap-1 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <p className="font-semibold">{value}</p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </div>
  );
}

function ChecklistItem({ title, detail, ok }: { title: string; detail: string; ok: boolean }) {
  return (
    <article className="rounded-lg border border-border bg-accent p-3">
      <div className="flex items-center justify-between gap-2.5">
        <h3 className="text-sm font-medium">{title}</h3>
        <Badge variant={ok ? 'positive' : 'destructive'}>{ok ? 'OK' : 'Watch'}</Badge>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </article>
  );
}

function KpiCard({
  title,
  value,
  caption,
  valueClassName,
}: {
  title: string;
  value: string;
  caption: string;
  valueClassName?: string;
}) {
  return (
    <article className="rounded-lg border border-border bg-accent p-3">
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className={`my-1 text-2xl font-semibold tracking-tight ${valueClassName ?? ''}`}>
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{caption}</p>
    </article>
  );
}
