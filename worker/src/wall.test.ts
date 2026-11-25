import assert from "node:assert/strict";
import { PolicyFlags } from "@zerodev/permissions";
import { CallPolicyVersion, ParamCondition, toCallPolicy } from "@zerodev/permissions/policies";
import { decodeFunctionData, encodeFunctionData, pad, toFunctionSelector, type Hex } from "viem";
import test from "node:test";
import {
  CASH,
  INFRA,
  STOCK_TOKENS,
  TRADEABLE_SYMBOLS,
  PANCAKESWAP,
  UNISWAP_SWAP_ROUTER_ABI,
  allowedSpenders,
  buildCallPermissions,
  buildWallPolicies,
  grantHasMultihop,
  WALL_POLICY_FLAG,
  usableExtraTokens,
  type GrantCaps,
  GRANT_PERP_LIGHTER,
  LIGHTER_ROUTE_V1,
  LIGHTER_DEPOSIT_ABI,
  LIGHTER_CHANGE_PUBKEY_ABI,
  LIGHTER_WITHDRAW_PENDING_ABI,
  grantWallOptions,
  perpFits,
  pubKeyWords,
} from "../../packages/core/src/index";

/**
 * THE WALL, PINNED.
 *
 * These assertions are a specification, not a snapshot. The permission list moved
 * out of the dashboard so a phone could sign the same grant, and the danger in
 * that move is silent: drop one entry, loosen one condition, reorder the args of
 * an approve, and nothing throws — grants just start carrying powers their owners
 * did not agree to, and only for the people who signed after the change.
 *
 * So each expectation below was read off the ORIGINAL dashboard implementation and
 * written down independently. If a future edit widens the wall, this fails and
 * says which entry.
 */

const CAPS: GrantCaps = {
  perTradeUsdg: 50,
  dailyUsdg: 500,
  expiryDays: 14,
  maxDrawdownPct: 10,
  maxOpsPerDay: 48,
};

/** USDG is 6dp — the units a cap is actually expressed in on-chain. */
const usdg = (v: number) => BigInt(Math.round(v * 1e6)) * 10n ** 12n;

type Perm = ReturnType<typeof buildCallPermissions>[number] & {
  target: string;
  functionName?: string;
  args?: unknown[];
};

/** The agent's own account — what the wall pins swap/vault destinations to. */
const SELF = "0x00000000000000000000000000000000000000a9" as const;
/**
 * Two REAL Lighter API public keys, from the official signer (lighter-go v1.0.9
 * WASM) in the spike — the same vectors perps.test.ts proves `pubKeyWords`
 * against. Real keys rather than invented bytes, because the wall refuses a
 * key the contract would reject and these are what the contract accepts.
 */
const PERP_PK = "0x2427c4493c2df1a3ecdd750f1398b865e5428907c41065f0612cb3fa6b5ea0d7ac00465b07f3acd7" as const;
const PERP_PK_OTHER = "0x3fba6f2e6d1cc97965c00bcb9032ffbd408f77cfb929db0a49d4abd0b090426efb651217ad43f02d" as const;
const perms = () => buildCallPermissions(CAPS, SELF) as unknown as Perm[];
const find = (target: string, fn?: string) =>
  perms().filter((p) => p.target.toLowerCase() === target.toLowerCase() && (fn === undefined || p.functionName === fn));

test("the default spenders are the swap router and nothing else", () => {
  // An approved spender can pull whatever it was approved for, and the stock
  // approvals carry no amount condition, so listing an unused contract is a
  // standing licence over every share the agent holds.
  assert.deepEqual(allowedSpenders().map((a) => a.toLowerCase()), [PANCAKESWAP.smartRouter.toLowerCase()]);
});

test("no option can put Permit2 into the wall, as a target or as a spender", () => {
  // A Permit2 allowance is spendable by whoever Permit2 grants next, so with
  // uncapped stock approvals it is a licence over the whole book.
  const everySpotOption = buildCallPermissions(CAPS, SELF, {
    withdrawalAddresses: [SELF],
    perpLighter: { apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: PERP_PK },
  });
  const permit2 = INFRA.permit2.toLowerCase();
  assert.equal(JSON.stringify(everySpotOption, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).toLowerCase().includes(permit2.slice(2)), false);
});

test("USDG approve is capped at ONE TRADE and restricted to the allowed spenders", () => {
  const [p] = find(CASH.USDT, "approve");
  assert.ok(p, "USDG approve permission must exist");
  const [spender, amount] = p.args as [{ condition: number; value: string[] }, { condition: number; value: bigint }];
  // Two by default — the swap router and the vault. Rialto and Permit2 are each
  // opt-in, and every entry here is a standing licence, so the list growing
  // silently is exactly the regression this asserts against.
  assert.equal(spender.value.length, 1, "the one default spender, the swap router");
  // The cap is per TRADE, not per day. Using dailyUsdg here would let one approval
  // authorise ten trades' worth.
  assert.equal(amount.value, usdg(CAPS.perTradeUsdg));
});

test("by DEFAULT there is no way to send USDG out at all", () => {
  // The recipient used to be free-form, which left the per-call amount as the
  // only on-chain bound — and the daily USDG cap lives off-chain, in the very
  // worker that would be compromised. The real ceiling was therefore
  // perTradeUsdg x maxOpsPerDay per day until expiry (2,400/day at the default
  // preset): "bounded" only in that draining took a fortnight.
  assert.equal(find(CASH.USDT, "transfer").length, 0, "no registered address, no power to send");
});

test("registering withdrawal addresses pins the recipient to exactly those", () => {
  const A = "0x1111111111111111111111111111111111111111" as const;
  const B = "0x2222222222222222222222222222222222222222" as const;
  const list = buildCallPermissions(CAPS, SELF, {
    // Duplicated and mixed-case on purpose: a repeat must not bloat the policy
    // and a case difference must not read as a second address.
    withdrawalAddresses: [A, B, A, B.toUpperCase() as typeof B],
  }) as unknown as Perm[];
  const p = list.find((x) => x.target.toLowerCase() === CASH.USDT.toLowerCase() && x.functionName === "transfer");
  assert.ok(p, "registering an address grants the transfer permission");
  const [recipient, amount] = p.args as [{ condition: number; value: string[] }, { value: bigint }];
  assert.equal(recipient.condition, ParamCondition.ONE_OF);
  assert.deepEqual(recipient.value, [A, B]);
  // The amount cap still applies on top of the destination pin.
  assert.equal(amount.value, usdg(CAPS.perTradeUsdg));
});

