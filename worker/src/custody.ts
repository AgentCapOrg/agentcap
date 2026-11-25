/**
 * WHERE AN ASSET LIVES, as distinct from whether it is owned.
 *
 * Every accounting surface in this repo was written when those two questions
 * had one answer: the smart account holds everything it owns. The Trencher vault
 * breaks that — it holds tokens on behalf of one account.
 *
 * This module is the seam. It exists so that "who are we?" has ONE answer that
 * four different readers share — the balance read, the receipt decode, the flow
 * classifier and the delivery probe — rather than four that can drift. The
 * transfer-marker saga and the suppression-key saga are both what happens when a
 * derivation lives in two places, and this one would live in four.
 *
 * WHAT IS DELIBERATELY NOT HERE: any notion that vault-held units are a
 * different ASSET. They are the same ERC-20 with the same cost basis; only their
 * location differs. `basis.ts` is per raw unit and split-invariant for exactly
 * that reason, and partitioning it by custody would mean a `recover` — which
 * moves a position with no economic event at all — silently split one basis into
 * two.
 */
import { grantTrencher, type StoredGrant } from "../../packages/core/src/index";

/**
 * Where a holding sits. An open union with an exhaustive switch below, so
 * adding a third custody fails to COMPILE rather than falling through to a
 * default that quietly treats it like an account balance.
 */
export type Custody = "account" | "trencher-vault";

/**
 * Contracts that hold assets for this account, beyond the account itself.
 *
 * Empty for every grant without the Trencher marker. `grantTrencher` demands the
 * marker AND well-formed addresses, so nothing a setting can write reaches this
 * list: a settings-sourced value would point one owner's reader at another
 * owner's vault.
 */
export function custodyAddressesOf(
  grant: Pick<StoredGrant, "grantFeatures" | "trencherVaultAddress" | "trencherFactoryAddress"> | null | undefined,
): `0x${string}`[] {
  const trench = grantTrencher(grant);
  return trench ? [trench.vault] : [];
}

/**
 * HISTORICAL ROWS ONLY. A grant stored by an older build can name a removed
 * class vault ("pons-class"). No wall, limit or live read uses it; the ledger
 * audit tools still net it as this account's own custody, because the books
 * they check were written that way.
 */
