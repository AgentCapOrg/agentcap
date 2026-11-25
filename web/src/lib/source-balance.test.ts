import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEPOSIT_SOURCES } from "./deposit-math";
import { SOURCE_RPC, isSourceAddress, readSourceBalance } from "./source-balance";

const EVM = "0x00000000000000000000000000000000000000aa";
const base = DEPOSIT_SOURCES["eth-base"];

function answering(status: number, body: unknown, seen: { url: string; init?: RequestInit }[] = []): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe("the sending wallet's balance, for Max", () => {
  it("reads native ETH from that network's RPC, with no cookie or referrer", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    assert.equal(await readSourceBalance(base, EVM, answering(200, { jsonrpc: "2.0", id: 1, result: "0xde0b6b3a7640000" }, seen)), 10n ** 18n);
    assert.equal(seen[0]!.url, SOURCE_RPC["eth-base"]);
    assert.deepEqual(JSON.parse(String(seen[0]!.init!.body)), { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [EVM, "latest"] });
    assert.equal(seen[0]!.init!.credentials, "omit");
    assert.equal(seen[0]!.init!.referrerPolicy, "no-referrer");
  });

  it("answers null, never zero, for anything short of a clean answer", async () => {
    const cases: [string, typeof fetch][] = [
      ["refused", answering(403, { jsonrpc: "2.0", error: { code: 403, message: "Access forbidden" } })],
      ["rpc error", answering(200, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "header not found" } })],
      ["not json", answering(200, "<html>")],
      ["no result", answering(200, { jsonrpc: "2.0", id: 1 })],
      ["decimal, not hex", answering(200, { result: "1000" })],
      ["network down", (async () => { throw new TypeError("fetch failed"); }) as typeof fetch],
    ];
    for (const [what, fetchImpl] of cases) assert.equal(await readSourceBalance(base, EVM, fetchImpl), null, what);
  });

  it("asks nobody about an address that is not one for that network", async () => {
    const seen: { url: string }[] = [];
    for (const [source, address] of [[base, "9mAdjznSUjrVFJKuacoFg8tkA6UfTqTboeuqN3eGr842"], [base, "0x123"]] as const) {
      assert.equal(isSourceAddress(source, address), false, address);
      assert.equal(await readSourceBalance(source, address, answering(200, { result: "0x1" }, seen)), null);
    }
    assert.equal(seen.length, 0);
  });
});
