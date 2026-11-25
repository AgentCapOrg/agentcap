/**
 * A CONFIRMATION THAT UNDERSTATES WHAT IT MOVES IS NOT A CONFIRMATION.
 *
 * `cli/bin.mjs` and `RecoverPanel.tsx` are the two surfaces a human reads
 * before a sweep. These are source-read assertions: rendering the panel would
 * prove nothing about a `window.confirm` string, and `cli/bin.mjs` is an
 * interactive prompt around a child process.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = readFileSync(path.join(__dirname, "..", "..", "cli", "bin.mjs"), "utf8");
const PANEL = readFileSync(
  path.join(__dirname, "..", "..", "web", "src", "components", "RecoverPanel.tsx"),
  "utf8",
);

/** Comments stripped, so prose that quotes a string is not read as the code. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
const BIN_CODE = code(BIN);
const PANEL_CODE = code(PANEL);

describe("the CLI prompt discloses what it moves", () => {
  it("STOPS SAYING 'nothing to recover' over an account that holds only ETH", () => {
    assert.match(BIN_CODE, /balances\.length === 0 && heldWei === 0n\)/, "ETH counts as something to recover");
  });

  it("prints the headings", () => {
    assert.match(BIN_CODE, /SMART ACCOUNT/, "the account must be named");
    assert.match(BIN_CODE, /DESTINATION/, "and where it is all going");
  });

  it("the success receipt names everything that moved", () => {
    assert.match(BIN_CODE, /const list = accountParts\.join\(", "\)/);
  });

  it("the old flattened one-liner is gone", () => {
    // Anchored on the exact call that produced "about to sweep 20.000000 USDG".
    assert.doesNotMatch(
      BIN_CODE,
      /warn\(`about to sweep \$\{bold\(list\)\}`\)/,
      "the single-line disclosure must not come back",
    );
  });
});

describe("the hosted panel discloses what it moves", () => {
  it("cannot call an account it could not read 'empty'", () => {
    assert.match(PANEL_CODE, /const empty = known && balances\.length === 0 && unreadable\.length === 0/);
    assert.match(PANEL_CODE, /const blind = known && balances\.length === 0 && unreadable\.length > 0/);
  });

  it("puts the headings in the confirm dialog, not a flat list", () => {
    assert.match(PANEL_CODE, /SMART ACCOUNT \$\{smartAccount/, "the account");
    assert.match(PANEL_CODE, /"DESTINATION"/, "and the destination");
  });
});
