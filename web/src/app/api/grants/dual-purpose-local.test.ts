/**
 * ONE INSTALL, TWO WALLETS, SELF-HOSTED: /api/grants?wallet=perps.
 *
 * Perps are not offered on BNB Chain: no Perps wallet is made or renewed,
 * whatever AGENTCAP_PERPS says, and nothing is written. A self-hosted Perps
 * home that already exists ($AGENTCAP_HOME/accounts/perps, purposeHome) is
 * still read by GET, held to by the Spot intake and stopped by the kill.
 *
 * Driven through the real route in a temporary AGENTCAP_HOME, with grants
 * sealed by the canonical-wall fixture over a stub chain.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import type { StoredGrant } from "@agentcap/core";
import { RESTORE_PERPS_OWNER_DIFFERS, RESTORE_PERPS_UNREAD, restorePerpsRefusal } from "@/lib/restore-perps-owner";

const ORIGIN = "http://localhost:3100";
const ENV = ["AGENTCAP_HOME", "AGENTCAP_HOSTED", "DATABASE_URL", "AGENTCAP_GRANT_FILE", "AGENTCAP_PERPS"] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let home = "";
let route: typeof import("./route");
let fixture: typeof import("@/lib/canonical-wall-fixture");
let chain: ReturnType<typeof import("@/lib/canonical-wall-fixture").derivingChain>;
let owner: LocalAccount;
let SPOT: `0x${string}`, PERPS: `0x${string}`;

const spotFile = () => path.join(home, "grant.json");
const perpsHome = () => path.join(home, "accounts", "perps");
const perpsFile = () => path.join(perpsHome(), "grant.json");
const read = (file: string): string | null => { try { return readFileSync(file, "utf8"); } catch { return null; } };
const post = (grant: unknown, query = "?wallet=perps") =>
  route.POST(new Request(`${ORIGIN}/api/grants${query}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(grant) }));
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });
/** The Spot grant.json a self-hosted install holds: the same owner key, at index 0. */
const spotOnDisk = (over: Partial<StoredGrant> = {}) => JSON.stringify({
  owner: owner.address, smartAccount: SPOT, chainId: 56, serialized: "spot-permission", sessionKeyAddress: owner.address,
  grantFeatures: ["tradeable-v2"], caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 20, maxOpsPerDay: 20 },
  grantedAt: 1, expiresAt: 9_999_999_999, demoOwnerPrivateKey: "kept-on-this-install", ...over,
}, null, 2);
const perpsGrant = async (account = PERPS, signer = owner) => (await fixture.signerGrant({ owner: signer, account, purpose: "perps" })).grant;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-grants-dual-local-"));
  process.env.AGENTCAP_HOME = home;
  for (const k of ["AGENTCAP_HOSTED", "DATABASE_URL", "AGENTCAP_GRANT_FILE"] as const) delete process.env[k];
  process.env.AGENTCAP_PERPS = "paper";
  fixture = await import("@/lib/canonical-wall-fixture");
  chain = fixture.derivingChain();
  chain.install();
  route = await import("./route");
  owner = privateKeyToAccount(generatePrivateKey());
  const { deriveKernelAccountAddress } = await import("@/lib/derive-account");
  const at = async (w: "spot" | "perps") => { const d = await deriveKernelAccountAddress(owner.address, 56, w); assert.ok(d.ok); return d.address; };
  SPOT = await at("spot");
  PERPS = await at("perps");
});
after(() => {
  chain?.restore();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
beforeEach(() => {
  process.env.AGENTCAP_PERPS = "paper";
  chain.state.down = false;
  for (const name of ["grant.json", "accounts", "grants"]) rmSync(path.join(home, name), { recursive: true, force: true });
  writeFileSync(spotFile(), spotOnDisk());
});

/** A Perps grant.json already on this install: no route writes one on BNB Chain. */
async function seedPerps(): Promise<StoredGrant> {
  const grant = await perpsGrant();
  mkdirSync(perpsHome(), { recursive: true });
  writeFileSync(perpsFile(), JSON.stringify(grant), { mode: 0o600 });
  return grant;
}

describe("self-hosted: no Perps wallet is made or renewed on BNB Chain", () => {
  const untouched = (before: string | null) => {
    assert.equal(read(spotFile()), before, "the Spot grant.json is untouched");
    assert.equal(existsSync(perpsHome()), false, "and no Perps home was made");
  };

  it("WHATEVER AGENTCAP_PERPS SAYS, paper included: 403 perps-wallet-not-offered, nothing written", async () => {
    const before = read(spotFile());
    const grant = await perpsGrant();
    for (const ceiling of [undefined, "off", "live", "papr", "paper"]) {
      if (ceiling === undefined) delete process.env.AGENTCAP_PERPS;
      else process.env.AGENTCAP_PERPS = ceiling;
      const res = await json(await post(grant));
      assert.equal(res.status, 403, String(ceiling));
      assert.equal(res.body.code, "perps-wallet-not-offered");
      untouched(before);
    }
  });

  it("a Perps renewal's first step is refused 403 and its grant.json is kept byte for byte; the kill still stops it", async () => {
    // A renewal's stop archived and removed accounts/perps/grant.json, then
    // the POST that should have followed was refused: a Perps wallet gone from
    // this install until perps came back on. It is refused with the renewal.
    const grant = await seedPerps();
    const before = { perps: read(perpsFile()), spot: read(spotFile()), home: readdirSync(perpsHome()).sort() };
    const renewalStop = () => route.DELETE(new Request(`${ORIGIN}/api/grants?wallet=perps`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "permission-replacement" }),
    }));
    for (const ceiling of [undefined, "off", "live", "papr", "paper"]) {
      if (ceiling === undefined) delete process.env.AGENTCAP_PERPS;
      else process.env.AGENTCAP_PERPS = ceiling;
      const res = await json(await renewalStop());
      assert.equal(res.status, 403, String(ceiling));
      assert.equal(res.body.code, "perps-wallet-not-offered");
      assert.match(String(res.body.error), /was not stopped[\s\S]*Nothing was changed/);
      assert.equal(read(perpsFile()), before.perps, `the Perps grant.json is byte for byte what it was (${String(ceiling)})`);
      assert.deepEqual(readdirSync(perpsHome()).sort(), before.home, "and nothing was archived beside it");
      assert.equal(read(spotFile()), before.spot, "the Spot grant.json is untouched");
    }
    // The kill is not a renewal: it stops the Perps wallet whatever the lever says.
    delete process.env.AGENTCAP_PERPS;
    const killed = await json(await route.DELETE(new Request(`${ORIGIN}/api/grants`, { method: "DELETE" })));
    assert.deepEqual(killed, { status: 200, body: { ok: true, perps: "stopped" } });
    assert.equal(existsSync(perpsFile()), false);
    assert.deepEqual(JSON.parse(read(path.join(perpsHome(), "grants", `${grant.smartAccount.toLowerCase()}.json`))!), grant, "its owner key is kept in its own archive");
  });

  it("the Spot intake holds the Perps grant.json to the same rules: another owner's is 409, and grant.json is kept", async () => {
    mkdirSync(perpsHome(), { recursive: true });
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    writeFileSync(perpsFile(), JSON.stringify({ purpose: "perps", owner: stranger, smartAccount: PERPS }));
    const before = read(spotFile());
    const res = await json(await post(JSON.parse(spotOnDisk({ serialized: "renewed" })), ""));
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "owner-differs");
    // It may answer the second step of a restore, after that restore's own stop:
    // it says what this request did, never that neither wallet changed.
    assert.equal(res.body.error, "Both of a login's wallets must use the same owner key, so this permission was not saved. Your other wallet was not changed.");
    assert.equal(read(spotFile()), before);
    // With the Perps wallet's own owner it is the renewal it always was.
    writeFileSync(perpsFile(), JSON.stringify({ purpose: "perps", owner: owner.address, smartAccount: PERPS }));
    assert.equal((await post(JSON.parse(spotOnDisk({ serialized: "renewed" })), "")).status, 200);
    assert.equal((JSON.parse(read(spotFile())!) as StoredGrant).serialized, "renewed");
  });
});

