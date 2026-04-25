import { useCallback, useMemo, useRef, useState, type FormEvent } from 'react';
import { computeLoanMetrics, computePortfolioSummary } from '@aave-monitor/core';
import { BorrowRateHistoryCard, InterestAccrualHistoryCard } from './components/ReserveCharts';
import { ServerSettings } from './components/ServerSettings';
import { ToastProvider, ToastViewport } from './components/ui/toast';
import { type ToastMessage } from './components/ui/toast-context';
import { Card, CardContent } from './components/ui/card';
import { WalletSearchCard } from './components/dashboard/WalletSearchCard';
import { PortfolioSummaryCard } from './components/dashboard/SummaryCards';
import { PortfolioHistoryCard } from './components/PortfolioHistoryCard';
import {
  type LoanRow,
  LoanPositionsTable,
  VaultPositionsTable,
} from './components/dashboard/PositionTables';
import { PositionDetailsSection, SelectedLoanLabel } from './components/dashboard/PositionDetails';
import { usePortfolioMonitor } from './hooks/usePortfolioMonitor';
import { usePositionDetailsData } from './hooks/usePositionDetailsData';

export default function App() {
  const {
    wallet,
    setWallet,
    isLoading,
    error,
    result,
    walletBorrowedAssetBalances,
    portfolioHistory,
    now,
    selectedVaultAddress,
    selectedLoan,
    selectedVault,
    submitWalletInput,
    refreshCurrentWallet,
    selectLoan,
    selectVault,
  } = usePortfolioMonitor();
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const nextToastId = useRef(1);

  const {
    selectedReserveTelemetry,
    reserveTelemetryError,
    borrowRateHistory,
    loanInterestHistory,
    vaultInterestHistories,
    vaultRateHistory,
  } = usePositionDetailsData({
    walletInput: wallet,
    result,
    selectedLoan,
    selectedVault,
  });

  const computed = useMemo(() => computeLoanMetrics(selectedLoan), [selectedLoan]);
  const portfolio = useMemo(() => {
    if (!result) return null;
    return computePortfolioSummary(result.loans, result.vaults, walletBorrowedAssetBalances);
  }, [result, walletBorrowedAssetBalances]);
  const loanRows: LoanRow[] = useMemo(
    () =>
      (result?.loans ?? []).map((loan) => ({
        loan,
        metrics: computeLoanMetrics(loan),
      })),
    [result],
  );
  const vaultRows = useMemo(() => result?.vaults ?? [], [result]);
  const hasAnyPositions = Boolean(result && (result.loans.length > 0 || result.vaults.length > 0));

  const handleFetch = async (event: FormEvent) => {
    event.preventDefault();
    await submitWalletInput();
  };

  const pushToast = useCallback((toast: Omit<ToastMessage, 'id'>) => {
    const toastId = nextToastId.current++;
    const nextToast: ToastMessage = { id: toastId, ...toast };
    window.setTimeout(() => {
      setToasts((current) => current.filter((entry) => entry.id !== nextToast.id));
    }, 3200);
    setToasts((current) => [...current, nextToast]);
  }, []);

  return (
    <ToastProvider value={{ pushToast }}>
      <div className="min-h-screen w-full overflow-x-hidden bg-background px-4 py-6 text-foreground antialiased md:px-6 md:py-8">
        <main className="mx-auto max-w-7xl">
          <header className="flex items-end justify-between gap-4 max-[980px]:flex-col max-[980px]:items-start">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">aash</h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Track Aave and Morpho positions with realtime health metrics and customizable risk
                parameters.
              </p>
            </div>
            <ServerSettings />
          </header>

          <WalletSearchCard
            error={error}
            isLoading={isLoading}
            now={now}
            result={result}
            wallet={wallet}
            onRefresh={refreshCurrentWallet}
            onSubmit={handleFetch}
            onWalletChange={setWallet}
          />

          {result ? (
            <>
              {hasAnyPositions ? (
                <>
                  {portfolio ? <PortfolioSummaryCard portfolio={portfolio} /> : null}

                  <div className="mt-4">
                    <PortfolioHistoryCard samples={portfolioHistory} currentTimeMs={now} />
                  </div>

                  <LoanPositionsTable
                    rows={loanRows}
                    selectedLoanId={selectedLoan?.id ?? ''}
                    onSelectLoan={selectLoan}
                  />
                  <VaultPositionsTable
                    vaults={vaultRows}
                    selectedVaultAddress={selectedVaultAddress}
                    onSelectVault={selectVault}
                  />
                  {selectedVault ? (
                    <>
                      <p className="mt-4 text-sm text-muted-foreground">
                        Showing details for{' '}
                        <span className="font-semibold text-foreground">
                          {selectedVault.vaultName} · {selectedVault.asset.symbol}
                        </span>
                      </p>
                      <section className="mt-2 grid gap-4">
                        <BorrowRateHistoryCard
                          samples={vaultRateHistory}
                          reserve={null}
                          currentTimeMs={now}
                          title="Net APY History"
                          description={`Sampled net APY for ${selectedVault.vaultSymbol} tracked over time.`}
                          rateLabel="Net APY"
                          emptyMessage="Net APY history needs at least two samples. Keep the dashboard running and refreshing to build the chart over time."
                        />
                        <InterestAccrualHistoryCard
                          kind="vault"
                          title={`${selectedVault.vaultName} — Daily Earnings`}
                          description={`Realized earnings for ${selectedVault.vaultSymbol} derived from Morpho cumulative PnL.`}
                          snapshots={vaultInterestHistories[selectedVault.vaultAddress] ?? []}
                          currentTimeMs={now}
                        />
                      </section>
                    </>
                  ) : (
                    <>
                      <SelectedLoanLabel loan={selectedLoan} />
                      <PositionDetailsSection
                        borrowRateHistory={borrowRateHistory}
                        loanInterestHistory={loanInterestHistory}
                        computed={computed}
                        now={now}
                        reserveTelemetry={selectedReserveTelemetry}
                        reserveTelemetryError={reserveTelemetryError}
                        selectedLoan={selectedLoan}
                      />
                    </>
                  )}
                </>
              ) : (
                <Card className="mt-4">
                  <CardContent className="pt-6">
                    <p className="text-muted-foreground">
                      No active Aave, Morpho market, or Morpho vault positions were found for this
                      wallet.
                    </p>
                  </CardContent>
                </Card>
              )}
            </>
          ) : null}

          <footer className="mt-6 text-xs text-muted-foreground">
            <p>
              Simplified monitor. Per-asset liquidation prices are shown for each collateral asset.
            </p>
          </footer>
        </main>
      </div>
      <ToastViewport toasts={toasts} />
    </ToastProvider>
  );
}
