import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkPolicy, type AgentLimits, type AgentState, type TradeIntent } from "./policy";

// 6dp micro figures, scaled to 18dp USDT base units.
const MICRO = 10n ** 12n;

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const AAPL = "0x4444444444444444444444444444444444444444" as const;
const EVIL = "0x9999999999999999999999999999999999999999" as const;

const NOW = 1_800_000_000;

function limits(over: Partial<AgentLimits> = {}): AgentLimits {
  return {
    perTradeUsdg: (50_000_000n * MICRO), // 50 USDG
    dailyUsdg: (500_000_000n * MICRO), // 500 USDG
    allowedTargets: [ROUTER, VAULT, USDG],
    allowedAssets: [USDG, AAPL],
    maxDrawdownBps: 1_000, // 10%
    expiresAt: NOW + 86_400,
    maxOpsPerDay: 48,
    ...over,
  };
}

function state(over: Partial<AgentState> = {}): AgentState {
  return {
    spentTodayUsdg: 0n,
    opsToday: 0,
    highWaterMarkUsdg: 0n,
    equityUsdg: 0n,
    nowSec: NOW,
    ...over,
  };
}

function swap(over: Partial<Extract<TradeIntent, { kind: "swap" }>> = {}): TradeIntent {
  return {
    kind: "swap",
    target: ROUTER,
    sellToken: USDG,
    buyToken: AAPL,
    sellAmountRaw: (25_000_000n * MICRO),
    notionalUsdg: (25_000_000n * MICRO),
    ...over,
  };
}

