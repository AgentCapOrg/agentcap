/**
 * A DIAGNOSTIC THAT READS A SEALED SETTINGS BLOB MUST NOT BE ABLE TO PRINT ONE.
 *
 * The settings object this data comes from can hold a Telegram bot token, an
 * allowlist, an LLM key and a grant's worth of addresses. The protection is
 * structural rather than careful: `describeTenant` is handed a flat record of
 * the named fields and never the object, so nothing else is in scope where the
 * strings are built. These tests pin that, and pin the null-versus-default
 * distinction the report exists to preserve.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { describeAccounting, describeTenant, type TenantFacts } from "./inspect-tenant";
import { fleetIdTarget } from "./fleet-id";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const facts = (over: Partial<TenantFacts> = {}): TenantFacts => ({
  tenant: "0x4b6dcd559c82ea897c34dacfb785fb0c8f85d4c5",
  smartAccount: "0xa96Bf429888e1aAb4255762d17d29C53f6a0370d",
  assetMode: null,
  liveTradingEnabled: true,
  discoveryEnabled: null,
  scoutEnabled: null,
  scoutBudgetUsdg: null,
  scoutPerTokenUsdg: null,
  maxImpactBps: null,
  slippageBps: null,
  settingsMissing: false,
  settingsError: null,
  ...over,
});

describe("the report says what is set and what is merely defaulted", () => {
  it("marks an unset field as unset AND names the default", () => {
    // These resolve identically at runtime and mean opposite things to somebody
    // deciding what to change: one is a choice, the other is a gap.
    const out = describeTenant(facts()).join("\n");
    assert.match(out, /scoutEnabled\s+\(unset\) -> default false/);
    assert.match(out, /slippageBps\s+\(unset\) -> default 100/);
  });

  it("reports an unreadable settings row as UNKNOWN, never as default", () => {
    const out = describeTenant(facts({ settingsError: "decrypt failed" })).join("\n");
    assert.match(out, /settings UNREADABLE/);
    assert.match(out, /unknown, NOT default/);
    assert.doesNotMatch(out, /\(unset\)/, "a failed read must not be dressed as an absent field");
  });
});

describe("IT CANNOT PRINT A SECRET", () => {
  it("takes named fields, never the settings object", () => {
    /**
     * The structural guarantee. If this function ever accepted the blob, a
     * formatter would be the only thing standing between a bot token and a log
     * line — and the first person to add a field would not know that.
     */
    const src = readFileSync(path.join(__dirname, "inspect-tenant.ts"), "utf8");
    const body = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const forbidden of [
      "telegramBotToken",
      "anthropicApiKey",
      "groqApiKey",
      "telegramAllowlist",
      "grant_json",
      "DATABASE_URL",
      "AGENTCAP_STORE_DEK",
      "privateKey",
      "sessionKey",
    ]) {
      assert.ok(!body.includes(forbidden), `${forbidden} must not appear in the reporter`);
    }
    // And it must not iterate an arbitrary record into output.
    assert.doesNotMatch(body, /Object\.entries\(s\)|Object\.keys\(s\)/);
    assert.doesNotMatch(body, /JSON\.stringify\(settings/);
  });

  it("and the orchestrator hook hands it one field at a time", () => {
    const orch = readFileSync(path.join(__dirname, "orchestrator.ts"), "utf8");
    const body = orch.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // The whole settings object must never be spread into the facts record.
    assert.doesNotMatch(body, /describeTenant\(\s*\{[^}]*\.\.\.s\b/);
    assert.match(body, /pick\("slippageBps"\)/, "fields are named individually");
  });

  it("and refuses a tenant value that is not an address", () => {
    const orch = readFileSync(path.join(__dirname, "orchestrator.ts"), "utf8");
    // The one fleet-id parser validates it (fleet-id.ts), before any read.
    const at = orch.search(/^async function runTenantInspectIfAsked\(/m);
    const body = orch.slice(at, at + orch.slice(at).search(/^}/m));
    assert.match(body, /fleetIdTarget\("AGENTCAP_INSPECT_TENANT", process\.env\.AGENTCAP_INSPECT_TENANT\)/, "the env value is validated before any read");
    assert.ok(body.indexOf("fleetIdTarget(") < body.indexOf("DATABASE_URL"));
    for (const value of ["0x123", "agent:9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", "everyone"]) {
      const target = fleetIdTarget("AGENTCAP_INSPECT_TENANT", value);
      assert.ok(target && "refused" in target && /refusing to guess/.test(target.refused), value);
    }
  });

  it("and runs once per process, not once per pass", () => {
    const orch = readFileSync(path.join(__dirname, "orchestrator.ts"), "utf8");
    assert.match(orch, /if \(tenantInspectRan\) return;/);
  });
});

/**
 * THE VERDICT IS THE WHOLE POINT, so it is the thing under test.
 *
 * Shogun's real numbers: a peak of 49.91 against 24.92 of equity, on an account
 * that had never traded. The breaker read 5008bps and refused every buy, and
 * the question that mattered — is this a loss or a bookkeeping artefact? — was
 * decided by exactly the comparison below.
 */
