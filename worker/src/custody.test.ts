/**
 * ASSETS THAT ARE OWNED BUT NOT HELD.
 *
 * Every accounting surface here was written when "owned" and "held by the smart
 * account" were the same fact. The Trencher vault separates them on purpose, and
 * the rules below are where that separation is destructive if nobody notices:
 * one of them DELETES a cost basis.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { GRANT_TRENCHER } from "../../packages/core/src/index";
import {
  bookAddresses,
  custodyAddressesOf,
  exitTargetFor,
  strandedBasisSymbols,
  unreadHeldOnRecord,
  type Custody,
} from "./custody";

const ACCOUNT = "0x00000000000000000000000000000000000000a1";
const VAULT = "0x00000000000000000000000000000000000000c0";
const FACTORY = "0x00000000000000000000000000000000000000fa";

const vaultGrant = { grantFeatures: [GRANT_TRENCHER], trencherVaultAddress: VAULT, trencherFactoryAddress: FACTORY };
const plainGrant = { grantFeatures: ["tradeable-v2"] };

describe("who counts as `we`", () => {
  it("a grant with no vault marker has exactly one holder", () => {
    assert.deepEqual(custodyAddressesOf(plainGrant), []);
    assert.deepEqual(bookAddresses(plainGrant, ACCOUNT), [ACCOUNT]);
  });

  it("the marker ALONE is not enough — an address must be sealed with it", () => {
    // grantTrencher's rule, inherited rather than re-implemented: a marker is a
    // claim, and reading a book from a claim would read someone else's.
    assert.deepEqual(custodyAddressesOf({ grantFeatures: [GRANT_TRENCHER] }), []);
  });

  it("a retired class-vault marker adds no holder to a live read", () => {
    const retired = { grantFeatures: ["pons-class"], ponsClassVaultAddress: VAULT };
    assert.deepEqual(bookAddresses(retired as never, ACCOUNT), [ACCOUNT]);
  });

  it("a sealed vault joins the book, account first", () => {
    assert.deepEqual(bookAddresses(vaultGrant, ACCOUNT), [ACCOUNT, VAULT]);
  });

  it("a checksummed address comes back lowercased, so a key built from it is stable", () => {
    const mixed = { ...vaultGrant, trencherVaultAddress: `0x${VAULT.slice(2).toUpperCase()}` };
    assert.deepEqual(bookAddresses(mixed, `0x${ACCOUNT.slice(2).toUpperCase()}`), [ACCOUNT, VAULT]);
  });
});

describe("closing a stranded basis must not close a live one", () => {
  const base = {
    basisSymbols: ["PEPE"],
    positions: [] as string[],
    unpricedByDesign: [] as string[],
    missingPrice: [] as string[],
  };

  it("still closes a genuinely flat position, which is the rule's whole job", () => {
    assert.deepEqual(strandedBasisSymbols({ ...base, basisSymbols: ["SOLD"] }), ["SOLD"]);
  });

  it("the account's own three sources still count", () => {
    for (const key of ["positions", "unpricedByDesign", "missingPrice"] as const) {
      assert.deepEqual(strandedBasisSymbols({ ...base, [key]: ["PEPE"] }), [], key);
    }
  });
});

/**
 * THE WIRING, asserted as source.
 *
 * Everything above is pure and testable. What is not testable is whether the
 * tick actually calls it — and "declared, forwarded, never supplied" is the
 * failure mode this repo has shipped repeatedly (the suppression key was one). Each assertion here
 * corresponds to a specific silent failure.
 */
