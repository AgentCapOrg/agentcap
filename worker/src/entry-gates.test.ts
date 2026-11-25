/**
 * A GATE IS A REFUSAL THE WALL WOULD MAKE ANYWAY — NEVER ONE IT WOULD NOT.
 *
 * entry-gates.ts lets a strategy skip a buy before proposing it. That is only
 * safe in one direction: every gate must be a refusal checkPolicy writes with
 * the SAME rule, given limits that pass everything else. A gate the wall would
 * accept is this mirror going stricter than the chain, which policy.ts calls a
 * real bug in as many words — so the sweep below drives every gated case
 * through checkPolicy itself rather than restating its rules.
 *
 * And the other half of the contract: an exit is never gated, and the per-arm
 * backstop lets exactly one gated buy per (token, rule) reach the wall.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkPolicy, type AgentLimits, type AgentState, type TradeIntent } from "./policy";
import { entryGateFor, entryGateLatch, entryGatesOf, intentEntryGate } from "./entry-gates";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const TRENCH_VAULT = "0x5555555555555555555555555555555555555555" as const;
/** Allowed and sellable — the ordinary case. */
const OK = "0xaAaaAaAaaAaAaaaAaAAAaaAaaAaaAAaAAaaAAAaA" as const;
/** Watched (allowed) but not covered by the signature — the `no-exit` case. */
const WATCHED = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
/** In the signature but not watched. */
const SIGNED = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
/** Neither. */
const NEITHER = "0xdddddddddddddddddddddddddddddddddddddddd" as const;
const TOKENS = [OK, WATCHED, SIGNED, NEITHER] as const;

const NOW = 1_800_000_000;

/** Limits that pass EVERYTHING except the two rules under test. */
function limits(over: Partial<AgentLimits> = {}): AgentLimits {
  return {
    perTradeUsdg: 1_000_000_000n,
    dailyUsdg: 10_000_000_000n,
    allowedTargets: [ROUTER, USDG, TRENCH_VAULT],
    allowedAssets: [USDG, OK, WATCHED],
    sellableAssets: [USDG, OK, SIGNED],
    quoteAssets: [USDG],
    cashToken: USDG,
    maxDrawdownBps: 1_000,
    expiresAt: NOW + 86_400,
    maxOpsPerDay: 1_000,
    ...over,
  };
}

const state: AgentState = { spentTodayUsdg: 0n, opsToday: 0, highWaterMarkUsdg: 0n, equityUsdg: 0n, nowSec: NOW };

const buySwap = (token: `0x${string}`): TradeIntent => ({
  kind: "swap",
  target: ROUTER,
  sellToken: USDG,
  buyToken: token,
  sellAmountRaw: 5_000_000n,
  notionalUsdg: 5_000_000n,
});

/** Every shape of the two lists a grant can produce, including "the rule cannot run". */
const SHAPES: { name: string; over: Partial<AgentLimits> }[] = [
  { name: "both lists", over: {} },
  { name: "no sellable list (fixture/backtest)", over: { sellableAssets: undefined } },
  { name: "an empty sellable list", over: { sellableAssets: [] } },
  { name: "mixed-case lists", over: { allowedAssets: [USDG, OK.toUpperCase().replace("0X", "0x") as `0x${string}`, WATCHED], sellableAssets: [USDG.toUpperCase().replace("0X", "0x"), OK, SIGNED] } },
];