describe("self-hosted: GET ?wallet=perps reads the Perps home, never the Spot one", () => {
  const get = (query: string) => route.GET(new Request(`${ORIGIN}/api/grants${query}`));

  it("the Perps grant through the allowlist and its own heartbeat; the Spot answer is Spot's", async () => {
    const grant = await seedPerps();
    writeFileSync(path.join(perpsHome(), "heartbeat.json"), JSON.stringify({ at: 1_790_000_000, mode: "paper" }));
    writeFileSync(path.join(home, "heartbeat.json"), JSON.stringify({ at: 1_780_000_000, mode: "live" }));
    const res = await get("?wallet=perps");
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown> & { grant: Record<string, unknown> };
    assert.equal(String(body.grant.smartAccount).toLowerCase(), PERPS.toLowerCase());
    assert.equal(body.workerAliveAt, 1_790_000_000, "the Perps worker's own heartbeat");
    assert.equal(body.mode, "paper");
    assert.equal(body.grant.serialized, undefined);
    assert.ok(!text.toLowerCase().includes(grant.demoSessionPrivateKey!.slice(2).toLowerCase()), "the session key never leaves");
    const spot = (await (await get("")).json()) as { grant: { smartAccount: string }; workerAliveAt: number };
    assert.equal(spot.grant.smartAccount, SPOT);
    assert.equal(spot.workerAliveAt, 1_780_000_000);
  });

  it("no Perps grant.json is { exists: false }, whatever Spot holds; one that names Spot is refused 503", async () => {
    assert.deepEqual(await json(await get("?wallet=perps")), { status: 200, body: { exists: false } });
    mkdirSync(perpsHome(), { recursive: true });
    writeFileSync(perpsFile(), spotOnDisk());
    const res = await json(await get("?wallet=perps"));
    assert.equal(res.status, 503);
    assert.doesNotMatch(JSON.stringify(res.body), /kept-on-this-install|spot-permission/);
  });

  it("A PERPS grant.json THAT IS THERE BUT CANNOT BE READ IS A 503, never none; a BOM is stripped as the POST strips it; and the Wallet screen's restore check sees each", async () => {
    // The restore asks this before its stop, which self-hosted removes Spot's
    // grant.json; the POST that ends it reads the Perps file
    // this same way (otherLocalWalletRefusal) and would refuse it after.
    const viaGet = (async (url: string | URL | Request) => get(String(url).replace(/^\/api\/grants/, ""))) as typeof fetch;
    const stranger = privateKeyToAccount(generatePrivateKey()).address;
    const grant = await seedPerps();
    const onDisk = read(perpsFile())!;

    writeFileSync(perpsFile(), `\ufeff${onDisk}`);
    const bom = await json(await get("?wallet=perps"));
    assert.equal(bom.status, 200);
    assert.equal(bom.body.exists, true, "a BOM is no reason to call a wallet absent");
    assert.equal(String((bom.body.grant as { owner: string }).owner).toLowerCase(), owner.address.toLowerCase());
    assert.equal(await restorePerpsRefusal(stranger, viaGet), RESTORE_PERPS_OWNER_DIFFERS);
    assert.equal(await restorePerpsRefusal(owner.address, viaGet), null);

    for (const [what, damage] of [
      ["truncated", () => writeFileSync(perpsFile(), onDisk.slice(0, 20))],
      ["a directory", () => { rmSync(perpsFile()); mkdirSync(perpsFile()); }],
    ] as const) {
      damage();
      const res = await json(await get("?wallet=perps"));
      assert.equal(res.status, 503, what);
      assert.equal(res.body.error, "Couldn't read your Perps wallet. Please try again.", what);
      assert.equal(await restorePerpsRefusal(owner.address, viaGet), RESTORE_PERPS_UNREAD, `${what}: refused before the restore's stop, even under its own owner key`);
    }
    rmSync(perpsFile(), { recursive: true, force: true });
    assert.deepEqual(await json(await get("?wallet=perps")), { status: 200, body: { exists: false } }, "gone is none");
    assert.equal(await restorePerpsRefusal(stranger, viaGet), null);
    // Spot's answer is as it was: an unreadable Spot grant.json is none there.
    writeFileSync(spotFile(), "{not json");
    assert.deepEqual(await json(await get("")), { status: 200, body: { exists: false } });
  });

  it("perps off: still answered", async () => {
    await seedPerps();
    delete process.env.AGENTCAP_PERPS;
    const body = (await (await get("?wallet=perps")).json()) as { exists?: boolean };
    assert.equal(body.exists, true);
  });

  it("the Perps worker's report, from the Perps home's own ledger", async () => {
    const grant = await seedPerps();
    const { wrapSqlite } = await import("../../../../../worker/src/db");
    const { applyLedgerSchema } = await import("../../../../../worker/src/store");
    const report = { v: 1, mode: "paper", blocker: null, venueReadAt: null, protectAt: null, accountIndex: null, positions: [],
      openNotionalMicro: "0", collateralMicro: "100000000", inTransitMicro: null, minLiqDistanceBps: null, stopsMissing: 0, incident: false };
    for (const [dir, perps] of [[perpsHome(), JSON.stringify(report)], [home, JSON.stringify({ ...report, collateralMicro: "999" })]] as const) {
      const raw = new DatabaseSync(path.join(dir, "agentcap.db"));
      try {
        const db = wrapSqlite(raw);
        await applyLedgerSchema(db);
        // Keyed as the worker keys it (worker/src/store.ts ensureAgent): by the
        // stored grant's smartAccount, verbatim. The real signer hands it over
        // checksummed, as viem derives it.
        await db.prepare(`INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, mode, epoch, perps)
          VALUES (?, 'Perps', '0x1', '0x2', 56, '{}', 0, 0, 'paper', 1, ?)`).run(grant.smartAccount, perps);
      } finally { raw.close(); }
    }
    const body = (await (await get("?wallet=perps")).json()) as { perps?: unknown };
    assert.deepEqual(body.perps, report, "the Perps home's ledger, never the Spot one's");
  });
});

