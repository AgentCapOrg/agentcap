import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as core from "@agentcap/core";
import {
  GRANT_PERP_LIGHTER,
  GRANT_TRANSFER,
  LIGHTER_ROUTE_V1,
  WITHDRAWAL_ALLOWLIST_LANDED_AT,
  grantHasTransfer,
  grantPerp,
  type StoredGrant,
} from "@agentcap/core";
import { CANONICAL_GRANT_FEATURES, checkCanonicalWall } from "./canonical-wall";
import { TRENCHER_FACTORY, TRENCHER_VAULT, resealed, signerGrant } from "./canonical-wall-fixture";

/**
 * THE SERVER STORES THE AGENTCAP WALL, AND NOTHING ELSE.
 *
 * Every grant here is built by the real packages. The ones that pass come out of
 * web/src/lib/session.ts prepareAgentGrant — the signer the dashboard, the iOS
 * engine and sdk/browser.ts all go through. The ones that fail are what a tenant
 * holding their own owner key can build instead: a permission the owner really
 * enabled and the chain would really install, carrying a power the canonical
 * wall does not — a USDG transfer, the Rialto target, the v4 UniversalRouter —
 * or metadata that tells the worker's mirror something the wall does not say.
 */

const ACCOUNT = "0x00000000000000000000000000000000000a11ce" as const;
const ATTACKER = "0x000000000000000000000000000000000000bad1" as const;
const EXTRA = { symbol: "CATE", address: "0x0000000000000000000000000000000000ca7e00" as const, decimals: 18 };
const EXTRA2 = { symbol: "UBIK", address: "0x0000000000000000000000000000000000ca7e02" as const, decimals: 18 };
const EXTRA3 = { symbol: "NEON", address: "0x0000000000000000000000000000000000ca7e03" as const, decimals: 18 };
/** The fullest wall these tests seal: Trencher + three coins. */
const FULL = { account: ACCOUNT, extraTokens: [EXTRA, EXTRA2, EXTRA3], trencher: true };
/** A canonical Lighter API public key (five little-endian limbs, each below p, not all zero). */
const PERP_KEY = `0x${"1a".repeat(40)}` as `0x${string}`;

const verdict = (g: unknown) => checkCanonicalWall(g as Record<string, unknown>);
const refusedWith = (g: unknown, code: string) => {
  const v = verdict(g);
  assert.equal(v.ok, false, "expected a refusal");
  if (!v.ok) assert.equal(v.code, code, v.why);
  return v;
};

const decode = (g: StoredGrant) => JSON.parse(Buffer.from(g.serialized, "base64").toString("utf8"));
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

describe("grants from the real signer pass", () => {
  it("the default mint — official listings, and nothing of a removed route", async () => {
    const { grant } = await signerGrant({ account: ACCOUNT });
    assert.deepEqual(verdict(grant), { ok: true });
    assert.deepEqual(grant.grantFeatures, [core.TRADEABLE_V2, core.GRANT_SCOPED_SPENDERS]);
    for (const field of ["v4AdapterAddress", "ponsAdapterAddress", "ponsClassVaultAddress", "ponsClassVaultFactoryAddress"]) {
      assert.ok(!(field in grant), field);
    }
  });

  it("the opt-ins — custom tokens with Trencher scope — and with the dormant perps marker, every accepted marker", async () => {
    const { grant: trench } = await signerGrant({ account: ACCOUNT, extraTokens: [EXTRA], trencher: true });
    assert.deepEqual(verdict(trench), { ok: true });
    assert.equal(trench.trencherVaultAddress, TRENCHER_VAULT);
    assert.equal(trench.trencherFactoryAddress, TRENCHER_FACTORY);
    assert.ok(trench.grantTokens?.includes(EXTRA.address));

    const { grant: everything } = await signerGrant(FULL);
    assert.deepEqual(verdict(everything), { ok: true });
    assert.deepEqual(everything.grantTokens?.slice().sort(), [EXTRA.address, EXTRA2.address, EXTRA3.address].sort());
    assert.ok(everything.grantFeatures?.includes(core.GRANT_SCOPED_SPENDERS));

    // No signer can mint the perps marker for a BNB grant (below), so it is
    // named here rather than signed.
    const minted = new Set([...(trench.grantFeatures ?? []), GRANT_PERP_LIGHTER]);
    assert.deepEqual([...minted].sort(), [...CANONICAL_GRANT_FEATURES].sort());
  });

  it("hosted delivery adds a binding beside the grant, which this check leaves to verifyGrantBinding", async () => {
    const { grant } = await signerGrant({ account: ACCOUNT });
    const hosted = { ...grant, binding: { nonce: "n", walletSignature: `0x${"11".repeat(65)}`, ownerSignature: `0x${"22".repeat(65)}` } };
    assert.deepEqual(verdict(hosted), { ok: true });
  });

  it("re-sealing the SAME wall passes too, so every refusal below is the change and not the sealing", async () => {
    const { grant, owner } = await signerGrant({ account: ACCOUNT, trencher: true });
    assert.deepEqual(verdict(await resealed(grant, owner)), { ok: true });
  });
});

