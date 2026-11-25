/**
 * OFFICIAL COINS — the platform's own curated non-equity listings.
 *
 * An official coin is the platform doing for a coin what it already does for
 * AAPL: publishing a verified address so no owner has to find, type or vouch for
 * one. It is CURATED, not discovered — that is the whole difference from the
 * trencher feed, which deliberately cannot drive entries in live mode.
 *
 * It does NOT add anything to `STOCK_TOKENS`, and it must never be made to:
 * snapshot.ts calls `tokenPaused()` across it, `builtinGrantTargets()` derives
 * the sellable set from it AT RUNTIME (a coin added there would join
 * `sellableAssets` for every already-signed grant — a hole in the wall), and the
 * web UI renders registry entries as stocks. An official coin enters through the
 * same door an owner-added token uses.
 *
 * Everything downstream still binds, and listing a coin cannot widen a grant
 * that is already signed: an owner whose grant predates a listing must re-sign
 * before their key can touch it. An owner can decline the whole category with
 * `officialCoinsEnabled: false`.
 *
 */
import { bnbChain, bnbTestnet } from "./chain";
import { CASH } from "./tokens";
import type { CustomToken } from "./tokens";

/** A platform-curated coin, with everything needed to price and trade it pinned. */
export interface OfficialCoin {
  /** Ticker as the CONTRACT reports it, uppercased for symbol-keyed lookups. */
  symbol: string;
  /** Human name, read from the contract at listing time. */
  name: string;
  /** The ERC-20, lowercased. */
  address: `0x${string}`;
  /** Real ERC-20 decimals. Never guessed — the asset model divides by 10^this. */
  decimals: number;
  /** What the coin is priced in. USDT only — see `officialCoinsFor`. */
  quoteToken: `0x${string}`;
  /** When this listing was verified against the chain, for the audit trail. */
  listedOn: string;
}

/** THE CASH-QUOTED RULE: cash is the one asset every funded agent actually holds. */
function isUsdgQuoted(c: OfficialCoin): boolean {
  return c.quoteToken.toLowerCase() === (CASH.USDT as string).toLowerCase();
}

/**
 * Listings per chain.
 *
 * An empty list is the honest state for a chain with no verified listing, and is
 * a different fact from "official coins are turned off" — which is a setting.
 */
export const OFFICIAL_COINS: Readonly<Record<number, readonly OfficialCoin[]>> = Object.freeze({
  /**
   * EMPTY. A listing here has to outlive a 14-day grant cycle, because the wall
   * seals token addresses at SIGNING time and every owner must re-sign to reach
   * a new entry — so only an asset whose depth is durable on that scale belongs.
   */
  [bnbChain.id]: [],
  /** BNB Chain testnet: nothing is listed. */
  [bnbTestnet.id]: [],
});

/**
 * Listings for a chain, filtered to the ones that are actually reachable.
 *
 * The filter runs HERE rather than at each call site so that a listing which
 * cannot be traded also cannot be watched, priced, put in a basket or sealed
 * into a wall. A coin the agent can see and can never act on is the failure this
 * whole file exists to end, and reproducing it one layer down would be worse
 * than not listing at all.
 */
export function officialCoinsFor(chainId: number): readonly OfficialCoin[] {
  return (OFFICIAL_COINS[chainId] ?? []).filter(isUsdgQuoted);
}

/** One listing by address, or null. Lowercase-insensitive. */
export function officialCoinByAddress(chainId: number, address: string): OfficialCoin | null {
  const key = address.toLowerCase();
  return officialCoinsFor(chainId).find((c) => c.address.toLowerCase() === key) ?? null;
}

/** One listing by symbol, or null. Case-insensitive. */
export function officialCoinBySymbol(chainId: number, symbol: string): OfficialCoin | null {
  const key = symbol.toUpperCase();
  return officialCoinsFor(chainId).find((c) => c.symbol.toUpperCase() === key) ?? null;
}

/** Every official symbol on a chain, for basket resolution. */
export function officialCoinSymbols(chainId: number): string[] {
  return officialCoinsFor(chainId).map((c) => c.symbol);
}

/**
 * Listings in the shape the SIGNERS take, so a re-sign seals them.
 *
 * `usableExtraTokens` drops anything already in `builtinGrantTargets()` and
 * anything malformed, so passing these alongside the owner's own custom tokens
 * is safe against both duplication and a listing that collides with a built-in.
 */
export function officialCoinTokens(chainId: number): CustomToken[] {
  return officialCoinsFor(chainId).map((c) => ({
    symbol: c.symbol,
    address: c.address,
    decimals: c.decimals,
  }));
}
