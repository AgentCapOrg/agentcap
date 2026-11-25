/**
 * EACH SPENDER ONLY ON THE TOKENS IT PULLS — WallOptions.scopedSpenders.
 *
 * Unscoped, every spender sits in the ONE_OF of every coin approve, though the
 * Trencher vault only ever pulls cash. That is reach nothing uses, and 32 bytes of first-enable data
 * per entry.
 *
 * ── STRICTLY NARROWER, AND THE OLD WALL UNTOUCHED ───────────────────────
 *
 * Every call the scoped wall permits, the unscoped one permits too: same
 * permissions in the same order, each ONE_OF a subset, every scalar rule equal.
 * And without the marker nothing changes byte for byte, because every grant
 * signed before it must keep rebuilding as the wall it was signed over.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Address } from "viem";

import {
  buildCallPermissions,
  buildWallPolicies,
  grantWallOptions,
  type WallOptions,
} from "./wall";
import { GRANT_SCOPED_SPENDERS } from "./grant";
import { PANCAKESWAP } from "./protocols";
import { CASH, STOCK_TOKENS, TRADEABLE_SYMBOLS } from "./tokens";
import { LIGHTER_ROUTE_V1 } from "./perps";
import { CallPolicyVersion, toCallPolicy } from "@zerodev/permissions/policies";

const CAPS = { perTradeUsdg: 50, dailyUsdg: 200, expiryDays: 30, maxDrawdownPct: 20, maxOpsPerDay: 100 };
const ACCOUNT = "0x1111111111111111111111111111111111111111" as Address;
const TRENCHER_VAULT = "0x4444444444444444444444444444444444444444";
const TRENCHER_FACTORY = "0x5555555555555555555555555555555555555555";
const coin = (i: number) => ({
  symbol: `C${i}`,
  address: `0x${(0xa0 + i).toString(16).padStart(2, "0").repeat(20)}` as Address,
  decimals: 18,
});
const UBIK = coin(0);
/** A canonical Lighter API public key at the route's index — the key perps.test.ts and worker/src/wall.test.ts use. */
const PERP = {
  apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex,
  apiPublicKey: "0x2427c4493c2df1a3ecdd750f1398b865e5428907c41065f0612cb3fa6b5ea0d7ac00465b07f3acd7" as const,
};
const PROXY = LIGHTER_ROUTE_V1.proxy.toLowerCase();

/** Trencher + `n` coins. */
const everything = (n: number): WallOptions => ({
  trencherVaultAddress: TRENCHER_VAULT,
  trencherFactoryAddress: TRENCHER_FACTORY,
  extraTokens: Array.from({ length: n }, (_, i) => coin(i)),
});

type Perm = { target: string; functionName?: string; args?: readonly ({ condition: number; value: unknown } | null)[] };
const perms = (opts: WallOptions) => buildCallPermissions(CAPS, ACCOUNT, opts) as unknown as Perm[];
const lc = (a: readonly unknown[]) => a.map((x) => String(x).toLowerCase());
const approveOf = (ps: Perm[], token: string) =>
  ps.find((p) => p.functionName === "approve" && p.target.toLowerCase() === token.toLowerCase())!;
const spendersOf = (p: Perm) => lc(p.args![0]!.value as unknown[]);
const stocks = STOCK_TOKENS.filter((t) => (TRADEABLE_SYMBOLS as readonly string[]).includes(t.symbol)).map((t) => t.address);

describe("who is approved for what, scoped", () => {
  const all: WallOptions = { ...everything(2), scopedSpenders: true };
  const ps = perms(all);

  it("USDG: every spender, exactly as unscoped — every venue is funded in cash", () => {
    const unscoped = perms({ ...all, scopedSpenders: false });
    assert.deepEqual(spendersOf(approveOf(ps, CASH.USDT)), spendersOf(approveOf(unscoped, CASH.USDT)));
    for (const s of [PANCAKESWAP.smartRouter, TRENCHER_VAULT]) {
      assert.ok(spendersOf(approveOf(ps, CASH.USDT)).includes(s.toLowerCase()), `USDG approve names ${s}`);
    }
  });

  it("a stock: Router02 and nothing else", () => {
    for (const s of stocks) assert.deepEqual(spendersOf(approveOf(ps, s)), [PANCAKESWAP.smartRouter.toLowerCase()], s);
  });

  it("a custom coin: the swap router that can sell it, and no vault", () => {
    assert.deepEqual(spendersOf(approveOf(ps, UBIK.address)), lc([PANCAKESWAP.smartRouter]));
  });

  it("Router02 still trades every stock", () => {
    const router = ps.find((p) => p.functionName === "exactInputSingle")!;
    for (const s of stocks) assert.ok(lc(router.args![0]!.value as unknown[]).includes(s.toLowerCase()), s);
  });
});