describe("one-direction parity: a gate implies checkPolicy refuses with the same rule", () => {
  for (const shape of SHAPES) {
    it(`swap, ${shape.name}`, () => {
      const l = limits(shape.over);
      const gates = entryGatesOf(l);
      let gated = 0;
      for (const token of TOKENS) {
        const rule = entryGateFor(gates, token);
        const intent = buySwap(token);
        const verdict = checkPolicy(intent, l, state);
        if (rule !== null) {
          gated += 1;
          assert.equal(verdict.ok, false, `gate ${rule} on ${token} but the wall would accept it`);
          assert.equal(!verdict.ok && verdict.rule, rule, `gate names ${rule}, the wall names another`);
        }
        // The intent-level gate is the same answer, for the same token.
        const whole = intentEntryGate(intent, l);
        assert.deepEqual(whole, rule === null ? null : { token: token.toLowerCase(), rule });
      }
      // The sweep must actually exercise the rule, or it proves nothing.
      assert.ok(gated > 0, "nothing was gated");
    });
  }

  it("the swap gate asks in the wall's order: not watched is asset-allowlist before it is no-exit", () => {
    const gates = entryGatesOf(limits());
    assert.equal(entryGateFor(gates, NEITHER), "asset-allowlist");
    assert.equal(entryGateFor(gates, WATCHED), "no-exit");
    assert.equal(entryGateFor(gates, SIGNED), "asset-allowlist");
    assert.equal(entryGateFor(gates, OK), null);
  });

  it("unread gates gate nothing", () => {
    for (const token of TOKENS) {
      assert.equal(entryGateFor(undefined, token), null);
      assert.equal(entryGateFor(null, token), null);
    }
  });
});

describe("what a gate must never touch", () => {
  it("AN EXIT IS NEVER GATED — not into cash, not out of a coin the key cannot even sell", () => {
    const l = limits();
    for (const token of TOKENS) {
      const sell: TradeIntent = { kind: "swap", target: ROUTER, sellToken: token, buyToken: USDG, sellAmountRaw: 1n, notionalUsdg: 1n };
      assert.equal(intentEntryGate(sell, l), null, `swap exit out of ${token}`);
    }
  });

  it("AND NOT BY LUCK: an exit into a cash leg the gate WOULD refuse to buy is still never gated", () => {
    // The fixture above lists USDG as allowed and sellable, so a sell into it
    // was never gated whatever intentEntryGate asked first — the isExitIntent
    // guard could be deleted and that test would still pass. Here the cash leg
    // itself is on neither list, so only the guard stands between an exit and
    // a gate.
    const l = limits({ allowedAssets: [OK, WATCHED], sellableAssets: [OK, SIGNED] });
    const gates = entryGatesOf(l);
    assert.equal(entryGateFor(gates, USDG), "asset-allowlist", "buying the cash leg WOULD be gated");
    const latch = entryGateLatch();
    for (const token of TOKENS) {
      const sell: TradeIntent = { kind: "swap", target: ROUTER, sellToken: token, buyToken: USDG, sellAmountRaw: 1n, notionalUsdg: 1n };
      for (const exit of [sell]) {
        assert.equal(intentEntryGate(exit, l), null, `${exit.kind} exit out of ${token}`);
        // Nor can the backstop ever hold one back — not even after a row
        // naming the rule the cash leg would be refused under.
        for (let tick = 0; tick < 3; tick++) {
          assert.equal(latch.withhold(exit, l), false, `${exit.kind} exit out of ${token}, tick ${tick}`);
          latch.settle(exit, l, { status: "rejected", rejectRule: "asset-allowlist" });
        }
      }
    }
  });

  it("the autonomous trencher rail is judged by its vault's assets, not these lists", () => {
    const intent: TradeIntent = { ...(buySwap(NEITHER) as Extract<TradeIntent, { kind: "swap" }>), target: TRENCH_VAULT, custody: "trencher" };
    assert.equal(intentEntryGate(intent, limits()), null);
  });

  it("transfers and equity orders are not these rules' business", () => {
    const l = limits();
    const others: TradeIntent[] = [
      { kind: "transfer", target: USDG, recipient: OK, amountUsdg: 1n },
      { kind: "equity-order", ticker: "AAPL", side: "buy", notionalUsdg: 1n },
    ];
    for (const intent of others) assert.equal(intentEntryGate(intent, l), null, intent.kind);
  });
});