test("every tradeable stock token can be approved, so nothing can be bought but not sold", () => {
  const tradeable = STOCK_TOKENS.filter((t) => (TRADEABLE_SYMBOLS as readonly string[]).includes(t.symbol));
  assert.ok(tradeable.length > 0, "sanity: there are tradeable tokens");
  for (const t of tradeable) {
    const [p] = find(t.address, "approve");
    assert.ok(p, `${t.symbol} must be approvable or the agent could buy it and never sell`);
    // No amount condition on purpose: share counts are 18dp and not comparable to
    // a USDG cap. Asserted so nobody "tightens" it into a broken policy.
    assert.equal((p.args as unknown[])[1], null, `${t.symbol} approve must have no amount condition`);
  }
});

test("MULTI-HOP IS GONE, and the packed path is why it cannot come back", () => {
  // It used to be granted with `args: [null, null, self]` — recipient pinned at
  // word 2, both tokens open. That was defensible only while its single-hop
  // sibling was equally open. Once `exactInputSingle` pinned both token legs,
  // this became the loosest door in the wall: the output token lives inside a
  // packed `path`, so the drain the single-hop pin closes was one selector away.
  assert.equal(find(PANCAKESWAP.smartRouter, "exactInput").length, 0, "no multi-hop permission");

  // AND THE PATH IS UNCONSTRAINABLE — which is why the answer is removal rather
  // than a tighter rule. Proven against viem's encoder: the output token is not
  // right-aligned in any word, and its word index MOVES with the hop count, so
  // no fixed-offset ONE_OF can ever name it.
  const OTHER = "0x00000000000000000000000000000000000000ff" as const;
  const path = `0x${CASH.USDT.slice(2)}000bb8${CASH.WBNB.slice(2)}000bb8${OTHER.slice(2)}` as `0x${string}`;
  const calldata = encodeFunctionData({
    abi: UNISWAP_SWAP_ROUTER_ABI,
    functionName: "exactInput",
    args: [{ path, recipient: SELF, amountIn: 1_000_000n, amountOutMinimum: 0n }],
  });
  const body = `0x${calldata.slice(10)}`;
  const wordAt = (i: number) => `0x${body.slice(2 + i * 64, 2 + (i + 1) * 64)}`;
  assert.equal(BigInt(wordAt(5)), 66n, "3 hops = 20+3+20+3+20 bytes of path");
  const tail = OTHER.slice(2).toLowerCase();
  assert.ok(
    ![6, 7, 8].some((i) => wordAt(i).toLowerCase().endsWith(tail)),
    "the output token is not right-aligned in any word — a ONE_OF rule cannot match it",
  );

  // Marker and permission move together. A wall that no longer grants the route
  // must not hand out a marker that tells the worker to build it.
  assert.equal(grantHasMultihop({ grantFeatures: ["tradeable-v2"] }), false);
});


test("the router is narrowed to ONE entrypoint", () => {
  // ONE, not two. `exactInput` (multi-hop) was dropped: its packed `path` hides
  // the output token and cannot be constrained at the pinned policy version,
  // which made it the loosest door once exactInputSingle pinned both legs.
  assert.equal(find(PANCAKESWAP.smartRouter, "exactInputSingle").length, 1);
  assert.equal(find(PANCAKESWAP.smartRouter, "exactInput").length, 0);
  assert.equal(find(PANCAKESWAP.smartRouter).length, 1, "and nothing else on that router");
});

test("owner-added tokens are validated and de-duplicated before becoming policy", () => {
  const builtinAddr = STOCK_TOKENS[0]!.address;
  const usable = usableExtraTokens([
    { address: builtinAddr, symbol: "DUP", decimals: 18 } as never, // already covered
    { address: "0xnothex", symbol: "BAD", decimals: 18 } as never, // malformed
    { address: "0x1111111111111111111111111111111111111111", symbol: "OK", decimals: 18 } as never,
    { address: "0x1111111111111111111111111111111111111111", symbol: "OK", decimals: 18 } as never, // repeat
  ]);
  assert.equal(usable.length, 1, "only the one valid, non-duplicate token survives");
  assert.equal(usable[0]!.symbol, "OK");
});

test("the wall carries exactly the expected permission set — no more, no less", () => {
  const list = perms();
  const stockCount = STOCK_TOKENS.filter((t) => (TRADEABLE_SYMBOLS as readonly string[]).includes(t.symbol)).length;
  // DEFAULT wall: 1 USDG approve + N stock approves + the swap router ×1
  // (exactInputSingle only). No USDG transfer: that is opt-in.
  assert.equal(list.length, stockCount + 2, "an unexpected permission count means something was added or lost");
  // ...and each opt-in adds exactly the entries it should, never more.
  const withXfer = buildCallPermissions(CAPS, SELF, { withdrawalAddresses: [SELF] });
  assert.equal(withXfer.length, list.length + 1);
  // Nothing may authorise sending native value.
  for (const p of list) assert.equal(p.valueLimit, 0n, `${p.target} must not be allowed to move native ETH`);

  // RETIRED OPTIONS ADD NOTHING. A caller built before the Pons venues and the
  // energy buy were removed may still hand these in: the wall must not move.
  const retired = {
    ponsAdapterAddress: "0x00000000000000000000000000000000000000d5",
    ponsClassVaultAddress: "0x00000000000000000000000000000000000000c0",
    ponsClassVaultFactoryAddress: "0x00000000000000000000000000000000000000fa",
    energyBuy: true,
  };
  assert.deepEqual(buildCallPermissions(CAPS, SELF, retired as never), buildCallPermissions(CAPS, SELF, {}));
});

test("the wall carries a hard expiry and a call policy — and NO rate limit", () => {
  const now = 1_800_000_000;
  const { policies, expiresAt } = buildWallPolicies({ caps: CAPS, smartAccount: SELF, now });
  assert.equal(expiresAt, now + CAPS.expiryDays * 86_400);

  // TWO, not three. This asserted three while the middle one was a pointer into
  // empty space, and the count passing was part of why nobody looked: a test
  // can only check that a policy was CONSTRUCTED, never that the contract it
  // names exists. eth_getCode on 2026-08-30 returned 0 bytes for
  // RATE_LIMIT_POLICY_CONTRACT on mainnet 4663 AND testnet 46630, while the
  // timestamp and call policies both carry real bytecode.
  //
  // So maxOpsPerDay is enforced by the WORKER only, alongside the daily total
  // and the drawdown breaker, and the on-chain ceiling is per-trade until
  // expiry. WALL_POLICY_CONTRACTS + the arm-time probe are what make a future
  // undeployed singleton a refusal instead of a mystery.
  assert.equal(policies.length, 2, "expiry + call policy; the rate limit is gone because it was never there");
});

