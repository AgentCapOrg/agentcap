/**
 * Market data layer — server-side only.
 *
 * Sources, in order of trust:
 *  - Chainlink feeds (on-chain, multicall): price + updatedAt. THE price source.
 *    DEX-derived prices (GeckoTerminal etc.) are junk while stock pools are shallow.
 *  - Stock contracts (on-chain, multicall): tokenPaused, uiMultiplier.
 *  - Blockscout API: official Robinhood logo (cdn.robinhood.com), holders, 24h volume.
 */

import { webChainRead } from "@/lib/chain-read";
import { createPublicClient } from "viem";
import {
  CHAINLINK_ABI,
  STOCK_ABI,
  STOCK_TOKENS,
  bnbChain,
} from "@agentcap/core";

export interface MarketToken {
  symbol: string;
  name: string;
  kind: "stock" | "etf" | "memecoin";
  address: string;
  logo: string;
  priceUsd: number | null;
  /** Unix seconds of the last Chainlink update; null when the token has no feed. */
  priceUpdatedAt: number | null;
  /**
   * Trading halted on the token contract. NULL WHEN THE READ FAILED.
   *
   * It fell back to `false`, so one refused multicall leg published "trading
   * normally" for a token nobody had asked. A halt is the single most
   * consequential thing this row says; it may only be asserted when the chain
   * actually answered.
   */
  paused: boolean | null;
  /** 1.0 = no pending corporate action. */
  uiMultiplier: number | null;
  volume24hUsd: number | null;
  holders: number | null;
}

export interface MarketData {
  fetchedAt: number;
  tokens: MarketToken[];
}

const client = createPublicClient({ chain: bnbChain, transport: webChainRead() });

const LOGO_CDN = (address: string) =>
  `https://cdn.robinhood.com/ncw_assets/logos/${address.toLowerCase()}.png`;

interface BlockscoutStats {
  iconUrl: string | null;
  volume24hUsd: number | null;
  holders: number | null;
}

// BNB Chain has no Blockscout index to ask, so these three are unknown. The
// old chain's index is never asked: the same address there is another token.
async function fetchBlockscoutStats(_address: string): Promise<BlockscoutStats> {
  return { iconUrl: null, volume24hUsd: null, holders: null };
}

export async function fetchMarket(): Promise<MarketData> {
  const withFeed = STOCK_TOKENS.filter((t) => t.chainlinkFeed !== null);

  const feedCalls = withFeed.flatMap((t) => [
    { address: t.chainlinkFeed!, abi: CHAINLINK_ABI, functionName: "latestRoundData" } as const,
    { address: t.chainlinkFeed!, abi: CHAINLINK_ABI, functionName: "decimals" } as const,
  ]);
  const stateCalls = STOCK_TOKENS.flatMap((t) => [
    { address: t.address, abi: STOCK_ABI, functionName: "tokenPaused" } as const,
    { address: t.address, abi: STOCK_ABI, functionName: "uiMultiplier" } as const,
  ]);

  const [feedResults, stateResults, blockscout] = await Promise.all([
    client.multicall({ contracts: feedCalls }),
    client.multicall({ contracts: stateCalls }),
    Promise.all(STOCK_TOKENS.map((t) => fetchBlockscoutStats(t.address))),
  ]);

  const prices = new Map<string, { priceUsd: number; updatedAt: number }>();
  withFeed.forEach((t, i) => {
    const round = feedResults[i * 2];
    const dec = feedResults[i * 2 + 1];
    if (round?.status !== "success" || dec?.status !== "success") return;
    const [, answer, , updatedAt] = round.result as readonly [bigint, bigint, bigint, bigint, bigint];
    prices.set(t.symbol, {
      priceUsd: Number(answer) / 10 ** Number(dec.result as number),
      updatedAt: Number(updatedAt),
    });
  });

  const tokens: MarketToken[] = STOCK_TOKENS.map((t, i) => {
    const pausedRes = stateResults[i * 2];
    const multRes = stateResults[i * 2 + 1];
    const price = prices.get(t.symbol);
    const stats = blockscout[i]!;
    return {
      symbol: t.symbol,
      name: t.name,
      kind: t.kind,
      address: t.address,
      logo: stats.iconUrl ?? LOGO_CDN(t.address),
      priceUsd: price?.priceUsd ?? null,
      priceUpdatedAt: price?.updatedAt ?? null,
      paused: pausedRes?.status === "success" ? (pausedRes.result as boolean) : null,
      uiMultiplier:
        multRes?.status === "success" ? Number(multRes.result as bigint) / 1e18 : null,
      volume24hUsd: stats.volume24hUsd,
      holders: stats.holders,
    };
  });

  // Unknown volume sorts LAST rather than as zero: `?? 0` ranked a token
  // Blockscout did not answer for identically to one that genuinely did no
  // trade, which is the same conflation this file just removed from `paused`.
  tokens.sort((a, b) => {
    if (a.volume24hUsd === b.volume24hUsd) return 0;
    if (a.volume24hUsd === null) return 1;
    if (b.volume24hUsd === null) return -1;
    return b.volume24hUsd - a.volume24hUsd;
  });

  return { fetchedAt: Math.floor(Date.now() / 1000), tokens };
}
