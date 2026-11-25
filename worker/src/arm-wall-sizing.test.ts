/**
 * THE ARM-TIME SIZER MUST DESCRIBE THE GRANT IT IS SIZING.
 *
 * At arm time the worker rebuilds the wall from the stored grant to compute
 * this agent's first-enable gas envelope, "from the SAME inputs the signature
 * was made over ... so the ceiling the executor applies and the ceiling the
 * signer enforced are the same number by construction rather than by
 * agreement". That equality holds only while the rebuild passes every
 * capability the grant carries.
 *
 * It did not, once: a capability passed as half a pair made `wallShape` throw,
 * the throw was caught, and the executor silently fell back to the flat
 * first-enable ceiling — a different, unmeasured number.
 *
 * Source-read, because the spread is an inline object literal inside an IIFE
 * inside `arm()`, reachable only by arming a real agent against a real chain.
 * The property is structural anyway: it is about which accessors the call site
 * mentions, and a shape test cannot pass on a branch that never ran.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const IDX = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

/** The arm-time rebuild: the `wallShape(buildCallPermissions(...))` call. */
const SIZER = (() => {
  const start = IDX.indexOf("    firstEnable = (() => {");
  assert.ok(start > 0, "the arm-time first-enable sizer moved — re-point this test, do not delete it");
  return IDX.slice(start, IDX.indexOf("const env = firstEnableEnvelope(shape);", start));
})();

describe("the arm-time wall sizer", () => {
  it("reads every capability from the GRANT, never from live settings", () => {
    // The whole point of the rebuild is to reproduce what was signed. Settings
    // can change after signing — that is what a sealed grant is FOR — so a
    // capability sourced from `cfg` here would size a wall nobody signed, and
    // would do it silently because the number still looks plausible.
    for (const accessor of ["grantWallOptions(grant)", "grantTrencher(grant)", "trencherFactoryAddress:"]) {
      assert.ok(SIZER.includes(accessor), `${accessor} is missing from the arm-time rebuild`);
    }
    assert.doesNotMatch(SIZER, /cfg\./, "no live setting may reach the sizer");
  });

  it("still fails CLOSED when the shape cannot be computed", () => {
    // The fallback itself is correct and must stay. A shape we cannot compute
    // must never widen anything — absent means the executor keeps the flat
    // ceiling, which is the conservative prior. What was wrong was reaching it
    // for a grant that was perfectly sizable.
    const block = IDX.slice(IDX.indexOf("    firstEnable = (() => {"), IDX.indexOf("let executor: AgentExecutor | null = null;"));
    assert.match(block, /catch \(e\)/);
    assert.match(block, /return undefined;/, "an unsizable wall returns absent, not a guessed envelope");
    assert.match(block, /could not size this wall/, "and says so out loud");
  });
});
