import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { steadyBasketTick, type SteadyBasketConfig } from "./steady-basket";
import { takeTick, type Snapshot } from "./types";

/**
 * steadyBasketTick now returns its reasons alongside its intents. These tests
 * predate that and are about the intents, so they keep asserting on those.
 */
const sbTick = (...a: Parameters<typeof steadyBasketTick>) => takeTick(steadyBasketTick(...a)).intents;

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const AAPL = "0x4444444444444444444444444444444444444444" as const;
const MSFT = "0x5555555555555555555555555555555555555555" as const;

function cfg(over: Partial<SteadyBasketConfig> = {}): SteadyBasketConfig {
  return {
    legs: [
      { symbol: "AAPL", token: AAPL, weightBps: 5_000 },
      { symbol: "MSFT", token: MSFT, weightBps: 5_000 },
    ],
    buyPerTickUsdg: 20_000_000n, // 20 USDG per tick
    swapRouter: ROUTER,
    usdg: USDG,
    ...over,
  };
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    cashUsdg: 100_000_000n, // 100 USDG
    vaultUsdg: 0n,
    holdings: new Map(),
    prices: new Map(),
    pausedTokens: new Set<string>(),
    staleFeeds: new Set<string>(),
    sequencerUp: true,
    // Wide open by default: these fixtures predate cap-aware sizing, so the
    // headroom must not clamp them. Clamping is pinned in its own test.
    spendHeadroomUsdg: 1_000_000_000_000n,
    perTradeCapUsdg: 1_000_000_000_000n,
    ...over,
  };
}

describe("steadyBasketTick", () => {
  it("emits nothing when the sequencer is down", () => {
    assert.deepEqual(sbTick(cfg(), snap({ sequencerUp: false })), []);
  });

  it("splits the tick budget across legs by weight", () => {
    const intents = sbTick(cfg(), snap());
    const swaps = intents.filter((i) => i.kind === "swap");
    assert.equal(swaps.length, 2);
    for (const s of swaps) {
      assert.equal(s.kind === "swap" && s.sellAmountRaw, 10_000_000n);
      assert.equal(s.kind === "swap" && s.notionalUsdg, 10_000_000n);
      assert.equal(s.target, ROUTER);
    }
  });

  it("skips paused tokens but still buys the rest", () => {
    const intents = sbTick(
      cfg(),
      snap({ pausedTokens: new Set([AAPL.toLowerCase()]) }),
    );
    const swaps = intents.filter((i) => i.kind === "swap");
    assert.equal(swaps.length, 1);
    assert.equal(swaps[0]!.kind === "swap" && swaps[0]!.buyToken, MSFT);
  });

  it("skips legs with a stale price feed", () => {
    const intents = sbTick(cfg(), snap({ staleFeeds: new Set(["MSFT"]) }));
    const swaps = intents.filter((i) => i.kind === "swap");
    assert.equal(swaps.length, 1);
    assert.equal(swaps[0]!.kind === "swap" && swaps[0]!.buyToken, AAPL);
  });

  it("shrinks the weighted basket to available cash", () => {
    const intents = sbTick(cfg(), snap({ cashUsdg: 19_000_000n }));
    const buys = intents.filter(i => i.kind === "swap");
    assert.equal(buys.length, 2);
    assert.deepEqual(buys.map(i => i.sellAmountRaw), [9_500_000n, 9_500_000n]);
  });

  it("respects per-trade and daily caps while shrinking a Shogun-sized ticket", () => {
    const intents = sbTick(cfg({ buyPerTickUsdg: 25_000_000n }), snap({ cashUsdg: 23_669_414n, perTradeCapUsdg: 5_000_000n, spendHeadroomUsdg: 7_000_000n }));
    assert.deepEqual(intents.filter(i => i.kind === "swap").map(i => i.sellAmountRaw), [5_000_000n, 2_000_000n]);
  });

  it("does not spend cash or create zero orders when cash or the cap is zero", () => {
    for (const s of [snap({ cashUsdg: 0n }), snap({ perTradeCapUsdg: 0n })]) {
      assert.equal(sbTick(cfg(), s).some(i => i.kind === "swap"), false);
    }
  });
});