describe("checkPolicy", () => {
  it("approves a legal swap", () => {
    assert.deepEqual(checkPolicy(swap(), limits(), state()), { ok: true });
  });

  it("rejects after expiry, regardless of everything else", () => {
    const v = checkPolicy(swap(), limits(), state({ nowSec: NOW + 86_401 }));
    assert.equal(v.ok, false);
    assert.equal(!v.ok && v.rule, "expiry");
  });

  it("rejects a target that is not allowlisted", () => {
    const v = checkPolicy(swap({ target: EVIL }), limits(), state());
    assert.equal(!v.ok && v.rule, "target-allowlist");
  });

  it("target allowlist is case-insensitive", () => {
    const upper = ROUTER.toUpperCase().replace("0X", "0x") as `0x${string}`;
    assert.deepEqual(checkPolicy(swap({ target: upper }), limits(), state()), { ok: true });
  });

  it("rejects a swap involving a non-allowlisted asset", () => {
    const v = checkPolicy(swap({ buyToken: EVIL }), limits(), state());
    assert.equal(!v.ok && v.rule, "asset-allowlist");
  });

  it("rejects a trade above the per-trade cap", () => {
    const v = checkPolicy(swap({ sellAmountRaw: (50_000_001n * MICRO), notionalUsdg: (50_000_001n * MICRO) }), limits(), state());
    assert.equal(!v.ok && v.rule, "per-trade-cap");
  });

  it("allows a trade exactly at the per-trade cap", () => {
    assert.deepEqual(checkPolicy(swap({ sellAmountRaw: (50_000_000n * MICRO), notionalUsdg: (50_000_000n * MICRO) }), limits(), state()), { ok: true });
  });

  it("rejects when the daily cap would be exceeded", () => {
    const v = checkPolicy(swap(), limits(), state({ spentTodayUsdg: (490_000_000n * MICRO) }));
    assert.equal(!v.ok && v.rule, "daily-cap");
  });

  it("counts existing spend toward the daily cap, not just this trade", () => {
    assert.deepEqual(
      checkPolicy(swap(), limits(), state({ spentTodayUsdg: (475_000_000n * MICRO) })),
      { ok: true },
    );
  });

  it("trips the drawdown breaker at the threshold", () => {
    // HWM 1000, equity 900 → exactly 10% drawdown → halt
    const v = checkPolicy(
      swap(),
      limits(),
      state({ highWaterMarkUsdg: (1_000_000_000n * MICRO), equityUsdg: (900_000_000n * MICRO) }),
    );
    assert.equal(!v.ok && v.rule, "drawdown-breaker");
  });

  describe("a tripped breaker must never lock the exit", () => {
    // The breaker brakes RISK; it does not bar the doors. Applied to every
    // kind it rejected the sell that would clear the position, the vault
    // withdrawal that would pull cash back, and the transfer home — while the
    // high-water mark only ratchets up, so nothing the agent could do cleared
    // it. The account was stuck until a human intervened, and the escape the
    // code actually offered was to DEPOSIT MORE.
    const tripped = { highWaterMarkUsdg: (1_000_000_000n * MICRO), equityUsdg: (800_000_000n * MICRO) }; // 20%

    it("still refuses a BUY — that is the whole point of the breaker", () => {
      const v = checkPolicy(swap(), limits({ cashToken: USDG }), state(tripped));
      assert.equal(!v.ok && v.rule, "drawdown-breaker");
    });

    it("ALLOWS the de-risking sell — swapping back into cash", () => {
      const sell = swap({ sellToken: AAPL, buyToken: USDG });
      const v = checkPolicy(sell, limits({ cashToken: USDG }), state(tripped));
      assert.deepEqual(v, { ok: true });
    });

    it("ALLOWS sending money home to a pinned recipient", () => {
      const v = checkPolicy(
        { kind: "transfer", target: USDG, recipient: EVIL, amountUsdg: (10_000_000n * MICRO) },
        // EVIL is only "evil" elsewhere; here it stands for a registered
        // withdrawal address the wall already pinned at signing time.
        limits({ cashToken: USDG, withdrawalAddresses: [EVIL] }),
        state(tripped),
      );
      assert.deepEqual(v, { ok: true });
    });

    it("without a cashToken it stays STRICT — a fixture must not silently widen the wall", () => {
      const sell = swap({ sellToken: AAPL, buyToken: USDG });
      const v = checkPolicy(sell, limits(), state(tripped)); // no cashToken
      assert.equal(!v.ok && v.rule, "drawdown-breaker");
    });

    it("an exit is still subject to every OTHER rule — this is not a bypass", () => {
      const sell = swap({ sellToken: AAPL, buyToken: USDG });
      const v = checkPolicy(sell, limits({ cashToken: USDG }), state({ ...tripped, nowSec: NOW + 999_999 }));
      assert.equal(!v.ok && v.rule, "expiry");
    });
  });

  it("does not trip the breaker just below the threshold", () => {
    const v = checkPolicy(
      swap(),
      limits(),
      state({ highWaterMarkUsdg: (1_000_000_000n * MICRO), equityUsdg: (901_000_000n * MICRO) }),
    );
    assert.deepEqual(v, { ok: true });
  });

  it("ignores drawdown before any high-water mark exists", () => {
    assert.deepEqual(
      checkPolicy(swap(), limits(), state({ highWaterMarkUsdg: 0n, equityUsdg: 0n })),
      { ok: true },
    );
  });

  /**
   * UNKNOWN equity is not LOW equity.
   *
   * When a held asset can't be valued — a memecoin whose pool got too thin, a
   * feed that was withdrawn — the tick's equity figure is a partial sum with
   * that holding simply missing. Judging a drawdown on it reads the gap as a
   * loss, trips the breaker, and rejects every intent INCLUDING the sell that
   * would clear the position. The agent locks the owner in at the exact moment
   * it promised them "you can always get out", and it can never recover on its
   * own: the high-water mark isn't lowered while the book is incomplete, and the
   * book stays incomplete while the token is held.
   */
  describe("drawdown breaker on an unknown book", () => {
    // $8k of the $10k book is an unpriceable memecoin; the visible part is $2k.
    const partial = { highWaterMarkUsdg: (10_000_000_000n * MICRO), equityUsdg: (2_000_000_000n * MICRO) };

    it("does NOT judge a drawdown when the book can't be totalled", () => {
      assert.deepEqual(
        checkPolicy(swap(), limits(), state({ ...partial, equityKnown: false })),
        { ok: true },
      );
    });

    it("still trips on the same numbers when the book IS complete", () => {
      const v = checkPolicy(swap(), limits(), state({ ...partial, equityKnown: true }));
      assert.equal(!v.ok && v.rule, "drawdown-breaker", "a real 80% drawdown must still halt");
    });

    it("treats an absent flag as a known book, so existing callers are unchanged", () => {
      const v = checkPolicy(swap(), limits(), state(partial));
      assert.equal(!v.ok && v.rule, "drawdown-breaker");
    });

    it("an unknown book does not become a free pass — every other rule still applies", () => {
      const unknown = { ...partial, equityKnown: false };
      assert.equal(
        !checkPolicy(swap(), limits(), state({ ...unknown, opsToday: 48 })).ok,
        true,
        "ops cap",
      );
      assert.equal(
        !checkPolicy(swap(), limits(), state({ ...unknown, spentTodayUsdg: (490_000_000n * MICRO) })).ok,
        true,
        "daily cap",
      );
      assert.equal(
        !checkPolicy(swap(), limits(), state({ ...unknown, nowSec: 9_999_999_999 })).ok,
        true,
        "expiry",
      );
    });
  });

  it("rejects once the daily ops budget is spent", () => {
    const v = checkPolicy(swap(), limits(), state({ opsToday: 48 }));
    assert.equal(!v.ok && v.rule, "ops-cap");
  });

  // ── transfers: money leaving the wall is a spend, not a withdrawal ────────
  const RECIPIENT = "0x5555555555555555555555555555555555555555" as const;
  const transfer = (over: Partial<Extract<TradeIntent, { kind: "transfer" }>> = {}): TradeIntent => ({
    kind: "transfer",
    target: USDG,
    recipient: RECIPIENT,
    amountUsdg: (25_000_000n * MICRO),
    ...over,
  });

  it("approves a legal transfer (free-form recipient, capped amount)", () => {
    assert.deepEqual(checkPolicy(transfer(), limits(), state()), { ok: true });
  });

  it("rejects a transfer with a malformed recipient — garbage never reaches calldata", () => {
    const v = checkPolicy(transfer({ recipient: "robins-other-wallet" as `0x${string}` }), limits(), state());
    assert.equal(!v.ok && v.rule, "transfer-recipient");
    const v2 = checkPolicy(transfer({ recipient: "0xdeadbeef" as `0x${string}` }), limits(), state());
    assert.equal(!v2.ok && v2.rule, "transfer-recipient");
  });

  it("rejects a zero/negative transfer", () => {
    const v = checkPolicy(transfer({ amountUsdg: 0n }), limits(), state());
    assert.equal(!v.ok && v.rule, "transfer-amount");
  });

  it("transfers obey the per-trade cap", () => {
    const v = checkPolicy(transfer({ amountUsdg: (50_000_001n * MICRO) }), limits(), state());
    assert.equal(!v.ok && v.rule, "per-trade-cap");
  });

  it("transfers count against the daily cap — NOT exempt like vault withdrawals", () => {
    const v = checkPolicy(transfer(), limits(), state({ spentTodayUsdg: (490_000_000n * MICRO) }));
    assert.equal(!v.ok && v.rule, "daily-cap");
  });

  it("transfers still respect expiry and the ops cap", () => {
    const expired = checkPolicy(transfer(), limits(), state({ nowSec: NOW + 86_401 }));
    assert.equal(!expired.ok && expired.rule, "expiry");
    const throttled = checkPolicy(transfer(), limits(), state({ opsToday: 48 }));
    assert.equal(!throttled.ok && throttled.rule, "ops-cap");
  });
});

