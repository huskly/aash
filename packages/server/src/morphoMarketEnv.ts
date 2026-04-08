import { AbiCoder, getAddress, keccak256 } from 'ethers';

const MORPHO_API_URL = 'https://api.morpho.org/graphql';

const CHAIN_IDS_BY_SLUG: Record<string, number> = {
  ethereum: 1,
  base: 8453,
};

type MarketAsset = {
  address: string;
  symbol: string;
};

type MorphoMarket = {
  uniqueKey: string;
  loanAsset: MarketAsset;
  collateralAsset: MarketAsset | null;
  oracleAddress: string;
  irmAddress: string;
  lltv: string;
};

type MarketByUniqueKeyResponse = {
  data?: {
    marketByUniqueKey?: MorphoMarket | null;
  };
  errors?: Array<{ message: string }>;
};

export type ResolvedMarketInput = {
  chainId: number;
  uniqueKey: string;
  marketUrl?: string;
};

export type MorphoEnvVars = {
  morphoBlue: string;
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltv: string;
};

const MARKET_BY_UNIQUE_KEY_QUERY = `
  query MarketByUniqueKey($uniqueKey: String!, $chainId: Int!) {
    marketByUniqueKey(uniqueKey: $uniqueKey, chainId: $chainId) {
      uniqueKey
      loanAsset {
        address
        symbol
      }
      collateralAsset {
        address
        symbol
      }
      oracleAddress
      irmAddress
      lltv
    }
  }
`;

export function resolveMorphoMarketInput(
  input: string,
  chainIdOverride?: number,
): ResolvedMarketInput {
  const trimmed = input.trim();
  const directKey = trimmed.match(/^0x[a-fA-F0-9]{64}$/);
  if (directKey) {
    return {
      chainId: chainIdOverride ?? 1,
      uniqueKey: directKey[0].toLowerCase(),
    };
  }

  const normalizedUrl = trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(normalizedUrl);
  } catch {
    throw new Error(
      'Expected a Morpho market URL like app.morpho.org/ethereum/market/<id>/<slug> or a 32-byte market unique key.',
    );
  }

  if (!url.hostname.endsWith('morpho.org')) {
    throw new Error('Expected a Morpho URL on app.morpho.org.');
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 3 || parts[1] !== 'market') {
    throw new Error('Expected a Morpho market URL path like /ethereum/market/<id>/<slug>.');
  }

  const network = parts[0]?.toLowerCase();
  const uniqueKey = parts[2];
  const resolvedChainId = network ? CHAIN_IDS_BY_SLUG[network] : undefined;
  if (!network || resolvedChainId == null) {
    throw new Error(`Unsupported Morpho network '${parts[0] ?? ''}'.`);
  }
  if (!uniqueKey || !/^0x[a-fA-F0-9]{64}$/.test(uniqueKey)) {
    throw new Error('Morpho market URL is missing a valid 32-byte market ID.');
  }

  return {
    chainId: chainIdOverride ?? resolvedChainId,
    uniqueKey: uniqueKey.toLowerCase(),
    marketUrl: normalizedUrl,
  };
}

export async function fetchMorphoMarket(uniqueKey: string, chainId: number): Promise<MorphoMarket> {
  const response = await fetch(MORPHO_API_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: MARKET_BY_UNIQUE_KEY_QUERY,
      variables: { uniqueKey, chainId },
    }),
  });

  if (!response.ok) {
    throw new Error(`Morpho API returned ${response.status}`);
  }

  const payload = (await response.json()) as MarketByUniqueKeyResponse;
  if (payload.errors?.length) {
    throw new Error(`Morpho API error: ${payload.errors[0]?.message ?? 'unknown'}`);
  }

  const market = payload.data?.marketByUniqueKey;
  if (!market) {
    throw new Error(`Morpho market not found for chainId=${chainId} uniqueKey=${uniqueKey}`);
  }
  if (!market.collateralAsset) {
    throw new Error(`Morpho market ${uniqueKey} has no collateral asset.`);
  }

  return market;
}

export function marketToEnvVars(market: MorphoMarket): MorphoEnvVars {
  if (!market.collateralAsset) {
    throw new Error(`Morpho market ${market.uniqueKey} has no collateral asset.`);
  }

  return {
    morphoBlue: '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb',
    loanToken: getAddress(market.loanAsset.address),
    collateralToken: getAddress(market.collateralAsset.address),
    oracle: getAddress(market.oracleAddress),
    irm: getAddress(market.irmAddress),
    lltv: market.lltv,
  };
}

export function computeMorphoMarketId(env: MorphoEnvVars): string {
  const abiCoder = AbiCoder.defaultAbiCoder();
  return keccak256(
    abiCoder.encode(
      ['address', 'address', 'address', 'address', 'uint256'],
      [env.loanToken, env.collateralToken, env.oracle, env.irm, env.lltv],
    ),
  );
}

export function formatMorphoEnvExports(env: MorphoEnvVars): string {
  return [
    `export MORPHO_BLUE=${env.morphoBlue}`,
    `export MORPHO_LOAN_TOKEN=${env.loanToken}`,
    `export MORPHO_COLLATERAL_TOKEN=${env.collateralToken}`,
    `export MORPHO_ORACLE=${env.oracle}`,
    `export MORPHO_IRM=${env.irm}`,
    `export MORPHO_LLTV=${env.lltv}`,
  ].join('\n');
}
