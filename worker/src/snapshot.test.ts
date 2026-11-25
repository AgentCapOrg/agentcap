/**
 * readAccountBalances had no tests at all, which is how it shipped the mirror
 * image of the bug positions.ts is careful about: a failed read collapsing into
 * a zero balance that is indistinguishable from an empty wallet.
 *
 * That zero is not harmless. It writes a ~0 equity row, and every last-minus-
 * first P&L reader takes the FIRST row as its baseline — so one RPC hiccup at
 * the wrong moment misreports the account's whole return, permanently.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicClient } from "viem";
import { readAccountBalances } from "./snapshot";

const ACCT = "0x00000000000000000000000000000000000000a1" as const;
const USDG = 6n; // decimals, for readability below
const usdg = (v: number) => BigInt(Math.round(v * 10 ** Number(USDG)));

type CallResult = { status: "success"; result: bigint } | { status: "failure"; error: Error };
const good = (v: bigint): CallResult => ({ status: "success", result: v });
const bad = (): CallResult => ({ status: "failure", error: new Error("reverted") });

/** A viem-shaped client with just the three reads readAccountBalances makes. */
function client(opts: {
  eth?: bigint | "throw";
  multi?: CallResult[] | "throw";
  convert?: bigint | "throw";
}): PublicClient {
  return {
    async getBalance() {
      if (opts.eth === "throw") throw new Error("rpc down");
      return opts.eth ?? 0n;
    },
    async multicall() {
      if (opts.multi === "throw") throw new Error("rpc down");
      return opts.multi ?? [good(0n), good(0n)];
    },
    async readContract() {
      if (opts.convert === "throw") throw new Error("rpc down");
      return opts.convert ?? 0n;
    },
  } as unknown as PublicClient;
}

describe("readAccountBalances — an unknown is never a zero", () => {
  it("a clean read reports every figure and no gaps", async () => {
    const b = await readAccountBalances(
      client({ eth: 5n, multi: [good(usdg(250)), good(0n)] }),
      ACCT,
    );
    assert.equal(b.cashUsdg, usdg(250));
    assert.equal(b.ethWei, 5n);
    assert.deepEqual(b.unread, []);
  });

  it("a totally failed multicall reports the cash unread, not zero", async () => {
    const b = await readAccountBalances(client({ eth: 1n, multi: "throw" }), ACCT);
    assert.deepEqual(b.unread, ["cash"]);
  });

  it("a reverted cash call is unread even though the batch answered", async () => {
    const b = await readAccountBalances(client({ multi: [bad(), good(0n)] }), ACCT);
    assert.deepEqual(b.unread, ["cash"]);
  });

  it("a failed ETH read is reported too — gas is spent from it", async () => {
    const b = await readAccountBalances(client({ eth: "throw" }), ACCT);
    assert.deepEqual(b.unread, ["eth"]);
  });
});
