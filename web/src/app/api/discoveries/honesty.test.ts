import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * A FAILED READ MUST NOT BECOME A CLAIM ABOUT A COIN, and a degraded read must
 * not be cached like a good one.
 */

// THE READ AND ITS HTTP WRAPPER, SCANNED TOGETHER.
//
// Most of this was one file. The read moved to lib/read-discoveries so a server
// component could share its single-flight memo instead of fetching this process
// over the network, which left the cache-control behaviour here and everything
// else there. The properties below are about the discoveries read AS A WHOLE,
// so the whole is what they read — splitting them across two constants would
// mean deciding, per assertion, which half is allowed to satisfy it, and the
// first one filed under the wrong half would pass by accident forever.
const ROUTE =
  readFileSync(new URL("../../../lib/read-discoveries.ts", import.meta.url), "utf8") +
  readFileSync(new URL("./route.ts", import.meta.url), "utf8");
/**
 * The coins view moved out of the console onto its own page. These assertions
 * follow it: the properties belong to the CARDS and to the ORDER the page
 * checks its empty states in, not to the file that happened to hold them.
 */
const CARDS = readFileSync(new URL("../../../components/TokenCards.tsx", import.meta.url), "utf8");

describe("what the cards claim", () => {
  it("calls fully-diluted value FDV, never market cap", () => {
    // The index substitutes FDV for market cap whenever it has no circulating
    // supply, so the two were the same number under a label that overstates it
    // — a token reads bigger, older and safer than it is. worker/src/venues/
    // token-stats.ts made this argument first; the card had not heard it.
    assert.ok(!/Market cap/.test(CARDS), "FDV must not be labelled market cap");
    assert.match(CARDS, /<i>FDV<[/]i>/);
  });

});

describe("a degraded read is not cached like a good one", () => {
  it("a degraded render gets a short life, a whole one the full TTL", () => {
    // Measured in production: one bad render was served x-nextjs-cache: HIT for
    // six consecutive polls — about two and a half minutes — while the
    // underlying read had already recovered. The cache, not the RPC, is what
    // made a blink into an outage.
    assert.match(ROUTE, /const degraded = reached === 0 && asked > 0;/);
    assert.match(ROUTE, /payload\.degraded/);
    assert.match(ROUTE, /s-maxage=10, stale-while-revalidate=0/);
  });

  it("single-flight, because the route is dynamic and every tab polls it", () => {
    // Without it, N tabs missing together each walk the index at once.
    // The type parameter is deliberately loose. What must hold is that ONE
    // promise is held at module scope and reused; what that promise resolves to
    // is free to change, and pinning it meant this failed the first time the
    // memo started carrying more than the payload.
    assert.match(ROUTE, /let inFlight: Promise<\w+> \| null/);
    assert.match(ROUTE, /if \(inFlight\) return inFlight;/);
    // Anchored to a real export, not a mention: the comment above the memo
    // explains what it replaced, and matching prose would fail forever.
    assert.ok(!/^export const revalidate/m.test(ROUTE), "ISR cannot refuse to cache a degraded render");
    assert.match(ROUTE, /^export const dynamic = "force-dynamic";/m);
  });
});