export function historicalClassVault(
  features: readonly string[],
  address: unknown,
): `0x${string}` | null {
  if (!features.includes("pons-class") || typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  return address.toLowerCase() as `0x${string}`;
}

/**
 * Every address whose balance is this account's money — "we", for a reader that
 * needs to net a receipt or read a book.
 *
 * The account is always first. Order is not load-bearing but it is stable, so a
 * key built from this list is reproducible.
 */
export function bookAddresses(
  grant: Pick<StoredGrant, "grantFeatures" | "trencherVaultAddress" | "trencherFactoryAddress"> | null | undefined,
  smartAccount: string,
): string[] {
  return [smartAccount.toLowerCase(), ...custodyAddressesOf(grant)];
}

/**
 * How a position of this custody is exited, named rather than assumed.
 *
 * The question custody actually changes is not "what is it worth" — that is the
 * same arithmetic either way — but "how do I get out of it", and that is the
 * question an owner asks at the worst possible moment. An exhaustive switch on
 * a union means a third custody cannot be added without answering it.
 */
export function exitTargetFor(custody: Custody): string {
  switch (custody) {
    case "account":
      return "sell it from the account, through the venue it trades on";
    case "trencher-vault":
      return "sell it through the Trencher vault for USDG returned to your account, or recover the token with the owner key";
  }
}

/**
 * WHICH COST-BASIS ROWS DESCRIBE A POSITION THAT IS GENUINELY GONE.
 *
 * Extracted from the tick because it is a DESTRUCTIVE, IRREVERSIBLE write —
 * `setBasis(…, {qtyRaw: 0n, costUsdg: 0n})` deletes the `cost_basis` row and the
 * `position_floors` row with it — and it was reachable from no test at all. The
 * same move `equity.ts` documents making for the same reason.
 *
 * The rule is "the chain is the truth: a symbol we no longer hold has no basis".
 * That is right only if the question "do we hold it" is asked of everywhere we
 * could be holding it — the caller merges vault holdings into `positions`.
 */
export function strandedBasisSymbols(args: {
  /** Every symbol with a live cost-basis row. */
  basisSymbols: readonly string[];
  /** Priced positions the account holds. */
  positions: readonly string[];
  /** Held but deliberately unpriceable — absent from `positions`, still owned. */
  unpricedByDesign: readonly string[];
  /** Held but unpriced this tick — likewise absent, likewise still owned. */
  missingPrice: readonly string[];
  /**
   * Symbols this tick actually LOOKED AT on chain — the watch set.
   *
   * THE AUTHORITY FOR "GONE" IS A READING, NEVER A SETTING. Every held set
   * above is derived from `watchTokens`, and `watchTokens` is rebuilt whenever
   * strategy settings change, with no guard for symbols currently held. So
   * dropping a token from the basket — or turning `officialCoinsEnabled` off —
   * removed it from `positions` while its `cost_basis` row survived, and this
   * function then reported a still-held position as stranded. The sweep deletes
   * the basis AND the position floor in the same breath, so both mechanical
   * exits go blind on a live holding and the next sell cannot price its own
   * P&L.
   *
   * A symbol we did not look at is UNKNOWN, not absent. Omitted means "every
   * basis symbol was looked at", which is what every pre-existing caller
   * assumed.
   */
  watched?: readonly string[];
  /**
   * Symbols we ASKED about whose balance did not come back (positions.ts
   * `unreadBalances`, account and vault reads together).
   *
   * Asked is not answered. `watched` says the tick looked; this says the look
   * failed, and a failed look is no more evidence that a position is gone than
   * not looking was. Only a balance that came back zero may close a basis.
   * Shogun's GATO basis was closed off a single rate-limited balance row while
   * its vault held every unit (2026-11-04 08:36 UTC).
   *
   * Omitted means "every balance read answered", which is what every caller
   * before this field could see.
   */
  unread?: readonly string[];
}): string[] {
  const heldNow = new Set([
    ...args.positions,
    ...args.unpricedByDesign,
    ...args.missingPrice,
  ]);
  const looked = args.watched === undefined ? null : new Set(args.watched);
  const unread = new Set(args.unread ?? []);
  return args.basisSymbols.filter(
    // Not held AND we actually asked about it AND it answered. Absent from a set
    // that was never populated for this symbol is not evidence of anything.
    (symbol) => !heldNow.has(symbol) && (looked === null || looked.has(symbol)) && !unread.has(symbol),
  );
}

/**
 * WHICH UNREAD BALANCES THE BOOKS SAY WE HOLD — the ones that hold the tick.
 *
 * A token whose balance did not come back is unknown, not flat. When the books
 * carry an open position in it (a `cost_basis` quantity above zero), the book
 * this tick would compose is missing a holding we know about: equity would read
 * low against a peak that only ratchets, and the drawdown breaker would judge
 * the gap. So these go to `bookGaps` and the tick holds, exactly as an unread
 * cash balance does.
 *
 * WHY NOT EVERY UNREAD TOKEN. Some never answer: a mainnet token address on a
 * testnet grant has no code there and fails on every tick. Holding the whole
 * book on those would freeze it for good. A token with no open basis keeps
 * today's behaviour (the tick goes on without it), and `strandedBasisSymbols`
 * still refuses to close anything on its account.
 *
 * A lookup that throws counts as on record. Holding a tick costs a tick;
 * guessing wrong here books a phantom drawdown. That is only worth anything if
 * the lookup CAN throw: store.ts getBasis answers zero for a failed query, so
 * the tick passes openBasisQty, which does not.
 */
export async function unreadHeldOnRecord(
  unread: readonly string[],
  openQtyOf: (symbol: string) => Promise<bigint>,
): Promise<string[]> {
  const held: string[] = [];
  for (const symbol of new Set(unread)) {
    const qty = await openQtyOf(symbol).catch(() => null);
    if (qty === null || qty > 0n) held.push(symbol);
  }
  return held;
}