test("the session key may EXECUTE but may not SIGN (the ERC-1271 hole)", () => {
  // Every other assertion in this file is about a CALL policy, and a call
  // policy governs UserOp calls only — it says nothing about signatures. The
  // permission validator implements signMessage and signTypedData, so on the
  // library default (FOR_ALL_VALIDATION) the session key can mint ERC-1271
  // signatures the account honours. That bypasses the wall rather than
  // stretching it: Permit2 is an approved spender and the stock approvals
  // carry no amount condition, so a SIGNED permitTransferFrom — submitted by
  // anyone, from their own EOA — drains tokens with no UserOp, no rate limit,
  // and no trace in the ledger.
  //
  // This costs agentcap nothing: the whole trading path is UserOps.
  assert.equal(WALL_POLICY_FLAG, PolicyFlags.NOT_FOR_VALIDATE_SIG);
  assert.notEqual(
    WALL_POLICY_FLAG,
    PolicyFlags.FOR_ALL_VALIDATION,
    "the library default lets the session key sign — never ship it",
  );
});

test("the swap recipient is pinned to our own account, at the RIGHT calldata offset", () => {
  const [swap] = find(PANCAKESWAP.smartRouter, "exactInputSingle");
  assert.ok(swap);
  const args = swap.args as (null | { condition: number; value: string })[];

  // Seven entries for a ONE-parameter function, because the call policy maps
  // args[i] to calldata offset i*32 with no ABI arity check, and
  // ExactInputSingleParams is an all-static tuple encoded INLINE as seven
  // consecutive words. Index 3 is `recipient`.
  assert.equal(args.length, 7);
  assert.deepEqual(args[3], { condition: ParamCondition.EQUAL, value: SELF });

  // BOTH TOKEN LEGS ARE PINNED, and this is the assertion that used to say the
  // opposite. It read `for (const i of [0, 1, 2, 4, 5, 6]) assert.equal(args[i],
  // null)` — enshrining the hole: with tokenOut open, a stolen key could
  // approve a stock (the amount is deliberately uncapped) and swap the entire
  // balance into a token it had just minted, in ONE UserOp. The recipient pin
  // was satisfied throughout: the account duly received the worthless token.
  const legs = [args[0], args[1]] as unknown as { condition: number; value: string[] }[];
  for (const [i, leg] of legs.entries()) {
    assert.equal(leg?.condition, ParamCondition.ONE_OF, `token leg ${i} must be an allowlist`);
    assert.ok(
      leg.value.map((a) => a.toLowerCase()).includes(CASH.USDT.toLowerCase()),
      `token leg ${i} must admit USDG`,
    );
    assert.ok(
      !leg.value.map((a) => a.toLowerCase()).includes("0x00000000000000000000000000000000000000ff"),
      `token leg ${i} must not admit a token nobody named`,
    );
  }
  // The two legs are built from the SAME list the approve permissions use, so
  // what a key may approve and what it may swap into cannot drift apart.
  assert.deepEqual(legs[0]!.value, legs[1]!.value, "both legs share one allowlist");
  for (const i of [2, 4, 5, 6]) assert.equal(args[i], null, `arg ${i} must stay unconstrained`);

  // AND PROVE THE OFFSET, against viem's encoder rather than against the
  // reasoning above. If SwapRouter02's struct ever gains a dynamic member or
  // reorders its fields, the inline layout shifts and args[3] would silently
  // constrain the WRONG word — a policy that looks strict and isn't. This
  // fails loudly instead.
  const OTHER = "0x00000000000000000000000000000000000000ff" as const;
  const calldata = encodeFunctionData({
    abi: UNISWAP_SWAP_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: CASH.USDT as `0x${string}`,
        tokenOut: OTHER,
        fee: 3000,
        recipient: SELF,
        amountIn: 1_000_000n,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  // Skip the 4-byte selector, then read word 3 (the policy's offset 3*32).
  const body = `0x${calldata.slice(10)}`;
  const wordAt = (i: number) => `0x${body.slice(2 + i * 64, 2 + (i + 1) * 64)}`;
  assert.equal(
    wordAt(3).toLowerCase(),
    pad(SELF, { size: 32 }).toLowerCase(),
    "offset 3*32 must be `recipient` — if this fails the tuple layout moved and the pin is aimed at the wrong field",
  );

  // AND THE TOKEN LEGS, for the same reason and with more at stake: a ONE_OF
  // aimed at the wrong word is an allowlist that permits everything while
  // reading as strict. Words 0 and 1 must be tokenIn and tokenOut.
  assert.equal(
    wordAt(0).toLowerCase(),
    pad(CASH.USDT as `0x${string}`, { size: 32 }).toLowerCase(),
    "offset 0 must be `tokenIn`",
  );
  assert.equal(
    wordAt(1).toLowerCase(),
    pad(OTHER, { size: 32 }).toLowerCase(),
    "offset 1 must be `tokenOut`",
  );
  // The neighbour too, so a shift in either direction fails rather than aliases.
  assert.equal(BigInt(wordAt(2)), 3000n, "word 2 is the fee tier");
});

/**
 * EVERY OPTION REACHES THE CHAIN.
 *
 * `buildWallPolicies` once silently dropped an adapter option on the way to
 * `buildCallPermissions`. It type-checked, because the function's argument is
 * an intersection with `WallOptions`: the field was accepted at the call site
 * and discarded one line later. A grant signed through that path carries a
 * feature marker over a call policy containing no matching permission, so the
 * off-chain mirror is looser than the chain. This asserts the WRAPPER, which
 * is what both signers actually use.
 */
test("buildWallPolicies forwards EVERY adapter into the call policy", () => {
  const call = (opts: Parameters<typeof buildWallPolicies>[0]) => {
    const { policies } = buildWallPolicies(opts);
    // The call policy is the LAST, and its permissions live under policyParams
    // — the zerodev policy object exposes only getPolicyData/getPolicyInfoInBytes
    // /policyParams, so reading `.permissions` off the top level silently yields
    // an empty list and this test would pass for the wrong reason.
    //
    // Indexed from the end deliberately. This read `policies[2]` until the
    // rate-limit policy was removed, and a positional index into a list whose
    // length is itself under test is a second thing to remember to change.
    const p = policies[policies.length - 1] as unknown as { policyParams?: { permissions?: { target: string }[] } };
    const perms = p.policyParams?.permissions ?? [];
    assert.ok(perms.length > 0, "the call policy must expose its permissions, or this test proves nothing");
    return perms.map((x) => x.target.toLowerCase());
  };

  const bare = call({ caps: CAPS, smartAccount: SELF });
  const trencher = {
    trencherVaultAddress: "0x2222222222222222222222222222222222222222",
    trencherFactoryAddress: "0x3333333333333333333333333333333333333333",
  } as const;
  assert.ok(!bare.includes(trencher.trencherVaultAddress), "no Trencher vault asked for, none granted");
  assert.ok(
    call({ caps: CAPS, smartAccount: SELF, ...trencher }).includes(trencher.trencherVaultAddress),
    "the Trencher vault must survive buildWallPolicies",
  );

  // PERPS, the same trap — and the one where a
  // dropped field costs most: a grant carrying `perp-lighter-v1` and a sealed
  // key over a wall that can neither deposit, register the key, nor claim home.
  const PROXY = LIGHTER_ROUTE_V1.proxy.toLowerCase();
  const perpLighter = { apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: PERP_PK };
  assert.ok(!bare.includes(PROXY), "no perps asked for, none granted");
  const perpPolicies = buildWallPolicies({ caps: CAPS, smartAccount: SELF, perpLighter }).policies;
  const perpCall = perpPolicies[perpPolicies.length - 1] as unknown as {
    policyParams: { permissions: { target: string; functionName?: string; args?: { value?: unknown }[] }[] };
  };
  const onProxy = perpCall.policyParams.permissions.filter((p) => p.target.toLowerCase() === PROXY);
  assert.deepEqual(
    onProxy.map((p) => p.functionName),
    ["deposit", "changePubKey", "withdrawPendingBalance"],
    "perpLighter must survive buildWallPolicies — all three proxy permissions",
  );
  const perpApprove = perpCall.policyParams.permissions.find(
    (p) => p.target.toLowerCase() === CASH.USDT.toLowerCase() && p.functionName === "approve",
  )!;
  assert.ok(
    (perpApprove.args![0]!.value as string[]).map((a) => a.toLowerCase()).includes(PROXY),
    "and the proxy must be a USDG spender in the wall the signer actually seals",
  );
  // Byte-level, not just targets: the wrapper's permissions are the direct
  // builder's, rule for rule, key word for key word.
  const everything = { ...trencher, perpLighter } as const;
  const wrapped = buildWallPolicies({ caps: CAPS, smartAccount: SELF, ...everything }).policies;
  const direct2 = toCallPolicy({
    policyVersion: CallPolicyVersion.V0_0_4,
    permissions: buildCallPermissions(CAPS, SELF, everything) as never,
  });
  const last = wrapped[wrapped.length - 1]!;
  assert.equal(last.getPolicyData(), direct2.getPolicyData(), "buildWallPolicies must seal exactly buildCallPermissions' wall");
});

test("the swap's pinned asset set IS the approve set — they cannot drift", () => {
  // THE INVARIANT BEHIND 1.1. Pinning `tokenIn`/`tokenOut` is only worth
  // anything if the pinned list is the same list the approves cover. Pin a
  // narrower set and legitimate sells die on-chain with an opaque revert; pin a
  // wider one and the pin stops meaning what its comment says.
  //
  // wall.ts builds both from the single `swapAssets` const, in one call, so
  // they cannot drift by construction — but "by construction" is a claim about
  // code that a later refactor can quietly break. This asserts the OUTPUT,
  // which is the only thing the chain sees.
  const CUSTOM = {
    address: "0x00000000000000000000000000000000000000dd" as const,
    symbol: "MEME",
    decimals: 18,
  };
  for (const opts of [{}, { extraTokens: [CUSTOM] }]) {
    const list = buildCallPermissions(CAPS, SELF, opts) as unknown as Perm[];
    const approved = new Set(
      list.filter((p) => p.functionName === "approve").map((p) => p.target.toLowerCase()),
    );
    const swap = list.find(
      (p) => p.target.toLowerCase() === PANCAKESWAP.smartRouter.toLowerCase() && p.functionName === "exactInputSingle",
    )!;
    const legs = swap.args as unknown as { condition: number; value: string[] }[];
    for (const i of [0, 1] as const) {
      const pinned = new Set(legs[i]!.value.map((a) => a.toLowerCase()));
      assert.deepEqual(
        [...pinned].sort(),
        [...approved].sort(),
        `leg ${i} must be exactly the set of tokens this grant can approve`,
      );
    }
  }
});

const EVIL = "0x00000000000000000000000000000000000e0111" as const;
/** Word i of a calldata body, as the 32-byte hex the policy compares. */
const wordHex = (data: Hex, i: number) => `0x${data.slice(10 + i * 64, 10 + (i + 1) * 64)}`.toLowerCase();

/** A call-policy rule as @zerodev/permissions encodes it for V0_0_4. */
type PolicyRule = { condition: number; offset: number; params: Hex[] };

/**
 * A MODEL OF CallPolicy V0_0_4's check, faithful to the contract rather than to
 * our intent: the permission is keyed by selector, each rule reads
 * `bytes32(data[4 + offset : 4 + offset + 32])` and compares it as a whole
 * word, and an out-of-range slice REVERTS — which for the account is a refusal.
 */
function callPolicyAdmits(rules: readonly PolicyRule[], selector: string, data: Hex): boolean {
  if (data.slice(0, 10).toLowerCase() !== selector.toLowerCase()) return false;
  const bytes = (data.length - 2) / 2;
  for (const r of rules) {
    const start = 4 + r.offset;
    if (start + 32 > bytes) return false; // calldata slice out of range: the policy reverts
    const w = BigInt(`0x${data.slice(2 + start * 2, 2 + (start + 32) * 2)}`);
    const p = r.params.map((x) => BigInt(x));
    switch (r.condition) {
      case ParamCondition.EQUAL: if (w !== p[0]) return false; break;
      case ParamCondition.GREATER_THAN: if (!(w > p[0]!)) return false; break;
      case ParamCondition.LESS_THAN: if (!(w < p[0]!)) return false; break;
      case ParamCondition.GREATER_THAN_OR_EQUAL: if (!(w >= p[0]!)) return false; break;
      case ParamCondition.LESS_THAN_OR_EQUAL: if (!(w <= p[0]!)) return false; break;
      case ParamCondition.NOT_EQUAL: if (w === p[0]) return false; break;
      case ParamCondition.ONE_OF: if (!p.includes(w)) return false; break;
      default: return false; // not modelled: refuse rather than guess
    }
  }
  return true;
}

const hexWord = (v: bigint) => v.toString(16).padStart(64, "0");
const addrWord = (a: string) => a.slice(2).toLowerCase().padStart(64, "0");
const withWords = (data: Hex, edits: Record<number, string>, append: string[] = []) => {
  const body = data.slice(10).match(/.{64}/g)!;
  for (const [i, w] of Object.entries(edits)) body[Number(i)] = w;
  return `${data.slice(0, 10)}${body.join("")}${append.join("")}` as Hex;
};

/**
 * PERPETUALS ON LIGHTER — docs/perps.md rule 3: the wall grows by exactly four
 * sealed things, on 4663 only, and only by re-signing.
 *
 * Three kinds of evidence:
 * (a) the library places args[i] at offset i*32 past the ABI's arity, (b) each
 * pin byte-equals the word viem's encoder writes there, and (c) no calldata
 * that satisfies the pins can decode to a different key, index, account or
 * asset. changePubKey gets the most, because its `bytes` argument is dynamic
 * and its offset word is the one an attacker would move.
 */
const PROXY = LIGHTER_ROUTE_V1.proxy.toLowerCase();
const PERP = { apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: PERP_PK } as const;
const perpPerms = (opts: Parameters<typeof buildCallPermissions>[2] = {}) =>
  buildCallPermissions(CAPS, SELF, { ...opts, perpLighter: PERP }) as unknown as Perm[];
const onProxy = (list: Perm[], fn: string) => {
  const mine = list.filter((p) => p.target.toLowerCase() === PROXY && p.functionName === fn);
  assert.equal(mine.length, 1, `exactly one ${fn} permission on the proxy`);
  return mine[0]!;
};
/** The rules @zerodev/permissions actually encodes for one permission — what the signature is made over. */
const encodedRules = (p: Perm) => {
  const policy = toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: [p] as never });
  const [encoded] = (policy.policyParams as unknown as { permissions: { selector: Hex; rules: PolicyRule[] }[] }).permissions;
  return encoded!;
};
const spendersOfApprove = (list: Perm[], target: string) => {
  const p = list.find((x) => x.target.toLowerCase() === target.toLowerCase() && x.functionName === "approve");
  assert.ok(p, `${target} must have an approve`);
  return ((p.args as { value: string[] }[])[0]!.value).map((a) => a.toLowerCase());
};

