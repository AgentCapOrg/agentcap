import { erc20Abi, type Address } from "viem";
import { trencherAddresses, trencherPermissions, type TrencherPermission } from "./trencher-vault";
import { PolicyFlags } from "@zerodev/permissions";
import { CallPolicyVersion, ParamCondition, toCallPolicy } from "@zerodev/permissions/policies";
import { toTimestampPolicy } from "@zerodev/permissions/policies";
import {
  UNISWAP_SWAP_ROUTER_ABI,
  LIGHTER_DEPOSIT_ABI,
  LIGHTER_CHANGE_PUBKEY_ABI,
  LIGHTER_WITHDRAW_PENDING_ABI,
} from "./abis";
import { PANCAKESWAP } from "./protocols";
import { CASH, STOCK_TOKENS, TRADEABLE_SYMBOLS, CASH_DECIMALS, isValidCustomToken, type CustomToken } from "./tokens";
import { GRANT_SCOPED_SPENDERS, builtinGrantTargets, grantPurpose, type GrantCaps } from "./grant";
// perps.ts imports only perps-styles.ts, which imports nothing, so this cannot
// become a cycle through grant.ts.
import { LIGHTER_ROUTE_V1, grantPerp, pubKeyWords, validatePerpPubKey } from "./perps";
// The deployability policy, for `perpFits` below. first-enable-gas.ts
// deliberately imports nothing (it counts permissions structurally), so this
// is not a cycle and cannot become one without that file changing its rule.
import { wallShape, wallSignable } from "./first-enable-gas";

/**
 * THE WALL. One definition, shared by every client that can sign a grant.
 *
 * This file decides what a session key is permitted to do once the account
 * contract is enforcing it — which assets it may approve, which routers may pull
 * them, how much per call, and when the key dies. It used to live inside the
 * dashboard's session.ts, which was fine while the dashboard was the only thing
 * that could sign. It is not fine with a phone app that can sign too: two copies
 * of this list would drift, nothing would fail when they did, and the difference
 * would be a wallet with permissions its owner never agreed to.
 *
 * So it is here, imported by both, and the tests in worker/src/wall.test.ts assert
 * the exact shape rather than trusting that a refactor preserved it.
 *
 * READ BEFORE CHANGING. Every entry below is a power granted to an automated
 * agent. Widening one is not a feature flag — it is a permanent change to what a
 * compromised agent could do with someone's money, and it only takes effect for
 * grants signed afterwards, so the fleet will be running a mix of walls.
 */

/** UI amounts are exact to a millionth of a USDT; the chain counts in 18dp. */
const MICRO = 1_000_000;
const BASE_UNITS_PER_MICRO = 10n ** BigInt(CASH_DECIMALS - 6);

/** Largest UI-unit value that can be converted to exact base units. */
export const MAX_USDG_UI = Number.MAX_SAFE_INTEGER / MICRO;

/**
 * Convert a finite UI-unit cash amount to its base units. Rounded to a
 * micro-unit FIRST and scaled as integers: multiplying a float by 1e18
 * directly turns 10.1 into 10099999999999999… base units.
 */
export function usdgUnits(value: number): bigint {
  const micro = Math.round(value * MICRO);
  if (!Number.isFinite(value) || !Number.isSafeInteger(micro)) {
    throw new RangeError(`USDT amount must be finite and no larger than ${MAX_USDG_UI}`);
  }
  return BigInt(micro) * BASE_UNITS_PER_MICRO;
}

/**
 * THE SESSION KEY MAY EXECUTE, BUT IT MAY NOT SIGN.
 *
 * Everything else in this file is a CALL policy, and a call policy constrains
 * UserOp calls. It says nothing about signatures — and the permission validator
 * implements `signMessage` and `signTypedData` (@zerodev/permissions
 * toPermissionValidator), so with the library default (FOR_ALL_VALIDATION) the
 * session key can produce ERC-1271 signatures the account will honour.
 *
 * That was a hole straight through the wall, and the worst one, because it
 * bypasses the wall rather than stretching it. Anything that moves tokens
 * against a signature — an EIP-2612 permit, or an off-chain order that settles
 * against an ERC-1271 signature — could be SIGNED by the session key and
 * submitted by anyone, from their own EOA, with no UserOp at all. No call
 * policy is consulted, the rate limit never fires, and nothing in the ledger
 * records it.
 *
 * NOT_FOR_VALIDATE_SIG closes it: the kernel refuses to validate signatures
 * from this permission, while UserOp execution is untouched. This costs
 * agentcap nothing — the entire trading path is UserOps. Grep confirms nothing
 * in worker/, packages/ or web/src/lib signs with the session account.
 *
 * The flag travels ON-CHAIN in the validator's enable data, so the account
 * itself enforces it — this is not a client-side promise. It is also hashed
 * into the permission id, which means it only takes effect for grants signed
 * AFTER this change: existing grants keep the old, permissive wall until
 * they're re-signed. See the header note about the fleet running a mix.
 */
export const WALL_POLICY_FLAG = PolicyFlags.NOT_FOR_VALIDATE_SIG;

/**
 * THE SINGLETONS EVERY GRANT DEPENDS ON, so their absence can be a REFUSAL
 * rather than a mystery.
 *
 * A ZeroDev policy is an address plus its data: `getPolicyInfoInBytes()` is
 * `concat([policyFlag, policyAddress])`, and the addresses come from
 * @zerodev/permissions' own constants — defaults for a deployment the library
 * assumes exists. On Robinhood Chain one of them did not, and nothing here
 * checked, so the grant sealed a pointer into empty space and the failure
 * surfaced as a UserOp that would not validate, with no message naming a cause.
 *
 * This repo already knows the discipline. index.ts refuses to trust the
 * drawdown breaker unless its address has CODE on the grant chain, because
 * otherwise the read "silently fails open while the user believes they're
 * protected". The wall's own policy contracts had no such check — which is
 * exactly why an undeployed singleton survived every test in the suite.
 *
 * Duplicated as literals ON PURPOSE. Re-exporting the package's constants would
 * make this list track whatever the library ships next, and the point of a
 * probe is to assert what THIS code sealed. If a version bump moves an address,
 * the probe must fail loudly rather than follow it.
 */
