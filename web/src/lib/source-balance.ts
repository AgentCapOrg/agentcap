/**
 * THE BALANCE OF THE WALLET AN OWNER SENDS FROM, so Max can keep a reserve.
 *
 * Read in the browser, from a public RPC for that one network. The read sends
 * only the address the owner chose to fill in, and only for Max. The server is
 * not involved: nothing here proxies through AgentCap. That leaves no endpoint
 * a stranger could use to spend our provider credits.
 *
 * Each URL was checked on 2026-11-19 to answer a browser origin (CORS) for a
 * balance read.
 *
 * `null` IS THE ANSWER FOR ANY FAILURE: a refused request, a timeout, a
 * malformed reply, an address that is not one. The panel then says it could
 * not read the balance and leaves Max off. A failed read never becomes 0, which
 * would read as "this wallet is empty".
 */
import { robinhoodChain } from "@agentcap/core";
import type { DepositSource, SourceId } from "./deposit-math";

export const SOURCE_RPC: Readonly<Record<SourceId, string>> = Object.freeze({
  "eth-robinhood": robinhoodChain.rpcUrls.default.http[0]!,
  "eth-ethereum": "https://ethereum-rpc.publicnode.com",
  "eth-base": "https://mainnet.base.org",
  "eth-arbitrum": "https://arb1.arbitrum.io/rpc",
});

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Is `address` the right shape for this source's network? Shape only. */
export function isSourceAddress(source: DepositSource, address: string): boolean {
  return EVM_ADDRESS.test(address);
}

/** The balance in base units, or null for anything short of a clean answer. */
export async function readSourceBalance(
  source: DepositSource,
  address: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<bigint | null> {
  if (!isSourceAddress(source, address)) return null;
  const body = { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] };
  try {
    const response = await fetchImpl(SOURCE_RPC[source.id], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) return null;
    const json = (await response.json()) as { result?: unknown; error?: unknown };
    if (json.error !== undefined) return null;
    return typeof json.result === "string" && /^0x[0-9a-fA-F]+$/.test(json.result) ? BigInt(json.result) : null;
  } catch {
    return null;
  }
}