describe("an owner-enabled permission that is not the AgentCap wall is refused", () => {
  it("an extra USDG transfer permission", async () => {
    const { grant, owner } = await signerGrant({ account: ACCOUNT });
    const drained = await resealed(grant, owner, { withdrawalAddresses: [ATTACKER] });
    const v = refusedWith(drained, "invalid_wall");
    assert.match(v.ok ? "" : v.why, /does not implement/);
  });

  it("the transfer marker, even over a wall dated to when the mirror would honour it", async () => {
    // The mirror-only attack: grantHasTransfer believes any "transfer" marker on
    // a grant dated before the withdrawal allowlist, and reads it as a transfer
    // to ANY recipient. The date is in the signed timestamp policy, so the
    // tenant re-seals the canonical wall at that date and adds the marker.
    const { grant, owner } = await signerGrant({ account: ACCOUNT });
    const backdated = await resealed(grant, owner, { now: WITHDRAWAL_ALLOWLIST_LANDED_AT - 86_400, caps: { ...grant.caps, expiryDays: 365 } });
    const marked = { ...backdated, caps: { ...grant.caps, expiryDays: 365 }, grantFeatures: [...(grant.grantFeatures ?? []), GRANT_TRANSFER] };
    assert.equal(grantHasTransfer(marked), true, "the premise: this is what the worker would believe");
    const v = refusedWith(marked, "invalid_grant");
    assert.match(v.ok ? "" : v.why, /"transfer"/);
    // And with a real transfer permission underneath, the same refusal.
    const both = await resealed(marked, owner, { withdrawalAddresses: [ATTACKER] });
    refusedWith(both, "invalid_grant");
  });

  it("retired and unknown markers, over an otherwise canonical wall", async () => {
    const { grant } = await signerGrant({ account: ACCOUNT });
    for (const marker of ["multihop", "v4", "rialto", "transfer", "anything"]) {
      refusedWith({ ...grant, grantFeatures: [...(grant.grantFeatures ?? []), marker] }, "invalid_grant");
    }
    refusedWith({ ...grant, grantFeatures: (grant.grantFeatures ?? []).filter((f) => f !== "tradeable-v2") }, "invalid_grant");
    refusedWith({ ...grant, grantFeatures: undefined }, "invalid_grant");
  });

  it("token metadata that disagrees with the wall, in either direction", async () => {
    const { grant } = await signerGrant({ account: ACCOUNT, extraTokens: [EXTRA] });
    // Wider than the wall: the mirror would call a token sellable that the key cannot approve.
    refusedWith({ ...grant, grantTokens: [...(grant.grantTokens ?? []), ATTACKER] }, "invalid_wall");
    // Narrower than the wall: the wall carries an approve the metadata hides.
    refusedWith({ ...grant, grantTokens: (grant.grantTokens ?? []).filter((a) => a !== EXTRA.address) }, "invalid_wall");
  });

  it("a sealed address without its marker, or a marker without its address", async () => {
    const { grant } = await signerGrant({ account: ACCOUNT, trencher: true });
    const { trencherVaultAddress: _v, ...noVault } = grant;
    void _v;
    refusedWith(noVault, "invalid_grant");
    refusedWith({ ...grant, grantFeatures: (grant.grantFeatures ?? []).filter((f) => f !== "trencher-vault-v1") }, "invalid_grant");
    // Pointed at a different vault than the one the wall was sealed with.
    refusedWith({ ...grant, trencherVaultAddress: ATTACKER }, "invalid_wall");
  });

  it("A REMOVED ROUTE IS REFUSED, by its marker or by its sealed address — never silently accepted", async () => {
    // What a stale client (an old tab, an old app build) or a hand-built grant
    // would still send.
    const { grant } = await signerGrant({ account: ACCOUNT });
    for (const marker of ["pons-adapter", "pons-class", "energy-buy-v1", "v4-adapter"]) {
      const v = refusedWith({ ...grant, grantFeatures: [...(grant.grantFeatures ?? []), marker] }, "invalid_grant");
      assert.match(v.ok ? "" : v.why, /does not grant/, marker);
    }
    for (const field of ["v4AdapterAddress", "ponsAdapterAddress", "ponsClassVaultAddress", "ponsClassVaultFactoryAddress"]) {
      const v = refusedWith({ ...grant, [field]: ATTACKER }, "invalid_grant");
      assert.match(v.ok ? "" : v.why, /adapter metadata/, field);
    }
  });

  it("start or expiry edited beside a signature that says otherwise", async () => {
    const { grant } = await signerGrant({ account: ACCOUNT });
    refusedWith({ ...grant, grantedAt: WITHDRAWAL_ALLOWLIST_LANDED_AT - 1 }, "invalid_grant");
    refusedWith({ ...grant, expiresAt: grant.expiresAt + 86_400 }, "invalid_grant");
    refusedWith({ ...grant, caps: { ...grant.caps, perTradeUsdg: grant.caps.perTradeUsdg * 10 } }, "invalid_wall");
  });

  it("an owner key hidden inside the serialized permission", async () => {
    const ownerKey = generatePrivateKey();
    const { grant } = await signerGrant({ account: ACCOUNT, owner: privateKeyToAccount(ownerKey) });
    const params = decode(grant);
    params.action.hidden = ownerKey;
    refusedWith({ ...grant, serialized: encode(params) }, "owner_key_forbidden");
  });

  it("the owner key handed over as though it were the session key", async () => {
    // The one place both owner-key scans look away from: the session key field.
    const ownerKey = generatePrivateKey();
    const owner = privateKeyToAccount(ownerKey);
    const { grant } = await signerGrant({ account: ACCOUNT, owner });
    refusedWith(await resealed(grant, owner, {}, ownerKey), "owner_key_forbidden");
  });

  it("a different session key inside the permission than the one handed to the server", async () => {
    const { grant } = await signerGrant({ account: ACCOUNT });
    refusedWith({ ...grant, demoSessionPrivateKey: generatePrivateKey() }, "invalid_grant");
  });

  it("anything unreadable, without throwing", () => {
    for (const g of [{}, { serialized: "not-a-permission-account" }, { owner: ATTACKER, smartAccount: ACCOUNT, caps: {}, grantedAt: 1, expiresAt: 2, serialized: "e30=" }]) {
      assert.equal(verdict(g).ok, false);
    }
  });
});