describe("describeAccounting separates a stale peak from a real drawdown", () => {
  const base = {
    smartAccount: "0x05a198A677Fbcd8f5c168d397Fa7ef5eB6D65487",
    durableAccruedFeeUsdg: 0,
    durableHwmGrossUsdg: null,
    durableHwmWithdrawnUsdg: null,
    durableEpoch: 1,
    maxDrawdownBps: 500,
    error: null,
  };

  it("names a peak above contributed capital on zero trades as a DEFECT", () => {
    const out = describeAccounting({
      ...base,
      durableHwmUsdg: 49.912,
      equityUsdg: 24.915968,
      trades: 0,
      flows: [{ direction: "in", amountUsdg: 24.915968, source: "inferred", txHash: null, blockNumber: null }],
    }).join("\n");
    assert.match(out, /REFUSING every buy/);
    assert.match(out, /DEFECT: the peak exceeds contributed capital by 24\.996032 USDG on ZERO trades/);
    assert.match(out, /not a drawdown/);
  });

  it("does NOT cry defect when the peak matches what was put in", () => {
    const out = describeAccounting({
      ...base,
      durableHwmUsdg: 24.915968,
      equityUsdg: 24.915968,
      trades: 0,
      flows: [{ direction: "in", amountUsdg: 24.915968, source: "chain-log", txHash: "0xabc", blockNumber: 1 }],
    }).join("\n");
    assert.match(out, /peak agrees with contributed capital/);
    assert.doesNotMatch(out, /DEFECT/);
  });

  it("refuses the verdict once a trade could explain the peak", () => {
    const out = describeAccounting({
      ...base,
      durableHwmUsdg: 49.912,
      equityUsdg: 24.915968,
      trades: 3,
      flows: [{ direction: "in", amountUsdg: 24.915968, source: "chain-log", txHash: "0xabc", blockNumber: 1 }],
    }).join("\n");
    assert.match(out, /cannot settle it alone/);
    assert.doesNotMatch(out, /DEFECT/);
  });

  it("an unreadable count is never rendered as zero trades", () => {
    const out = describeAccounting({ ...base, durableHwmUsdg: null, equityUsdg: null, trades: null, flows: null, error: "connection refused" }).join("\n");
    assert.match(out, /UNREADABLE/);
    assert.doesNotMatch(out, /DEFECT/);
    assert.doesNotMatch(out, /0\.000000/);
  });

  it("carries the running total so a withdrawal is visible as one", () => {
    const out = describeAccounting({
      ...base,
      durableHwmUsdg: 49.912,
      equityUsdg: 24.915968,
      trades: 0,
      flows: [
        { direction: "in", amountUsdg: 30.701312, source: "chain-log", txHash: "0x06cd8dba8f", blockNumber: 63014999 },
        { direction: "out", amountUsdg: 5.785344, source: "chain-log", txHash: "0x84fab7ee56", blockNumber: 63015107 },
      ],
    }).join("\n");
    assert.match(out, /OUT\s+5\.785344\s+running\s+24\.915968/);
    assert.match(out, /net contributions\s+24\.915968/);
  });
});

/**
 * THE DIAGNOSTIC MUST NOT BE THE THING THAT REPORTS A WRONG NUMBER.
 *
 * It printed "→ breaker reads 5470bps — REFUSING every buy" about an account the
 * engine was reading at 0bps and trading normally. It had read `hwm_usdg`
 * directly, which since the withdrawal split is the GROSS peak; the figure the
 * breaker divides by is gross minus what withdrawals have taken out of it.
 *
 * A module whose whole premise is "an unknown is not a zero" producing a
 * confident wrong number is worth a test of its own.
 */
describe("the accounting report reads the EFFECTIVE peak", () => {
  it("SHOGUN AFTER THE REPAIR: 0bps, not 5470", () => {
    const out = describeAccounting({
      smartAccount: "0x05a198A677Fbcd8f5c168d397Fa7ef5eB6D65487",
      durableHwmUsdg: 25.487111, // 56.272455 − 30.785344
      durableHwmGrossUsdg: 56.272455,
      durableHwmWithdrawnUsdg: 30.785344,
      durableAccruedFeeUsdg: 0,
      durableEpoch: 1,
      equityUsdg: 25.487111,
      maxDrawdownBps: 500,
      flows: [{ direction: "in", amountUsdg: 25, source: "inferred", txHash: null, blockNumber: null }],
      trades: 7,
      error: null,
    }).join("\n");

    assert.match(out, /→ breaker reads\s+0bps/, "the engine reads 0bps, so this must too");
    assert.doesNotMatch(out, /REFUSING every buy/);
  });

  it("and shows both halves, so the figure can be checked rather than trusted", () => {
    const out = describeAccounting({
      smartAccount: "0x05",
      durableHwmUsdg: 25.487111,
      durableHwmGrossUsdg: 56.272455,
      durableHwmWithdrawnUsdg: 30.785344,
      durableAccruedFeeUsdg: 0,
      durableEpoch: 1,
      equityUsdg: 25.487111,
      maxDrawdownBps: 500,
      flows: [],
      trades: 0,
      error: null,
    }).join("\n");
    assert.match(out, /durable peak \(effective\)\s+25\.487111\s+= gross 56\.272455 − withdrawn 30\.785344/);
  });
});
