import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import {
  CHAINS,
  allChains,
  canonicalId,
  chainInfo,
  chainOfEvmId,
  explorerUrl,
  idFamily,
  onchainIdIn,
  onchainIdsIn,
  requireChain,
  sameId,
} from "./ids";
import { CASH } from "./tokens";

const EVM = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const EVM_HASH = `0x${"Ab".repeat(32)}`;

describe("the chain registry", () => {
  it("names Robinhood Chain, mainnet and test, and nothing else", () => {
    assert.deepEqual(allChains().map((c) => c.ref), [CHAINS.robinhood, CHAINS.robinhoodTestnet]);
    assert.equal(chainInfo(CHAINS.robinhood)?.family, "evm");
    assert.equal(chainInfo(CHAINS.robinhood)?.evmChainId, 4663);
    assert.equal(chainInfo(CHAINS.robinhoodTestnet)?.realMoney, false);
  });

  it("is fail-closed: an unknown chain is null, never a default", () => {
    for (const bad of ["eip155:1", "", null, 4663, "EIP155:4663"]) assert.equal(chainInfo(bad), null, String(bad));
    assert.throws(() => requireChain("eip155:8453"), /unknown chain/);
    assert.equal(chainOfEvmId(4663), CHAINS.robinhood);
    assert.equal(chainOfEvmId(46630), CHAINS.robinhoodTestnet);
    for (const id of [1, 8453, 0, -1, 4663.5, "4663"]) assert.equal(chainOfEvmId(id), null, String(id));
  });

  it("keeps the books in USDG on both chains, at 6 decimals", () => {
    assert.equal(chainInfo(CHAINS.robinhood)?.cash.address, CASH.USDG.toLowerCase());
    for (const c of allChains()) assert.equal(c.cash.decimals, 6);
  });
});

describe("canonical ids", () => {
  it("lowercases EVM ids", () => {
    assert.equal(canonicalId(CHAINS.robinhood, "token", EVM), EVM.toLowerCase());
    assert.equal(canonicalId(CHAINS.robinhood, "op", EVM_HASH), EVM_HASH.toLowerCase());
  });

  it("treats case-folded EVM ids as the same id", () => {
    assert.equal(sameId(CHAINS.robinhood, "token", EVM, EVM.toLowerCase()), true);
  });

  it("refuses the wrong length, a bad shape, or an unknown chain", () => {
    assert.equal(canonicalId(CHAINS.robinhood, "op", EVM), null, "an address is not a hash");
    assert.equal(canonicalId(CHAINS.robinhood, "token", EVM_HASH), null, "a hash is not an address");
    assert.equal(canonicalId(CHAINS.robinhood, "token", "not-an-address"), null);
    assert.equal(canonicalId("eip155:1", "token", EVM), null);
  });

  it("names the family of a bare id by its shape", () => {
    assert.equal(idFamily(EVM), "evm");
    assert.equal(idFamily(EVM_HASH), "evm");
    assert.equal(idFamily("PEPE"), null);
  });
});

describe("explorer links", () => {
  it("Blockscout for Robinhood Chain", () => {
    assert.equal(explorerUrl(CHAINS.robinhood, "op", EVM_HASH), `https://robinhoodchain.blockscout.com/tx/${EVM_HASH.toLowerCase()}`);
    assert.equal(explorerUrl(CHAINS.robinhood, "token", EVM), `https://robinhoodchain.blockscout.com/token/${EVM.toLowerCase()}`);
    assert.equal(explorerUrl(CHAINS.robinhood, "account", EVM), `https://robinhoodchain.blockscout.com/address/${EVM.toLowerCase()}`);
    assert.equal(explorerUrl(CHAINS.robinhood, "token", "not-a-token"), null);
  });
});

describe("on-chain id detection", () => {
  it("finds EVM addresses and hashes", () => {
    const hits = onchainIdsIn(`bought at ${EVM} tx ${EVM_HASH}`);
    assert.deepEqual(hits, [
      { family: "evm", shape: "address", value: EVM },
      { family: "evm", shape: "hash", value: EVM_HASH },
    ]);
  });

  it("leaves ordinary prose alone", () => {
    for (const t of ["supercalifragilisticexpialidociousandmorewordsjoined", "the market is quiet today", "PEPE pumped 40% on the week", ""]) {
      assert.equal(onchainIdIn(t), false, t);
    }
  });

  it("answers every shared case as Brain's Python mirror does", () => {
    const fixture = JSON.parse(readFileSync(new URL("../../../services/brain/tests/data/onchain_ids.json", import.meta.url), "utf8")) as
      { cases: { text: string; hits: { family: string; shape: string; value: string }[] }[] };
    for (const c of fixture.cases) assert.deepEqual(onchainIdsIn(c.text), c.hits, c.text);
  });
});
