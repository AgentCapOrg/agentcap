/**
 * CHAIN-NEUTRAL IDENTITY.
 *
 * A chain is named explicitly, the way CAIP-2 names it, and every id is
 * canonicalised by its chain's own rule:
 *
 *   EVM      0x + 40 hex (account, token) or 0x + 64 hex (operation), lowercased.
 *
 * THE REGISTRY IS FAIL-CLOSED. A chain this file does not name is not a chain:
 * `chainInfo` answers null and the strict helpers throw. That is the opposite
 * of chain.ts `chainForId`, which maps every id but the testnet to Robinhood
 * mainnet; that helper stays as it is for the EVM paths that use it today.
 *
 * Pure: no I/O, no clock, and browser-safe (web imports it).
 */

/** The chain families AgentCap can name. */
export type ChainFamily = "evm";

/** CAIP-2 references: `eip155:<chain id>`. */
export const CHAINS = Object.freeze({
  robinhood: "eip155:4663",
  robinhoodTestnet: "eip155:46630",
} as const);
export type ChainRef = (typeof CHAINS)[keyof typeof CHAINS];

/** The stable a chain's books are kept in: Paxos USDG (6 decimals). */
export interface CashAsset {
  symbol: "USDG";
  /** The token's address on that chain (an ERC-20 proxy on Robinhood Chain); null where none is verified. */
  address: string | null;
  decimals: 6;
}

/** How a chain is shown beside the others: a short name, a glyph and its colours. */
export interface ChainLook {
  /** One or two characters for tight places (a badge, a chip). */
  glyph: string;
  /** The chain's own colour, for borders, dots and accents. */
  accent: string;
  /** A two-stop gradient for hero surfaces. */
  gradient: readonly [string, string];
}

export interface ChainInfo {
  ref: ChainRef;
  family: ChainFamily;
  /** The full name ("Robinhood Chain"). */
  label: string;
  /** The short name for a badge ("Robinhood"). */
  short: string;
  /** False on a test network: never shown as real money. */
  realMoney: boolean;
  /** The EVM chain id, for EVM chains only. */
  evmChainId?: number;
  explorer: { name: string; base: string };
  cash: CashAsset;
  look: ChainLook;
}


/** Robinhood Chain USDG (packages/core/src/tokens.ts CASH.USDG), lowercased. */
const ROBINHOOD_USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

const ROBINHOOD_LOOK: ChainLook = { glyph: "R", accent: "#CCFF00", gradient: ["#CCFF00", "#00C805"] };

const REGISTRY: ReadonlyMap<string, ChainInfo> = new Map<string, ChainInfo>([
  [CHAINS.robinhood, {
    ref: CHAINS.robinhood, family: "evm", label: "Robinhood Chain", short: "Robinhood", realMoney: true, evmChainId: 4663,
    explorer: { name: "Blockscout", base: "https://robinhoodchain.blockscout.com" },
    cash: { symbol: "USDG", address: ROBINHOOD_USDG, decimals: 6 }, look: ROBINHOOD_LOOK,
  }],
  [CHAINS.robinhoodTestnet, {
    ref: CHAINS.robinhoodTestnet, family: "evm", label: "Robinhood Chain Testnet", short: "Robinhood test", realMoney: false, evmChainId: 46630,
    explorer: { name: "Blockscout", base: "https://explorer.testnet.chain.robinhood.com" },
    cash: { symbol: "USDG", address: null, decimals: 6 }, look: ROBINHOOD_LOOK,
  }],
]);

/** Every chain AgentCap names, in display order. */
export function allChains(): ChainInfo[] {
  return [...REGISTRY.values()];
}

/** A chain's facts, or null for anything this registry does not name (never a default). */
export function chainInfo(ref: unknown): ChainInfo | null {
  return typeof ref === "string" ? REGISTRY.get(ref) ?? null : null;
}

/** As chainInfo, but an unknown chain throws: for code that must never guess. */
export function requireChain(ref: unknown): ChainInfo {
  const c = chainInfo(ref);
  if (!c) throw new Error(`unknown chain: ${String(ref).slice(0, 80)}`);
  return c;
}

/** The CAIP-2 reference of an EVM chain id this registry names, or null (never a default). */
export function chainOfEvmId(id: unknown): ChainRef | null {
  if (typeof id !== "number" || !Number.isSafeInteger(id)) return null;
  for (const c of REGISTRY.values()) if (c.family === "evm" && c.evmChainId === id) return c.ref;
  return null;
}

// ── canonical ids ───────────────────────────────────────────────────────────

/** What an id names: an account (a wallet, a vault, a program), a token, or an operation (a tx hash). */
export type IdKind = "account" | "token" | "op";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * An id in its chain's canonical spelling (lowercased), or null when it is not
 * one. The chain must be one this registry names.
 */
export function canonicalId(chain: unknown, kind: IdKind, raw: unknown): string | null {
  const c = chainInfo(chain);
  if (!c || typeof raw !== "string") return null;
  const s = raw.trim();
  if (kind === "op") return EVM_HASH.test(s) ? s.toLowerCase() : null;
  return EVM_ADDRESS.test(s) ? s.toLowerCase() : null;
}

/** Two ids name the same thing on that chain. */
export function sameId(chain: unknown, kind: IdKind, a: unknown, b: unknown): boolean {
  const x = canonicalId(chain, kind, a);
  return x !== null && x === canonicalId(chain, kind, b);
}

/** The family an id's SHAPE belongs to, chain unknown: "evm" or null. Never a canonicaliser. */
export function idFamily(raw: unknown): ChainFamily | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  return EVM_ADDRESS.test(s) || EVM_HASH.test(s) ? "evm" : null;
}

/** The explorer page for an id on its chain, or null for an id that is not canonical there. */
export function explorerUrl(chain: unknown, kind: IdKind, raw: unknown): string | null {
  const c = chainInfo(chain);
  const id = canonicalId(chain, kind, raw);
  if (!c || !id) return null;
  return `${c.explorer.base}/${kind === "op" ? "tx" : kind === "token" ? "token" : "address"}/${id}`;
}

// ── detectors for public and model-facing backstops ─────────────────────────

export interface OnchainIdHit {
  family: ChainFamily;
  /** "address" (a 20-byte id) or "hash" (a 32-byte hash). */
  shape: "address" | "hash";
  value: string;
}

const EVM_IN_TEXT = /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])|0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

/** Every on-chain id in a text: EVM addresses and hashes. The shape is enough, a match is never checked against a chain. */
export function onchainIdsIn(text: unknown): OnchainIdHit[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const hits: OnchainIdHit[] = [];
  for (const m of text.matchAll(EVM_IN_TEXT)) hits.push({ family: "evm", shape: m[0].length === 66 ? "hash" : "address", value: m[0] });
  return hits;
}

/** Whether a text carries any on-chain id (onchainIdsIn). */
export function onchainIdIn(text: unknown): boolean {
  return onchainIdsIn(text).length > 0;
}
