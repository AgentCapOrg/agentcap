/**
 * ONE LOGIN, TWO WALLETS, HOSTED: /api/grants?wallet=perps.
 *
 * Perps are not offered on BNB Chain, so no Perps wallet is made or renewed:
 * both are refused with nothing written, the renewal's first step (its
 * permission-replacement stop) included. A Perps record that already exists is
 * still shown by GET, held to by the stores and stopped by the kill, and a
 * binding signed for one wallet is never accepted for the other.
 *
 * Driven through the real route over the real file-backed stores (the
 * single-service hosted deploy), a real session, real Privy access tokens
 * (ES256, verified offline against a pinned key, exactly as production can be
 * configured), real owner signatures, grants sealed by the canonical-wall
 * fixture, and a stub chain whose EntryPoint derives each Kernel account from
 * its initCode, so index 0 and index 1 are two real, different addresses. Only
 * the single-use nonce store, which needs Postgres hosted, is stood in (it
 * counts what it spends).
 */
import assert from "node:assert/strict";
import { pilotFixture } from "@/lib/perps-pilot-fixture";
let pilot: ReturnType<typeof pilotFixture>;
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it, mock, type TestContext } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import { sealSecret } from "../../../../../worker/src/store-crypto";
import { bindingMessage, type GrantPurpose, type StoredGrant } from "@agentcap/core";
import {
  RENEWAL_PERPS_OWNER_DIFFERS, RENEWAL_PERPS_UNREAD, RESTORE_PERPS_HOSTED, RESTORE_PERPS_UNREAD_HOSTED, renewalPerpsRefusal, restorePerpsRefusal,
} from "@/lib/restore-perps-owner";

const ORIGIN = "https://app.agentcap.xyz";
const APP = "agentcap-test-app";
const ENV = [
  "AGENTCAP_HOME", "AGENTCAP_HOSTED", "AGENTCAP_SESSION_SECRET", "AGENTCAP_STORE_DEK", "DATABASE_URL", "AGENTCAP_PUBLIC_ORIGIN",
  "AGENTCAP_PERPS", "AGENTCAP_PERPS_PAPER_TENANTS", "NEXT_PUBLIC_PRIVY_APP_ID", "PRIVY_APP_SECRET", "PRIVY_VERIFICATION_KEY",
] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

let home = "";
let route: typeof import("./route");
let auth: typeof import("@/lib/auth");
let fixture: typeof import("@/lib/canonical-wall-fixture");
let stores: typeof import("../../../../../worker/src/grant-store");
let identities: typeof import("../../../../../worker/src/identity-store");
let chain: ReturnType<typeof import("@/lib/canonical-wall-fixture").derivingChain>;
let derive: typeof import("@/lib/derive-account").deriveKernelAccountAddress;
let nonces = 0;

