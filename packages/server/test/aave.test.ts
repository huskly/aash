import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildLoanPositions,
  COINGECKO_IDS_BY_SYMBOL,
  type RawUserReserveWithMarket,
} from '@aave-monitor/core';

describe('Aave pricing aliases', () => {
  it('maps cbBTC collateral to the CoinGecko Coinbase Wrapped BTC feed', () => {
    assert.equal(COINGECKO_IDS_BY_SYMBOL.CBBTC, 'coinbase-wrapped-btc');
  });

  it('keeps cbBTC collateral valued when building loan positions', () => {
    const reserves: RawUserReserveWithMarket[] = [
      {
        currentATokenBalance: '10000000', // 0.1 cbBTC
        currentTotalDebt: '0',
        usageAsCollateralEnabledOnUser: true,
        reserve: {
          symbol: 'cbBTC',
          decimals: 8,
          underlyingAsset: '0xcbbtc0000000000000000000000000000000000',
          baseLTVasCollateral: '7300',
          reserveLiquidationThreshold: '7800',
          liquidityRate: '0',
          variableBorrowRate: '0',
        },
        __marketName: 'proto_mainnet_v3',
      },
      {
        currentATokenBalance: '0',
        currentTotalDebt: '2500000000', // 2,500 USDC
        usageAsCollateralEnabledOnUser: false,
        reserve: {
          symbol: 'USDC',
          decimals: 6,
          underlyingAsset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          baseLTVasCollateral: '0',
          reserveLiquidationThreshold: '0',
          liquidityRate: '0',
          variableBorrowRate: '0',
        },
        __marketName: 'proto_mainnet_v3',
      },
    ];

    const prices = new Map<string, number>([
      ['CBBTC', 95_000],
      ['USDC', 1],
    ]);

    const [loan] = buildLoanPositions(reserves, prices);

    assert.ok(loan);
    assert.equal(loan.supplied.length, 1);
    assert.equal(loan.supplied[0]?.symbol, 'CBBTC');
    assert.equal(loan.supplied[0]?.usdPrice, 95_000);
    assert.equal(loan.supplied[0]?.usdValue, 9_500);
    assert.equal(loan.totalSuppliedUsd, 9_500);
    assert.equal(loan.totalBorrowedUsd, 2_500);
  });
});