/**
 * NEVER ENTER A POSITION THE KEY CANNOT EXIT.
 *
 * Buying spends USDG, and approving USDG is one generic permission every grant
 * carries. Selling needs a per-token approve sealed into the signature. So a
 * token with a live pool but no approve permission buys fine and can never be
 * sold — the exit reverts at the wall, with the owner's money inside.
 *
 * This is not hypothetical. On 2026-07-27, eleven registry stocks (AAPL, MSFT,
 * SPY and friends) had live pools while the signed allowlist still read
 * QQQ/NVDA/TSLA, and /settings offered every one of them as a basket option.
 */
describe("checkPolicy — the no-exit rule", () => {
  const CATE = "0x5555555555555555555555555555555555555555" as const;
  const sellable = (...a: string[]) => limits({ allowedAssets: [USDG, AAPL, CATE], sellableAssets: a });

  it("REFUSES a buy the key cannot sell back", () => {
    const v = checkPolicy(swap({ buyToken: CATE }), sellable(USDG, AAPL), state());
    assert.equal(v.ok, false);
    assert.equal(v.ok === false && v.rule, "no-exit");
  });

  it("allows the buy once the grant covers it", () => {
    assert.equal(checkPolicy(swap({ buyToken: CATE }), sellable(USDG, AAPL, CATE), state()).ok, true);
  });

  it("NEVER blocks a sell — an exit must always be attemptable", () => {
    // CATE is not sellable per the grant, but the agent is holding it and
    // trying to get out. Refusing here would be the trap, not the guard.
    const v = checkPolicy(
      swap({ sellToken: CATE, buyToken: USDG }),
      sellable(USDG, AAPL),
      state(),
    );
    assert.equal(v.ok, true, "the wall may reject it on-chain, but policy must let it try");
  });

  it("matches addresses case-insensitively", () => {
    const v = checkPolicy(swap({ buyToken: CATE }), sellable(USDG, CATE.toUpperCase()), state());
    assert.equal(v.ok, true);
  });

  it("is inert when sellableAssets is absent — backtests and fixtures are unaffected", () => {
    const noSet = limits({ allowedAssets: [USDG, AAPL, CATE] });
    assert.equal(noSet.sellableAssets, undefined);
    assert.equal(checkPolicy(swap({ buyToken: CATE }), noSet, state()).ok, true);
  });

  it("still runs the asset allowlist first — an unlisted token fails on that, not this", () => {
    const v = checkPolicy(swap({ buyToken: EVIL }), sellable(USDG, AAPL, EVIL), state());
    assert.equal(v.ok === false && v.rule, "asset-allowlist");
  });

  it("refuses the buy BEFORE the position exists, not after", () => {
    // The on-chain policy would only reject the SELL — by which point the money
    // is already in the asset. Catching it here is the only free moment.
    const v = checkPolicy(swap({ buyToken: CATE }), sellable(USDG), state());
    assert.equal(v.ok === false && v.detail.includes("never closed"), true);
  });
});