/**
 * PERPETUALS ARE NOT ON BNB CHAIN.
 *
 * Lighter is a Robinhood Chain deployment. On either chain this product runs on
 * its proxy is not the venue: a CALL to a codeless address succeeds and a
 * deposit would "land" having posted nothing. So no signer seals a key there,
 * and a hand-built grant that carries one is refused, as is metadata that
 * disagrees with the wall in either direction.
 */
describe("perpetuals", () => {
  const BLOCK = { route: GRANT_PERP_LIGHTER, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: PERP_KEY };
  const WALL_PERP = { perpLighter: { apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: PERP_KEY } };

  it("the real signer seals no Lighter key on BNB Chain or its testnet", async () => {
    for (const chainId of [56, 97]) {
      await assert.rejects(signerGrant({ account: ACCOUNT, perp: { apiPublicKey: PERP_KEY }, chainId }), /refusing to sign: perpetuals exist only/);
    }
  });

  it("perps on a chain this product runs on are refused, even over a wall that carries them", async () => {
    const { grant, owner } = await signerGrant({ account: ACCOUNT });
    const sealed = await resealed(grant, owner, WALL_PERP);
    const handBuilt = { ...sealed, grantFeatures: [...(grant.grantFeatures ?? []), GRANT_PERP_LIGHTER], perp: BLOCK };
    for (const chainId of [56, 97, undefined, "4663"]) {
      refusedWith({ ...handBuilt, chainId }, "invalid_grant");
    }
    assert.equal(grantPerp(handBuilt), null, "and the worker's reader arms nothing on chain 56");
    // A private key riding beside the public one goes nowhere either.
    refusedWith({ ...handBuilt, perp: { ...BLOCK, apiPrivateKey: `0x${"33".repeat(40)}` } }, "invalid_grant");
  });

  it("the marker without the block, the block without the marker, and a perps wall declaring neither", async () => {
    const { grant, owner } = await signerGrant({ account: ACCOUNT });
    let v = refusedWith({ ...grant, grantFeatures: [...(grant.grantFeatures ?? []), GRANT_PERP_LIGHTER] }, "invalid_grant");
    assert.match(v.ok ? "" : v.why, /Perpetuals metadata does not match/);
    v = refusedWith({ ...grant, perp: BLOCK }, "invalid_grant");
    assert.match(v.ok ? "" : v.why, /Perpetuals metadata does not match/);
    // The venue permissions sealed with neither marker nor block: metadata hides a power.
    refusedWith(await resealed(grant, owner, WALL_PERP), "invalid_wall");
  });
});

