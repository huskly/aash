import { useEffect, useState } from 'react';
import type {
  FetchState,
  LoanPosition,
  MorphoVaultPosition,
  ReserveTelemetry,
} from '@aave-monitor/core';
import {
  fetchBorrowRateHistory,
  fetchInterestHistory,
  fetchReserveTelemetry,
  type InterestSnapshot,
} from '../api/aaveMonitor';
import { buildBorrowRateHistoryKey, readBorrowRateHistory } from '../lib/borrowRateHistory';
import type { BorrowRateSample } from '../components/ReserveCharts';

type UsePositionDetailsDataArgs = {
  walletInput: string;
  result: FetchState | null;
  selectedLoan: LoanPosition | null;
  selectedVault: MorphoVaultPosition | null;
};

type UsePositionDetailsDataResult = {
  selectedReserveTelemetry: ReserveTelemetry | null;
  reserveTelemetryError: string;
  borrowRateHistory: BorrowRateSample[];
  loanInterestHistory: InterestSnapshot[];
  vaultInterestHistories: Record<string, InterestSnapshot[]>;
  vaultRateHistory: BorrowRateSample[];
};

export function usePositionDetailsData({
  walletInput,
  result,
  selectedLoan,
  selectedVault,
}: UsePositionDetailsDataArgs): UsePositionDetailsDataResult {
  const [selectedReserveTelemetry, setSelectedReserveTelemetry] = useState<ReserveTelemetry | null>(
    null,
  );
  const [reserveTelemetryError, setReserveTelemetryError] = useState('');
  const [borrowRateHistory, setBorrowRateHistory] = useState<BorrowRateSample[]>([]);
  const [loanInterestHistory, setLoanInterestHistory] = useState<InterestSnapshot[]>([]);
  const [vaultInterestHistories, setVaultInterestHistories] = useState<
    Record<string, InterestSnapshot[]>
  >({});
  const [vaultRateHistory, setVaultRateHistory] = useState<BorrowRateSample[]>([]);

  useEffect(() => {
    if (!selectedLoan || selectedLoan.borrowed.length === 0) {
      setSelectedReserveTelemetry(null); // eslint-disable-line react-hooks/set-state-in-effect -- resetting state on dependency change
      setReserveTelemetryError('');
      setBorrowRateHistory([]);
      setLoanInterestHistory([]);
      return;
    }

    const primaryBorrow = selectedLoan.borrowed.reduce((max, borrowed) =>
      borrowed.usdValue > max.usdValue ? borrowed : max,
    );

    let cancelled = false;
    setSelectedReserveTelemetry(null);
    setReserveTelemetryError('');

    const resolvedWallet = result?.wallet ?? walletInput.trim();
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

    if (!selectedLoan.marketName.startsWith('proto_')) {
      void fetchInterestHistory(resolvedWallet, selectedLoan.id, 'loan').then((snapshots) => {
        if (cancelled) return;
        setLoanInterestHistory(snapshots);
      });
      return () => {
        cancelled = true;
      };
    }

    setLoanInterestHistory([]);

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
  }, [result?.lastUpdated, result?.wallet, selectedLoan, walletInput]);

  useEffect(() => {
    const resolvedWallet = result?.wallet;
    if (!resolvedWallet || !selectedVault) {
      setVaultRateHistory([]); // eslint-disable-line react-hooks/set-state-in-effect -- resetting on dependency change
      return;
    }
    let cancelled = false;
    void fetchBorrowRateHistory(resolvedWallet, selectedVault.vaultAddress).then((samples) => {
      if (cancelled) return;
      setVaultRateHistory(samples);
    });
    return () => {
      cancelled = true;
    };
  }, [result?.wallet, result?.lastUpdated, selectedVault]);

  useEffect(() => {
    const resolvedWallet = result?.wallet;
    if (!resolvedWallet || !result?.vaults.length) {
      setVaultInterestHistories({}); // eslint-disable-line react-hooks/set-state-in-effect -- resetting on dependency change
      return;
    }
    let cancelled = false;
    void Promise.all(
      result.vaults.map(async (vault) => {
        const snapshots = await fetchInterestHistory(resolvedWallet, vault.vaultAddress, 'vault');
        return [vault.vaultAddress, snapshots] as const;
      }),
    ).then((entries) => {
      if (cancelled) return;
      setVaultInterestHistories(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [result?.wallet, result?.vaults, result?.lastUpdated]);

  return {
    selectedReserveTelemetry,
    reserveTelemetryError,
    borrowRateHistory,
    loanInterestHistory,
    vaultInterestHistories,
    vaultRateHistory,
  };
}