describe("the tick uses the custody seam", () => {
  const CODE = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

  it("the receipt decode nets over every holder, not just the account", () => {
    // Otherwise a vault buy's token leg is absent and the fill is unattributable
    // — the quote-derived basis, back again.
    assert.match(CODE, /netTokenDeltas\(exec\.logs, bookAddresses\(/);
  });

  it("the delivery probe asks the holder that actually received it", () => {
    // A vault buy delivers to the vault BY DESIGN. Reading the account would
    // find an exact zero and accuse a working trade of being a honeypot, on the
    // one venue where honeypots really live.
    assert.match(CODE, /args: \[acquired\.holder\]/);
    assert.ok(
      !/functionName: "balanceOf",\s*args: \[executor\.address\],\s*\}\) as Promise<bigint>,\s*\}\);\s*const note = describeDelivery/.test(CODE),
      "the delivery probe must not be hardcoded to the account",
    );
  });

  it("the stranded-basis sweep is the extracted predicate, not an inline set", () => {
    assert.match(CODE, /strandedBasisSymbols\(\{/);
    assert.ok(
      !/const heldNow = new Set\(\[\.\.\.positions\.map/.test(CODE),
      "the inline three-set version deletes live positions",
    );
  });

  it("the custody read's failure reaches the gate that holds, and an unread HELD coin the incomplete book", () => {
    // Reported any later and the tick publishes an equity figure missing a real
    // holding, then runs a destructive sweep against a book it could not see.
    // A whole-book gap (cash, ETH, the vault, a whole read,
    // the Trencher vault's cash) still holds the tick. A held coin whose own
    // row failed no longer does — that return switched off every exit — it
    // makes the book incomplete instead (unread-held.ts classifyBookGaps), as
    // an unread venue does. See "a failed balance row is not a zero" below.
    assert.match(
      CODE,
      /const gaps = classifyBookGaps\(\{\s*balances: bal\.unread,\s*positionsReadFailed: posRead\.readFailed,\s*trencherCashUnread,\s*unreadHeld,\s*\}\);/,
    );
    assert.match(CODE, /unreadBook = gaps\.holdTick;\s*unreadHeld = gaps\.incomplete;/);
    assert.match(CODE, /const bookIncomplete = unknownCost\.length > 0 \|\| venueGap\.length > 0 \|\| unreadHeld\.length > 0;/);
  });

});

/**
 * A SETTINGS CHANGE MUST NEVER DELETE THE BASIS OF AN ASSET STILL HELD.
 *
 * Every "held" set this predicate takes is derived from `watchTokens`, and
 * `watchTokens` is rebuilt whenever strategy settings change with no guard for
 * symbols currently held. Drop a token from the basket — or turn
 * `officialCoinsEnabled` off — and the symbol vanishes from `positions` while
 * its `cost_basis` row survives. The sweep then deletes the basis AND the
 * position floor, so both mechanical exits go blind on a live holding and the
 * next sell cannot price its own P&L.
 *
 * `watchTokens` is not authority for whether an economic position exists.
 */
describe("the watch set is not evidence that a position is gone", () => {
  const held = {
    basisSymbols: ["PEPE"],
    positions: [] as string[],
    unpricedByDesign: [] as string[],
    missingPrice: [] as string[],
  };

  it("KEEPS the basis when the symbol left the watch set", () => {
    // The owner un-ticks PEPE while still holding it. It is absent from
    // `positions` only because nothing looked.
    assert.deepEqual(strandedBasisSymbols({ ...held, watched: ["TSLA", "NVDA"] }), []);
  });

  it("but still strands a symbol that WAS looked at and is genuinely flat", () => {
    // The case the sweep exists for: watched, read, not held anywhere.
    assert.deepEqual(strandedBasisSymbols({ ...held, watched: ["PEPE", "TSLA"] }), ["PEPE"]);
  });

  it("and a watched, still-held symbol is never stranded", () => {
    assert.deepEqual(
      strandedBasisSymbols({ ...held, positions: ["PEPE"], watched: ["PEPE"] }),
      [],
    );
  });

  it("omitting `watched` keeps every caller's previous behaviour", () => {
    // Absent means "everything was looked at".
    assert.deepEqual(strandedBasisSymbols(held), ["PEPE"]);
  });

  it("AND THE TICK HANDS IT WHAT IT ACTUALLY READ", () => {
    const SRC = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    // The guarantee is only real if the live caller supplies the set; a default
    // that silently restores the old behaviour is the bug again.
    assert.match(SRC, /watched: watchTokens\.map\(\(t\) => t\.symbol\)/);
  });
});

/**
 * A FAILED BALANCE ROW IS NOT A ZERO.
 *
 * Live, 2026-11-04 08:36 UTC: one tick's reads hit a public-RPC 429. viem's
 * multicall turned it into failure rows instead of throwing, readPositions
 * skipped them like zeros with `readFailed: false`, and the sweep closed the
 * cost basis of Shogun's GATO while the vault held every unit. Every tick since
 * has read "unpriced AND no cost on record", which skips the Brain review.
 *
 * `watched` (above) says the tick looked. `unread` says the look failed.
 */
describe("a failed balance row is not a zero", () => {
  const book = {
    basisSymbols: ["GATO"],
    positions: [] as string[],
    unpricedByDesign: [] as string[],
    missingPrice: [] as string[],
    watched: ["GATO", "AAPL"],
  };

  it("THE BUG: an unread token reads like a flat one without `unread`", () => {
    assert.deepEqual(strandedBasisSymbols(book), ["GATO"]);
  });

  it("THE FIX: an unread token's basis is never closed", () => {
    assert.deepEqual(strandedBasisSymbols({ ...book, unread: ["GATO"] }), []);
  });

  it("but a token that answered zero still closes, beside one that did not answer", () => {
    assert.deepEqual(
      strandedBasisSymbols({ ...book, basisSymbols: ["GATO", "SOLD"], watched: ["GATO", "SOLD"], unread: ["GATO"] }),
      ["SOLD"],
    );
  });

  it("an unread token with an open basis holds the tick; one with none does not", async () => {
    const open = new Map([["GATO", 2_842n * 10n ** 18n]]);
    const qtyOf = async (s: string) => open.get(s) ?? 0n;
    // TESTNET is the "none" case: a mainnet token address has no code there and
    // fails on every tick. Holding on it would freeze the book for good.
    assert.deepEqual(await unreadHeldOnRecord(["GATO", "TESTNET"], qtyOf), ["GATO"]);
  });

  it("a basis lookup that throws counts as on record, so the tick holds rather than guesses", async () => {
    const qtyOf = async () => {
      throw new Error("database is locked");
    };
    assert.deepEqual(await unreadHeldOnRecord(["GATO"], qtyOf), ["GATO"]);
  });

  it("each symbol is asked once, however many reads missed it", async () => {
    const asked: string[] = [];
    const qtyOf = async (s: string) => {
      asked.push(s);
      return 1n;
    };
    assert.deepEqual(await unreadHeldOnRecord(["GATO", "GATO"], qtyOf), ["GATO"]);
    assert.deepEqual(asked, ["GATO"]);
  });

  it("AND THE TICK WIRES BOTH HALVES: the vault read joins, the sweep is told, the held ones are found", () => {
    const SRC = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    // The vault's own read joins the account's, so a 429 on the Trencher vault
    // (where Shogun's GATO sat) is not lost.
    assert.match(SRC, /posRead\.unreadBalances\.push\(\.\.\.custodyRead\.unreadBalances\)/);
    assert.match(SRC, /unreadPositions = \[\.\.\.new Set\(posRead\.unreadBalances\)\]/);
    // The sweep is handed the unread set — a default would be the bug again.
    assert.match(SRC, /unread: unreadPositions,/);
    // The gate asks the LIVE book for an open quantity, through the lookup that
    // THROWS on a failed query. getBasis answers zero there, which would make
    // the fail-closed branch unreachable (unread-basis-guard.integration.test.ts).
    assert.match(SRC, /unreadHeldOnRecord\(unreadPositions, \(symbol\) => openBasisQty\(agentId, "live", symbol\)\)/);
    assert.doesNotMatch(SRC, /unreadHeldOnRecord\([^)]*getBasis/);
  });
});
