/**
 * OFFICIAL COINS — the listing itself, and the three things it must never become.
 *
 * Most of these are shape tests on a constant, which is exactly what they should
 * be: the whole value of a pinned listing is that it does not depend on a
 * running chain, a discovery window, or a table that gets pruned. What a test
 * CAN prove is that the pinning is internally consistent and that the listing
 * cannot leak into the registry paths that would break it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  OFFICIAL_COINS,
  officialCoinByAddress,
  officialCoinBySymbol,
  officialCoinSymbols,
  officialCoinTokens,
  officialCoinsFor,
} from "./official-coins";
import { CASH, STOCK_TOKENS } from "./tokens";
import { builtinGrantTargets, usableExtraTokens } from "./index";

const MAINNET = 4663;
const TESTNET = 46630;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("official coins — the listing", () => {
  it("returns a list for every known chain, empty or not", () => {
    // NOT "at least one on mainnet", which is what this asserted until the first
    // listing died. An empty list is a legitimate and honest state — the
    // platform is not obliged to be listing anything — so pinning a non-empty
    // registry would make an accurate registry fail its own test, and invite
    // somebody to re-list a dead coin to get CI green.
    assert.ok(Array.isArray(officialCoinsFor(MAINNET)));
    assert.deepEqual(officialCoinsFor(TESTNET), [], "the testnet launchpad is not populated");
  });

  it("returns an empty list for an unknown chain rather than throwing", () => {
    assert.deepEqual(officialCoinsFor(1), []);
    assert.deepEqual(officialCoinSymbols(999_999), []);
  });

  it("carries only USDG-quoted curves, because the adapter cannot reach the others", () => {
    // PonsSelfTrade is non-payable and the wall keeps valueLimit at 0, so a
    // native-ETH curve — 57.6% of the launchpad — is unreachable. A listing the
    // agent could see and never trade is the failure this file exists to end.
    for (const c of officialCoinsFor(MAINNET)) {
      assert.equal(c.quoteToken.toLowerCase(), (CASH.USDT as string).toLowerCase());
    }
  });

  it("filters a non-USDG listing OUT of every accessor, not just the list", () => {
    // The filter lives in officialCoinsFor so an unreachable listing cannot be
    // watched, priced, basketed or sealed. If it were applied per-call-site,
    // one missed site would resurrect exactly the bug.
    const raw = OFFICIAL_COINS[MAINNET] ?? [];
    const nonUsdg = raw.filter((c) => c.quoteToken.toLowerCase() !== (CASH.USDT as string).toLowerCase());
    for (const c of nonUsdg) {
      assert.equal(officialCoinByAddress(MAINNET, c.address), null);
      assert.equal(officialCoinBySymbol(MAINNET, c.symbol), null);
      assert.ok(!officialCoinSymbols(MAINNET).includes(c.symbol));
      assert.ok(!officialCoinTokens(MAINNET).some((t) => t.address === c.address));
    }
  });

  it("looks a coin up by address and by symbol, case-insensitively", () => {
    // Runs over whatever is listed, so it stays true of an empty registry and
    // becomes load-bearing the moment one is added — rather than crashing on
    // `[0]!`, which is how these read before the first listing was retired.
    for (const c of officialCoinsFor(MAINNET)) {
      assert.equal(officialCoinByAddress(MAINNET, c.address.toUpperCase())?.symbol, c.symbol);
      assert.equal(officialCoinBySymbol(MAINNET, c.symbol.toLowerCase())?.address, c.address);
    }
    // These two hold with or without a listing, which is the half worth having
    // while the list is empty: a miss must be null, never a partial answer.
    assert.equal(officialCoinByAddress(MAINNET, "0x" + "9".repeat(40)), null);
    assert.equal(officialCoinBySymbol(MAINNET, "NOSUCHCOIN"), null);
  });

  it("has no duplicate symbol or address within a chain", () => {
    const coins = officialCoinsFor(MAINNET);
    assert.equal(new Set(coins.map((c) => c.symbol.toUpperCase())).size, coins.length);
    assert.equal(new Set(coins.map((c) => c.address.toLowerCase())).size, coins.length);
  });
});

describe("official coins — what a listing must never become", () => {
  it("is NOT in STOCK_TOKENS, on either address or symbol", () => {
    // Three separate breakages if it were, and the second is a hole in the wall:
    //   1. snapshot.ts probes tokenPaused() across STOCK_TOKENS. A Pons coin
    //      reverts, so its entry fails every tick and reports "unread" about a
    //      token that has nothing to read.
    //   2. builtinGrantTargets() derives from STOCK_TOKENS AT RUNTIME while the
    //      on-chain wall was sealed at SIGNING time — so the worker would
    //      believe it could sell something no signature covers.
    //   3. the web UI renders registry entries as stocks.
    const addrs = new Set(STOCK_TOKENS.map((t) => t.address.toLowerCase()));
    const syms = new Set(STOCK_TOKENS.map((t) => t.symbol.toUpperCase()));
    for (const c of officialCoinsFor(MAINNET)) {
      assert.ok(!addrs.has(c.address.toLowerCase()), `${c.symbol} must not be a registry address`);
      assert.ok(!syms.has(c.symbol.toUpperCase()), `${c.symbol} must not shadow a registry symbol`);
    }
  });

  it("is NOT already covered by builtinGrantTargets, so sealing it means something", () => {
    // If a listing were in the builtin set, usableExtraTokens would DROP it and
    // grantTokens would silently not carry it — a grant that looks signed for
    // the coin and is not.
    const builtin = builtinGrantTargets();
    for (const c of officialCoinsFor(MAINNET)) {
      assert.ok(!builtin.has(c.address.toLowerCase()), `${c.symbol} must need explicit sealing`);
    }
  });

  it("survives usableExtraTokens, which is what actually reaches the call policy", () => {
    const tokens = officialCoinTokens(MAINNET);
    const usable = usableExtraTokens(tokens);
    assert.equal(usable.length, tokens.length, "no listing may be silently dropped before the wall");
    for (const t of tokens) {
      assert.ok(usable.some((u) => u.address.toLowerCase() === t.address.toLowerCase()));
    }
  });

  it("de-duplicates against an owner who typed the same coin in by hand", () => {
    // Listings go first at the signer, so the VERIFIED address survives and the
    // hand-typed duplicate is dropped rather than producing two permissions.
    //
    // Uses a SYNTHETIC listing so the property is pinned whether or not the
    // platform is currently listing anything. `usableExtraTokens` is pure, so
    // this exercises the real de-duplication rather than a stand-in for it.
    const official = [{ symbol: "OFFICIAL", address: ("0x" + "d".repeat(40)) as `0x${string}`, decimals: 18 }];
    const ownerTyped = { symbol: "MYNAME", address: official[0]!.address, decimals: 6 };
    const usable = usableExtraTokens([...official, ownerTyped]);
    const hits = usable.filter((u) => u.address.toLowerCase() === official[0]!.address.toLowerCase());
    assert.equal(hits.length, 1, "the same address must not be sealed twice");
    assert.equal(hits[0]!.symbol, "OFFICIAL", "the listing's own symbol and decimals must win");
    assert.equal(hits[0]!.decimals, 18);
  });

  it("hands the signer exactly the CustomToken shape, with real decimals", () => {
    for (const t of officialCoinTokens(MAINNET)) {
      assert.deepEqual(Object.keys(t).sort(), ["address", "decimals", "symbol"]);
      assert.equal(typeof t.decimals, "number");
      // 18 is a guess that silently misvalues a 9dp coin — the asset model
      // divides by 10^decimals.
      assert.equal(t.decimals, officialCoinBySymbol(MAINNET, t.symbol)!.decimals);
    }
  });

  it("is frozen, so nothing can add a listing at runtime", () => {
    assert.ok(Object.isFrozen(OFFICIAL_COINS));
  });

  it("states in its own source that a listing is not permission", () => {
    // The one property no unit test can check by executing it: that the next
    // person to touch this file is told a listing cannot widen a signed grant.
    const src = readFileSync(path.join(__dirname, "official-coins.ts"), "utf8");
    assert.match(src, /re-sign/i, "the file must say a re-sign is required");
    assert.match(src, /STOCK_TOKENS/, "the file must say why it is not a registry entry");
  });
});

