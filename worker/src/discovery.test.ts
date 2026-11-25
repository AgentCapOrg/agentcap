/**
 * Discovery is the one path where a THIRD PARTY's data reaches a message the
 * owner reads and may act on. So the tests care about two things: that it picks
 * the right side of a pair, and that nothing an attacker controls — a token
 * symbol, a malformed event — gets through unshaped.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CASH } from "../../packages/core/src/index";
import {
  describeDiscovery,
  describeTrending,
  trendingStatusLine,
  discoverTrending,
  newTokenOf,
  sanitizeSymbol,
  type Discovery,
} from "./discovery";
import { applyVerdicts, nullScout } from "./strategist/memecoin-scout";
import { emptyGeckoBuckets, type GeckoPool } from "./venues/geckoterminal";

// 6dp micro figures, scaled to 18dp USDT base units.
const MICRO = 10n ** 12n;

const USDG = (CASH.USDT as string).toLowerCase() as `0x${string}`;
const WETH = (CASH.WBNB as string).toLowerCase() as `0x${string}`;
const CATE = "0x00000000000000000000000000000000000000c1" as const;
const DOGE = "0x00000000000000000000000000000000000000d0" as const;

const pair = (a: `0x${string}`, b: `0x${string}`) => ({
  token: a,
  quote: b,
  symbol: "",
  decimals: 18,
  protocol: "uniswap",
  createdAt: 1,
  txHash: "0x",
});

describe("newTokenOf — which side actually launched", () => {
  it("picks the non-cash side, whichever order it arrives in", () => {
    assert.equal(newTokenOf(pair(CATE, USDG)), CATE);
    assert.equal(newTokenOf(pair(USDG, CATE)), CATE);
    assert.equal(newTokenOf(pair(CATE, WETH)), CATE);
    assert.equal(newTokenOf(pair(WETH, CATE)), CATE);
  });

  it("says nothing about a cash/cash pool — USDG/WETH is not a launch", () => {
    assert.equal(newTokenOf(pair(USDG, WETH)), null);
    assert.equal(newTokenOf(pair(WETH, USDG)), null);
  });

  it("says nothing about an exotic pair with no cash leg", () => {
    // Nothing to value it against, so announcing it would be noise the owner
    // can't act on anyway.
    assert.equal(newTokenOf(pair(CATE, DOGE)), null);
  });

  it("treats native ETH as a cash side", () => {
    const NATIVE = "0x0000000000000000000000000000000000000000" as const;
    assert.equal(newTokenOf(pair(CATE, NATIVE)), CATE);
  });

  it("is case-insensitive about the cash addresses", () => {
    const upper = USDG.toUpperCase().replace("0X", "0x") as `0x${string}`;
    assert.equal(newTokenOf(pair(CATE, upper)), CATE);
  });
});

/**
 * A token's symbol is chosen by whoever deployed it and lands in a Telegram
 * message and an event line. Same reasoning as the memory sanitizers: strip
 * anything that could pass for markup or a list separator, and cap the length.
 */
describe("sanitizeSymbol", () => {
  it("keeps an ordinary ticker intact", () => {
    assert.equal(sanitizeSymbol("CATE"), "CATE");
    assert.equal(sanitizeSymbol("wstETH-1"), "wstETH-1");
  });

  it("strips markup, separators and whitespace", () => {
    assert.equal(sanitizeSymbol("<b>CATE</b>"), "bCATEb");
    assert.equal(sanitizeSymbol("CATE,NVDA"), "CATENVDA");
    assert.equal(sanitizeSymbol("CA TE"), "CATE");
    assert.equal(sanitizeSymbol("CATE\n/grant"), "CATEgrant");
  });

  it("caps the length so a symbol can't flood the message", () => {
    assert.equal(sanitizeSymbol("x".repeat(200)).length, 16);
  });

  it("never returns empty — an unnamed token still needs a label", () => {
    assert.equal(sanitizeSymbol(""), "?");
    assert.equal(sanitizeSymbol("<<<>>>"), "?");
  });
});

