import { defineChain } from "viem";

/**
 * BNB Chain constants.
 * Every contract address below was checked on-chain with eth_getCode against
 * chains 56 and 97 on 2026-11-24, except where marked. Do not add addresses
 * here without probing them first.
 */

export const bnbChain = defineChain({
  id: 56, // 0x38
  name: "BNB Smart Chain",
  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://bsc-dataseed.bnbchain.org"] },
  },
  blockExplorers: {
    default: {
      name: "BscScan",
      url: "https://bscscan.com",
      apiUrl: "https://api.etherscan.io/v2/api?chainid=56",
    },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

export const bnbTestnet = defineChain({
  id: 97, // 0x61
  name: "BNB Smart Chain Testnet",
  testnet: true,
  nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://bsc-testnet-dataseed.bnbchain.org"] },
  },
  blockExplorers: {
    default: {
      name: "BscScan",
      url: "https://testnet.bscscan.com",
    },
  },
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

/**
 * Resolve a chain object from a grant/selector chain id. Anything that isn't
 * the testnet id is treated as mainnet — the two BNB Chain networks are the
 * only chains this product runs on.
 */
export function chainForId(id: number): typeof bnbChain | typeof bnbTestnet {
  return id === bnbTestnet.id ? bnbTestnet : bnbChain;
}

/** Block-explorer base URL for a chain id (BscScan on both chains). */
export function explorerFor(chainId: number): string {
  return chainForId(chainId).blockExplorers!.default.url;
}

/** One of the two chain ids this product runs on. */
export type BnbChainId = typeof bnbChain.id | typeof bnbTestnet.id;

/** Exactly 56 or 97, as a number: a numeric string, a float or a missing id is neither. */
export function isBnbChainId(id: unknown): id is BnbChainId {
  return id === bnbChain.id || id === bnbTestnet.id;
}

/**
 * STRICT VARIANTS, FOR NEW CODE. chainForId and explorerFor above map every id
 * but the testnet to mainnet, which is what lets a typo or a
 * missing id read as BNB Chain. These throw on anything that is not one
 * of the two BNB Chain ids instead, as ids.ts requireChain does.
 *
 * The lenient pair stays as it is: flipping it would change what existing
 * callers do with whatever ids prod already holds, and that needs a read of
 * prod first.
 */
export function chainForIdStrict(id: unknown): typeof bnbChain | typeof bnbTestnet {
  if (id === bnbChain.id) return bnbChain;
  if (id === bnbTestnet.id) return bnbTestnet;
  throw new Error(`unknown chain id: ${String(id).slice(0, 80)}`);
}

/** As explorerFor, but an unknown chain id throws (chainForIdStrict). */
export function explorerForStrict(chainId: unknown): string {
  return chainForIdStrict(chainId).blockExplorers!.default.url;
}

/**
 * Build the Pimlico bundler RPC for a chain from just an API key. The chain id
 * is stamped from the grant itself, so the URL can never point at the wrong
 * chain — the whole class of "testnet bundler with a mainnet grant" bugs the
 * mismatch guard exists for simply cannot happen on this path.
 */
export function pimlicoBundlerUrl(chainId: number, apiKey: string): string {
  return `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${encodeURIComponent(apiKey)}`;
}

/**
 * The Pimlico PAYMASTER RPC — the same endpoint as the bundler.
 *
 * NOT YET PROBED ON BNB CHAIN: it needs a Pimlico API key. Confirm
 * `pm_getPaymasterStubData` on chain 56 before relying on sponsorship.
 *
 * A separate function despite being the same string today, for the reason the
 * bundler helper exists: the chain id is stamped from the grant, so a testnet
 * grant can never reach a mainnet sponsor. Deliberately NOT an operator-supplied
 * override — an override would reintroduce the wrong-chain class this shape makes
 * impossible, and bundlerChainMismatch only inspects the bundler URL.
 */
export function pimlicoPaymasterUrl(chainId: number, apiKey: string): string {
  return `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${encodeURIComponent(apiKey)}`;
}

/** ERC-4337 EntryPoints — all deployed on both 56 and 97 (probed 2026-11-24). */
export const ENTRYPOINT = {
  v06: "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789",
  v07: "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  v08: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
} as const;

/** Canonical infra verified deployed on 56 and 97. */
export const INFRA = {
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
  create2Deployer: "0x4e59b44847b379578588920cA78FbF26c0B4956C",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
} as const;

/** Data-source identifiers. BNB Chain is an L1: there is no sequencer feed. */
export const DATA = {
  geckoTerminalSlug: "bsc",
  dexScreenerChainId: "bsc",
  /** GeckoTerminal's dex id for PancakeSwap v3 (api/v2/networks/bsc/dexes, read 2026-11-25). */
  pancakeswapV3DexId: "pancakeswap-v3-bsc",
} as const;
