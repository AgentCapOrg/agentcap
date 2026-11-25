/**
 * Steady Basket — Phase 1's deterministic strategy. No LLM anywhere.
 * DCA a fixed USDG amount into a weighted stock-token basket on a schedule.
 *
 * A Strategy NEVER executes anything. It reads a snapshot and returns intents;
 * the runner pushes each intent through checkPolicy → simulate → execute.
 */

import type { TradeIntent } from "../policy";
import { entryGateFor, lockedLegs } from "../entry-gates";
import { entryBrake, opsSpent, type Snapshot, type Tick } from "./types";
import type { Why } from "./reasons";

export type { Snapshot };

export interface BasketLeg {
  symbol: string;
  token: `0x${string}`;
  weightBps: number; // sums to 10_000 across legs
}

export interface SteadyBasketConfig {
  legs: BasketLeg[];
  buyPerTickUsdg: bigint;
  /** The swap router, the runner's pick. */
  swapRouter: `0x${string}`;
  usdg: `0x${string}`;
  /**
   * TAKE A PROFIT WHEN A LEG HAS RUN THIS FAR AHEAD OF WHAT IT COST, in bps.
   * Zero means never, and zero is the default.
   *
   * WHY THIS STRATEGY HAD NO SELL AT ALL. Every intent it could emit was a
   * buy — `sellToken` was always cash.
   * An agent on the shipped default could accumulate forever and never realise
   * anything, which is not a strategy anybody chose; it is a strategy nobody
   * noticed was one-way. In production one funded agent bought nine times with
   * real money and still holds all six positions, because there was no code
   * path that could ever sell them.
   *
   * TAKE-PROFIT ONLY, AND NO STOP-LOSS. A stop-loss on a DCA sleeve is
   * incoherent: the whole thesis of averaging in is to keep buying through a
   * drawdown, so a rule that sells the dip would fight the rule that buys it,
   * and the two would trade against each other with the owner paying the
   * spread both ways. Taking a profit does not contradict accumulating — it is
   * the other half of it, and it is the half an owner means by "if it is happy
   * with its profit it sells".
   *
   * OFF BY DEFAULT, DELIBERATELY. Turning this on changes what a live agent
   * does with somebody's money, and the threshold that is right for one book is
   * wrong for another. registry.ts already states the rule this follows: a
   * setting is "know about this", never "do this to me" — the owner turns it on.
   */
  takeProfitBps?: number;
}