export const WALL_POLICY_CONTRACTS: readonly { name: string; address: Address }[] = [
  { name: "TimestampPolicy", address: "0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F" as Address },
  { name: "CallPolicy V0_0_4", address: "0x9a52283276A0ec8740DF50bF01B28A80D880eaf2" as Address },
  { name: "ECDSA signer", address: "0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF" as Address },
];

/**
 * The only contracts a token approval may ever name as spender.
 */
export function allowedSpenders(trencherVaultAddress?: Address): Address[] {
  return [
    PANCAKESWAP.smartRouter as Address,
    // The Trencher vault: `buy()` pulls cash from the owner with transferFrom,
    // so it must be nameable inside the capped USDG approve. It gains no approve
    // permission of its own.
    //
    // IT USED TO HAVE ONE, and that is why this entry exists. `trencherPermissions`
    // carried its own USDG `approve` scoped EQUAL(vault); spread into the array
    // below, it collided with the router approve on Kernel's (target, selector)
    // key and every Trencher wall reverted at validation with
    // `AA23 reverted duplicate permissionHash`. Naming the vault here is the
    // same authority expressed once instead of twice.
    //
    // What makes it safe to approve: it keeps what it buys, which is its
    // purpose, but it holds for exactly one owner, sends sale proceeds only to
    // that owner, and has no code path that names anyone else
    // (contracts/TrencherVault.sol).
    ...(trencherVaultAddress ? [trencherVaultAddress] : []),
  ];
}

/**
 * The owner's choices that widen the wall beyond its secure default.
 *
 * Every field here defaults to the CLOSED position. That is the lesson of the
 * signature hole and the unpinned recipients: a default that happens to be
 * permissive survives for months because nothing fails. So the default wall
 * trades, and does nothing else.
 */
export interface WallOptions extends TrencherPermission {
  /**
   * A PERPS WALLET'S WALL: no Spot authority at all, whatever else is passed.
   *
   * The one field here that only ever NARROWS. A Perps wallet (index 1,
   * grant.purpose "perps") trades perpetuals and nothing else, so its wall
   * The one field here that only ever NARROWS. A Perps wallet (index 1,
   * grant.purpose "perps") trades perpetuals and nothing else, so its wall
   * carries no stock, coin or USDG approve to a Spot spender, no swap, no
   * Trencher vault and no USDG transfer out. What it may carry is the perp
   * route (when a perp block is sealed: the deposit, the key registration and
   * the proxy in the one USDG approve). With none, it is EMPTY, and an empty
   * wall can do nothing on chain: that is the paper Perps wallet.
   * not two that can drift. Absent (every grant signed before Perps) is the
   * Spot wall, unchanged.
   *
   * Set from the grant's PURPOSE and nothing else: by a signer from the
   * purpose it signs, and on a rebuild by `grantWallOptions` from the stored
   * grant's, so no other option can talk a rebuild into the other wallet's wall.
   */
  perpsOnly?: boolean;
  extraTokens?: readonly CustomToken[];
  /**
   * Addresses USDG may be transferred OUT to.
   *
   * EMPTY (the default) means the wall carries NO transfer permission at all —
   * a compromised agent cannot move USDG to an address, full stop.
   *
   * This closes the largest remaining hole. The recipient used to be free-form
   * because chat transfers are user-confirmed, so the amount was the only
   * on-chain bound — but that bound is PER CALL, and the daily USDG cap is
   * enforced only off-chain, in the worker. A compromised worker ignores its
   * own counter, so the true on-chain ceiling was perTradeUsdg × maxOpsPerDay
   * every day until expiry: 2,400 USDG/day at the default preset. "Bounded"
   * in the sense that draining the account took a fortnight.
   *
   * Registering addresses is the same re-sign-to-widen model the token
   * allowlist already uses, and for the same reason: the wall cannot grow by
   * itself. Moving money out to an UNREGISTERED address remains possible any
   * time via the owner key (`agentcap recover`), which is not bound by the
   * wall — so this removes an agent's power, not the owner's.
   */
  withdrawalAddresses?: readonly Address[];
  /**
   * EACH SPENDER NAMED ONLY ON THE TOKENS IT ACTUALLY PULLS. Off for every
   * grant signed before GRANT_SCOPED_SPENDERS existed, so those rebuild byte
   * for byte as they were signed; both signers now seal it on.
   *
   * Without it, every spender is pinned on every approve, the Trencher vault —
   * which only ever pulls USDG — included, in the ONE_OF of all the stock
   * approves and every custom-token approve. That is reach nothing uses, and it
   * is not free: each entry is 32 bytes of the enable data the first operation
   * carries.
   *
   * Scoped:
   *   - USDG approve: every spender, unchanged — every venue is funded in USDG.
   *     The Lighter proxy, when sealed, is named on this approve alone
   *     (`usdgSpenders`), never on a stock or coin approve.
   *   - stock and custom-token approves: the swap router only.
   *
   * Strictly narrower: every call the scoped wall permits, the unscoped one
   * permits too.
   */
  scopedSpenders?: boolean;
  /**
   * PERPETUALS ON LIGHTER — USDG margin into this account's own Lighter
   * account, registration of ONE sealed API key, and claims back home, over the
   * frozen LIGHTER_ROUTE_V1 (perps.ts, docs/perps.md rule 3). CLOSED by
   * default, like everything here.
   *
   * AN OBJECT, NOT A BOOLEAN. The route is a versioned constant —
   * GRANT_PERP_LIGHTER ("perp-lighter-v1") names it forever — but the API key
   * is per-agent and the wall pins its exact bytes, so the key has to be sealed
   * here and recorded on the grant (StoredGrant.perp). `grantWallOptions`
   * rebuilds this from `grantPerp(grant)` for that reason: marker + chain +
   * block, all or nothing.
   *
   * PUBLIC KEY ONLY. There is no field here a private key fits in, and the
   * refusal below never echoes what it was given: a signer that passed the
   * wrong half of a key pair must not print it into a log on the way out.
   *
   * THE CHAIN IS NOT AN INPUT TO THIS FILE:
   * nothing here can see which chain a signature is for. So the chain gate
   * sits at the two doors that can set this field — `perpFits` answers false
   * off 4663 (signers), and `grantPerp`, behind `grantWallOptions`, refuses the
   * marker off 4663 (the executor and the hosted rebuild). On any other chain
   * the proxy is codeless, a CALL to it succeeds with empty returndata, and a
   * deposit would "land" having posted nothing.
   *
   * SEALED ONLY WHEN IT FITS, and NEVER DROPPED
   * SILENTLY once a previous grant carried it: a registered Lighter key stays
   * valid at the venue whatever the grant says, so a re-sign that lost the
   * block would leave a live venue account with no key (rule 5). The refusal
   * is the signers'; `perpFits` is what they ask.
   */
  perpLighter?: { apiKeyIndex: number; apiPublicKey: `0x${string}` };
}