/**
 * THE SCOUT CEILING — buying something nobody can price.
 *
 * A token the tick couldn't value has a genuinely unknown worth: its pool is too
 * new or too thin for a TWAP anyone should trust. Carrying it at cost keeps the
 * book honest, but it also means the drawdown breaker CANNOT see it move. The
 * budget is therefore the only control on this money, and it has to bite before
 * the position exists.
 */
describe("checkPolicy — the scout ceiling", () => {
  const CATE = "0x5555555555555555555555555555555555555555" as const;
  const base = limits({ allowedAssets: [USDG, AAPL, CATE], sellableAssets: [USDG, AAPL, CATE] });
  const scout = (over: Partial<import("./policy").ScoutContext> = {}) => ({
    limits: { enabled: true, budgetUsdg: (100_000_000n * MICRO), perTokenUsdg: (25_000_000n * MICRO) },
    buyUnpriceable: true,
    existingCostUsdg: 0n,
    quarantinedUsdg: 0n,
    ...over,
  });

  it("allows an unpriceable buy inside the budget", () => {
    const v = checkPolicy(swap({ buyToken: CATE, notionalUsdg: (10_000_000n * MICRO) }), base, state(), scout());
    assert.equal(v.ok, true);
  });

  it("REFUSES an unpriceable buy when scout mode is off", () => {
    const v = checkPolicy(
      swap({ buyToken: CATE }),
      base,
      state(),
      scout({ limits: { enabled: false, budgetUsdg: (100_000_000n * MICRO), perTokenUsdg: (25_000_000n * MICRO) } }),
    );
    assert.equal(v.ok === false && v.rule, "scout-budget");
  });

  it("REFUSES past the per-token ceiling, counting what's already sunk in", () => {
    const v = checkPolicy(
      swap({ buyToken: CATE, notionalUsdg: (10_000_000n * MICRO) }),
      base,
      state(),
      scout({ existingCostUsdg: (20_000_000n * MICRO) }),
    );
    assert.equal(v.ok === false && v.rule, "scout-budget");
  });

  it("REFUSES past the total budget", () => {
    const v = checkPolicy(
      swap({ buyToken: CATE, notionalUsdg: (10_000_000n * MICRO) }),
      base,
      state(),
      scout({ quarantinedUsdg: (95_000_000n * MICRO) }),
    );
    assert.equal(v.ok === false && v.rule, "scout-budget");
  });

  it("does NOT gate a buy of something the tick priced fine", () => {
    const v = checkPolicy(
      swap({ buyToken: CATE }),
      base,
      state(),
      scout({ buyUnpriceable: false, limits: { enabled: false, budgetUsdg: 0n, perTokenUsdg: 0n } }),
    );
    assert.equal(v.ok, true, "a priceable token is not scout business");
  });

  it("NEVER blocks the SELL of an unpriceable position — the exit stays open", () => {
    // Holding CATE, can't price it, scout mode off and budget exhausted. Getting
    // out must still be allowed: the rule only ever inspects buyToken.
    const v = checkPolicy(
      swap({ sellToken: CATE, buyToken: USDG }),
      base,
      state(),
      scout({
        buyUnpriceable: false,
        quarantinedUsdg: (100_000_000n * MICRO),
        limits: { enabled: false, budgetUsdg: 0n, perTokenUsdg: 0n },
      }),
    );
    assert.equal(v.ok, true);
  });

  it("leaves transfers alone", () => {
    const out: TradeIntent = { kind: "transfer", target: USDG, recipient: VAULT, amountUsdg: (25_000_000n * MICRO) };
    assert.equal(checkPolicy(out, base, state(), scout()).ok, true);
  });

  it("runs AFTER the no-exit rule — an unsellable token fails on that first", () => {
    const noSell = limits({ allowedAssets: [USDG, AAPL, CATE], sellableAssets: [USDG, AAPL] });
    const v = checkPolicy(swap({ buyToken: CATE }), noSell, state(), scout());
    assert.equal(v.ok === false && v.rule, "no-exit", "the more fundamental refusal wins");
  });

  it("is inert when no context is passed — backtests and fixtures are unaffected", () => {
    assert.equal(checkPolicy(swap({ buyToken: CATE }), base, state()).ok, true);
  });
});

