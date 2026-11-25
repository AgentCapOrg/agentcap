import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chainForId, explorerFor, pimlicoBundlerUrl, bnbChain, bnbTestnet } from "../../packages/core/src/index";
import { bundlerChainMismatch } from "./settings";
import { readStatus, type StatusContext } from "./telegram/reads";

const statusCtx = (chainId: number | null): StatusContext => ({
  name: "Robin",
  strategy: "steady-basket",
  
  paused: false,
  workerAliveSec: 0,
  grant: null,
  chainId,
  telegramMaxActionUsdg: 25,
});

describe("/status chain line — you always know which mode the band rides", () => {
  it("mainnet reads as REAL FUNDS", () => {
    assert.match(readStatus(statusCtx(56)), /mainnet 56 · REAL FUNDS/);
  });
  it("testnet reads as simulated only", () => {
    // "practice only" retired: the product used "practice" for this NETWORK and
    // for simulated trading alike, and an owner who wanted the second picked the
    // first. The `• mode:` line above carries Paper/Live; this line is the chain.
    assert.match(readStatus(statusCtx(97)), /testnet 97 — <b>simulated only<\/b>/);
  });
  // People fund testnet, see 0, and think agentcap is broken. /status must say why.
  it("testnet explains that funded balances are neither used nor shown", () => {
    const out = readStatus({ ...statusCtx(97), paperStartUsdg: 1000 });
    assert.match(out, /not used and not shown/);
    assert.match(out, /1000 USDG book/);
    assert.match(out, /switch to mainnet/);
  });
  it("mainnet shows no testnet explainer", () => {
    assert.doesNotMatch(readStatus(statusCtx(56)), /not used and not shown/);
  });
  it("no grant → no chain line", () => {
    assert.doesNotMatch(readStatus(statusCtx(null)), /chain:/);
  });
});

describe("chainForId / explorerFor", () => {
  it("maps the two BNB Chain ids", () => {
    assert.equal(chainForId(97).id, bnbTestnet.id);
    assert.equal(chainForId(56).id, bnbChain.id);
  });

  it("treats anything unknown as mainnet (the only real chain)", () => {
    assert.equal(chainForId(1).id, bnbChain.id);
  });

  it("explorer URLs differ per chain", () => {
    assert.equal(explorerFor(97), "https://testnet.bscscan.com");
    assert.equal(explorerFor(56), "https://bscscan.com");
  });
});

describe("pimlicoBundlerUrl — the easy-path builder is always chain-correct", () => {
  it("stamps the grant's chain id into the URL, so the mismatch guard can't fire on it", () => {
    for (const id of [97, 56]) {
      const url = pimlicoBundlerUrl(id, "pim_secret");
      assert.equal(url, `https://api.pimlico.io/v2/${id}/rpc?apikey=pim_secret`);
      // the generated URL always matches the chain it was built for
      assert.equal(bundlerChainMismatch(url, id), null);
    }
  });
  it("url-encodes the key so odd characters can't break the URL", () => {
    assert.match(pimlicoBundlerUrl(56, "a b/c?d"), /apikey=a%20b%2Fc%3Fd$/);
  });
});

describe("bundlerChainMismatch — the silent-failure guard", () => {
  it("null when no bundler URL is set", () => {
    assert.equal(bundlerChainMismatch(undefined, 56), null);
    assert.equal(bundlerChainMismatch("", 56), null);
  });

  it("null when the URL's chain id matches the grant", () => {
    assert.equal(bundlerChainMismatch("https://api.pimlico.io/v2/97/rpc?apikey=x", 97), null);
    assert.equal(bundlerChainMismatch("https://api.pimlico.io/v2/56/rpc?apikey=x", 56), null);
  });

  it("flags a testnet bundler with a mainnet grant (and vice versa)", () => {
    assert.equal(bundlerChainMismatch("https://api.pimlico.io/v2/97/rpc?apikey=x", 56), 97);
    assert.equal(bundlerChainMismatch("https://api.pimlico.io/v2/56/rpc?apikey=x", 97), 56);
  });

  it("does NOT read a known id out of a longer number", () => {
    // 970 contains "97" and 5611 begins with "56": boundaries must prevent a match.
    assert.equal(bundlerChainMismatch("https://api.pimlico.io/v2/970/rpc", 56), null);
    assert.equal(bundlerChainMismatch("https://api.pimlico.io/v2/5611/rpc", 97), null);
  });

  it("null when the URL names no known chain id (heuristic stays quiet)", () => {
    assert.equal(bundlerChainMismatch("https://my-custom-bundler.example.com/rpc", 56), null);
    assert.equal(bundlerChainMismatch("https://bundler.example.com/v2/1/rpc", 97), null);
  });

  it("catches chain ids passed as query params", () => {
    assert.equal(bundlerChainMismatch("https://bundler.example.com/rpc?chain=97", 56), 97);
  });
});
