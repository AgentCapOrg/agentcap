/**
 * The Telegram agent's secret screen finishes on very long runs and still
 * finds what it should (review RHS, round 1).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { containsSecret, redactSecrets } from "./agent";

test("send_file's screen finishes on a file of one 6-million-character run and still finds the 0x key in it", () => {
  // Review RHS, round 1: the run regex threw RangeError here, and send_file swallowed it and sent the file.
  const file = `${"a".repeat(6_000_000)}\n0x${"ab".repeat(32)}\n`;
  assert.equal(containsSecret(file, []), true);
  assert.equal(redactSecrets(file, []).endsWith("\n[redacted]\n"), true);
});

test("the key, JWT and bot-token shapes finish on a 6-million-character run, and still find what they find (review RHS, round 1)", () => {
  // Unbounded, each threw RangeError (Maximum call stack size exceeded) on Node 26, and send_file sent the file unscanned.
  const run = "a".repeat(6_000_000);
  for (const [text, found] of [[`sk-${run}`, true], [`123456:${run}`, true], [`eyJ${run}`, false], ["1".repeat(6_000_000), false]] as const) {
    assert.equal(containsSecret(text, []), found, text.slice(0, 8));
    const redacted = redactSecrets(text, []);
    assert.equal(redacted.startsWith("[redacted]"), found, text.slice(0, 8));
  }
  // A JWT whose claims run to kilobytes is still one.
  const jwt = `eyJhbGciOiJSUzI1NiJ9.${"c".repeat(20_000)}.${"s".repeat(342)}`;
  assert.equal(containsSecret(`token ${jwt} end`, []), true);
  assert.equal(redactSecrets(`token ${jwt} end`, []), "token [redacted] end");
});

test("a notebook's base64 is not refused as secret-shaped (review RHS, round 1)", () => {
  let x = 0x51ed270b;
  const bytes = Uint8Array.from({ length: 3_000_000 }, () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) >>> 24);
  const notebook = JSON.stringify({ cells: [{ outputs: [{ data: { "image/png": Buffer.from(bytes).toString("base64") } }] }] });
  assert.equal(containsSecret(notebook, []), false);
  assert.equal(redactSecrets(notebook, []), notebook);
});
