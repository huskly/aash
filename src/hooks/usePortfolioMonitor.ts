import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildLoanPositions,
  ETHEREUM_ADDRESS_REGEX,
  fetchFromAaveSubgraph,
  fetchMidnightLoans,
  fetchMorphoPositions,
  fetchUsdPrices,
  type FetchState,
  type LoanPosition,
  type MorphoVaultPosition,
} from '@aave-monitor/core';
import {
  fetchBorrowRateHistory,
  fetchInterestHistory,
  fetchPortfolioHistory,
  fetchWalletAssetBalances,
  type InterestSnapshot,
  type PortfolioSnapshot,
} from '../api/aaveMonitor';
import type { BorrowRateSample } from '../components/ReserveCharts';
import { buildBorrowRateHistoryKey, readBorrowRateHistory } from '../lib/borrowRateHistory';
import { combineBorrowInterestHistories } from '../lib/portfolioInterestHistory';
import { combineBorrowRateHistories } from '../lib/portfolioBorrowRateHistory';

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

type UsePortfolioMonitorResult = {
  wallet: string;
  setWallet: React.Dispatch<React.SetStateAction<string>>;
  isLoading: boolean;
  error: string;
  result: FetchState | null;
  walletBorrowedAssetBalances: Map<string, number>;
  portfolioHistory: PortfolioSnapshot[];
  portfolioBorrowRateHistory: BorrowRateSample[];
  portfolioBorrowInterestHistory: InterestSnapshot[];
  now: number;
  selectedLoanId: string;
  selectedVaultAddress: string;
  selectedLoan: LoanPosition | null;
  selectedVault: MorphoVaultPosition | null;
  submitWalletInput: () => Promise<void>;
  refreshCurrentWallet: () => Promise<void>;
  selectLoan: (loanId: string) => void;
  selectVault: (vaultAddress: string) => void;
};