describe("checkPolicy — equity orders (the broker rail)", () => {
  // On this rail these caps are the ONLY wall: no account contract re-checks
  // behind them (DESIGN.md §5). Every rule here is load-bearing, not a mirror.
  const eq = (over: Partial<Extract<TradeIntent, { kind: "equity-order" }>> = {}): TradeIntent => ({
    kind: "equity-order",
    ticker: "AAPL",
    side: "buy",
    notionalUsdg: (25_000_000n * MICRO), // 25 USD
    ...over,
  });
  const eqLimits = (over: Partial<AgentLimits> = {}) => limits({ allowedTickers: ["AAPL", "NVDA"], ...over });

  it("approves a legal order — with NO contract target to allowlist", () => {
    // The variant has no target field, so the target-allowlist rule must not
    // fire. An empty allowedTargets proves it is genuinely skipped.
    assert.deepEqual(checkPolicy(eq(), eqLimits({ allowedTargets: [] }), state()), { ok: true });
  });

  it("rejects a ticker outside the allowlist — the broker rail's asset wall", () => {
    const v = checkPolicy(eq({ ticker: "GME" }), eqLimits(), state());
    assert.equal(!v.ok && v.rule, "ticker-allowlist");
  });

  it("matches tickers case-insensitively — 'aapl' is AAPL, not a bypass", () => {
    assert.equal(checkPolicy(eq({ ticker: "aapl" }), eqLimits(), state()).ok, true);
  });

  it("skips the ticker allowlist only when undefined (fixtures), like sellableAssets", () => {
    assert.equal(checkPolicy(eq({ ticker: "ANYTHING" }), limits(), state()).ok, true);
  });

  it("rejects a non-positive notional", () => {
    const v = checkPolicy(eq({ notionalUsdg: 0n }), eqLimits(), state());
    assert.equal(!v.ok && v.rule, "order-amount");
  });

  it("caps a single order at the per-trade limit", () => {
    const v = checkPolicy(eq({ notionalUsdg: (50_000_001n * MICRO) }), eqLimits(), state());
    assert.equal(!v.ok && v.rule, "per-trade-cap");
  });

  it("counts SELLS against the caps too — a sell is still an op and still exposure", () => {
    const v = checkPolicy(eq({ side: "sell", notionalUsdg: (50_000_001n * MICRO) }), eqLimits(), state());
    assert.equal(!v.ok && v.rule, "per-trade-cap");
  });

  it("enforces the rolling daily cap", () => {
    const v = checkPolicy(eq(), eqLimits(), state({ spentTodayUsdg: (490_000_000n * MICRO) }));
    assert.equal(!v.ok && v.rule, "daily-cap");
  });

  it("enforces the ops cap and the expiry like every other rail", () => {
    const ops = checkPolicy(eq(), eqLimits(), state({ opsToday: 48 }));
    assert.equal(!ops.ok && ops.rule, "ops-cap");
    const exp = checkPolicy(eq(), eqLimits(), state({ nowSec: NOW + 86_401 }));
    assert.equal(!exp.ok && exp.rule, "expiry");
  });

  it("the drawdown breaker fires on equity orders", () => {
    const v = checkPolicy(
      eq(),
      eqLimits(),
      state({ highWaterMarkUsdg: (1_000_000_000n * MICRO), equityUsdg: (890_000_000n * MICRO) }),
    );
    assert.equal(!v.ok && v.rule, "drawdown-breaker");
  });

  it("STAGE (b): reviewed terms above the cap are rejected even when the estimate passed", () => {
    // The two-stage shape from DESIGN.md §5: stage (a) judges the proposed
    // notional; review() then returns priced terms (fees, slippage), and the
    // SAME checkPolicy judges those. This pins that a review-inflated notional
    // is caught — the property the live executor's safety rests on.
    const proposed = eq({ notionalUsdg: (49_000_000n * MICRO) });
    assert.equal(checkPolicy(proposed, eqLimits(), state()).ok, true);
    const reviewed = { ...proposed, notionalUsdg: (51_000_000n * MICRO) } as TradeIntent; // fees pushed it over
    const v = checkPolicy(reviewed, eqLimits(), state());
    assert.equal(!v.ok && v.rule, "per-trade-cap");
  });
});