test("PERPS opt-in: absent by default; three proxy permissions and ONE spender entry when sealed; no native value", () => {
  // CLOSED by default, and the bare wall is byte-for-byte the one every grant
  // already carries (wall-release.test.ts pins its fingerprint unchanged).
  assert.equal(find(LIGHTER_ROUTE_V1.proxy).length, 0, "no proxy permission without the opt-in");
  for (const p of perms()) {
    for (const a of (p.args ?? []) as (null | { value?: unknown })[]) {
      const v = a?.value;
      const values = Array.isArray(v) ? v : [v];
      assert.ok(!values.map((x) => String(x).toLowerCase()).includes(PROXY), `${p.target}.${p.functionName} must not name the proxy`);
    }
  }

  const CUSTOM = { symbol: "MEME", address: "0x00000000000000000000000000000000000000dd" as const, decimals: 18 };
  const plain = buildCallPermissions(CAPS, SELF, { extraTokens: [CUSTOM] }) as unknown as Perm[];
  const withPerps = perpPerms({ extraTokens: [CUSTOM] });
  assert.equal(withPerps.length, plain.length + 3, "perps are exactly THREE permissions: deposit, changePubKey, claim");
  assert.deepEqual(
    withPerps.filter((p) => p.target.toLowerCase() === PROXY).map((p) => p.functionName),
    ["deposit", "changePubKey", "withdrawPendingBalance"],
  );
  for (const p of withPerps) assert.equal(p.valueLimit, 0n, `${p.target}.${p.functionName} must not be allowed to move native ETH`);

  // NOT on-chain withdraw, createOrder or cancelAllOrders — the owner's escape
  // hatches. A session key with cancelAllOrders could strip the venue stops.
  for (const fn of ["withdraw", "createOrder", "cancelAllOrders"]) {
    assert.ok(!withPerps.some((p) => p.target.toLowerCase() === PROXY && p.functionName === fn), `${fn} must never be granted`);
  }

  // THE PROXY IS A SPENDER IN THE USDG APPROVE'S ONE_OF AND NOWHERE ELSE. The
  // stock and extra approves carry no amount condition; the proxy joining
  // their ONE_OF would be an uncapped allowance over the whole book, held by a
  // contract whose upgrades skip their notice period.
  assert.deepEqual(
    spendersOfApprove(withPerps, CASH.USDT),
    [...spendersOfApprove(plain, CASH.USDT), PROXY],
    "the USDG approve grows by exactly the proxy",
  );
  const approvesOf = (l: Perm[]) => l.filter((p) => p.functionName === "approve").map((p) => p.target.toLowerCase());
  assert.deepEqual(approvesOf(withPerps), approvesOf(plain), "no new approve permission — only a wider USDG spender list");
  for (const target of approvesOf(withPerps).filter((t) => t !== CASH.USDT.toLowerCase())) {
    assert.deepEqual(spendersOfApprove(withPerps, target), spendersOfApprove(plain, target), `${target}'s approve must not change`);
    assert.ok(!spendersOfApprove(withPerps, target).includes(PROXY), `${target} must never name the proxy`);
  }
  // …and the USDG approve's amount cap is unchanged: the proxy pulls under the
  // same per-trade ceiling as every other spender.
  const usdgApprove = withPerps.find((p) => p.target.toLowerCase() === CASH.USDT.toLowerCase() && p.functionName === "approve")!;
  assert.deepEqual((usdgApprove.args as unknown[])[1], { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: usdg(CAPS.perTradeUsdg) });
});