describe("a Perps wallet's grant (perps slice 5b): the Perps wall, and in this build an empty one", () => {
  const PERPS_ACCOUNT = "0x00000000000000000000000000000000000e1e1e" as const;

  it("the paper Perps grant passes: purpose perps, mainnet, no marker, the empty Perps wall", async () => {
    const { grant } = await signerGrant({ account: PERPS_ACCOUNT, purpose: "perps" });
    assert.deepEqual(verdict(grant), { ok: true });
    assert.equal(grant.purpose, "perps");
    assert.deepEqual(grant.grantFeatures, []);
    // THE PREMISE: its call policy permits nothing, and the rebuild agrees.
    assert.deepEqual(core.buildCallPermissions(grant.caps, PERPS_ACCOUNT, core.grantWallOptions(grant)), []);
  });

  it("A PERPS GRANT SEALED OVER THE SPOT WALL is refused: the rebuild is the Perps wall", async () => {
    // What a tenant holding the owner key could build: the purpose and the
    // empty marker list the server wants, over the full Spot wall (every stock
    // approve, the swaps, the class vault) at the Perps address.
    const { grant, owner } = await signerGrant({ account: PERPS_ACCOUNT, purpose: "perps" });
    const overSpot = await resealed(grant, owner, { perpsOnly: false });
    assert.notEqual(decode(overSpot).permissionParams.policies[1].policyParams.permissions.length, 0, "premise: a Spot wall was sealed");
    const v = refusedWith(overSpot, "invalid_wall");
    assert.match(v.ok ? "" : v.why, /does not implement the advertised AgentCap limits/);
    // And the same wall declared as Spot would have been fine: only the purpose differs.
    const { grant: spot, owner: spotOwner } = await signerGrant({ account: PERPS_ACCOUNT });
    assert.deepEqual(verdict(await resealed(spot, spotOwner)), { ok: true });
  });

  it("a Spot grant relabelled Perps is refused, whatever it declares", async () => {
    const { grant } = await signerGrant({ account: PERPS_ACCOUNT });
    refusedWith({ ...grant, purpose: "perps" }, "invalid_wall");
    // Even with its markers stripped, its wall is still the Spot one.
    const v = refusedWith({ ...grant, purpose: "perps", grantFeatures: [], grantTokens: undefined }, "invalid_wall");
    assert.match(v.ok ? "" : v.why, /does not implement the advertised AgentCap limits/);
  });

  it("D5: the paper Perps wall carries nothing — any marker, token, sealed address or perp block is refused by name", async () => {
    const { grant } = await signerGrant({ account: PERPS_ACCOUNT, purpose: "perps" });
    for (const [what, change] of [
      ["a removed marker", { grantFeatures: ["energy-buy-v1"] }],
      ["the perpetuals marker", { grantFeatures: [GRANT_PERP_LIGHTER] }],
      ["the perpetuals block", { grantFeatures: [GRANT_PERP_LIGHTER], perp: { route: GRANT_PERP_LIGHTER, apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: PERP_KEY } }],
      ["a recovery reference", { perpRecovery: { v: 1 } }],
      ["the wide-stock Spot marker", { grantFeatures: ["tradeable-v2"] }],
      ["the scoped-spenders shape", { grantFeatures: [core.GRANT_SCOPED_SPENDERS] }],
      ["a traded token", { grantTokens: [EXTRA.address] }],
      ["a removed sealed address", { ponsClassVaultAddress: ATTACKER }],
      ["a sealed Trencher vault", { trencherVaultAddress: TRENCHER_VAULT }],
      ["no marker list at all", { grantFeatures: undefined }],
    ] as const) {
      const v = refusedWith({ ...grant, ...change }, "invalid_wall");
      assert.match(v.ok ? "" : v.why, /carries nothing in this build/, what);
    }
  });

  it("a Perps wallet exists only on Robinhood Chain mainnet", async () => {
    const { grant } = await signerGrant({ account: PERPS_ACCOUNT, purpose: "perps" });
    for (const chainId of [46630, 1, undefined, "4663"]) {
      const v = refusedWith({ ...grant, chainId }, "invalid_grant");
      assert.match(v.ok ? "" : v.why, /only on Robinhood Chain mainnet/, String(chainId));
    }
  });

  it("a purpose that names no wallet is refused by name, never rebuilt as Spot", async () => {
    const { grant } = await signerGrant({ account: PERPS_ACCOUNT });
    for (const purpose of ["Perps", "", "other", 1, null]) {
      const v = refusedWith({ ...grant, purpose }, "invalid_grant");
      assert.match(v.ok ? "" : v.why, /names a wallet this service does not know/, String(purpose));
    }
    // Spot, named or not, is the wall it always was.
    assert.deepEqual(verdict({ ...grant, purpose: "spot" }), { ok: true });
  });
});

