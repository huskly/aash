import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  buildLoanPositions,
  computeLoanMetrics,
  computePortfolioSummary,
  ETHEREUM_ADDRESS_REGEX,
  fetchFromAaveSubgraph,
  fetchMorphoPositions,
  fetchUsdPrices,
  type FetchState,
  type ReserveTelemetry,
} from '@aave-monitor/core';
import {
  fetchBorrowRateHistory,
  fetchReserveTelemetry,
  fetchWalletAssetBalances,
} from './api/aaveMonitor';
import { readBorrowRateHistory, buildBorrowRateHistoryKey } from './lib/borrowRateHistory';
import { type BorrowRateSample } from './components/ReserveCharts';
import { ServerSettings } from './components/ServerSettings';
import { ToastProvider, ToastViewport } from './components/ui/toast';
import { type ToastMessage } from './components/ui/toast-context';
import { Card, CardContent } from './components/ui/card';
import { WalletSearchCard } from './components/dashboard/WalletSearchCard';
import { PortfolioSummaryCard } from './components/dashboard/SummaryCards';
import {
  type LoanRow,
  LoanPositionsTable,
  VaultPositionsTable,
} from './components/dashboard/PositionTables';
import { PositionDetailsSection, SelectedLoanLabel } from './components/dashboard/PositionDetails';

const GRAPH_API_KEY = import.meta.env.VITE_THE_GRAPH_API_KEY as string | undefined;
const COINGECKO_API_KEY = import.meta.env.VITE_COINGECKO_API_KEY as string | undefined;
const UPDATE_RATE_MS = 120_000;
const LAST_WALLET_STORAGE_KEY = 'aave-monitor:last-wallet';

function getWalletFromQueryString(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('wallet') ?? params.get('address') ?? params.get('walletAddress') ?? '';
}