/** The record a stopped Perps wallet leaves behind, as the worker's own stop writes it. */
describe("local renewal identity survives its grant removal", () => {
  const stopForRenewal = async (grant: StoredGrant) => {
    const { stopLocalPerpsGrantForRenewal } = await import("../../../../../worker/src/perps-kill");
    return stopLocalPerpsGrantForRenewal(grant.smartAccount, grant.sessionKeyAddress!);
  };
  it("the retained record contains no keys and still prevents a conflicting Spot restore after the Perps grant is gone", async () => {
    const current = await seedPerps();
    assert.equal(await stopForRenewal(current), "stopped");
    assert.equal(existsSync(perpsFile()), false);
    const binding = path.join(perpsHome(), "permission-replacement.json");
    const text = read(binding); assert.ok(text); assert.doesNotMatch(text, /PrivateKey|serialized|signature/i); assert.equal(statSync(binding).mode & 0o777, 0o600);
    const status = await json(await route.GET(new Request(`${ORIGIN}/api/grants?wallet=perps`)));
    assert.equal(status.body.exists, false); assert.equal(status.body.stored, true); assert.equal(status.body.storedOwner, owner.address.toLowerCase());
    const pendingRead = (async () => Response.json(status.body)) as typeof fetch;
    assert.equal(await restorePerpsRefusal(owner.address, pendingRead), null);
    assert.equal(await restorePerpsRefusal(SPOT, pendingRead), RESTORE_PERPS_OWNER_DIFFERS);
    assert.equal(await stopForRenewal({ ...current, sessionKeyAddress: owner.address }), "changed");
    assert.equal(read(binding), text, "a stale retry cannot replace the retained identity");
    const stranger = privateKeyToAccount(generatePrivateKey());
    const conflict = await json(await post(JSON.parse(spotOnDisk({ owner: stranger.address })), ""));
    assert.equal(conflict.status, 409); assert.equal(conflict.body.code, "owner-differs");
    const allowed = await post(JSON.parse(spotOnDisk()), ""); assert.equal(allowed.status, 200);
  });
  it("an unreadable retained identity fails closed, and a kill clears the pending relationship", async () => {
    const current = await seedPerps();
    assert.equal(await stopForRenewal(current), "stopped");
    const binding = path.join(perpsHome(), "permission-replacement.json");
    writeFileSync(binding, "{broken");
    assert.equal((await post(JSON.parse(spotOnDisk()), "")).status, 503);
    assert.equal((await route.GET(new Request(`${ORIGIN}/api/grants?wallet=perps`))).status, 503);
    const { stopLocalPerpsWallet } = await import("../../../../../worker/src/perps-kill");
    await stopLocalPerpsWallet(); assert.equal(existsSync(binding), false, "kill discards the relationship even when the stopped record is unreadable");
    assert.equal((await post(JSON.parse(spotOnDisk()), "")).status, 200);
  });
  it("a status read waits for the grant and retained identity writer transition", async () => {
    const current = await seedPerps();
    const { withLocalStateLock } = await import("../../../../../worker/src/local-state-lock");
    const { retainLocalPerpsBinding } = await import("../../../../../worker/src/local-perps-binding");
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writing = withLocalStateLock(home, async () => {
      rmSync(perpsFile()); entered(); await gate; retainLocalPerpsBinding(current, perpsHome());
    });
    await ready;
    let finished = false;
    const reading = route.GET(new Request(`${ORIGIN}/api/grants?wallet=perps`)).then(res => { finished = true; return res; });
    try { await new Promise(resolve => setTimeout(resolve, 35)); assert.equal(finished, false, "status cannot observe the gap between two identity files"); }
    finally { release(); await writing; }
    const status = await json(await reading);
    assert.equal(status.body.stored, true); assert.equal(status.body.storedOwner, owner.address.toLowerCase());
  });
});
