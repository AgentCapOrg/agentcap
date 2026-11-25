import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const INDEX = readFileSync(`${HERE}index.ts`, "utf8");

/**
 * THE LIVE RAIL, MADE EXPLICIT.
 *
 * `trenchCandidates` began `if (!paperActive()) return []`, and `paperActive` is
 * defined as the ABSENCE of an executor (`!active.executor`). So arming a live
 * executor did not take the strategy live — it turned the candidate feed OFF.
 * The memecoin strategy stopped seeing anything at the exact moment it became
 * able to act, silently.
 */
describe("trencher goes live only when the owner says so", () => {
  it("still returns nothing when neither paper nor live is on", () => {
    // Tests the GUARD, not its formatting. This pinned the exact one-line source
    // and broke the moment the branch grew a body — a fine trade if the body were
    // cosmetic, but the body IS the fix (next test).
    assert.match(INDEX, /if \(!paperActive\(\) && !cfg\.trencherLiveEnabled\) \{/);
    const guard = INDEX.slice(INDEX.indexOf("if (!paperActive() && !cfg.trencherLiveEnabled)")).slice(0, 1400);
    assert.match(guard, /return \[\];/, "the guard must still return no candidates");
  });

  it("SAYS SO instead of returning an empty feed in silence", () => {
    // A user picked trencher, armed a real key, and got an empty candidate feed
    // every tick forever. He reported it as “it didn't take any trades yet” and
    // then “I think I'm stuck in paper mode” — the shape of a system refusing
    // without saying so. index.ts's own comment calls the surprise out, and then
    // left it silent.
    const guard = INDEX.slice(INDEX.indexOf("if (!paperActive() && !cfg.trencherLiveEnabled)")).slice(0, 1400);
    assert.match(guard, /trencherRailAnnounced/, "the refusal must be announced");
    assert.match(guard, /addEvent/, "and recorded where the owner can see it");
  });

  it("the remedy is reachable from the settings page", () => {
    // The flag had an API branch and no input, so the one action that would fix
    // it could not be taken. Same class as ponsAdapterAddress.
    const page = readFileSync(new URL("../../web/src/terminal/screens/Settings.tsx", import.meta.url), "utf8");
    assert.match(page, /trencherLiveEnabled/, "no control means no remedy");
  });

  it("is OFF by default — spending real money is opt-in", async () => {
    const { SETTINGS_DEFAULTS } = await import("../../packages/core/src/index");
    assert.equal(SETTINGS_DEFAULTS.trencherLiveEnabled, false);
  });

  it("composes with the other bounds rather than replacing them", () => {
    // The scout budget is what actually limits a buy into something nobody can
    // independently value, and a curve-priced coin is exactly that. Enabling
    // live trencher must not be a way around it.
    assert.match(INDEX, /q\.source === "sampled"/);
    assert.ok(
      !/trencherLiveEnabled[\s\S]{0,200}?scoutAllows/.test(INDEX),
      "the live flag must not gate or bypass the scout budget",
    );
  });
});