/** The tradeable stock tokens, in the order every list in this file names them. */
function tradeableStockAddresses(): Address[] {
  return STOCK_TOKENS.filter((t) => (TRADEABLE_SYMBOLS as readonly string[]).includes(t.symbol)).map(
    (t) => t.address as Address,
  );
}

/**
 * Owner-added tokens that are safe to seal into a policy.
 *
 * Validated HERE, at the last point before an address becomes on-chain policy: a
 * malformed entry either bricks the grant or silently widens it. Anything already
 * covered by the built-in set is dropped so the policy carries no duplicates.
 */
export function usableExtraTokens(extraTokens: readonly CustomToken[] = []): CustomToken[] {
  const builtin = builtinGrantTargets();
  const seen = new Set<string>();
  return extraTokens.filter((t) => {
    if (!isValidCustomToken(t)) return false;
    const key = t.address.toLowerCase();
    if (builtin.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The call-policy permission list — pure data, which is what makes it testable.
 *
 * Deliberately separate from `buildWallPolicies` below: the ZeroDev Policy objects
 * are opaque once constructed, so asserting on them proves little. This returns
 * the thing that actually defines the wall, in a shape a test can read.
 */
export function buildCallPermissions(
  caps: GrantCaps,
  /**
   * The agent's own smart-account address — where value must land.
   *
   * REQUIRED, not optional with a fallback. An optional parameter would let a
   * caller silently rebuild the OLD wall, where the swap recipient and the
   * vault receiver were unconstrained, and nothing would fail — which is
   * exactly how the signature hole (WALL_POLICY_FLAG) survived: a default that
   * happened to be permissive.
   *
   * Available at policy-build time because the Kernel address derives from the
   * SUDO validator alone; the permission plugin is enabled at UserOp time and
   * does not affect it. Both signers derive a sudo-only account first, pin it
   * here, and then assert the final account matches.
   */
  smartAccount: Address,
  opts: WallOptions = {},
) {
  // THE PERP KEY IS VALIDATED HERE, for the adapters' reason above and with
  // more at stake. The wall pins the key's exact calldata words, so a key the
  // contract would reject (a limb ≥ p, all zero, the wrong length) is a
  // changePubKey permission that can never match an honest call — a perps route
  // that looks granted and can never register its key, found out only after
  // the owner has signed and deposited. Throwing beats sealing it.
  //
  // THE INDEX MUST BE THE ROUTE'S, not merely in range. GRANT_PERP_LIGHTER
  // names LIGHTER_ROUTE_V1 forever, including its key index, and `grantPerp`
  // refuses any other — so a wall pinned to another index is a signature whose
  // marker the worker will never honour, and an index in Lighter's reserved set
  // would register the agent's key over the owner's own Robinhood Wallet
  // session. Neither is a choice a signer gets to make.
  //
  // The message never echoes the value: this is the one option a caller could
  // plausibly fill with the wrong half of a key pair.
  let perp: { keyIndex: number; words: readonly [`0x${string}`, `0x${string}`] } | undefined;
  if (opts.perpLighter != null) {
    const { apiKeyIndex, apiPublicKey } = opts.perpLighter;
    if (apiKeyIndex !== LIGHTER_ROUTE_V1.apiKeyIndex) {
      throw new Error(
        `perpLighter.apiKeyIndex must be the route's key index ${LIGHTER_ROUTE_V1.apiKeyIndex}: ` +
          "perp-lighter-v1 names that index forever, and the worker refuses any other",
      );
    }
    const canonical = typeof apiPublicKey === "string" ? validatePerpPubKey(apiPublicKey) : null;
    if (canonical === null) {
      throw new Error(
        "perpLighter.apiPublicKey is not a canonical Lighter API public key (40 bytes, five little-endian " +
          "Goldilocks limbs each below p, not all zero) — refusing to seal a key the contract would reject",
      );
    }
    perp = { keyIndex: apiKeyIndex, words: pubKeyWords(canonical) };
  }
  // The Trencher vault joins the spender list rather than carrying its own
  // USDG approve — see `allowedSpenders` and `trencherPermissions` for why two
  // approves on one target made the whole wall uninstallable.
  //
  // `trencherAddresses` is the same validator `trencherPermissions` uses, so a
  // half-configured vault throws here exactly as it does there rather than
  // being silently dropped from the spender list while its call permissions
  // are built.
  const trencherVault = trencherAddresses(opts)?.vault;
  const spenders = allowedSpenders(trencherVault);
  // THE LIGHTER PROXY JOINS THE USDG APPROVE, AND ONLY THE USDG APPROVE.
  //
  // It must be nameable there: `deposit` pulls USDG from msg.sender with
  // safeTransferFrom (AdditionalZkLighter.sol), and a second USDG `approve`
  // permission scoped to the proxy alone would collide with this one on
  // Kernel's (target, selector) key — `AA23 reverted duplicate permissionHash`,
  // the Trencher failure (wall-duplicate-permission.test.ts).
  //
  // It must NOT join `spenders`. That list is the ONE_OF on every stock and
  // extra approve, which carry no amount condition: an uncapped allowance over
  // every stock, held by an upgradeable contract whose governance can skip its
  // notice period, is a licence nobody should sign for a venue that only ever
  // takes cash. Because the proxy pulls only from msg.sender, the allowance
  // this approve creates is spendable by no one but this account's own
  // `deposit` call below.
  //
  // A PERPS WALL NAMES NO SPOT SPENDER HERE (WallOptions.perpsOnly). The one
  // USDG approve is kept for the venue alone, so the allowance it can create is
  // never one a Spot spender could pull.
  const usdgSpenders: Address[] = [
    ...(opts.perpsOnly ? [] : spenders),
    ...(perp ? [LIGHTER_ROUTE_V1.proxy as Address] : []),
  ];
  const extras = usableExtraTokens(opts.extraTokens);
  // Every asset this signature may hold a leg in: USDG plus everything the
  // approve permissions below cover. This is what the swap router's tokenIn and
  // tokenOut are pinned to — same source, same call, so the approve set and
  // the swap set cannot drift apart within one grant.
  const swapAssets: Address[] = [
    CASH.USDT as Address,
    ...tradeableStockAddresses(),
    ...extras.map((t) => t.address as Address),
  ];
  // ── WHO MAY BE APPROVED FOR WHAT (WallOptions.scopedSpenders) ─────────────
  //
  // Unscoped, every approve below names every spender. Scoped, each token's
  // approve names only the contracts that can pull THAT token: the Trencher
  // vault pulls USDG and nothing else (TrencherVault's `cash` is immutable), so
  // it stays on the USDG approve only.
  // Filtered from `spenders` rather than rebuilt, so the order — and with it
  // the encoded bytes of every entry that remains — is the one the unscoped
  // wall already uses.
  const coinSpenders =
    opts.scopedSpenders === true
      ? spenders.filter((s) => s.toLowerCase() !== trencherVault?.toLowerCase())
      : spenders;
  const self = { condition: ParamCondition.EQUAL, value: smartAccount } as const;
  // Deduped and lowercased so a list with the same address twice doesn't bloat
  // the on-chain policy, and a case difference can't read as a second address.
  const withdrawals = [
    ...new Set((opts.withdrawalAddresses ?? []).map((a) => a.toLowerCase() as Address)),
  ];

  const permissions = [
    ...trencherPermissions(opts, smartAccount, usdgUnits(caps.perTradeUsdg)),
    {
      // approve USDG, only to the allowed spenders, only up to one trade's size.
      // `usdgSpenders`, not `spenders`: the Lighter proxy, when sealed, is
      // named HERE and nowhere else — see above.
      target: CASH.USDT as Address,
      valueLimit: 0n,
      abi: erc20Abi,
      functionName: "approve",
      args: [
        { condition: ParamCondition.ONE_OF, value: usdgSpenders },
        { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: usdgUnits(caps.perTradeUsdg) },
      ],
    },
    // approve the TRADEABLE stock tokens so the agent can SELL what it may buy.
    // No amount condition: share counts are 18dp and not comparable to a USDG
    // cap, and a router can only pull what was approved — while the USDG cap
    // above already bounds what could ever have been bought.
    ...STOCK_TOKENS.filter((t) => (TRADEABLE_SYMBOLS as readonly string[]).includes(t.symbol)).map(
      (t) =>
        ({
          target: t.address as Address,
          valueLimit: 0n,
          abi: erc20Abi,
          functionName: "approve",
          args: [{ condition: ParamCondition.ONE_OF, value: coinSpenders }, null],
        }) as const,
    ),
    // Owner-added tokens, same shape and same routers. Present ONLY because the
    // owner listed them and is signing this grant right now — which is precisely
    // why the wall cannot widen by itself.
    ...extras.map(
      (t) =>
        ({
          target: t.address as Address,
          valueLimit: 0n,
          abi: erc20Abi,
          functionName: "approve",
          args: [{ condition: ParamCondition.ONE_OF, value: coinSpenders }, null],
        }) as const,
    ),
    // USDG out of the wall — ONLY to addresses the owner registered, and only
    // one trade's worth per call. Absent entirely when the list is empty, which
    // is the default: no registered destination, no power to send.
    //
    // The recipient used to be free-form, leaving the per-call amount as the
    // only on-chain bound — and since the daily USDG cap lives off-chain in the
    // worker, a compromised worker's real ceiling was perTradeUsdg ×
    // maxOpsPerDay per day, every day, until expiry.
    ...(withdrawals.length > 0
      ? [
          {
            target: CASH.USDT as Address,
            valueLimit: 0n,
            abi: erc20Abi,
            functionName: "transfer",
            args: [
              { condition: ParamCondition.ONE_OF, value: withdrawals },
              { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: usdgUnits(caps.perTradeUsdg) },
            ],
          } as const,
        ]
      : []),
    {
      // Uniswap SwapRouter02: exactInputSingle only, AND the output must land
      // in the agent's own account.
      //
      // Without the recipient pin, the approve cap above bounds only how much
      // can be spent per call — not who receives the proceeds. A compromised
      // agent could swap USDG for a token and direct the output anywhere, over
      // and over, up to the daily cap. "Bounded by the approve cap" was true
      // and beside the point: the money still left.
      //
      // WHY THE ARGS ARRAY IS SEVEN LONG FOR A ONE-PARAMETER FUNCTION. The
      // call policy maps args[i] to calldata offset i*32 (see
      // @zerodev/permissions callPolicyUtils getPermissionFromABI) — a FLAT
      // positional mapping with no ABI arity check. ExactInputSingleParams is
      // a tuple of seven STATIC members, so the ABI encoder lays it out inline
      // as seven consecutive words rather than behind a pointer. Index 3 is
      // therefore exactly `recipient`.
      //
      // That alignment is real but fragile: it depends on the tuple staying
      // all-static and the member order not moving. wall.test.ts proves the
      // offset against viem's own encoder rather than against this reasoning —
      // if SwapRouter02's struct ever changes, that test fails loudly instead
      // of the policy quietly constraining the wrong word.
      //
      // BOTH TOKEN LEGS ARE PINNED, and the recipient pin alone was not enough.
      // With `tokenOut` open, a stolen session key needed two calls and one
      // UserOp: approve the router for a stock (the amount is deliberately
      // uncapped — share counts are 18dp and not comparable to a USDG cap),
      // then `exactInputSingle{tokenIn: STOCK, tokenOut: <token the attacker
      // minted>, amountIn: the whole balance, amountOutMinimum: 0}`. The
      // recipient pin is satisfied: the account duly RECEIVES the worthless
      // token. The stocks left via the pool, so the ops-per-day cap never
      // bites — one op is enough to convert the entire non-cash book.
      //
      // The ONE_OF pin on both legs closes it. Same list as the approve
      // permissions above — `swapAssets` — so the set a key may APPROVE and the
      // set it may SWAP INTO cannot drift apart within a grant.
      //
      // Cost: one bytes32 per allowed address per rule, so two legs over the
      // default 15-address list is ~960 bytes of extra enable-data, paid once
      // on the first UserOp of each session key.
      target: PANCAKESWAP.smartRouter as Address,
      valueLimit: 0n,
      abi: UNISWAP_SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        { condition: ParamCondition.ONE_OF, value: swapAssets },
        { condition: ParamCondition.ONE_OF, value: swapAssets },
        null,
        self,
        null,
        null,
        null,
      ],
    },
    // MULTI-HOP (`exactInput`) IS GONE, and it cannot come back in this shape.
    //
    // It used to sit here with `args: [null, null, self]` — the recipient
    // pinned at word 2, everything else open. The comment defending it argued
    // that a longer path "buys a worse price, not somebody else's tokens",
    // which was true only while its single-hop sibling was equally open. Now
    // that `exactInputSingle` pins both token legs, this permission is the
    // loosest door in the wall: the output token lives inside a packed `path`
    // and can be anything at all.
    //
    // AND THE PATH CANNOT BE CONSTRAINED. `SLICE_EQUAL` is the only condition
    // in the library aimed at dynamic bytes, and it is unavailable twice over:
    // it requires CallPolicyVersion V0_0_5 while this wall pins V0_0_4, and
    // even there it resolves the argument type from the ABI, where
    // ExactInputParams is a `tuple` and never a `bytes`. A fixed-offset rule
    // cannot help either — the path is `token(20) ‖ fee(3) ‖ token(20) …`, so
    // the output token straddles two words and its word index MOVES with the
    // hop count. There is no word that equals a token address.
    //
    // WHAT THIS COSTS, said plainly: roughly three quarters of this chain's
    // pools quote against WETH, so any token with no direct USDG pair becomes
    // unreachable. That is a real loss of reach and it is the honest trade —
    // the alternative is shipping a hole that cannot be closed. The way back is
    // an adapter with static args, not this.
    // ── PERPETUALS ON LIGHTER, when the signer sealed them ───────────────
    //
    // Three permissions on the ZkLighter proxy of LIGHTER_ROUTE_V1, plus the
    // proxy's place in the USDG approve above — the four sealed things of
    // docs/perps.md rule 3, and nothing else. Distinct selectors on one target,
    // so Kernel's (target, selector) key never collides
    // (wall-duplicate-permission.test.ts).
    //
    // WHAT IS NOT HERE, on purpose: the proxy's on-chain `withdraw`,
    // `createOrder` and `cancelAllOrders`. They are the OWNER's escape hatches
    // (LIGHTER_OWNER_RECOVER_ABI, driven by `recover` with the owner key); a
    // session key holding `cancelAllOrders` could strip the venue stops rule 7
    // depends on, and on-chain `createOrder`'s semantics on this instance are
    // unproven. Everything the agent does at the venue it does with the API
    // key, over Lighter's L2 — which this wall does not and cannot bound.
    //
    // WHAT A STOLEN SESSION KEY GAINS, said plainly and once for all three:
    //   - It can move up to perTradeUsdg of USDG per call into THIS account's
    //     own Lighter account, and repeat it: a UserOp can batch approve +
    //     deposit, and there is no on-chain rate limit on 4663. So the whole
    //     USDG balance can be put on Lighter — the per-trade cap bounds a call,
    //     not a day, and the Settings collateral cap is software an attacker
    //     does not run. No deposit can credit anyone else's account.
    //   - Once there, the money is exactly as safe as the Lighter API key, and
    //     that key can lose it to a counterparty (trading against an account
    //     it controls, parking it in sub-accounts, minting pool shares).
    //     Anyone holding this grant holds both keys — they live side by side —
    //     so rule 4's worst case is theirs. That does not exceed what the same
    //     grant can already lose through open-fee swaps into attacker pools.
    //   - It can (re-)register the SEALED key at the route's index at any time
    //     until expiry, including after the owner rotated it away with
    //     `recover`. Rotation lasts only while nobody holding this grant undoes
    //     it; recover's session-revoking leg is what closes that.
    //   - It can make the proxy pay this account what it is already owed.
    // It cannot register any other key, withdraw on-chain, deposit for another
    // address or asset, move native value, or cancel a stop.
    //
    // PINNED VALUES ARE BIGINT OR FULL-WORD HEX, never decimal strings: the
    // library encodes a non-hex value with `toHex` and LEFT-pads anything
    // shorter than 32 bytes, so a decimal string or a short hex pins a word the
    // encoder never produces — a permission that matches nothing and reads as
    // strict.
    ...(perp
      ? [
          {
            // deposit(_to, _assetIndex, _routeType, _amount) — ALL FOUR WORDS
            // PINNED. Static arguments, one word each (`_routeType` is a
            // Solidity enum, encoded uint8), proven against viem's encoder in
            // wall.test.ts.
            //
            //   w0 _to — THIS account. The Lighter account is keyed on `_to`
            //        and the proxy credits it whoever paid (registerDeposit), so
            //        unpinned this is a USDG transfer to any stranger's venue
            //        account wearing a deposit's clothes, on a venue with no
            //        withdraw-to-owner rule.
            //   w1 _assetIndex — 3, USDG: the only asset the account approves
            //        this proxy for, pinned so the permission says so rather
            //        than leaning on that.
            //   w2 _routeType — 0, perps. Route 1 is Lighter's spot book, which
            //        nothing in agentcap reads, books or unwinds.
            //   w3 _amount — ≤ perTradeUsdg, the same cap the approve carries.
            //        Redundant under that approve today; pinned because a
            //        future change to the approve must not silently uncap the
            //        one call that moves money off-chain.
            //
            // `valueLimit: 0n` IS LOAD-BEARING: `deposit` is payable, and native
            // ETH deposits share this entry point.
            target: LIGHTER_ROUTE_V1.proxy as Address,
            valueLimit: 0n,
            abi: LIGHTER_DEPOSIT_ABI,
            functionName: "deposit",
            args: [
              self, // w0 _to — this account's own Lighter account
              { condition: ParamCondition.EQUAL, value: BigInt(LIGHTER_ROUTE_V1.assetIndex) }, // w1 USDG (3)
              { condition: ParamCondition.EQUAL, value: BigInt(LIGHTER_ROUTE_V1.routePerps) }, // w2 perps (0)
              { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: usdgUnits(caps.perTradeUsdg) }, // w3 _amount
            ],
          } as const,
          {
            // changePubKey(_accountIndex, _apiKeyIndex, _pubKey) — ONE key, at
            // ONE index, and nothing else. Authenticated on-chain only by
            // msg.sender being the account's L1 address, which is why a Kernel
            // can call it with no EIP-191/1271 signature (and why the wall's
            // NOT_FOR_VALIDATE_SIG costs perps nothing).
            //
            // `bytes` is dynamic, so SIX args for three parameters: the call
            // policy maps args[i] to offset i*32 with no arity check.
            //
            //   w0 _accountIndex — OPEN, BY NECESSITY. The index does not exist
            //        at signing: the first deposit creates the account and the
            //        sequencer numbers it. Lighter's GitHub has a NIL "my own
            //        account" shortcut that would make this pinnable; it is not
            //        deployed on 4663. The contract lets a registered L1 owner
            //        name any index and leaves the check to the circuit, so the
            //        only reachable effect of another w0 is a request to put the
            //        SEALED key on an account this address does not own, which
            //        the circuit rejects. (A dirty uint48 reverts in the ABI
            //        decoder — measured by eth_call on 4663.)
            //   w1 _apiKeyIndex — the route's index (16), never one Lighter
            //        reserves for its own apps and never 255.
            //   w2 offset of _pubKey — 0x60, straight after the three head
            //        words. LOAD-BEARING: the deployed decoder follows this
            //        word, so without it the calldata could point `_pubKey` at
            //        bytes past w5 while w3..w5 still hold the sealed words —
            //        and register any key at all. Measured: a relocated 0x80
            //        call with another key succeeds on 4663 under eth_call; only
            //        this pin refuses it.
            //   w3 _pubKey.length — 40, so the decoder reads exactly w4 and
            //        the first eight bytes of w5.
            //   w4 pk[0:32] and w5 pk[32:40] ++ 24 zero bytes — the exact key,
            //        from `pubKeyWords`, the one function the worker's final
            //        fence uses too. w5 is RIGHT-padded because that is how ABI
            //        `bytes` pads; the dirty-padding case is refused because
            //        EQUAL compares the whole word.
            //
            // Trailing calldata is admitted — no pin reads past w5 — and
            // harmless: the decoder takes 40 bytes from 0x60 and ignores it, so
            // it still registers the sealed key (wall.test.ts proves it).
            target: LIGHTER_ROUTE_V1.proxy as Address,
            valueLimit: 0n,
            abi: LIGHTER_CHANGE_PUBKEY_ABI,
            functionName: "changePubKey",
            args: [
              null, // w0 _accountIndex — unknown at signing, see above
              { condition: ParamCondition.EQUAL, value: BigInt(perp.keyIndex) }, // w1 the route's key index
              { condition: ParamCondition.EQUAL, value: 0x60n }, // w2 offset of _pubKey — WHERE the key is read
              { condition: ParamCondition.EQUAL, value: 40n }, // w3 _pubKey.length
              { condition: ParamCondition.EQUAL, value: perp.words[0] }, // w4 pk[0:32]
              { condition: ParamCondition.EQUAL, value: perp.words[1] }, // w5 pk[32:40], right-padded
            ],
          } as const,
          {
            // withdrawPendingBalance(_owner, _assetIndex, _baseAmount) — the
            // claim that ends a secure withdrawal. Anyone may call it and it
            // always pays `_owner` (ZkLighter.sol), so with `_owner` pinned to
            // this account the only reachable effect is paying this account
            // what the venue already owes it. Lighter's relayer usually claims
            // first; this is the liveness fallback, and a claim for more than
            // is pending, or zero, reverts.
            //
            //   w0 _owner — THIS account.
            //   w1 _assetIndex — 3, the one asset this route moves.
            //   w2 _baseAmount — OPEN: money coming home is not a risk the wall
            //        needs to bound, and the
            //        pending figure is only known at claim time.
            target: LIGHTER_ROUTE_V1.proxy as Address,
            valueLimit: 0n,
            abi: LIGHTER_WITHDRAW_PENDING_ABI,
            functionName: "withdrawPendingBalance",
            args: [
              self, // w0 _owner — pays this account and no other
              { condition: ParamCondition.EQUAL, value: BigInt(LIGHTER_ROUTE_V1.assetIndex) }, // w1 USDG (3)
              null, // w2 _baseAmount — whatever is pending
            ],
          } as const,
        ]
      : []),
  ];
  if (!opts.perpsOnly) return permissions;
  // A PERPS WALLET KEEPS THE PERP ROUTE AND NOTHING ELSE
  // (WallOptions.perpsOnly). A filter over the Spot list rather than a second
  // list, so a kept permission is the very object Spot would seal for that
  // route: its recipient pins, its key words and its per-call cap included.
  //
  // By TARGET, and USDG by selector too: the USDG `transfer` to a registered
  // withdrawal address shares the approve's target and must not ride along.
  // The approve itself survives only when it names someone (`usdgSpenders`,
  // already stripped of every Spot spender above); with no perp block there is
  // nobody to name, and the wall is empty.
  return permissions.filter((permission) => {
    const target = permission.target.toLowerCase();
    if (target === CASH.USDT.toLowerCase()) return permission.functionName === "approve" && usdgSpenders.length > 0;
    return perp !== undefined && target === LIGHTER_ROUTE_V1.proxy.toLowerCase();
  });
}

/**
 * The complete policy set for a grant: expiry, rate limit, and the call policy.
 *
 * `now` is injectable so a test can assert the timestamps rather than racing the
 * clock. Callers should leave it alone.
 */
export function buildWallPolicies(args: {
  caps: GrantCaps;
  /** The agent's own account — see buildCallPermissions. Required, never defaulted. */
  smartAccount: Address;
  now?: number;
} & WallOptions) {
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const expiresAt = now + args.caps.expiryDays * 86_400;

  const policies = [
    // Hard expiry — the key dies even if every other control fails.
    toTimestampPolicy({ validAfter: now, validUntil: expiresAt }),
    // THE RATE LIMIT POLICY IS GONE, because it was never there.
    //
    // `toRateLimitPolicy({count: maxOpsPerDay, interval: 86_400})` used to sit
    // on this line. Its `policyAddress` defaults to RATE_LIMIT_POLICY_CONTRACT
    // in @zerodev/permissions — and that address has NO CODE on Robinhood
    // Chain. Measured 2026-08-30 with eth_getCode against both live RPCs:
    //
    //   RateLimitPolicy  0xf63d4139B25c836334edD76641356c6b74C86873   0 bytes on 4663 AND 46630
    //   TimestampPolicy  0xB9f8f524bE6EcD8C945b1b87f9ae5C192FdCE20F   1,441 bytes
    //   CallPolicy V4    0x9a52283276A0ec8740DF50bF01B28A80D880eaf2   6,539 bytes
    //   ECDSA signer     0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF   1,609 bytes
    //
    // So every grant this repo could produce installed a policy pointing at an
    // empty address. Kernel calls `checkUserOpPolicy` expecting a uint256; a
    // call to a codeless address succeeds with zero returndata. That is not
    // "ops go unlimited" — it is most likely EVERY UserOp failing validation,
    // which is consistent with this project never having landed a trade.
    //
    // A policy that cannot execute is not a bound. Leaving it in traded a
    // guarantee we did not have for a failure mode we could not diagnose.
    //
    // SAY THE COST OUT LOUD. maxOpsPerDay is now enforced by the WORKER only,
    // alongside the daily total and the drawdown breaker. The on-chain ceiling
    // is per-trade × (however many ops fit before expiry) — see the header.
    //
    // And it was never the cap it was described as, even where the contract IS
    // deployed: RateLimitPolicy decrements a LIFETIME counter and returns
    // packValidationData(startAt); this call never passed `startAt`, so it
    // defaulted to 0 and imposed no spacing at all. It was maxOpsPerDay ops
    // TOTAL per grant, with no daily refill — not "48 a day".
    //
    // The fix that would restore a real on-chain bound is to deploy the policy
    // singleton to 4663 ourselves and pass `policyAddress`. That is a contract
    // deployment and it is deliberately not bundled with this correction.
    toCallPolicy({
      policyVersion: CallPolicyVersion.V0_0_4,
      // EVERY option must be forwarded, and the type system will not tell you:
      // this function's argument is an intersection with WallOptions, so a field
      // is accepted at the call site and can be silently dropped one line later.
      // The result would be a signature carrying a feature marker over a call
      // policy without the permission behind it — a mirror looser than the chain
      // is the one shape this file exists to prevent.
      permissions: buildCallPermissions(args.caps, args.smartAccount, {
        // And the one that narrows, which is no less a trap to drop: a Perps
        // grant would be signed over the Spot wall, the stock approvals and
        // the swap routes included, at the Perps wallet's address.
        perpsOnly: args.perpsOnly,
        extraTokens: args.extraTokens,
        withdrawalAddresses: args.withdrawalAddresses,
        trencherVaultAddress: args.trencherVaultAddress,
        trencherFactoryAddress: args.trencherFactoryAddress,
        // And one that, missed, is just as bad: a signer that sized the SCOPED
        // wall (wallSignable over buildCallPermissions) and minted
        // GRANT_SCOPED_SPENDERS would have signed the unscoped one here — the
        // wall it had just refused as too large to install.
        scopedSpenders: args.scopedSpenders,
        // And where the miss would be worst of all: a grant carrying
        // `perp-lighter-v1` and a sealed key over a wall with no deposit, no
        // key registration and no proxy in the USDG approve. The worker would
        // plan an onboarding the chain refuses at its first step — or, after a
        // re-sign, leave a funded venue account with no claim path home.
        perpLighter: args.perpLighter,
      }) as never,
    }),
  ];

  return { policies, now, expiresAt };
}

/**
 * THE WALL A STORED GRANT DESCRIBES — one rebuild, two callers.
 *
 * The signer knows its wall because it is about to build it. The executor holds
 * only the SERIALIZED account, and `buildWallPolicies` says plainly why that is
 * no help: "the ZeroDev Policy objects are opaque once constructed". So the
 * executor rebuilds the wall from the same inputs the signature was made over,
 * and both sides size the first operation from the same object.
 *
 * That shared rebuild is the whole point. The product minted grants whose first
 * UserOp the executor was already designed to refuse, because signing had no
 * idea the executor's ceiling existed. Two descriptions of one wall is how that
 * happened; this is the one description.
 *
 * PLACEHOLDER TOKENS, DELIBERATELY. `grantTokens` records the ADDRESSES this
 * grant's policy covers, while `usableExtraTokens` wants whole `CustomToken`
 * objects. Only the COUNT reaches the shape — each extra adds one approve
 * permission and one entry to each list it appears in — so well-formed
 * placeholders reproduce the size exactly. Using the symbols would be no more
 * accurate and would need a second source that can disagree.
 *
 * AND `grantTokens`, NOT `settings.customTokens`. The grant records what its
 * policy actually covers; settings record what the owner has typed since. They
 * differ exactly when someone added a token without re-signing — and sizing a
 * wall from the larger list would refuse a wall that is genuinely small.
 *
 * `perpLighter` FROM `grantPerp(grant)`, AND ONLY FROM IT. The marker is not
 * the whole permission — the wall pins the sealed API
 * public key — so the rebuild needs the grant's `perp` block and its chain as
 * well, and takes them through the one reader the worker trusts: marker,
 * chain 4663, route, the route's key index and a canonical key, all or
 * nothing. A grant missing any of them rebuilds WITHOUT perps, which is the
 * narrower wall; server-side that fails the byte comparison against a
 * signature that carried them, which is the refusal a half-formed perp grant
 * deserves. Both fields are optional so a caller that passes neither rebuilds
 * exactly the wall it always did; the hosted canonical check passes both. The
 * sealed private key never enters this object.
 *
 * `perpsOnly` FROM THE SIGNED PURPOSE (`grantPurpose`), and only when it is
 * "perps". Absent is Spot, so every grant signed before Perps rebuilds the wall
 * it always did, key for key; a purpose that names no wallet THROWS rather
 * than rebuilding as Spot, the refusal `grantPurpose` gives everywhere else.
 * A Perps purpose is bound into the owner's signed claim (bindingMessage).
 */
export function grantWallOptions(grant: {
  purpose?: unknown;
  grantTokens?: readonly string[];
  grantFeatures?: readonly string[];
  chainId?: number;
  perp?: unknown;
}): WallOptions {
  const features = new Set((grant.grantFeatures ?? []).map((f) => String(f).toLowerCase()));
  const extraTokens: CustomToken[] = (grant.grantTokens ?? [])
    .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(String(a)))
    .map((address, i) => ({ symbol: `X${i}`, address: String(address) as `0x${string}`, decimals: 18 }));
  const perp =
    typeof grant.chainId === "number"
      ? grantPerp({ grantFeatures: grant.grantFeatures, chainId: grant.chainId, perp: grant.perp })
      : null;
  return {
    // Present only for a Perps grant, so a Spot grant yields an options object
    // with exactly the keys it always had.
    ...(grantPurpose(grant) === "perps" ? { perpsOnly: true } : {}),
    extraTokens,
    scopedSpenders: features.has(GRANT_SCOPED_SPENDERS),
    // Present only when granted, so a grant without perps yields an options
    // object with exactly the keys it always had.
    ...(perp ? { perpLighter: { apiKeyIndex: perp.apiKeyIndex, apiPublicKey: perp.apiPublicKey } } : {}),
  };
}

/**
 * A canonical key used ONLY to size a wall before a real key exists: every
 * limb is 1 (little-endian), which is below p and not all zero. Never returned,
 * never sealed — `perpFits` answers a boolean and nothing else leaves it.
 *
 * Sound because the SIZE of the perp permissions does not depend on the key's
 * bytes: w4 and w5 are one EQUAL rule each whatever they hold (wallShape
 * counts rules and parameters, not values). first-enable-gas.test.ts pins that
 * the answer is the same with a real key.
 */
const PERP_SIZING_KEY = `0x${"0100000000000000".repeat(5)}` as `0x${string}`;

/**
 * SHOULD THIS SIGNATURE CARRY PERPS? Asked by the signers before they sign, and
 * the only door besides `grantWallOptions` through which `WallOptions.perpLighter`
 * should be set.
 *
 * Two conditions, both about safety rather than preference:
 *
 *   - CHAIN 4663 ONLY. The proxy is a mainnet deployment and there is no
 *     Lighter on testnet 46630; elsewhere a CALL to it succeeds with empty
 *     returndata and a deposit would "land" having posted nothing.
 *     (`grantPerp` refuses the marker off 4663 as well.)
 *   - ONLY WHEN THE WALL STILL FITS. Three permissions, eleven EQUAL/LTE rules
 *     and one spender entry: 2,816 stub bytes, about 2.5M bounded first-enable
 *     gas.
 *
 * `false` IS NEVER A SILENT DROP. Perps that do not fit are REFUSED when the
 * previous grant carried them — a registered key outlives any grant, so
 * silently signing without the block would leave a live venue account with no
 * key (docs/perps.md rule 3, rule 5).
 *
 * THE SAME POLICY, NOT A COPY OF IT: `wallSignable` over `wallShape` over the
 * real `buildCallPermissions`, with the caller's own options — so a caller that
 * passes its real key gets the key validated too (a non-canonical key throws
 * here exactly as it would at signing). A caller asking before any key exists
 * (so that no venue key is minted for a wall that cannot hold it) is sized with
 * PERP_SIZING_KEY, which costs the same bytes.
 */
export function perpFits(
  caps: GrantCaps,
  smartAccount: Address,
  chainId: number,
  deploying: boolean,
  opts: WallOptions,
): boolean {
  if (chainId !== LIGHTER_ROUTE_V1.chainId) return false;
  const perpLighter = opts.perpLighter ?? { apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: PERP_SIZING_KEY };
  return wallSignable(wallShape(buildCallPermissions(caps, smartAccount, { ...opts, perpLighter })), {
    deploying,
  }).ok;
}