test("PERPS deposit: all four words pinned — this account, USDG, perps, ≤ one trade — at proven offsets", () => {
  const p = onProxy(perpPerms(), "deposit");
  const args = p.args as ({ condition: number; value: unknown } | null)[];
  assert.equal(args.length, 4);
  assert.deepEqual(args[0], { condition: ParamCondition.EQUAL, value: SELF }, "w0 _to is this account");
  assert.deepEqual(args[1], { condition: ParamCondition.EQUAL, value: 3n }, "w1 asset 3 — USDG");
  assert.deepEqual(args[2], { condition: ParamCondition.EQUAL, value: 0n }, "w2 route 0 — perps, never spot");
  assert.deepEqual(args[3], { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: usdg(CAPS.perTradeUsdg) }, "w3 ≤ perTradeUsdg");
  for (const i of [1, 2, 3]) assert.equal(typeof args[i]!.value, "bigint", `w${i} must be a bigint, never a decimal string`);

  // (b) against viem's encoder — the calldata the worker will build.
  const AMOUNT = 12_345_678n;
  const data = encodeFunctionData({ abi: LIGHTER_DEPOSIT_ABI, functionName: "deposit", args: [SELF, 3, 0, AMOUNT] });
  assert.equal(data.slice(0, 10), "0x8a857083", "the deployed deposit selector");
  assert.equal((data.length - 10) / 64, 4, "four static words");
  // (a) the library's rules: offsets 0..96, params byte-equal to viem's words
  // (the LTE bound compared to the cap, not to this amount).
  const enc = encodedRules(p);
  assert.equal(enc.selector.toLowerCase(), "0x8a857083");
  assert.deepEqual(enc.rules.map((r) => r.offset), [0, 32, 64, 96]);
  for (const i of [0, 1, 2]) assert.equal(enc.rules[i]!.params[0]!.toLowerCase(), wordHex(data, i), `rule ${i} must byte-equal viem's word ${i}`);
  assert.equal(BigInt(enc.rules[3]!.params[0]!), usdg(CAPS.perTradeUsdg));
  assert.equal(BigInt(wordHex(data, 3)), AMOUNT, "word 3 is the amount");

  // (c) the model refuses each pinned word moved, and admits the honest call.
  const admits = (d: Hex) => callPolicyAdmits(enc.rules, enc.selector, d);
  const deposit = (to: `0x${string}`, asset: number, route: number, amount: bigint) =>
    encodeFunctionData({ abi: LIGHTER_DEPOSIT_ABI, functionName: "deposit", args: [to, asset, route, amount] });
  assert.ok(admits(data), "the honest deposit is admitted");
  assert.equal(admits(deposit(EVIL, 3, 0, AMOUNT)), false, "crediting someone else's venue account is refused");
  assert.equal(admits(deposit(SELF, 2, 0, AMOUNT)), false, "another asset is refused");
  assert.equal(admits(deposit(SELF, 3, 1, AMOUNT)), false, "the spot route is refused");
  assert.equal(admits(deposit(SELF, 3, 0, usdg(CAPS.perTradeUsdg) + 1n)), false, "one base unit over the cap is refused");
  assert.ok(admits(deposit(SELF, 3, 0, usdg(CAPS.perTradeUsdg))), "exactly the cap is admitted");
  assert.equal(admits(withWords(data, { 0: `ff${addrWord(SELF).slice(2)}` })), false, "a dirty high byte in `_to` is refused — EQUAL is the whole word");
});