describe("describeDiscovery — what the owner is told", () => {
  const base: Discovery = {
    token: CATE,
    symbol: "CATE",
    decimals: 18,
    createdAt: 0,
    liquidityUsdg: (120_000_000_000n * MICRO), // $120k
    priceable: true,
    price8: 100_000n,
    fdvUsd: 800_000,
  };

  it("names the token, its depth and whether it can be priced", () => {
    const s = describeDiscovery(base);
    assert.match(s, /CATE/);
    assert.match(s, /120,000/);
    assert.match(s, /deep enough/);
  });

  it("gives the guard's own reason when it can't be priced", () => {
    const s = describeDiscovery({ ...base, priceable: false, reason: "pool too thin: 300 USDG" });
    assert.match(s, /can't price it yet/);
    assert.match(s, /too thin/);
  });

  it("handles an unpriceable pool with no depth reading at all", () => {
    const s = describeDiscovery({ ...base, liquidityUsdg: null, priceable: false, reason: "no route to USDG yet" });
    assert.match(s, /depth unknown/);
    assert.match(s, /no route/);
  });

  it("shows a truncated address so the owner can look it up", () => {
    assert.match(describeDiscovery(base), /0x00000000…/);
  });
});

/**
 * Trending and graduated coins — the discoverer that sees what is TRADING.
 *
 * The other two discoverers watch things being born: a Uniswap Initialize
 * event, or a Pons launch. Both are blind by construction to a coin that
 * launched last week and is up 40% today. These tests are mostly about the
 * boundaries of what this one is allowed to do with what it finds.
 */
describe("discoverTrending", () => {
  const pool = (over: Partial<GeckoPool> = {}): GeckoPool => ({
    poolId: "0x" + "1".repeat(40),
    poolAddress: null,
    tokenAddress: `0x${"a".repeat(40)}`,
    name: "AAA / WETH",
    dex: "pancakeswap-v3-bsc",
    priceUsd: 1,
    reserveUsd: 500_000,
    fdvUsd: 5_000_000,
    volume24hUsd: 900_000,
    change24hPct: 20,
    change1hPct: 1,
    buys24h: 900,
    sells24h: 700,
    buyers24h: 400,
    buckets: emptyGeckoBuckets(),
    createdAt: 1,
    ...over,
  });
  const LIMITS = { minReserveUsd: 25_000, minVolume24hUsd: 50_000, minBuyers24h: 100 };
  const keepAll = {
    name: "t",
    rank: async (ps: readonly GeckoPool[]) =>
      applyVerdicts(ps, { keep: ps.map((_, i) => ({ index: i, conviction: 3, reason: "r" })) }),
  };
  // A client whose ERC-20 reads always fail, so identity falls back to the
  // address — the path that must not throw.
  const blindClient = { async readContract() { throw new Error("no"); } } as never;

  const deps = (pools: GeckoPool[], over: Record<string, unknown> = {}) => ({
    client: blindClient,
    seen: new Set<string>(),
    known: [],
    fetchPools: async () => pools,
    scout: keepAll,
    limits: LIMITS,
    nowSec: 1_000,
    ...over,
  });

  it("keeps provider failures distinct from a successful empty ranking", async () => {
    const failed = await discoverTrending(deps([pool()], { scout: {
      name: "groq", rank: async () => ({ picks: [], passed: [], ignored: [], failed: true }),
    } }) as never);
    assert.equal(failed.researchStatus, "failed");
    assert.match(trendingStatusLine(failed), /research failed/);
    assert.doesNotMatch(trendingStatusLine(failed), /none worth mentioning/);
    const unavailable = await discoverTrending(deps([pool()], { scout: nullScout }) as never);
    assert.equal(unavailable.researchStatus, "unavailable");
    assert.match(trendingStatusLine(unavailable), /unassessed/);
    const pass = await discoverTrending(deps([pool()], { scout: {
      name: "groq", rank: async () => ({ picks: [], passed: [], ignored: [] }),
    } }) as never);
    assert.equal(pass.researchStatus, "ok");
    assert.match(trendingStatusLine(pass), /none worth mentioning/);
  });

  it("dedupes a coin that appears on several venues, keeping the DEEPEST", async () => {
    // The owner cares about the coin, not the pool — and the deepest venue is
    // the one a trade would actually reach.
    const res = await discoverTrending(deps([pool({ reserveUsd: 100_000 }), pool({ reserveUsd: 800_000 })]) as never);
    assert.equal(res.picks.length, 1);
    assert.equal(res.picks[0]!.pool.reserveUsd, 800_000);
  });

  it("skips what the owner already has and what has already been reported", async () => {
    const seen = new Set([pool().tokenAddress]);
    assert.equal((await discoverTrending(deps([pool()], { seen }) as never)).picks.length, 0);
    const known = [{ symbol: "AAA", name: "AAA", address: pool().tokenAddress, chainlinkFeed: null, kind: "memecoin" }];
    assert.equal((await discoverTrending(deps([pool()], { known }) as never)).picks.length, 0);
  });

  it("does not fall over when the token is not a readable ERC-20", async () => {
    // It still trades, so it is still worth reporting — by address rather than
    // by a name nobody could verify.
    const res = await discoverTrending(deps([pool()]) as never);
    assert.match(res.picks[0]!.symbol, /^0x/);
  });

  it("NEVER takes the index's own label as the symbol", async () => {
    // GeckoTerminal's `name` is attacker-chosen text headed for a human and
    // could be picked to impersonate a real ticker. Identity comes from the
    // contract or from the address, never from the feed.
    const res = await discoverTrending(deps([pool({ name: "USDG / WETH" })]) as never);
    assert.ok(!res.picks[0]!.symbol.includes("USDG"));
  });

  it("picks NOTHING when there is no brain to narrow with", async () => {
    // nullScout is the safe default: this step exists to exclude, so with
    // nothing doing the excluding, nothing has been vetted.
    const res = await discoverTrending(deps([pool()], { scout: nullScout }) as never);
    assert.equal(res.picks.length, 0);
    assert.equal(res.screened, 1, "but it still reports what the screen kept");
  });

  it("reports the funnel honestly at every stage", async () => {
    const thin = pool({ tokenAddress: `0x${"c".repeat(40)}`, reserveUsd: 10 });
    const res = await discoverTrending(deps([pool(), thin]) as never);
    assert.equal(res.scanned, 2, "both were seen");
    assert.equal(res.screened, 1, "one cleared the screen");
    assert.equal(res.picks.length, 1);
  });
});
