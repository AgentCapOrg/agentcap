/**
 * THE STRICT CHAIN HELPERS NAME TWO CHAINS AND THROW ON EVERYTHING ELSE; THE
 * LENIENT ONES ARE PINNED AS THEY ARE.
 *
 * chainForId maps any id but the testnet to mainnet, so a typo or a
 * missing id reads as BNB Chain. The strict pair is for new code that
 * must never guess. The lenient pair is pinned here so that flipping it, which
 * needs a read of prod first, is a decision and not an accident.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chainForId,
  chainForIdStrict,
  explorerFor,
  explorerForStrict,
  isBnbChainId,
  bnbChain,
  bnbTestnet,
} from "./chain";
import { CHAINS, allChains } from "./ids";

/** Ids that are not a BNB Chain id, each for its own reason. */
const NOT_BNB: readonly unknown[] = [
  1, // Ethereum
  4663, // Robinhood Chain, where this product no longer runs
  46630,
  0,
  -56,
  56.5,
  98,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  "56", // a numeric string is not the number
  "97",
  97n,
  undefined,
  null,
  {},
  [56],
  CHAINS.bnb, // a CAIP-2 ref is not an EVM chain id
];

describe("chainForIdStrict / explorerForStrict", () => {
  it("names mainnet and the testnet", () => {
    assert.equal(chainForIdStrict(56), bnbChain);
    assert.equal(chainForIdStrict(97), bnbTestnet);
    assert.equal(explorerForStrict(56), "https://bscscan.com");
    assert.equal(explorerForStrict(97), "https://testnet.bscscan.com");
  });

  it("throws on every other id, where the lenient pair answers mainnet", () => {
    for (const id of NOT_BNB) {
      assert.throws(() => chainForIdStrict(id), /^Error: unknown chain id: /, String(id));
      assert.throws(() => explorerForStrict(id), /^Error: unknown chain id: /, String(id));
    }
  });

  it("keeps a long id out of the message past 80 characters", () => {
    assert.throws(() => chainForIdStrict("9".repeat(500)), (e: Error) => e.message === `unknown chain id: ${"9".repeat(80)}`);
  });

  it("agrees with the ids.ts registry on every EVM chain it names", () => {
    const evm = allChains().filter((c) => c.family === "evm");
    assert.deepEqual(evm.map((c) => c.evmChainId), [56, 97]);
    for (const c of evm) {
      assert.equal(chainForIdStrict(c.evmChainId).id, c.evmChainId);
      assert.equal(explorerForStrict(c.evmChainId), c.explorer.base);
      assert.equal(chainForIdStrict(c.evmChainId).testnet === true, !c.realMoney);
    }
  });
});

describe("isBnbChainId", () => {
  it("is true for exactly 56 and 97", () => {
    assert.equal(isBnbChainId(56), true);
    assert.equal(isBnbChainId(97), true);
    for (const id of NOT_BNB) assert.equal(isBnbChainId(id), false, String(id));
  });
});

describe("chainForId / explorerFor — lenient, unchanged", () => {
  it("still map every id but the testnet to mainnet", () => {
    assert.equal(chainForId(97), bnbTestnet);
    assert.equal(chainForId(56), bnbChain);
    for (const id of [1, 0, 98, Number.NaN]) {
      assert.equal(chainForId(id), bnbChain, String(id));
      assert.equal(explorerFor(id), "https://bscscan.com", String(id));
    }
    assert.equal(chainForId(undefined as unknown as number), bnbChain);
    assert.equal(explorerFor(97), "https://testnet.bscscan.com");
  });
});