describe("the accepted markers are exactly what the signers can mint", () => {
  // Source scans, in the idiom of wall-policy-lockstep.test.ts: the failure this
  // guards is DRIFT. A signer that starts minting a marker, or passing a wall
  // option, that this check does not model would have every new hosted grant
  // refused in production — so it fails here first.
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  const SIGNERS = {
    "web signer": "./session.ts",
    "mobile signer": "../../../mobile/src/crypto/signGrant.ts",
  } as const;
  const exported = core as unknown as Record<string, unknown>;

  for (const [who, path] of Object.entries(SIGNERS)) {
    it(`${who}: every minted marker is accepted`, () => {
      const src = strip(read(path));
      const block = /grantFeatures:\s*\[([\s\S]*?)\],/.exec(src);
      assert.ok(block, `${who} must still build grantFeatures as an array literal`);
      const names = [...new Set([...block[1].matchAll(/\b(TRADEABLE_V2|GRANT_[A-Z0-9_]+)\b/g)].map((m) => m[1]))];
      assert.ok(names.length > 0);
      for (const name of names) {
        const marker = exported[name];
        assert.equal(typeof marker, "string", `${name} must be a core export`);
        assert.ok(CANONICAL_GRANT_FEATURES.includes(marker as string), `${who} mints ${name} (${String(marker)}), which the server would refuse`);
      }
    });

    it(`${who}: every wall option it passes is one the rebuild models`, () => {
      const src = strip(read(path));
      const block = /const wallOpts = \{([\s\S]*?)\};/.exec(src);
      assert.ok(block, `${who} must still collect its wall options in one literal`);
      const keys = [...block[1].matchAll(/(?:^|,)\s*(?:\.\.\.)?([A-Za-z0-9_]+)\s*(?=[:,]|$)/g)].map((m) => m[1]);
      assert.ok(keys.includes("scopedSpenders") && keys.includes("extraTokens"), `${who}: the key scan must see the options it is checking`);
      const modelled = new Set([
        "trenchScope",
        "extraTokens",
        // Rebuilt from the GRANT_SCOPED_SPENDERS marker by grantWallOptions —
        // a shape version, so again the marker is the whole sealed fact.
        "scopedSpenders",
        // Rebuilt from the GRANT_PERP_LIGHTER marker AND the grant's `perp`
        // block (the sealed key) by grantWallOptions → grantPerp.
        "perpLighter",
        // Rebuilt from the grant's signed `purpose` by grantWallOptions, which
        // canonical-wall.ts passes (perps slice 5b): a Perps signer sets it
        // from the purpose it signs, and the rebuild from the same field.
        "perpsOnly",
      ]);
      for (const key of keys) assert.ok(modelled.has(key), `${who} passes ${key} to the wall, which canonical-wall.ts does not rebuild`);
      assert.doesNotMatch(block[1], /withdrawalAddresses|allowRialto/, `${who} must not widen the wall with a transfer or Rialto`);
    });
  }
});