export function steadyBasketTick(cfg: SteadyBasketConfig, snap: Snapshot): Tick {
  if (!snap.sequencerUp) return { intents: [], why: [] };

  // ── THE DAY'S TRADE COUNT, READ BEFORE ANYTHING THAT SPENDS ONE ─────────
  //
  // The budget clamp below fixed "refused again" for the MONEY and left the
  // COUNT exactly as it was: with `maxOpsPerDay` used up and budget to spare,
  // this proposed the same legs every tick and the wall refused every one with
  // `ops-cap`. So a buy is withheld here — it is one operation, and not an exit
  // the wall exempts. The take-profit sell
  // is untouched: the count does not bind it, so neither may this.
  const countSpent = opsSpent(snap);
  // THE DRAWDOWN BREAKER BINDS THE BUYS, and only the buys. Tripped, the wall
  // refuses every buy with `drawdown-breaker`; the take-profit brings money
  // home, which the breaker never blocks. A held
  // coin whose balance did not read binds them the same way (entryBrake;
  // policy.ts holding-unread).
  const braked = entryBrake(snap) !== undefined;

  const intents: TradeIntent[] = [];
  // Positionally paired with `intents` — see Tick. Pushed together, always.
  const why: (Why | null)[] = [];

  // ── LEAVING, BEFORE ENTERING ────────────────────────────────────────────
  //
  // Exits first, the same order trencher uses and for the same reason: a tick
  // that both takes a profit and opens a new leg should realise the one it can
  // measure before it spends on one it cannot. There is at most one exit per
  // tick, so a basket that has run does not liquidate itself in a single pass.
  //
  // A STALE PRICE IS NOT A GAIN. `priceStale` means the market for that leg is
  // closed, so its value is last session's number — selling against it would be
  // taking a profit measured at a price nobody is currently making. And a leg
  // with no cost on record is skipped rather than assumed free: `costUsdg` is
  // null when the ledger has no basis for it, and treating null as zero would
  // read the entire holding as profit, which is the accounting bug this
  // codebase exists downstream of.
  if (cfg.takeProfitBps && cfg.takeProfitBps > 0) {
    for (const [symbol, h] of snap.holdings) {
      if (h.priceStale) continue;
      const cost = h.costUsdg ?? null;
      if (cost === null || cost <= 0n) continue;
      if (snap.pausedTokens.has(h.token.toLowerCase())) continue;
      const gainBps = Number(((h.valueUsdg - cost) * 10_000n) / cost);
      if (gainBps < cfg.takeProfitBps) continue;
      intents.push({
        kind: "swap",
        target: cfg.swapRouter,
        sellToken: h.token,
        buyToken: cfg.usdg,
        sellAmountRaw: h.rawBalance,
        notionalUsdg: h.valueUsdg,
      });
      why.push({ code: "take-profit", symbol, gainBps, usdgRaw: h.valueUsdg, costRaw: cost });
      break;
    }
  }

  // Counted so the tick can say WHY it bought nothing. An empty intent list
  // reads identically whether the schedule declined, the feeds were stale, or
  // the cash was short — and only this function can tell them apart.
  let skippedStale = 0;
  let skippedPaused = 0;
  let skippedLocked = 0;

  // ── THE DAY'S BUDGET BINDS THE BUYS ──────────────────────────────────────
  //
  // This loop consulted `snap.cashUsdg` and nothing else, so once the daily cap
  // was spent it proposed the same legs every tick and checkPolicy refused every
  // one. On the shipped defaults that is not an edge case, it is Tuesday:
  // `buyPerTickUsdg` 25 against a `dailyUsdg` of 50 at `tickSeconds` 60 spends
  // the entire day's budget in TWO MINUTES and then refuses for the remaining
  // 1,438 — three refusals a tick, ~4,300 a day.
  //
  // The cap is right and stays. The bug is the pairing: two files that never
  // meet ship a per-tick rate 720× the daily allowance. Making the strategy read
  // the headroom is what turns "refused again" into "the budget is spent", which
  // is a thing an owner can act on.
  //
  // It also unblocks the `Why` mechanism. `bought` goes true whenever this loop
  // pushes anything, and `bought` true means `idle` is never set — so the one
  // machine built to say why nothing happened could not fire in the commonest
  // way for nothing to happen. Proposing nothing is what lets it speak.
  //
  // The clamp only ever SHRINKS the proposal.
  // Reported as `idle` at the bottom, not pushed to `why` here — `why` is what
  // the tick DID, and this is the reason it did nothing. Same treatment as
  // `all-legs-stale` and `under-one-buy`.
  const budgetToday = snap.spendHeadroomUsdg;
  const budgetSpent = budgetToday <= 0n;
  const buyBudget = cfg.buyPerTickUsdg < snap.cashUsdg ? cfg.buyPerTickUsdg : snap.cashUsdg;

  if (!budgetSpent && !countSpent && !braked && buyBudget > 0n) {
    for (const leg of cfg.legs) {
      if (snap.pausedTokens.has(leg.token.toLowerCase())) {
        skippedPaused += 1;
        continue;
      }
      if (snap.staleFeeds.has(leg.symbol)) {
        skippedStale += 1;
        continue; // no reference price → no trade
      }
      // A LEG THE SIGNED KEY CANNOT SELL BACK is skipped, not proposed: the wall
      // refuses the buy (`no-exit`), and it refused it every tick for the life
      // of the grant. AFTER the stale and paused tests, deliberately — `shut`
      // below counts only those two, so a locked leg on a weekend is still a
      // stale leg and the 24/7 fallback still fires exactly when it did.
      if (entryGateFor(snap.entryGates, leg.token)) {
        skippedLocked += 1;
        continue;
      }
      const wanted = (buyBudget * BigInt(leg.weightBps)) / 10_000n;
      // CLAMP TO WHAT IS LEFT, per leg, as the legs consume it. Gating the loop
      // on `budgetToday > 0` alone would still propose a full 25 against a
      // headroom of 3 and be refused — the same dead loop, one tick later.
      const alreadyProposed = intents.reduce(
        (sum, i) => sum + (i.kind === "swap" ? i.notionalUsdg : 0n),
        0n,
      );
      const room = budgetToday - alreadyProposed;
      const available = wanted < room ? wanted : room;
      const legAmount = available < snap.perTradeCapUsdg ? available : snap.perTradeCapUsdg;
      // A leg that rounds to nothing is not a trade. This also ends the loop
      // cleanly once the budget is exhausted mid-basket, rather than pushing
      // zero-sized intents that `non-positive` would refuse.
      if (legAmount <= 0n) continue;
      intents.push({
        kind: "swap",
        target: cfg.swapRouter,
        sellToken: cfg.usdg,
        buyToken: leg.token,
        sellAmountRaw: legAmount,
        notionalUsdg: legAmount,
      });
      why.push({
        code: "dca-leg",
        symbol: leg.symbol,
        usdgRaw: legAmount,
        weightBps: leg.weightBps,
        legs: cfg.legs.length,
      });
    }
  }

  // NOTHING BOUGHT, AND THE FEEDS ARE WHY.
  //
  // Only reported when the schedule genuinely wanted to buy — cash was
  // sufficient and there were legs — and every one of them was skipped. A tick
  // that bought nothing because it had no cash is a different silence with a
  // different remedy, and saying "the feeds are stale" about it would be
  // wrong.
  const bought = intents.some((i) => i.kind === "swap" && i.sellToken === cfg.usdg);
  const shut =
    !bought && buyBudget > 0n && skippedStale + skippedPaused === cfg.legs.length && cfg.legs.length > 0;

  // THE OTHER SILENCE, WHICH HAD NO SENTENCE AT ALL.
  //
  // The comment above `shut` names this case exactly — "a tick that bought
  // nothing because it had no cash is a different silence with a different
  // remedy" — and then nothing ever wrote the different sentence. When cash is
  // below one tick's buy the loop above never runs, so `skippedStale` and
  // `skippedPaused` stay 0, so `shut` is false, so `all-legs-stale` cannot
  // fire; and the agent is not `no-cash` either, because only an exact zero
  // blocks the live rail. The owner sees "trading for real — every leg
  // available" beside an empty tape, forever.
  //
  // Reported only when there was something it WANTED to buy — no legs
  // configured is a different fact, and the basket screen already says it.
  const short = !bought && cfg.legs.length > 0 && snap.cashUsdg < cfg.buyPerTickUsdg;
  // AND THE THIRD SILENCE, which on shipped defaults is by far the commonest.
  //
  // Ordered AHEAD of `short`, because when the budget is spent the cash test
  // says nothing useful: an agent can be flush and still forbidden to buy, and
  // "you have 900 USDG and one buy costs 25" is a baffling thing to read at that
  // moment. Behind `shut`, because a closed market is the more fundamental fact
  // — there would be nothing to buy either way.
  const spent = !bought && cfg.legs.length > 0 && budgetSpent;
  // The count's version of the same silence, ranked just behind it: when both
  // are spent both sentences are true, and the money one is the sentence owners
  // already know. Ahead of `short` for the reason `spent` is — cash is not what
  // is stopping a buy the count forbids.
  const counted = !bought && cfg.legs.length > 0 && countSpent;
  // EVERY LEG LEFT TO BUY IS ONE THE KEY CANNOT SELL BACK — every leg that was
  // not stale or paused was locked. Only reachable when the loop ran, so never
  // beside `spent` or `counted`; behind `shut`, which is the more fundamental
  // fact (a locked leg on a closed market counts as stale and never gets here);
  // and AHEAD of `short`, because adding funds would not buy a locked leg.
  const locked =
    !bought && skippedLocked > 0 && skippedStale + skippedPaused + skippedLocked === cfg.legs.length;
  // Ahead of every other silence: with the breaker tripped nothing else on
  // this list could have bought either, and this is the one that says why.
  const brake = !bought && cfg.legs.length > 0 ? entryBrake(snap) : undefined;
  const idle: Why | undefined = brake ??
    (shut
      ? {
          code: "all-legs-stale",
          legs: cfg.legs.length,
          paused: skippedPaused,
          // Which of two true sentences this becomes. Passed through rather than
          // re-derived: the snapshot decided it beside the staleness it explains.
          marketShut: snap.marketShut,
        }
      : locked
        ? { code: "legs-locked", legs: cfg.legs.length, locked: lockedLegs(snap.entryGates, cfg.legs) }
      : spent
        ? { code: "budget-spent", capRaw: cfg.buyPerTickUsdg }
        : counted
        ? { code: "ops-spent" }
        : short
        ? {
            code: "under-one-buy",
            cashRaw: snap.cashUsdg,
            needRaw: cfg.buyPerTickUsdg,
          }
        : undefined);

  return idle ? { intents, why, idle } : { intents, why };
}