describe("checkPolicy — the withdrawal allowlist mirrors the on-chain pin", () => {
  const xfer = (recipient = "0x9999999999999999999999999999999999999999"): TradeIntent => ({
    kind: "transfer",
    target: USDG,
    recipient: recipient as `0x${string}`,
    amountUsdg: (10_000_000n * MICRO),
  });
  // Hex letters on purpose: a checksummed (EIP-55) address differs from its
  // lowercase form only in the BODY — the "0x" prefix stays lowercase, which is
  // why comparing whole strings case-blind is the right test, not toUpperCase().
  const A = "0xabcdef1111111111111111111111111111111111";

  it("an EMPTY list means the wall has no transfer permission at all", () => {
    const v = checkPolicy(xfer(), limits({ withdrawalAddresses: [] }), state());
    assert.equal(!v.ok && v.rule, "transfer-not-permitted");
    // The message has to say what to do — an owner with stuck funds needs the
    // owner-key path, not a policy code.
    assert.match(!v.ok ? v.detail : "", /recover/);
  });

  it("rejects a recipient that is not on the list", () => {
    const v = checkPolicy(xfer(), limits({ withdrawalAddresses: [A] }), state());
    assert.equal(!v.ok && v.rule, "transfer-recipient-allowlist");
  });

  it("allows a registered recipient, case-insensitively", () => {
    assert.equal(checkPolicy(xfer(A), limits({ withdrawalAddresses: [A] }), state()).ok, true);
    const checksummed = `0x${A.slice(2).toUpperCase()}`;
    assert.equal(
      checkPolicy(xfer(checksummed), limits({ withdrawalAddresses: [A] }), state()).ok,
      true,
      "an address is an address whatever its casing",
    );
  });

  it("UNDEFINED means a pre-allowlist grant, and must NOT be treated as empty", () => {
    // Such a grant genuinely carries the old free-form permission. A mirror
    // stricter than the chain rejects trades the wall would have allowed —
    // the one thing this file's contract forbids.
    assert.equal(checkPolicy(xfer(), limits(), state()).ok, true);
  });

  it("the amount cap still applies on top of the destination pin", () => {
    const v = checkPolicy(
      { ...xfer(A), amountUsdg: (50_000_001n * MICRO) } as TradeIntent,
      limits({ withdrawalAddresses: [A] }),
      state(),
    );
    assert.equal(!v.ok && v.rule, "per-trade-cap");
  });
});


