/**
 * "(3) agentcap" WHILE THE TAB IS HIDDEN — and the title given back intact.
 *
 * The count is prefixed onto whatever the page's title is, and taken off
 * again, rather than written as a fixed string: the title is the route's
 * (Next sets it per page), and a badge that replaced it would leave a token
 * page titled "agentcap" after the reader came back.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { badgedTitle, plainTitle } from "./tab-badge";

describe("the tab title", () => {
  it("counts what arrived, on the page's own title", () => {
    assert.equal(badgedTitle("agentcap", 3), "(3) agentcap");
    assert.equal(badgedTitle("TSLA · agentcap", 1), "(1) TSLA · agentcap");
  });

  it("replaces its own count rather than stacking one on another", () => {
    assert.equal(badgedTitle("(3) agentcap", 5), "(5) agentcap");
    assert.equal(badgedTitle("(99+) agentcap", 5), "(5) agentcap");
  });

  it("gives the title back exactly at zero", () => {
    assert.equal(badgedTitle("(3) agentcap", 0), "agentcap");
    assert.equal(plainTitle("(12) TSLA · agentcap"), "TSLA · agentcap");
    assert.equal(plainTitle("agentcap"), "agentcap");
  });

  it("does not take a bracket that is part of the page's own title", () => {
    assert.equal(plainTitle("(TSLA) agentcap"), "(TSLA) agentcap");
  });

  it("stops counting digits at 99", () => {
    assert.equal(badgedTitle("agentcap", 250), "(99+) agentcap");
  });
});
