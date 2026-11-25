/**
 * THE SHADOW REVIEW'S CLOCK AND RECORD: a null nextReviewAt never spins the
 * tick, and the evidence gate's answer is persisted. Run against the real
 * store.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import type { BrainDecision } from "./brain-client";
import { nextTickDelayMs } from "./decision-cadence";

const scratch = mkdtempSync(path.join(os.tmpdir(), "agentcap-shadow-admit-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.AGENTCAP_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
const originalCwd = process.cwd();
const store = await import("./store");
try {
  process.chdir(isolatedCwd);
  await store.initStore();
} finally {
  process.chdir(originalCwd);
}
const { persistBrainDecision } = await import("./brain-shadow");

after(() => {
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const now = Math.floor(Date.now() / 1000);

describe("THE TICK NEVER SPINS AT ONE SECOND", () => {
  const startedAt = 1_800_000_000_000;
  it("a null nextReviewAt schedules the regular interval", () => {
    const ms = nextTickDelayMs({ startedAt, now: startedAt + 2_000, tickSeconds: 240, nextReviewAt: null, reviewIntervalSec: 300 });
    assert.equal(ms, 238_000);
    assert.notEqual(ms, 1000);
  });
  it("which is the whole point: a past deadline would have been one second", () => {
    const past = Math.floor(startedAt / 1000) - 60;
    const ms = nextTickDelayMs({ startedAt, now: startedAt + 2_000, tickSeconds: 240, nextReviewAt: past, reviewIntervalSec: 300 });
    assert.equal(ms, 1000, "the hazard a refused review must not hand back");
  });
});

describe("THE GATE IS PERSISTED, not only logged", () => {
  const snapshot = { snapshotId: "fixture-snapshot", quality: {}, pnl: { publishable: true } } as never;
  const trigger = { fire: true, reason: "scheduled-review", detail: "fixture", candidates: [] } as never;
  const base = (id: string, over: Partial<BrainDecision> = {}): BrainDecision => ({
    schema_version: "1.0.0", decision_id: id, agent_id: "x", created_at: now, trigger_id: null,
    action: "hold", instrument_id: "fixture", symbol: "TSLA", confidence: 0.5, suggested_delta_usdg: 0,
    target_position_usdg: null, thesis: "Nothing new.", evidence: [], bull_case: "", bear_case: "",
    risks: [], invalidation: [], time_horizon: "", tier: "pulse", depth_used: "", escalation_reasons: [],
    candidate_action: null, models: [], cost: { model_calls: 1, tokens_in: 1, tokens_out: 1, usd: 0 }, ...over,
  });
  const signalsOf = (id: string) => {
    const raw = new DatabaseSync(path.join(process.env.AGENTCAP_HOME!, "agentcap.db"));
    try {
      const row = raw.prepare("SELECT signals_json FROM decisions WHERE id = ?").get(id) as { signals_json: string } | undefined;
      return JSON.parse(row!.signals_json) as Record<string, unknown>;
    } finally {
      raw.close();
    }
  };
  const agent = "0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a005";

  it("verdict, why, caveat count, schema version and what the model proposed", async () => {
    const d = base(`dec_gate_${now}`, { gate_verdict: "downgrade-to-hold", gate_why: "3 separate quality problems", gate_caveat_count: 3, hold_kind: "GATE_FORCED_HOLD", proposed_action: "buy", proposed_delta_usdg: 5_000_000 });
    await persistBrainDecision(agent, "brain", "run", "trig", trigger, snapshot, { ok: true, decision: d, seconds: 0 }, { priceUsd: "250", priceStale: false }, () => {});
    const s = signalsOf(d.decision_id);
    assert.deepEqual(
      [s.schema_version, s.gate_verdict, s.gate_why, s.gate_caveat_count, s.proposed_action, s.proposed_delta_usdg],
      ["1.0.0", "downgrade-to-hold", "3 separate quality problems", 3, "buy", 5_000_000],
    );
  });

  it("a Brain that sends none of them is recorded as not reporting — never as open", async () => {
    const d = base(`dec_gate_old_${now}`);
    await persistBrainDecision(agent, "brain", "run", "trig", trigger, snapshot, { ok: true, decision: d, seconds: 0 }, { priceUsd: "250", priceStale: false }, () => {});
    const s = signalsOf(d.decision_id);
    assert.deepEqual([s.gate_verdict, s.gate_why, s.gate_caveat_count, s.proposed_action, s.proposed_delta_usdg], [null, null, null, null, null]);
  });
});