describe("perps: the Lighter proxy pulls USDG and nothing else, scoped or not", () => {
  // The proxy joins `usdgSpenders`, never `spenders`, so scoping has nothing to
  // filter it out of and nothing to add it to. Pinned on both shapes because
  // an old grant still rebuilds unscoped, and an uncapped allowance over the
  // book for an upgradeable venue contract is wrong on either.
  const all: WallOptions = { ...everything(2), perpLighter: PERP };
  const shapes = { unscoped: perms({ ...all, scopedSpenders: false }), scoped: perms({ ...all, scopedSpenders: true }) };
  const onProxy = (ps: Perm[]) => ps.filter((p) => p.target.toLowerCase() === PROXY);

  it("the proxy is on the USDG approve, and that approve is the same on both shapes", () => {
    for (const [shape, ps] of Object.entries(shapes)) {
      assert.ok(spendersOf(approveOf(ps, CASH.USDT)).includes(PROXY), `${shape}: USDG approve names the proxy`);
    }
    assert.deepEqual(spendersOf(approveOf(shapes.scoped, CASH.USDT)), spendersOf(approveOf(shapes.unscoped, CASH.USDT)));
  });

  it("and on no stock or custom-coin approve, on either shape", () => {
    for (const [shape, ps] of Object.entries(shapes)) {
      for (const t of [...stocks, coin(0).address, coin(1).address]) {
        assert.ok(!spendersOf(approveOf(ps, t)).includes(PROXY), `${shape}: ${t} approve must not name the proxy`);
      }
      // And no approve at all other than USDG's — the explicit list above is
      // the case that matters; this catches any token a later change adds.
      for (const p of ps.filter((p) => p.functionName === "approve" && p.target.toLowerCase() !== CASH.USDT.toLowerCase())) {
        assert.ok(!spendersOf(p).includes(PROXY), `${shape}: ${p.target} approve must not name the proxy`);
      }
    }
  });

  it("the three proxy permissions are the same on both shapes", () => {
    // deposit, changePubKey, withdrawPendingBalance — scoping is about who may
    // pull which token, and none of these is an approve.
    assert.deepEqual(
      onProxy(shapes.scoped).map((p) => p.functionName),
      ["deposit", "changePubKey", "withdrawPendingBalance"],
    );
    assert.deepEqual(onProxy(shapes.scoped), onProxy(shapes.unscoped));
  });
});

describe("strictly narrower, and the old wall untouched", () => {
  const combos: WallOptions[] = [
    {},
    { extraTokens: [coin(0)] },
    everything(3),
    { ...everything(1), perpLighter: PERP },
  ];

  it("without the flag, byte for byte what was built before it existed", () => {
    for (const o of combos) assert.deepEqual(perms({ ...o, scopedSpenders: false }), perms(o));
  });

  it("with it, the same permissions in the same order, every list a subset, every scalar equal", () => {
    for (const o of combos) {
      const wide = perms(o);
      const narrow = perms({ ...o, scopedSpenders: true });
      assert.deepEqual(
        narrow.map((p) => [p.target.toLowerCase(), p.functionName]),
        wide.map((p) => [p.target.toLowerCase(), p.functionName]),
      );
      narrow.forEach((p, i) => {
        const w = wide[i]!;
        (p.args ?? []).forEach((a, j) => {
          const b = w.args![j];
          if (a === null || b === null) return assert.equal(a, b);
          assert.equal(a.condition, b!.condition);
          if (Array.isArray(a.value)) {
            const wider = new Set(lc(b!.value as unknown[]));
            for (const x of lc(a.value)) assert.ok(wider.has(x), `${p.functionName} on ${p.target}: ${x} is new`);
          } else assert.deepEqual(a.value, b!.value);
        });
      });
    }
  });

  it("buildWallPolicies seals the scoped wall it was asked for — the option is not dropped on the way", () => {
    // The trap wall.ts names four times before this: an option the signer
    // sizes with (buildCallPermissions) but buildWallPolicies does not forward
    // is a signature over a different wall from the one that was checked.
    const opts = { ...everything(3), scopedSpenders: true };
    const sealed = buildWallPolicies({ caps: CAPS, smartAccount: ACCOUNT, now: 1, ...opts }).policies[1]!;
    const expected = toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: perms(opts) as never });
    const unscoped = toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: perms({ ...opts, scopedSpenders: false }) as never });
    assert.equal(sealed.getPolicyData(), expected.getPolicyData());
    assert.notEqual(sealed.getPolicyData(), unscoped.getPolicyData());
  });

  it("and seals perps together with it — neither option is dropped for the other", () => {
    // Both are forwarded by name in buildWallPolicies. Dropping perps would sign
    // `perp-lighter-v1` over a wall with no deposit; dropping scoping would sign
    // the wall the signer had sized as too large.
    const base = { ...everything(3), scopedSpenders: true };
    const opts = { ...base, perpLighter: PERP };
    const data = (o: WallOptions) =>
      toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: perms(o) as never }).getPolicyData();
    const sealed = buildWallPolicies({ caps: CAPS, smartAccount: ACCOUNT, now: 1, ...opts }).policies[1]!;
    assert.equal(sealed.getPolicyData(), data(opts));
    assert.notEqual(sealed.getPolicyData(), data(base), "perps dropped");
    assert.notEqual(sealed.getPolicyData(), data({ ...opts, scopedSpenders: false }), "scoping dropped");
  });
});

describe("the marker", () => {
  const unmarked = { grantTokens: [UBIK.address], grantFeatures: ["tradeable-v2"] };
  const marked = { ...unmarked, grantFeatures: [...unmarked.grantFeatures, GRANT_SCOPED_SPENDERS] };

  it("grantWallOptions rebuilds the shape that was signed", () => {
    assert.equal(grantWallOptions(unmarked).scopedSpenders, false);
    assert.equal(grantWallOptions(marked).scopedSpenders, true);
  });
});
