import {
  computeMorphoMarketId,
  fetchMorphoMarket,
  formatMorphoEnvExports,
  marketToEnvVars,
  resolveMorphoMarketInput,
} from '../morphoMarketEnv.js';

function parseArgs(argv: string[]): { input: string; chainId?: number } {
  const args = [...argv];
  let input = '';
  let chainId: number | undefined;

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) break;

    if (arg === '--chain-id') {
      const raw = args.shift();
      if (!raw || !/^\d+$/.test(raw)) {
        throw new Error('--chain-id expects an integer value.');
      }
      chainId = Number(raw);
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`Unknown argument '${arg}'.`);
    }

    if (input) {
      throw new Error('Expected a single Morpho market URL or unique key.');
    }
    input = arg;
  }

  if (!input) {
    throw new Error('Usage: yarn morpho:market-env <market-url-or-unique-key> [--chain-id <id>]');
  }

  return { input, chainId };
}

async function main() {
  const { input, chainId } = parseArgs(process.argv.slice(2));
  const resolved = resolveMorphoMarketInput(input, chainId);
  const market = await fetchMorphoMarket(resolved.uniqueKey, resolved.chainId);
  const env = marketToEnvVars(market);
  const computedId = computeMorphoMarketId(env);

  if (computedId.toLowerCase() !== market.uniqueKey.toLowerCase()) {
    throw new Error(
      `Resolved params hash to ${computedId}, but Morpho returned market ID ${market.uniqueKey}.`,
    );
  }

  console.log(`# Morpho market ${market.uniqueKey} (chainId=${resolved.chainId})`);
  console.log(`# ${market.collateralAsset?.symbol ?? '?'} / ${market.loanAsset.symbol}`);
  console.log(formatMorphoEnvExports(env));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