/** What the proxy would register, per viem's decoder (null = it would revert decoding). */
function decodedPubKey(data: Hex): { keyIndex: number; pubKey: string } | null {
  try {
    const d = decodeFunctionData({ abi: LIGHTER_CHANGE_PUBKEY_ABI, data });
    const [, keyIndex, pubKey] = d.args as unknown as [number, number, string];
    return { keyIndex: Number(keyIndex), pubKey: pubKey.toLowerCase() };
  } catch {
    return null;
  }
}

test("PERPS changePubKey: ONE key at ONE index — six args for three parameters, at proven offsets", () => {
  const p = onProxy(perpPerms(), "changePubKey");
  const args = p.args as ({ condition: number; value: unknown } | null)[];
  assert.equal(args.length, 6, "six words: account, index, offset, length and the key's two words");
  assert.equal(args[0], null, "w0 the account index is OPEN — it does not exist until the first deposit lands");
  const [w4, w5] = pubKeyWords(PERP_PK);
  assert.deepEqual(args.slice(1), [
    { condition: ParamCondition.EQUAL, value: 16n },
    { condition: ParamCondition.EQUAL, value: 0x60n },
    { condition: ParamCondition.EQUAL, value: 40n },
    { condition: ParamCondition.EQUAL, value: w4 },
    { condition: ParamCondition.EQUAL, value: w5 },
  ]);
  // FULL 32-BYTE WORDS. The library LEFT-pads anything shorter, so an 8-byte
  // tail here would pin 0x00…<tail> — a word the encoder never writes.
  for (const v of [w4, w5]) assert.match(v, /^0x[0-9a-f]{64}$/);
  assert.ok(w5.endsWith("0".repeat(48)), "w5 is RIGHT-padded, as ABI bytes are");

  for (const pk of [PERP_PK, PERP_PK_OTHER]) {
    const perm = onProxy(buildCallPermissions(CAPS, SELF, { perpLighter: { apiKeyIndex: 16, apiPublicKey: pk } }) as unknown as Perm[], "changePubKey");
    const data = encodeFunctionData({ abi: LIGHTER_CHANGE_PUBKEY_ABI, functionName: "changePubKey", args: [22149, 16, pk] });
    assert.equal(data.slice(0, 10), "0x17010c68", "the deployed changePubKey selector");
    assert.equal((data.length - 2) / 2, 196, "4 + 6 × 32 bytes");
    const enc = encodedRules(perm);
    assert.equal(enc.selector.toLowerCase(), "0x17010c68");
    assert.equal(enc.rules.length, 5, "five rules — w0 is open");
    assert.deepEqual(enc.rules.map((r) => r.offset), [32, 64, 96, 128, 160]);
    for (const [k, rule] of enc.rules.entries()) {
      assert.equal(rule.condition, ParamCondition.EQUAL);
      assert.equal(rule.params[0]!.toLowerCase(), wordHex(data, k + 1), `rule ${k} must byte-equal viem's word ${k + 1}`);
    }
    assert.ok(callPolicyAdmits(enc.rules, enc.selector, data), "the honest registration is admitted");
    assert.deepEqual(decodedPubKey(data), { keyIndex: 16, pubKey: pk });
  }
});