/**
 * THE DAY'S BUDGET WAS BINDING ON THE SWEEP AND NOT ON THE BUYS.
 *
 * The buy loop consulted `cashUsdg` and nothing else, so once the daily cap was
 * spent it proposed the same legs every tick and checkPolicy refused every one.
 * On shipped defaults that is not an edge case: 25 USDG a tick at 60s against a
 * 50 USDG daily cap spends the whole allowance in TWO MINUTES and then refuses
 * for the remaining 1,438 — three refusals a tick, roughly 4,300 a day.
 *
 * The second half matters as much as the first. `bought` goes true whenever the
 * loop pushes anything, and `bought` true means `idle` is never set — so the
 * machine built to say why nothing happened could not fire in the commonest way
 * for nothing to happen.
 */
describe("the daily budget binds the buy loop", () => {
  it("proposes nothing when the day's budget is spent, however much cash is on hand", () => {
    // 900 USDG of cash and no permission to spend any of it. Before the clamp
    // this returned two swaps that the wall refused, every tick, all day.
    const out = takeTick(
      steadyBasketTick(cfg(), snap({ cashUsdg: 900_000_000n, spendHeadroomUsdg: 0n })),
    );
    assert.deepEqual(
      out.intents.filter((i) => i.kind === "swap"),
      [],
      "a buy the wall will certainly refuse must not be proposed",
    );
  });

  it("and SAYS SO, which it structurally could not before", () => {
    const out = takeTick(
      steadyBasketTick(cfg(), snap({ cashUsdg: 900_000_000n, spendHeadroomUsdg: 0n })),
    );
    assert.equal(out.idle?.code, "budget-spent");
  });

  it("does not blame the cash when the cash is fine", () => {
    // `under-one-buy` reads "you have X and one buy costs Y" — a baffling thing
    // to be told while holding 900 USDG. Ordering is the whole fix.
    const out = takeTick(
      steadyBasketTick(cfg(), snap({ cashUsdg: 900_000_000n, spendHeadroomUsdg: 0n })),
    );
    assert.notEqual(out.idle?.code, "under-one-buy");
  });

  it("clamps a partial budget instead of proposing the full tick", () => {
    // 20 USDG a tick across two 50% legs, with only 6 USDG of headroom left.
    // Gating on `headroom > 0` alone would still propose 10 + 10 and be refused.
    const intents = sbTick(cfg(), snap({ spendHeadroomUsdg: 6_000_000n }));
    const spent = intents
      .filter((i) => i.kind === "swap")
      .reduce((sum, i) => sum + (i.kind === "swap" ? i.notionalUsdg : 0n), 0n);
    assert.ok(spent > 0n, "a partial budget still buys something");
    assert.ok(spent <= 6_000_000n, `proposed ${spent} against 6 USDG of headroom`);
  });

  it("never proposes a zero-sized leg when the budget runs out mid-basket", () => {
    // The first leg takes the last of it; the second must be dropped, not
    // pushed at zero for `non-positive` to refuse.
    const intents = sbTick(cfg(), snap({ spendHeadroomUsdg: 10_000_000n }));
    for (const i of intents) {
      if (i.kind === "swap") assert.ok(i.notionalUsdg > 0n, "a zero-sized buy is not a trade");
    }
  });

  it("an ample budget is unchanged — this must not throttle a healthy agent", () => {
    const intents = sbTick(cfg(), snap());
    const swaps = intents.filter((i) => i.kind === "swap");
    assert.equal(swaps.length, 2);
    const spent = swaps.reduce((sum, i) => sum + (i.kind === "swap" ? i.notionalUsdg : 0n), 0n);
    assert.equal(spent, 20_000_000n, "the full per-tick size still goes out");
  });
});