describe("removed order kinds", () => {
  it("refuses a curve trade even when its target and both assets are allowed", () => {
    const A = "0x1111111111111111111111111111111111111111";
    const B = "0x2222222222222222222222222222222222222222";
    const v = checkPolicy(
      { kind: "curve-trade", target: A, assetIn: A, assetOut: B } as never,
      { allowedTargets: [A], allowedAssets: [A, B], sellableAssets: [A, B], cashToken: A } as never,
      { spentTodayUsdg: 0n, opsToday: 0, equityUsdg: 0n, highWaterMarkUsdg: 0n } as never,
    );
    assert.equal(v.ok, false);
    assert.equal((v as { rule: string }).rule, "target-allowlist");
  });
});

/**
 * A REFUSAL AN OWNER CAN ACT ON.
 *
 * `detail` is printed VERBATIM into the owner's event feed by index.ts. The
 * daily-cap refusal said `would exceed daily cap 50000000` — a raw 6dp bigint,
 * no units, no remaining balance, no reset time. "Fifty million" is what the
 * owner of a 50 USDG agent read, up to three times a tick, all day.
 */
describe("cap refusals are written for the person who has to read them", () => {
  const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  const STOCK = "0x4444444444444444444444444444444444444444";
  const ROUTER = "0x3333333333333333333333333333333333333333";

  const capLimits = () =>
    ({
      allowedTargets: [ROUTER],
      allowedAssets: [USDG, STOCK],
      sellableAssets: [USDG, STOCK],
      cashToken: USDG,
      perTradeUsdg: (10_000_000n * MICRO),
      dailyUsdg: (50_000_000n * MICRO),
      maxOpsPerDay: 100,
      maxDrawdownBps: 10_000,
      expiresAt: 2_000_000_000,
    }) as never;

  const capBuy = (notional: bigint) =>
    ({
      kind: "swap",
      target: ROUTER,
      sellToken: USDG,
      buyToken: STOCK,
      sellAmountRaw: notional,
      notionalUsdg: notional,
    }) as never;

  const capState = (spent: bigint) =>
    ({
      spentTodayUsdg: spent,
      opsToday: 0,
      equityUsdg: (1_000_000_000n * MICRO),
      highWaterMarkUsdg: 0n,
      nowSec: 1_000_000_000,
    }) as never;

  it("the daily-cap refusal contains no bare 6dp integer", () => {
    const v = checkPolicy(capBuy((5_000_000n * MICRO)), capLimits(), capState((49_000_000n * MICRO)));
    assert.equal(v.ok, false);
    assert.equal((v as { rule: string }).rule, "daily-cap");
    const detail = (v as { detail: string }).detail;
    assert.ok(
      !/\b\d{7,}\b/.test(detail),
      `a raw micro-USDG figure reached the owner: ${detail}`,
    );
  });

  it("and names what was spent, what the budget was, and what this trade wanted", () => {
    const v = checkPolicy(capBuy((5_000_000n * MICRO)), capLimits(), capState((49_000_000n * MICRO)));
    const detail = (v as { detail: string }).detail;
    for (const part of ["49.00 USDG", "50.00 USDG", "5.00 USDG"]) {
      assert.ok(detail.includes(part), `expected ${part} in: ${detail}`);
    }
  });

  it("says the exit is never blocked by it, because that is the question this prompts", () => {
    const detail = (checkPolicy(capBuy((5_000_000n * MICRO)), capLimits(), capState((49_000_000n * MICRO))) as { detail: string }).detail;
    assert.match(detail, /[Ee]xits are never blocked/);
  });

  it("the per-trade refusal is legible too, and names the re-sign", () => {
    const v = checkPolicy(capBuy((25_000_000n * MICRO)), capLimits(), capState(0n));
    assert.equal((v as { rule: string }).rule, "per-trade-cap");
    const detail = (v as { detail: string }).detail;
    assert.ok(!/\b\d{7,}\b/.test(detail), `raw figure in: ${detail}`);
    assert.ok(detail.includes("25.00 USDG") && detail.includes("10.00 USDG"));
    // The remedy differs from the daily cap's: this one is sealed in the
    // signature, so settings cannot move it.
    assert.match(detail, /re-sign/);
  });
});