test("PERPS changePubKey adversarial: every counterexample is refused, and every pin is load-bearing", () => {
  const enc = encodedRules(onProxy(perpPerms(), "changePubKey"));
  const admits = (d: Hex) => callPolicyAdmits(enc.rules, enc.selector, d);
  const admitsWithout = (word: number, d: Hex) => callPolicyAdmits(enc.rules.filter((r) => r.offset !== word * 32), enc.selector, d);
  const cpk = (acct: number, idx: number, pk: `0x${string}`) =>
    encodeFunctionData({ abi: LIGHTER_CHANGE_PUBKEY_ABI, functionName: "changePubKey", args: [acct, idx, pk] });
  const honest = cpk(22149, 16, PERP_PK);
  const SEALED = { keyIndex: 16, pubKey: PERP_PK };
  assert.ok(admits(honest));

  // ANOTHER KEY — refused at w4 (and w5); the key pins are what refuse it.
  const other = cpk(22149, 16, PERP_PK_OTHER);
  assert.equal(admits(other), false, "registering any other key must be refused");
  assert.equal(callPolicyAdmits(enc.rules.filter((r) => r.offset < 128), enc.selector, other), true, "premise: only the key pins refuse it");

  // ANOTHER INDEX — the owner's own Robinhood Wallet session lives at 0..3.
  const idx0 = cpk(22149, 0, PERP_PK);
  assert.equal(admits(idx0), false, "the sealed key at another index must be refused");
  assert.equal(admitsWithout(1, idx0), true, "premise: the index pin is what refuses it");

  // W2 RELOCATED — THE LOAD-BEARING OFFSET PIN. The head says the key lives at
  // 0xc0; w3..w5 still hold the sealed decoy, and the bytes the proxy would
  // actually register sit after them. Measured on 4663 under eth_call: the
  // deployed decoder follows w2, and only this pin refuses the call.
  const [ow4, ow5] = pubKeyWords(PERP_PK_OTHER);
  const relocated = withWords(honest, { 2: hexWord(0xc0n) }, [hexWord(40n), ow4.slice(2), ow5.slice(2)]);
  assert.equal(admits(relocated), false, "w2 = 0xc0 must be refused");
  assert.equal(admitsWithout(2, relocated), true, "premise: without the w2 pin this passes every other pin");
  assert.deepEqual(decodedPubKey(relocated), { keyIndex: 16, pubKey: PERP_PK_OTHER }, "…and the proxy would register the attacker's key");
  // And w2 = 0x80, the relocation the spike measured: refused at word 2.
  assert.equal(admits(withWords(honest, { 2: hexWord(0x80n) })), false, "w2 = 0x80 must be refused");

  // W3 — A SHORTER LENGTH registers a prefix nobody sealed.
  const short = withWords(honest, { 3: hexWord(32n) });
  assert.equal(admits(short), false, "length 32 must be refused");
  assert.equal(admitsWithout(3, short), true, "premise: the length pin is what refuses it");

  // DIRTY W5 PADDING — EQUAL compares the whole word, so bytes after the key's
  // tail are refused even though the decoder would ignore them.
  const dirty = withWords(honest, { 5: `${w5Of(PERP_PK).slice(2, 18)}${"ab".repeat(24)}` });
  assert.equal(admits(dirty), false, "dirty padding in w5 must be refused");
  assert.equal(admitsWithout(5, dirty), true, "premise: only the full-word w5 pin catches it");

  // TRUNCATED: 195 bytes cannot hold word 5, and the slice reverts.
  assert.equal(admits(honest.slice(0, -2) as Hex), false, "195 bytes must be refused");

  // ACCEPTED: any account index (w0 is open by necessity) and trailing bytes
  // the decoder never reads — and every one still registers the SEALED key.
  for (const acct of [1, 22149, 281_474_976_710_655]) {
    const d = cpk(acct, 16, PERP_PK);
    assert.ok(admits(d), `account index ${acct} is admitted`);
    assert.deepEqual(decodedPubKey(d), SEALED);
  }
  const trailing = withWords(honest, {}, ["cd".repeat(32), hexWord(40n), ow4.slice(2), ow5.slice(2)]);
  assert.equal(admits(trailing), true, "trailing junk is admitted — no pin reads past w5");
  assert.deepEqual(decodedPubKey(trailing), SEALED, "…and it still decodes to the sealed key, never the trailing one");

  // THE LEFT-PADDED TAIL NEVER MATCHES. Had the wall passed w5 as the bare 8
  // bytes pk[32:40], the library would left-pad it into a word no honest
  // encoding contains: a permission that reads as strict and registers nothing.
  const tail = `0x${PERP_PK.slice(2 + 64)}` as `0x${string}`;
  assert.equal(tail.length, 18, "8 bytes");
  const honestPerm = onProxy(perpPerms(), "changePubKey");
  const leftPadded = {
    ...honestPerm,
    args: [...(honestPerm.args as unknown[]).slice(0, 5), { condition: ParamCondition.EQUAL, value: tail }],
  } as unknown as Perm;
  const bad = encodedRules(leftPadded);
  assert.equal(bad.rules[4]!.params[0]!.toLowerCase(), pad(tail, { size: 32 }).toLowerCase(), "the library left-pads");
  for (const pk of [PERP_PK, PERP_PK_OTHER]) {
    for (const acct of [1, 22149]) {
      assert.equal(callPolicyAdmits(bad.rules, bad.selector, cpk(acct, 16, pk)), false, "a left-padded tail matches no honest call");
    }
  }

  // AND A FUZZ, seeded: randomise the open word, sometimes corrupt a pinned one
  // (small numbers are what offsets and lengths look like), sometimes append a
  // tail, sometimes truncate. Everything admitted that decodes must register
  // the sealed key at the sealed index; nothing may decode to anything else.
  let seed = 0x17010c68;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const randWord = () => Array.from({ length: 64 }, () => "0123456789abcdef"[Math.floor(rand() * 16)]).join("");
  let admitted = 0;
  let refused = 0;
  let decoded = 0;
  for (let n = 0; n < 4_000; n++) {
    // w0 mostly a plausible uint48, sometimes a whole random word (which the
    // proxy's decoder rejects — measured — and viem may or may not).
    const edits: Record<number, string> = { 0: rand() < 0.7 ? hexWord(BigInt(Math.floor(rand() * 2 ** 40))) : randWord() };
    for (const i of [1, 2, 3, 4, 5]) {
      const r = rand();
      if (r < 0.05) edits[i] = randWord();
      else if (r < 0.1) edits[i] = hexWord(BigInt(Math.floor(rand() * 0x200)));
    }
    const tail = Array.from({ length: Math.floor(rand() * 5) }, () =>
      rand() < 0.3 ? hexWord(BigInt(Math.floor(rand() * 0x200))) : randWord(),
    );
    let data = withWords(honest, edits, tail);
    if (rand() < 0.05) data = data.slice(0, data.length - 2 * (1 + Math.floor(rand() * 40))) as Hex;
    if (!admits(data)) {
      refused++;
      continue;
    }
    admitted++;
    const d = decodedPubKey(data);
    if (d === null) continue;
    decoded++;
    assert.deepEqual(d, SEALED, `admitted calldata registered something else: ${data}`);
  }
  assert.ok(admitted > 1_000, `the fuzz must exercise admitted calls (${admitted})`);
  assert.ok(decoded > 1_000, `and admitted calls must actually decode, or the check above is vacuous (${decoded})`);
  assert.ok(refused > 100, `and refused ones (${refused})`);
});