describe("the backstop: one rejected row per (token, rule) per arm, then withheld", () => {
  /**
   * index.ts's proposal loop, as far as the latch sees it: ask `withhold`, and
   * if the intent goes on, `settle` with the row the wall wrote — here the
   * wall's own verdict, through checkPolicy, never a restatement of it. True
   * when the intent was withheld.
   */
  const reach = (latch: ReturnType<typeof entryGateLatch>, intent: TradeIntent, l: AgentLimits): boolean => {
    if (latch.withhold(intent, l)) return true;
    const verdict = checkPolicy(intent, l, state);
    latch.settle(intent, l, verdict.ok ? { status: "paper" } : { status: "rejected", rejectRule: verdict.rule });
    return false;
  };

  it("lets the FIRST gated buy through so the wall writes its own refusal, and withholds every repeat", () => {
    const latch = entryGateLatch();
    const l = limits();
    assert.equal(reach(latch, buySwap(WATCHED), l), false, "the one row this arm");
    for (let tick = 0; tick < 50; tick++) assert.equal(reach(latch, buySwap(WATCHED), l), true);
  });

  it("keys on token AND rule, case-blind", () => {
    const latch = entryGateLatch();
    const l = limits();
    assert.equal(reach(latch, buySwap(WATCHED), l), false);
    assert.equal(reach(latch, buySwap(NEITHER), l), false, "another token gets its own row");
    assert.equal(reach(latch, buySwap(WATCHED.toUpperCase().replace("0X", "0x") as `0x${string}`), l), true);
    // The same token refused under a different rule is a different fact, and
    // gets its own row: the owner is owed both sentences.
    const narrow = limits({ sellableAssets: [USDG] });
    assert.equal(reach(latch, buySwap(OK), limits({ allowedAssets: [USDG] })), false, "asset-allowlist is one rule");
    assert.equal(reach(latch, buySwap(OK), narrow), false, "no-exit is a different rule");
    assert.equal(reach(latch, buySwap(OK), narrow), true);
  });

  it("THE ROW IS SPENT WHEN THE WALL WRITES IT — a gated buy stopped before the wall leaves it owed", () => {
    const latch = entryGateLatch();
    const l = limits();
    // A refused group claim or a failed decision
    // row: `withhold` let it go and nothing ever reached the wall. Asking
    // again, any number of times, must not spend the row.
    for (let tick = 0; tick < 5; tick++) assert.equal(latch.withhold(buySwap(WATCHED), l), false, `stopped before the wall, tick ${tick}`);
    // processIntentReporting returned null: no row was written.
    latch.settle(buySwap(WATCHED), l, null);
    assert.equal(latch.withhold(buySwap(WATCHED), l), false, "no row, nothing spent");
    // The wall refused it under ANOTHER rule — the breaker, a cap. That is a
    // different sentence; this one is still owed.
    latch.settle(buySwap(WATCHED), l, { status: "rejected", rejectRule: "drawdown" });
    assert.equal(latch.withhold(buySwap(WATCHED), l), false, "another rule's row does not say no-exit");
    // Then it reaches the wall and the wall says `no-exit`: spent, for the arm.
    latch.settle(buySwap(WATCHED), l, { status: "rejected", rejectRule: "no-exit" });
    assert.equal(latch.withhold(buySwap(WATCHED), l), true);
  });

  it("never withholds what is not gated, and never an exit", () => {
    const latch = entryGateLatch();
    const l = limits();
    for (let tick = 0; tick < 5; tick++) {
      assert.equal(reach(latch, buySwap(OK), l), false);
      assert.equal(
        reach(latch, { kind: "swap", target: ROUTER, sellToken: WATCHED, buyToken: USDG, sellAmountRaw: 1n, notionalUsdg: 1n }, l),
        false,
      );
    }
  });

  it("an arm clears it, so a re-sign starts with its own first row", () => {
    const latch = entryGateLatch();
    const l = limits();
    reach(latch, buySwap(WATCHED), l);
    assert.equal(reach(latch, buySwap(WATCHED), l), true);
    latch.clear();
    assert.equal(reach(latch, buySwap(WATCHED), l), false);
  });
});