// ── Privy, for real: an ES256 key pair the deployment pins ───────────────────
const privy = generateKeyPairSync("ec", { namedCurve: "P-256" });
function privyToken(did: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const signed = `${b64({ alg: "ES256", typ: "JWT" })}.${b64({ sid: `s-${did}`, sub: did, iss: "privy.io", aud: APP, iat: now, exp: now + 600 })}`;
  return `${signed}.${sign("sha256", Buffer.from(signed), { key: privy.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

/** A Privy login: its embedded wallet is the session, the owner key and the tenant. */
interface Login { account: LocalAccount; did: string; spot: `0x${string}`; perps: `0x${string}` }
async function login(name: string, admitted = true): Promise<Login> {
  const account = privateKeyToAccount(generatePrivateKey());
  if (admitted) await pilot.set(account.address, "allowed");
  // These tests exercise wallet authority after pilot admission. Admit only
  // their generated owners; read/kill tests below also withdraw that admission.
  process.env.AGENTCAP_PERPS_PAPER_TENANTS = [process.env.AGENTCAP_PERPS_PAPER_TENANTS, account.address].filter(Boolean).join(",");
  const at = async (wallet: GrantPurpose) => {
    const d = await derive(account.address, 56, wallet);
    assert.ok(d.ok, "the stub chain derives");
    return d.address;
  };
  return { account, did: `did:privy:${name}`, spot: await at("spot"), perps: await at("perps") };
}

/** The single-use nonce store is Postgres hosted; it is stood in for the length of one POST. */
async function withNonceStore<T>(fn: () => Promise<T>): Promise<T> {
  process.env.DATABASE_URL = "postgres://127.0.0.1:1/nonces-only";
  try {
    return await fn();
  } finally {
    delete process.env.DATABASE_URL;
  }
}

/**
 * POST `grant` as `who`, under `query`, with a `privy-did-owner-v1` binding its
 * owner signed over the claim for `signedFor` (the wallet the request names,
 * unless a test replays it onto the other).
 */
async function privyPost(grant: StoredGrant, query: string, who: Login, signedFor: GrantPurpose) {
  const nonce = auth.issueChallengeNonce(ORIGIN);
  const message = bindingMessage({
    version: "privy-did-owner-v1", origin: ORIGIN, nonce, owner: grant.owner, smartAccount: grant.smartAccount,
    chainId: grant.chainId, did: who.did, purpose: signedFor,
  });
  const res = await withNonceStore(async () => route.POST(new Request(`${ORIGIN}/api/grants${query}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(who.account.address)}`,
      authorization: `Bearer ${privyToken(who.did)}`,
    },
    body: JSON.stringify({ ...grant, binding: { version: "privy-did-owner-v1", nonce, did: who.did, ownerSignature: await who.account.signMessage({ message }) } }),
  })));
  return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string; code?: string; ownerFacing?: boolean } };
}

const tenantFile = (dir: "tenants" | "tenants-perps", who: Login) => path.join(home, dir, `${who.account.address.toLowerCase()}.json`);
const read = (file: string): string | null => { try { return readFileSync(file, "utf8"); } catch { return null; } };
const perpsGrantOf = async (who: Login) => stores.getGrantStore("perps").get(who.account.address);
const perpsGrant = async (who: Login, account = who.perps, owner = who.account) =>
  (await fixture.signerGrant({ owner, account, purpose: "perps" })).grant;
const spotGrant = async (who: Login) => (await fixture.signerGrant({ owner: who.account, account: who.spot })).grant;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-grants-dual-purpose-"));
  process.env.AGENTCAP_HOME = home;
  process.env.AGENTCAP_HOSTED = "1";
  process.env.AGENTCAP_SESSION_SECRET = "test-secret-at-least-thirty-two-characters-long";
  process.env.AGENTCAP_STORE_DEK = Buffer.alloc(32, 7).toString("base64");
  delete process.env.DATABASE_URL;
  delete process.env.AGENTCAP_PUBLIC_ORIGIN;
  process.env.AGENTCAP_PERPS = "paper";
  delete process.env.AGENTCAP_PERPS_PAPER_TENANTS;
  pilot = pilotFixture();
  process.env.NEXT_PUBLIC_PRIVY_APP_ID = APP;
  // WRITTEN, never read, and so not as `process.env.PRIVY_APP_SECRET`: that
  // spelling is how privy-boundary.test.ts finds a reader of the secret, and
  // only web/src/lib/privy.ts may be one.
  Object.assign(process.env, { PRIVY_APP_SECRET: "privy-secret-for-tests" });
  process.env.PRIVY_VERIFICATION_KEY = privy.publicKey.export({ type: "spki", format: "pem" }).toString();
  // Through require: the route reaches the worker's stores by require, and a
  // stub on the ESM instance is one the route never calls. Every store is made
  // here, file-backed, before DATABASE_URL is ever set for a nonce.
  const require = createRequire(import.meta.url);
  stores = require("../../../../../worker/src/grant-store.ts") as typeof stores;
  identities = require("../../../../../worker/src/identity-store.ts") as typeof identities;
  const settings = require("../../../../../worker/src/settings-store.ts") as typeof import("../../../../../worker/src/settings-store");
  stores.resetGrantStoreForTest();
  identities.resetIdentityStoreForTest();
  settings.resetSettingsStoreForTest();
  stores.getGrantStore("spot");
  stores.getGrantStore("perps");
  identities.getIdentityStore();
  settings.getSettingsStore("spot");
  settings.getSettingsStore("perps");
  const { SqlNonceStore } = require("../../../../../worker/src/auth-nonce-store.ts") as typeof import("../../../../../worker/src/auth-nonce-store");
  mock.method(SqlNonceStore.prototype, "consume", async () => {
    nonces += 1;
    return true;
  });
  fixture = await import("@/lib/canonical-wall-fixture");
  chain = fixture.derivingChain();
  chain.install();
  auth = await import("@/lib/auth");
  ({ deriveKernelAccountAddress: derive } = await import("@/lib/derive-account"));
  route = await import("./route");
});
after(() => {
  pilot?.close();
  chain?.restore();
  mock.restoreAll();
  stores?.resetGrantStoreForTest();
  identities?.resetIdentityStoreForTest();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/**
 * A Perps record already on the server. No route makes one on BNB Chain, so it
 * is put into the Perps store as one made before would sit there.
 */
async function seedPerps(who: Login, grant?: StoredGrant): Promise<StoredGrant> {
  const record = {
    ...(grant ?? (await perpsGrant(who))),
    binding: { version: "privy-did-owner-v1" as const, nonce: "seeded", did: who.did, ownerSignature: `0x${"22".repeat(65)}` as const },
  };
  await stores.getGrantStore("perps").put(who.account.address, record);
  return record;
}

describe("hosted: no Perps wallet is made or renewed on BNB Chain", () => {
  it("WHATEVER AGENTCAP_PERPS SAYS, paper included: creation is 403 perps-wallet-not-offered — no store, no identity, no nonce", async () => {
    const grace = await login("grace");
    assert.equal((await privyPost(await spotGrant(grace), "", grace, "spot")).status, 200);
    const identity = await identities.getIdentityStore().get(grace.account.address);
    try {
      for (const ceiling of [undefined, "off", "papr", "live", "on", "paper"]) {
        if (ceiling === undefined) delete process.env.AGENTCAP_PERPS;
        else process.env.AGENTCAP_PERPS = ceiling;
        const before = { spot: read(tenantFile("tenants", grace)), spent: nonces };
        const res = await privyPost(await perpsGrant(grace), "?wallet=perps", grace, "perps");
        assert.equal(res.status, 403, String(ceiling));
        assert.equal(res.body.code, "perps-wallet-not-offered");
        assert.match(res.body.error ?? "", /Nothing was saved/);
        assert.equal(nonces, before.spent, "no nonce spent");
        assert.equal(await perpsGrantOf(grace), null);
        assert.equal(read(tenantFile("tenants-perps", grace)), null, "the Perps store is untouched");
        assert.equal(read(tenantFile("tenants", grace)), before.spot, "and the Spot one");
        assert.deepEqual(await identities.getIdentityStore().get(grace.account.address), identity, "and the identity");
      }
    } finally {
      process.env.AGENTCAP_PERPS = "paper";
    }
  });

  it("a Perps renewal's FIRST STEP is refused too — the stop changes nothing, and the kill still stops the wallet", async () => {
    // A renewal that cannot finish must not start: the stop would retire the
    // Perps key and the grant that should follow is refused.
    const nina = await login("nina");
    assert.equal((await privyPost(await spotGrant(nina), "", nina, "spot")).status, 200);
    await seedPerps(nina);
    const held = await perpsGrantOf(nina);
    assert.ok(held);
    const del = (query: string, body: Record<string, unknown>) => route.DELETE(new Request(`${ORIGIN}/api/grants${query}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(nina.account.address)}` },
      body: JSON.stringify({ expectedTenant: nina.account.address, ...body }),
    }));
    const before = { perps: read(tenantFile("tenants-perps", nina)), spot: read(tenantFile("tenants", nina)) };
    try {
      for (const ceiling of [undefined, "off", "papr", "live", "paper"]) {
        if (ceiling === undefined) delete process.env.AGENTCAP_PERPS;
        else process.env.AGENTCAP_PERPS = ceiling;
        const res = await del("?wallet=perps", { purpose: "permission-replacement", expectedAccount: held.smartAccount, expectedSession: held.sessionKeyAddress });
        assert.equal(res.status, 403, String(ceiling));
        const body = (await res.json()) as { code?: string; error?: string; ownerFacing?: boolean };
        assert.equal(body.code, "perps-wallet-not-offered");
        assert.equal(body.ownerFacing, true);
        assert.match(body.error ?? "", /was not stopped[\s\S]*Nothing was changed/);
        assert.equal(read(tenantFile("tenants-perps", nina)), before.perps, `the Perps record is byte for byte what it was (${String(ceiling)})`);
        assert.equal(read(tenantFile("tenants", nina)), before.spot, "and the Spot one");
        assert.equal((await perpsGrantOf(nina))?.demoSessionPrivateKey, held.demoSessionPrivateKey, "the Perps key is still stored");
      }
      // The kill is not a renewal: it names no wallet and stops the Perps one
      // whatever the lever says.
      delete process.env.AGENTCAP_PERPS;
      const kill = await del("", { purpose: "delete-agent" });
      const killed = await kill.text();
      assert.equal(kill.status, 200, killed);
      assert.deepEqual(JSON.parse(killed), { ok: true, perps: "stopped" });
      assert.equal(await perpsGrantOf(nina), null);
      assert.equal(await stores.getGrantStore("spot").get(nina.account.address), null);
    } finally {
      process.env.AGENTCAP_PERPS = "paper";
    }
  });

  it("a Spot binding replayed onto the Perps grant, and a Perps binding onto the Spot grant: 403, nonce unspent, nothing stored", async () => {
    const alice = await login("alice");
    const before = { spot: read(tenantFile("tenants", alice)), perps: read(tenantFile("tenants-perps", alice)), spent: nonces };
    const asPerps = await privyPost(await perpsGrant(alice), "?wallet=perps", alice, "spot");
    assert.equal(asPerps.status, 403, JSON.stringify(asPerps.body));
    const asSpot = await privyPost(await spotGrant(alice), "", alice, "perps");
    assert.equal(asSpot.status, 403, JSON.stringify(asSpot.body));
    assert.equal(nonces, before.spent, "a refused claim spends no nonce");
    assert.equal(read(tenantFile("tenants", alice)), before.spot);
    assert.equal(read(tenantFile("tenants-perps", alice)), before.perps);
  });

});

describe("hosted: GET ?wallet=perps answers for the Perps wallet, and only it", () => {
  let kim: Login;
  let grant: StoredGrant;
  const get = (who: Login | null, query: string) =>
    route.GET(new Request(`${ORIGIN}/api/grants${query}`, who ? { headers: { cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(who.account.address)}` } } : {}));
  before(async () => {
    kim = await login("kim");
    assert.equal((await privyPost(await spotGrant(kim), "", kim, "spot")).status, 200);
    grant = await seedPerps(kim);
    // The ledger the hosted GET reads: hosted it is the shared Postgres; with
    // no DATABASE_URL (this file-backed deploy) each wallet's read opens its
    // own home's sqlite file (ledger.ts withReadDb).
    const { wrapSqlite } = await import("../../../../../worker/src/db");
    const { applyLedgerSchema } = await import("../../../../../worker/src/store");
    for (const dir of [home, path.join(home, "accounts", "perps")]) {
      mkdirSync(dir, { recursive: true });
      const raw = new DatabaseSync(path.join(dir, "agentcap.db"));
      try { await applyLedgerSchema(wrapSqlite(raw)); } finally { raw.close(); }
    }
  });

  it("the Perps grant through the allowlist, no-store, with the tenant echoed; Spot's answer is its own", async () => {
    const res = await get(kim, "?wallet=perps");
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    const text = await res.text();
    const body = JSON.parse(text) as Record<string, unknown> & { grant: Record<string, unknown> };
    assert.equal(body.exists, true);
    assert.equal(body.tenant, kim.account.address.toLowerCase());
    assert.equal(String(body.grant.smartAccount).toLowerCase(), kim.perps.toLowerCase());
    assert.equal(body.grant.purpose, "perps");
    assert.deepEqual(body.grant.binding, { version: "privy-did-owner-v1" }, "the binding's version, and nothing else of it");
    assert.equal("energy" in body, false, "a Perps wallet buys no energy");
    assert.equal(body.perps, null, "no report yet is null, never an empty book");
    for (const secret of [grant.demoSessionPrivateKey, grant.serialized, kim.did]) {
      assert.ok(!text.toLowerCase().includes(String(secret).replace(/^0x/, "").toLowerCase()), "no secret, nonce or DID in the Perps answer");
    }
    assert.equal(body.grant.serialized, undefined);

    const spot = await get(kim, "");
    const spotBody = (await spot.json()) as { grant: Record<string, unknown> };
    assert.equal(String(spotBody.grant.smartAccount).toLowerCase(), kim.spot.toLowerCase(), "the Spot answer is the Spot wallet's");
    assert.equal(spotBody.grant.purpose, undefined);
    // D3: Spot keeps main's denylist view, binding and all.
    assert.equal((spotBody.grant.binding as { did?: string }).did, kim.did);
  });

  it("never another tenant's: a login with no Perps wallet, or none at all, reads none", async () => {
    const leo = await login("leo");
    assert.deepEqual(await (await get(leo, "?wallet=perps")).json(), { exists: false, tenant: leo.account.address.toLowerCase() });
    // A Spot wallet is not a Perps one, stored or shown: no `stored`, and the Wallet screen's restore goes ahead.
    assert.equal((await privyPost(await spotGrant(leo), "", leo, "spot")).status, 200);
    assert.deepEqual(await (await get(leo, "?wallet=perps")).json(), { exists: false, tenant: leo.account.address.toLowerCase() });
    const viaGet = (async (url: string | URL | Request) => get(leo, String(url).replace(/^\/api\/grants/, ""))) as typeof fetch;
    assert.equal(await restorePerpsRefusal(privateKeyToAccount(generatePrivateKey()).address, viaGet), null);
    const out = await get(null, "?wallet=perps");
    assert.deepEqual(await out.json(), { exists: false, tenant: null });
    assert.equal(out.headers.get("cache-control"), "private, no-store");
  });

  it("A PERPS RECORD STOPPED FOR A RENEWAL is `stored`, never none: the Spot put still holds a Spot grant to it, so the Wallet screen's restore and renewal ask it through the login", async () => {
    const mia = await login("mia");
    const current = await seedPerps(mia);
    const viaGet = (async (url: string | URL | Request) => get(mia, String(url).replace(/^\/api\/grants/, ""))) as typeof fetch;
    // Shown, the hosted Perps wallet refuses every restore, the login's own key included (the legacy binding refuses that key).
    assert.equal(await restorePerpsRefusal(mia.account.address, viaGet), RESTORE_PERPS_HOSTED);
    assert.equal(await stores.getGrantStore("perps").stopForReplacement(mia.account.address, current.smartAccount), "stopped");
    assert.equal(await perpsGrantOf(mia), null, "set-up: the store will not show it");
    const body = await (await get(mia, "?wallet=perps")).json();
    assert.deepEqual(body, { exists: false, tenant: mia.account.address.toLowerCase(), stored: true });
    // The Wallet screen's restore and renewal read exactly this answer.
    const legacyKey = privateKeyToAccount(generatePrivateKey()).address;
    assert.equal(await restorePerpsRefusal(legacyKey, viaGet), RESTORE_PERPS_HOSTED, "another owner key is refused before its stop and revocation");
    assert.equal(await restorePerpsRefusal(mia.account.address, viaGet), RESTORE_PERPS_HOSTED, "and so is the login's own");
    assert.equal(await renewalPerpsRefusal(mia.account.address, mia.account.address, viaGet), null, "a Spot renewal re-signed by the login goes ahead");
    assert.equal(await renewalPerpsRefusal(legacyKey, legacyKey, viaGet), RENEWAL_PERPS_OWNER_DIFFERS, "a legacy-owned Spot grant's renewal beside it is refused first");
    // And the store's put does hold a Spot grant to that record: another owner key is refused there too.
    const spotUnderLegacy = (await fixture.signerGrant({ owner: privateKeyToAccount(generatePrivateKey()), account: mia.spot })).grant;
    await assert.rejects(stores.getGrantStore("spot").put(mia.account.address, spotUnderLegacy), /same owner key/);
  });

  it("ON THE FILE STORE, A PERPS RECORD THE SPOT PUT WOULD REFUSE ON is a 503, never `stored`: the restore and the renewal are refused before their stop", async () => {
    const nia = await login("nia");
    assert.equal((await privyPost(await spotGrant(nia), "", nia, "spot")).status, 200);
    await seedPerps(nia);
    const tenant = nia.account.address.toLowerCase();
    const perpsFile = path.join(home, "tenants-perps", `${tenant}.json`);
    const record = JSON.parse(readFileSync(perpsFile, "utf8")) as { grant: Record<string, unknown> };
    const viaGet = (async (url: string | URL | Request) => get(nia, String(url).replace(/^\/api\/grants/, ""))) as typeof fetch;
    try {
      for (const [what, text] of [
        ["truncated", "{ truncated"],
        ["naming the Spot wallet", readFileSync(path.join(home, "tenants", `${tenant}.json`), "utf8")],
        // Stopped for a renewal (so `get` hides it), and owned by another key than the login: compared through the
        // tenant it would pass for the login's own.
        ["stopped for a renewal, owned by another key than the login", JSON.stringify({ ...record, grant: {
          ...record.grant, owner: privateKeyToAccount(generatePrivateKey()).address,
          replacementStop: { sessionKeyHash: "0".repeat(64), sessionKeyAddress: record.grant.sessionKeyAddress, stoppedAt: 1 },
        } })],
      ] as const) {
        writeFileSync(perpsFile, text);
        const res = await get(nia, "?wallet=perps");
        assert.equal(res.status, 503, `${what}: ${await res.clone().text()}`);
        assert.equal(await restorePerpsRefusal(nia.account.address, viaGet, true), RESTORE_PERPS_UNREAD_HOSTED, `${what}: the login's own key too, before its stop`);
        assert.equal(await renewalPerpsRefusal(nia.account.address, nia.account.address, viaGet), RENEWAL_PERPS_UNREAD, `${what}: the renewal too, before its stop`);
        await assert.rejects(stores.getGrantStore("spot").put(nia.account.address, (await fixture.signerGrant({ owner: nia.account, account: nia.spot })).grant),
          Error, `${what}: which is what the Spot put does after the stop`);
      }
    } finally {
      writeFileSync(perpsFile, JSON.stringify(record));
    }
    assert.equal(((await (await get(nia, "?wallet=perps")).json()) as { exists?: boolean }).exists, true, "the record put back reads again");
  });

  it("an active Perps record whose session key cannot be opened is unreadable, not stopped for renewal", async () => {
    const noa = await login("noa-unread-key");
    const grant = await seedPerps(noa);
    const file = tenantFile("tenants-perps", noa);
    const original = readFileSync(file, "utf8");
    const record = JSON.parse(original) as Record<string, unknown>;
    const viaGet = (async (url: string | URL | Request) => get(noa, String(url).replace(/^\/api\/grants/, ""))) as typeof fetch;
    try {
      for (const [what, sealedSessionKey] of [
        ["malformed ciphertext", "not-a-sealed-session-key"],
        ["a different encryption key", sealSecret(grant.demoSessionPrivateKey, Buffer.alloc(32, 8))],
      ]) {
        const damaged = JSON.stringify({ ...record, sealedSessionKey });
        writeFileSync(file, damaged);
        assert.equal(await perpsGrantOf(noa), null, "the file store cannot supply a signing key");
        const res = await get(noa, "?wallet=perps");
        assert.equal(res.status, 503, `${what}: ${await res.clone().text()}`);
        assert.equal(res.headers.get("cache-control"), "private, no-store");
        assert.deepEqual(await res.json(), { error: "Couldn't read your Perps wallet. Please try again.", ownerFacing: true });
        assert.equal(await restorePerpsRefusal(noa.account.address, viaGet, true), RESTORE_PERPS_UNREAD_HOSTED);
        assert.equal(await renewalPerpsRefusal(noa.account.address, noa.account.address, viaGet), RENEWAL_PERPS_UNREAD,
          "same-owner renewal must not turn unreadable status into permission to start its stop");
        assert.equal(readFileSync(file, "utf8"), damaged, "status reads leave the record intact");
      }
    } finally {
      writeFileSync(file, original);
    }
    assert.equal(await stores.getGrantStore("perps").stopForReplacement(noa.account.address), "stopped");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).sealedSessionKey, "", "a deliberate stop erases the secret");
    assert.deepEqual(await (await get(noa, "?wallet=perps")).json(), {
      exists: false, tenant: noa.account.address.toLowerCase(), stored: true,
    }, "the explicit replacement stop still reports its retained owner without a key");
    const stopped = JSON.parse(readFileSync(file, "utf8"));
    try {
      for (const replacementStop of [null, {}, { ...stopped.grant.replacementStop, sessionKeyHash: "bad-fence" }]) {
        writeFileSync(file, JSON.stringify({ ...stopped, grant: { ...stopped.grant, replacementStop } }));
        const res = await get(noa, "?wallet=perps");
        assert.equal(res.status, 503, "an empty key plus a malformed stop marker is unreadable, never `stored`");
        assert.deepEqual(await res.json(), { error: "Couldn't read your Perps wallet. Please try again.", ownerFacing: true });
        assert.equal(await renewalPerpsRefusal(noa.account.address, noa.account.address, viaGet), RENEWAL_PERPS_UNREAD);
      }
    } finally {
      writeFileSync(file, JSON.stringify(stopped));
    }
  });

  it("D1: answered whatever AGENTCAP_PERPS says, including after pilot access ends, so an owner can always see a Perps wallet they hold", async (t) => {
    await pilot.set(kim.account.address, "revoked");
    const admitted = process.env.AGENTCAP_PERPS_PAPER_TENANTS;
    delete process.env.AGENTCAP_PERPS_PAPER_TENANTS;
    t.after(() => {
      process.env.AGENTCAP_PERPS = "paper";
      if (admitted === undefined) delete process.env.AGENTCAP_PERPS_PAPER_TENANTS;
      else process.env.AGENTCAP_PERPS_PAPER_TENANTS = admitted;
    });
    for (const ceiling of [undefined, "off", "live"]) {
      if (ceiling === undefined) delete process.env.AGENTCAP_PERPS;
      else process.env.AGENTCAP_PERPS = ceiling;
      const body = (await (await get(kim, "?wallet=perps")).json()) as { exists?: boolean; grant?: { smartAccount?: string } };
      assert.equal(body.exists, true, String(ceiling));
      assert.equal(body.grant?.smartAccount?.toLowerCase(), kim.perps.toLowerCase());
    }
    process.env.AGENTCAP_PERPS = "paper";
  });

  it("and the kill made for it stops it after pilot access ends: the Perps wallet made here is revoked with the Spot one", async (t) => {
    await pilot.set(kim.account.address, "revoked");
    const admitted = process.env.AGENTCAP_PERPS_PAPER_TENANTS;
    delete process.env.AGENTCAP_PERPS_PAPER_TENANTS;
    t.after(() => {
      if (admitted === undefined) delete process.env.AGENTCAP_PERPS_PAPER_TENANTS;
      else process.env.AGENTCAP_PERPS_PAPER_TENANTS = admitted;
    });
    const res = await route.DELETE(new Request(`${ORIGIN}/api/grants`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(kim.account.address)}` },
      body: JSON.stringify({ purpose: "delete-agent", expectedTenant: kim.account.address }),
    }));
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(await perpsGrantOf(kim), null);
    assert.equal(await stores.getGrantStore("spot").get(kim.account.address), null);
    assert.ok(readdirSync(path.join(home, "tenants-perps")).length > 0, "other logins' Perps wallets are untouched");
  });
});

/**
 * A SPOT RECORD STOPPED FOR A RENEWAL THAT NEVER LANDED is `stored`, as the
 * Perps branch says of its own (2026-11-18: an owner stopped his agent for a
 * re-signature and never signed; his screens said "Create your agentcapavatar").
 * The owner's screens read it to point at the re-signature rather than at
 * creating an agent (terminal/owner-state.ts). Everything else about the Spot
 * answer is unchanged: still `exists` false, never a grant view, and a record
 * that was removed, never made, or cannot be verified answers exactly as before.
 */
describe("hosted: GET (Spot) says `stored` for a record stopped for a renewal, and nothing else changes", () => {
  const get = (who: Login | null, query = "") =>
    route.GET(new Request(`${ORIGIN}/api/grants${query}`, who ? { headers: { cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(who.account.address)}` } } : {}));
  const stopForRenewal = (who: Login, account: string) => route.DELETE(new Request(`${ORIGIN}/api/grants`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", cookie: `${auth.SESSION_COOKIE}=${auth.mintSession(who.account.address)}` },
    body: JSON.stringify({ purpose: "permission-replacement", expectedTenant: who.account.address, expectedAccount: account }),
  }));
  before(async () => {
    // A live grant's answer reads the ledger: this file-backed deploy opens
    // the home's sqlite file (ledger.ts withReadDb), as the describe above.
    const { wrapSqlite } = await import("../../../../../worker/src/db");
    const { applyLedgerSchema } = await import("../../../../../worker/src/store");
    mkdirSync(home, { recursive: true });
    const raw = new DatabaseSync(path.join(home, "agentcap.db"));
    try { await applyLedgerSchema(wrapSqlite(raw)); } finally { raw.close(); }
  });

  it("a stopped Spot record is `stored`, no-store, with the tenant and nothing of the grant; the Perps answer is untouched", async () => {
    const sol = await login("sol-stopped");
    const grant = await spotGrant(sol);
    assert.equal((await privyPost(grant, "", sol, "spot")).status, 200);
    const stop = await stopForRenewal(sol, grant.smartAccount);
    assert.equal(stop.status, 200, await stop.clone().text());
    assert.equal(await stores.getGrantStore("spot").get(sol.account.address), null, "set-up: the store will not show it");
    const res = await get(sol);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { exists: false, tenant: sol.account.address.toLowerCase(), stored: true });
    assert.ok(!text.toLowerCase().includes(grant.smartAccount.slice(2).toLowerCase()), "no account, key or grant field in the answer");
    assert.deepEqual(await (await get(sol, "?wallet=perps")).json(), { exists: false, tenant: sol.account.address.toLowerCase() },
      "a stopped Spot record is not a Perps one");
  });

  it("a removed record, a login that never had one, another login's live grant, and a signed-out read answer as before", async () => {
    const ray = await login("ray-removed");
    const grant = await spotGrant(ray);
    assert.equal((await privyPost(grant, "", ray, "spot")).status, 200);
    assert.equal((await stopForRenewal(ray, grant.smartAccount)).status, 200);
    // Start over's removal (lib/start-over.ts `remove`) of the stopped record.
    await stores.getGrantStore("spot").remove(ray.account.address);
    assert.deepEqual(await (await get(ray)).json(), { exists: false, tenant: ray.account.address.toLowerCase() }, "removed: no `stored`");

    const una = await login("una-never");
    assert.deepEqual(await (await get(una)).json(), { exists: false, tenant: una.account.address.toLowerCase() }, "never made: no `stored`");

    const tia = await login("tia-live");
    assert.equal((await privyPost(await spotGrant(tia), "", tia, "spot")).status, 200);
    const live = (await (await get(tia)).json()) as { exists?: boolean; stored?: unknown };
    assert.equal(live.exists, true, "a live grant is still shown");
    assert.equal("stored" in live, false);

    const out = await get(null);
    assert.deepEqual(await out.json(), { exists: false, tenant: null });
  });

  it("a stopped record the store cannot verify keeps the plain answer: never `stored`, never a 503", async () => {
    const vic = await login("vic-unverified");
    const grant = await spotGrant(vic);
    assert.equal((await privyPost(grant, "", vic, "spot")).status, 200);
    assert.equal((await stopForRenewal(vic, grant.smartAccount)).status, 200);
    const file = tenantFile("tenants", vic);
    const stopped = readFileSync(file, "utf8");
    const record = JSON.parse(stopped) as { grant: Record<string, unknown> };
    try {
      for (const [what, text] of [
        ["truncated", "{ truncated"],
        ["a malformed stop marker", JSON.stringify({ ...record, grant: { ...record.grant, replacementStop: {} } })],
        ["naming the Perps wallet", JSON.stringify({ ...record, grant: { ...record.grant, purpose: "perps" } })],
      ] as const) {
        writeFileSync(file, text);
        const res = await get(vic);
        assert.equal(res.status, 200, `${what}: ${await res.clone().text()}`);
        assert.deepEqual(await res.json(), { exists: false, tenant: vic.account.address.toLowerCase() }, what);
      }
    } finally {
      writeFileSync(file, stopped);
    }
    assert.equal(((await (await get(vic)).json()) as { stored?: unknown }).stored, true, "the record put back is `stored` again");
  });
});