/** The honest w5 of a key: its last 8 bytes, right-padded. */
function w5Of(pk: `0x${string}`): `0x${string}` {
  return pubKeyWords(pk)[1];
}

test("PERPS withdrawPendingBalance: pays THIS account, asset 3, any amount — at proven offsets", () => {
  const p = onProxy(perpPerms(), "withdrawPendingBalance");
  const args = p.args as ({ condition: number; value: unknown } | null)[];
  assert.deepEqual(args, [
    { condition: ParamCondition.EQUAL, value: SELF },
    { condition: ParamCondition.EQUAL, value: 3n },
    null,
  ]);
  const data = encodeFunctionData({ abi: LIGHTER_WITHDRAW_PENDING_ABI, functionName: "withdrawPendingBalance", args: [SELF, 3, 8_085_000_000n] });
  assert.equal(data.slice(0, 10), "0x2f25807e", "the deployed claim selector");
  const enc = encodedRules(p);
  assert.deepEqual(enc.rules.map((r) => r.offset), [0, 32], "two rules — the amount is open");
  for (const [i, r] of enc.rules.entries()) assert.equal(r.params[0]!.toLowerCase(), wordHex(data, i));
  const admits = (d: Hex) => callPolicyAdmits(enc.rules, enc.selector, d);
  assert.ok(admits(data));
  const claim = (owner: `0x${string}`, asset: number) =>
    encodeFunctionData({ abi: LIGHTER_WITHDRAW_PENDING_ABI, functionName: "withdrawPendingBalance", args: [owner, asset, 1n] });
  assert.equal(admits(claim(EVIL, 3)), false, "a claim paying anyone else is refused");
  assert.equal(admits(claim(SELF, 0)), false, "another asset is refused");
});

test("PERPS off 4663 carry no perp permission: perpFits says no, and a rebuild seals none", () => {
  // The chain is not an input to buildCallPermissions — so the two doors that can set `perpLighter` are what gate it.
  const grant = (chainId: number) => ({
    chainId,
    grantFeatures: ["tradeable-v2", GRANT_PERP_LIGHTER],
    perp: { route: GRANT_PERP_LIGHTER, apiKeyIndex: 16, apiPublicKey: PERP_PK, apiKeySealed: "sealed" },
  });
  for (const chainId of [46630, 1, 8453]) {
    assert.equal(perpFits(CAPS, SELF, chainId, true, {}), false, `perpFits on ${chainId}`);
    assert.equal(perpFits(CAPS, SELF, chainId, false, { perpLighter: PERP }), false, `perpFits on ${chainId}, key in hand`);
    const opts = grantWallOptions(grant(chainId));
    assert.equal(opts.perpLighter, undefined, `a ${chainId} grant carrying the marker rebuilds no perps`);
    const wall = buildCallPermissions(CAPS, SELF, opts) as unknown as Perm[];
    assert.ok(!wall.some((p) => p.target.toLowerCase() === PROXY), `no proxy permission on ${chainId}`);
    assert.ok(!spendersOfApprove(wall, CASH.USDT).includes(PROXY), `no proxy spender on ${chainId}`);
  }
  // On 4663 the same grant rebuilds exactly the wall a signer seals, and the
  // sealed private-key blob never reaches the options.
  const opts = grantWallOptions(grant(4663));
  assert.deepEqual(opts.perpLighter, PERP);
  assert.ok(!JSON.stringify(opts).includes("sealed"), "apiKeySealed never enters the wall's inputs");
  assert.deepEqual(
    toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: buildCallPermissions(CAPS, SELF, opts) as never }).getPolicyData(),
    toCallPolicy({ policyVersion: CallPolicyVersion.V0_0_4, permissions: buildCallPermissions(CAPS, SELF, { ...opts, perpLighter: PERP }) as never }).getPolicyData(),
  );
  assert.ok(perpFits(CAPS, SELF, 4663, true, {}), "the default wall has room for perps on mainnet");
});

test("PERPS refuse a key the contract would reject, or an index the route does not name — without echoing the key", () => {
  const build = (perpLighter: unknown) => () => buildCallPermissions(CAPS, SELF, { perpLighter } as never);
  const LIMBS_OVER_P = `0x${"f".repeat(80)}`; // every limb 2^64 − 1 ≥ p: not a field element
  for (const bad of [
    `0x${"0".repeat(80)}`, // all zero
    LIMBS_OVER_P,
    PERP_PK.slice(0, -2), // 39 bytes
    `${PERP_PK}00`, // 41 bytes
    "not hex",
    42,
  ]) {
    assert.throws(build({ apiKeyIndex: 16, apiPublicKey: bad }), (e: Error) => {
      assert.match(e.message, /not a canonical Lighter API public key/);
      if (typeof bad === "string" && bad.length >= 20) {
        assert.ok(!e.message.includes(bad.slice(2, 20)), "the refusal must not echo what it was given");
      }
      return true;
    });
  }
  for (const idx of [0, 3, 157, 255, 17, -1, 16.5]) {
    assert.throws(build({ apiKeyIndex: idx, apiPublicKey: PERP_PK }), /route's key index 16/, `index ${idx}`);
  }
  // Absent and null are both the closed default.
  assert.equal(buildCallPermissions(CAPS, SELF, { perpLighter: undefined }).length, perms().length);
  assert.equal(buildCallPermissions(CAPS, SELF, { perpLighter: null } as never).length, perms().length);
  // Any case of a canonical key seals the same lowercase words.
  const upper = `0x${PERP_PK.slice(2).toUpperCase()}` as `0x${string}`;
  assert.deepEqual(
    onProxy(buildCallPermissions(CAPS, SELF, { perpLighter: { apiKeyIndex: 16, apiPublicKey: upper } }) as unknown as Perm[], "changePubKey").args,
    onProxy(perpPerms(), "changePubKey").args,
  );
});
