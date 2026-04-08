import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import {
  computeMorphoMarketId,
  fetchMorphoMarket,
  formatMorphoEnvExports,
  marketToEnvVars,
  resolveMorphoMarketInput,
} from '../src/morphoMarketEnv.js';

describe('resolveMorphoMarketInput', () => {
  it('parses a Morpho market URL into chain and unique key', () => {
    const resolved = resolveMorphoMarketInput(
      'app.morpho.org/ethereum/market/0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64/cbbtc-usdc',
    );

    assert.deepEqual(resolved, {
      chainId: 1,
      uniqueKey: '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64',
      marketUrl:
        'https://app.morpho.org/ethereum/market/0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64/cbbtc-usdc',
    });
  });

  it('accepts a raw unique key with a chain override', () => {
    const resolved = resolveMorphoMarketInput(
      '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64',
      8453,
    );

    assert.deepEqual(resolved, {
      chainId: 8453,
      uniqueKey: '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64',
    });
  });
});

describe('Morpho market env generation', () => {
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('maps the Ethereum cbBTC/USDC market into exact env vars', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: {
            marketByUniqueKey: {
              uniqueKey: '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64',
              loanAsset: {
                address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
                symbol: 'USDC',
              },
              collateralAsset: {
                address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
                symbol: 'cbBTC',
              },
              oracleAddress: '0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a',
              irmAddress: '0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC',
              lltv: '860000000000000000',
            },
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );

    const market = await fetchMorphoMarket(
      '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64',
      1,
    );
    const env = marketToEnvVars(market);

    assert.equal(
      computeMorphoMarketId(env),
      '0x64d65c9a2d91c36d56fbc42d69e979335320169b3df63bf92789e2c8883fcc64',
    );

    assert.equal(
      formatMorphoEnvExports(env),
      [
        'export MORPHO_BLUE=0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
        'export MORPHO_LOAN_TOKEN=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        'export MORPHO_COLLATERAL_TOKEN=0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
        'export MORPHO_ORACLE=0xA6D6950c9F177F1De7f7757FB33539e3Ec60182a',
        'export MORPHO_IRM=0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC',
        'export MORPHO_LLTV=860000000000000000',
      ].join('\n'),
    );
  });
});