export function usePortfolioMonitor(): UsePortfolioMonitorResult {
  const [wallet, setWallet] = useState(() => getInitialWallet());
  const [selectedLoanId, setSelectedLoanId] = useState('');
  const [selectedVaultAddress, setSelectedVaultAddress] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<FetchState | null>(null);
  const [walletBorrowedAssetBalances, setWalletBorrowedAssetBalances] = useState<
    Map<string, number>
  >(new Map());
  const [portfolioHistory, setPortfolioHistory] = useState<PortfolioSnapshot[]>([]);
  const [portfolioBorrowRateHistory, setPortfolioBorrowRateHistory] = useState<BorrowRateSample[]>(
    [],
  );
  const [portfolioBorrowInterestHistory, setPortfolioBorrowInterestHistory] = useState<
    InterestSnapshot[]
  >([]);
  const [now, setNow] = useState(() => Date.now());
  const hasAutoFetchedInitialWallet = useRef(false);

  const selectedLoan = useMemo(() => {
    if (!result || result.loans.length === 0) return null;
    if (selectedVaultAddress) return null;
    return result.loans.find((loan) => loan.id === selectedLoanId) ?? result.loans[0] ?? null;
  }, [result, selectedLoanId, selectedVaultAddress]);

  const selectedVault = useMemo(() => {
    if (!result || !selectedVaultAddress) return null;
    return result.vaults.find((vault) => vault.vaultAddress === selectedVaultAddress) ?? null;
  }, [result, selectedVaultAddress]);

  const loadWallet = useCallback(async (normalizedWallet: string) => {
    setError('');
    setIsLoading(true);

    try {
      const [reserves, morpho, midnightLoans] = await Promise.all([
        fetchFromAaveSubgraph(normalizedWallet, GRAPH_API_KEY),
        fetchMorphoPositions(normalizedWallet).catch(() => ({
          marketLoans: [],
          vaultPositions: [],
        })),
        fetchMidnightLoans(normalizedWallet).catch(() => []),
      ]);
      const reserveSymbols = Array.from(new Set(reserves.map((entry) => entry.reserve.symbol)));
      const prices = await fetchUsdPrices(reserveSymbols, COINGECKO_API_KEY);
      const loans = [
        ...buildLoanPositions(reserves, prices),
        ...morpho.marketLoans,
        ...midnightLoans,
      ];
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
      setSelectedVaultAddress((previousVaultAddress) => {
        if (
          previousVaultAddress &&
          morpho.vaultPositions.some((vault) => vault.vaultAddress === previousVaultAddress)
        ) {
          return previousVaultAddress;
        }
        if (loans.length > 0) return '';
        return morpho.vaultPositions[0]?.vaultAddress ?? '';
      });
      setSelectedLoanId((previousLoanId) => {
        if (loans.some((loan) => loan.id === previousLoanId)) return previousLoanId;
        return loans[0]?.id ?? '';
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch loan data.';
      setError(message);
      setResult(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const submitWalletInput = useCallback(async () => {
    const normalizedWallet = wallet.trim();
    if (!ETHEREUM_ADDRESS_REGEX.test(normalizedWallet)) {
      setError('Please enter a valid Ethereum wallet address.');
      setResult(null);
      return;
    }

    await loadWallet(normalizedWallet);
  }, [wallet, loadWallet]);

  const refreshCurrentWallet = useCallback(async () => {
    const normalizedWallet = result?.wallet ?? wallet.trim();
    if (!ETHEREUM_ADDRESS_REGEX.test(normalizedWallet)) {
      setError('Please enter a valid Ethereum wallet address.');
      setResult(null);
      return;
    }

    await loadWallet(normalizedWallet);
  }, [result?.wallet, wallet, loadWallet]);

  const selectLoan = useCallback((loanId: string) => {
    setSelectedVaultAddress('');
    setSelectedLoanId(loanId);
  }, []);

  const selectVault = useCallback((vaultAddress: string) => {
    setSelectedLoanId('');
    setSelectedVaultAddress(vaultAddress);
  }, []);

  useEffect(() => {
    if (hasAutoFetchedInitialWallet.current) return;
    const initialWallet = wallet.trim();

    if (!ETHEREUM_ADDRESS_REGEX.test(initialWallet)) return;

    hasAutoFetchedInitialWallet.current = true;
    void loadWallet(initialWallet); // eslint-disable-line react-hooks/set-state-in-effect -- fetch-on-mount
  }, [wallet, loadWallet]);

  useEffect(() => {
    if (!result?.wallet) return;

    const timerId = window.setInterval(() => {
      if (isLoading) return;
      void loadWallet(result.wallet);
    }, UPDATE_RATE_MS);

    return () => {
      window.clearInterval(timerId);
    };
  }, [result?.wallet, isLoading, loadWallet]);

  useEffect(() => {
    const timerId = window.setInterval(() => {
      setNow(Date.now());
    }, 10_000);

    return () => {
      window.clearInterval(timerId);
    };
  }, []);

  useEffect(() => {
    const resolvedWallet = result?.wallet;
    if (!resolvedWallet) {
      setPortfolioHistory([]); // eslint-disable-line react-hooks/set-state-in-effect
      return;
    }
    let cancelled = false;
    void fetchPortfolioHistory(resolvedWallet, undefined, undefined, 'day').then((samples) => {
      if (cancelled) return;
      setPortfolioHistory(samples);
    });
    return () => {
      cancelled = true;
    };
  }, [result?.wallet, result?.lastUpdated]);

  useEffect(() => {
    const resolvedWallet = result?.wallet;
    const loans = result?.loans ?? [];
    if (!resolvedWallet || loans.length === 0) {
      setPortfolioBorrowRateHistory([]); // eslint-disable-line react-hooks/set-state-in-effect
      return;
    }

    let cancelled = false;
    void Promise.all(
      loans.map(async (loan) => {
        const apiSamples = await fetchBorrowRateHistory(resolvedWallet, loan.id).catch(() => []);
        if (apiSamples.length > 0) {
          return { samples: apiSamples, weight: loan.totalBorrowedUsd };
        }

        if (loan.borrowed.length === 0) {
          return { samples: [], weight: loan.totalBorrowedUsd };
        }

        const primaryBorrow = loan.borrowed.reduce((max, borrowed) =>
          borrowed.usdValue > max.usdValue ? borrowed : max,
        );
        const storageKey = buildBorrowRateHistoryKey(loan.marketName, primaryBorrow.address);
        return { samples: readBorrowRateHistory(storageKey), weight: loan.totalBorrowedUsd };
      }),
    ).then((histories) => {
      if (cancelled) return;
      setPortfolioBorrowRateHistory(combineBorrowRateHistories(histories));
    });

    return () => {
      cancelled = true;
    };
  }, [result?.wallet, result?.lastUpdated, result?.loans]);

  useEffect(() => {
    const resolvedWallet = result?.wallet;
    const loans = result?.loans ?? [];
    if (!resolvedWallet || loans.length === 0) {
      setPortfolioBorrowInterestHistory([]); // eslint-disable-line react-hooks/set-state-in-effect
      return;
    }

    let cancelled = false;
    void Promise.all(
      loans.map((loan) => fetchInterestHistory(resolvedWallet, loan.id, 'loan').catch(() => [])),
    ).then((histories) => {
      if (cancelled) return;
      setPortfolioBorrowInterestHistory(combineBorrowInterestHistories(histories));
    });

    return () => {
      cancelled = true;
    };
  }, [result?.wallet, result?.lastUpdated, result?.loans]);

  return {
    wallet,
    setWallet,
    isLoading,
    error,
    result,
    walletBorrowedAssetBalances,
    portfolioHistory,
    portfolioBorrowRateHistory,
    portfolioBorrowInterestHistory,
    now,
    selectedLoanId,
    selectedVaultAddress,
    selectedLoan,
    selectedVault,
    submitWalletInput,
    refreshCurrentWallet,
    selectLoan,
    selectVault,
  };
}