function getInitialWallet(): string {
  const walletFromQuery = getWalletFromQueryString().trim();
  if (walletFromQuery) return walletFromQuery;

  try {
    return window.localStorage.getItem(LAST_WALLET_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export default function App() {
  const [wallet, setWallet] = useState(() => getInitialWallet());
  const [selectedLoanId, setSelectedLoanId] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>('');
  const [result, setResult] = useState<FetchState | null>(null);
  const [walletBorrowedAssetBalances, setWalletBorrowedAssetBalances] = useState<
    Map<string, number>
  >(new Map());
  const [selectedReserveTelemetry, setSelectedReserveTelemetry] = useState<ReserveTelemetry | null>(
    null,
  );
  const [reserveTelemetryError, setReserveTelemetryError] = useState('');
  const [borrowRateHistory, setBorrowRateHistory] = useState<BorrowRateSample[]>([]);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const hasAutoFetchedInitialWallet = useRef(false);
  const nextToastId = useRef(1);

  const selectedLoan = useMemo(() => {
    if (!result || result.loans.length === 0) return null;
    return result.loans.find((loan) => loan.id === selectedLoanId) ?? result.loans[0] ?? null;
  }, [result, selectedLoanId]);

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

  const fetchLoans = useCallback(async (normalizedWallet: string) => {
    setError('');
    setIsLoading(true);

    try {
      const [reserves, morpho] = await Promise.all([
        fetchFromAaveSubgraph(normalizedWallet, GRAPH_API_KEY),
        fetchMorphoPositions(normalizedWallet).catch(() => ({
          marketLoans: [],
          vaultPositions: [],
        })),
      ]);
      const reserveSymbols = Array.from(new Set(reserves.map((entry) => entry.reserve.symbol)));
      const prices = await fetchUsdPrices(reserveSymbols, COINGECKO_API_KEY);
      const loans = [...buildLoanPositions(reserves, prices), ...morpho.marketLoans];
      const borrowedAssets = Array.from(
        new Map(
          loans
            .flatMap((loan) => loan.borrowed)
            .map((asset) => [asset.address.toLowerCase(), asset]),
        ).values(),
      );
      const borrowedAssetBalances = await fetchWalletAssetBalances(
        normalizedWallet,
        borrowedAssets,
      ).catch(() => new Map<string, number>());
      const updatedAt = Date.now();

      setWalletBorrowedAssetBalances(borrowedAssetBalances);
      setNow(updatedAt);
      setResult({
        wallet: normalizedWallet,
        loans,
        vaults: morpho.vaultPositions,
        lastUpdated: new Date(updatedAt).toISOString(),
      });
      try {
        window.localStorage.setItem(LAST_WALLET_STORAGE_KEY, normalizedWallet);
      } catch {
        // Ignore storage errors (e.g. storage disabled).
      }
      setSelectedLoanId((previousLoanId) =>
        loans.some((loan) => loan.id === previousLoanId) ? previousLoanId : (loans[0]?.id ?? ''),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch loan data.';
      setError(message);
      setResult(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hasAutoFetchedInitialWallet.current) return;
    const initialWallet = wallet.trim();

    if (!ETHEREUM_ADDRESS_REGEX.test(initialWallet)) return;

    hasAutoFetchedInitialWallet.current = true;
    void fetchLoans(initialWallet); // eslint-disable-line react-hooks/set-state-in-effect -- fetch-on-mount
  }, [wallet, fetchLoans]);

  useEffect(() => {
    if (!result?.wallet) return;

    const timerId = window.setInterval(() => {
      if (isLoading) return;
      void fetchLoans(result.wallet);
    }, UPDATE_RATE_MS);

    return () => {
      window.clearInterval(timerId);
    };
  }, [result?.wallet, isLoading, fetchLoans]);

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setNow(Date.now());
    }, 10_000);

    return () => {
      window.clearInterval(timerId);
    };
  }, []);

  useEffect(() => {
    if (!selectedLoan || selectedLoan.borrowed.length === 0) {
      setSelectedReserveTelemetry(null); // eslint-disable-line react-hooks/set-state-in-effect -- resetting state on dependency change
      setReserveTelemetryError('');
      setBorrowRateHistory([]);
      return;
    }

    const primaryBorrow = selectedLoan.borrowed.reduce((max, borrowed) =>
      borrowed.usdValue > max.usdValue ? borrowed : max,
    );

    let cancelled = false;
    setSelectedReserveTelemetry(null);
    setReserveTelemetryError('');

    // Fetch rate history from backend, fall back to localStorage if unavailable.
    // Use the resolved wallet from the loaded result, not the editable input field.
    const resolvedWallet = result?.wallet ?? wallet.trim();
    void fetchBorrowRateHistory(resolvedWallet, selectedLoan.id).then((apiSamples) => {
      if (cancelled) return;
      if (apiSamples.length > 0) {
        setBorrowRateHistory(apiSamples);
      } else {
        const storageKey = buildBorrowRateHistoryKey(
          selectedLoan.marketName,
          primaryBorrow.address,
        );
        setBorrowRateHistory(readBorrowRateHistory(storageKey));
      }
    });

    if (selectedLoan.marketName.startsWith('morpho_')) {
      return;
    }

    void fetchReserveTelemetry(selectedLoan.marketName, primaryBorrow.address, primaryBorrow.symbol)
      .then((telemetry) => {
        if (cancelled) return;
        setSelectedReserveTelemetry(telemetry);
      })
      .catch((telemetryError: unknown) => {
        if (cancelled) return;
        setSelectedReserveTelemetry(null);
        setReserveTelemetryError(
          telemetryError instanceof Error
            ? telemetryError.message
            : 'Failed to fetch reserve telemetry.',
        );
      });

    return () => {
      cancelled = true;
    };
  }, [result?.lastUpdated, result?.wallet, selectedLoan?.marketName, selectedLoan, wallet]);

  const handleFetch = async (event: FormEvent) => {
    event.preventDefault();

    const normalizedWallet = wallet.trim();
    if (!ETHEREUM_ADDRESS_REGEX.test(normalizedWallet)) {
      setError('Please enter a valid Ethereum wallet address.');
      setResult(null);
      return;
    }

    await fetchLoans(normalizedWallet);
  };

  const handleRefresh = async () => {
    const normalizedWallet = result?.wallet ?? wallet.trim();
    if (!ETHEREUM_ADDRESS_REGEX.test(normalizedWallet)) {
      setError('Please enter a valid Ethereum wallet address.');
      setResult(null);
      return;
    }

    await fetchLoans(normalizedWallet);
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
            onRefresh={handleRefresh}
            onSubmit={handleFetch}
            onWalletChange={setWallet}
          />

          {result ? (
            <>
              {hasAnyPositions ? (
                <>
                  {portfolio ? <PortfolioSummaryCard portfolio={portfolio} /> : null}

                  <LoanPositionsTable
                    rows={loanRows}
                    selectedLoanId={selectedLoanId}
                    onSelectLoan={setSelectedLoanId}
                  />
                  <VaultPositionsTable vaults={vaultRows} />
                  <SelectedLoanLabel loan={selectedLoan} />
                  <PositionDetailsSection
                    borrowRateHistory={borrowRateHistory}
                    computed={computed}
                    now={now}
                    reserveTelemetry={selectedReserveTelemetry}
                    reserveTelemetryError={reserveTelemetryError}
                    selectedLoan={selectedLoan}
                  />
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
