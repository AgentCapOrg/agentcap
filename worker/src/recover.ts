/**
 * Fund recovery — sweep an agent's smart account back to a wallet you control,
 * signed by the OWNER key (the account's sudo validator), NOT the session key.
 *
 * Why this exists: the address you funded is an ERC-4337 (ZeroDev Kernel) smart
 * account — a counterfactual contract, not a plain EOA. Its owner private key
 * derives a DIFFERENT address, so importing that key into MetaMask shows an
 * empty wallet while the funds sit in the smart account. And after a kill switch
 * the session key is gone. The one thing that always works: rebuild the account
 * from the owner key as the sudo signer and have IT move the money out.
 *
 * The sudo validator has no session-key policies attached, so recovery is not
 * bound by the per-trade / daily caps — it can move the whole balance in one op.
 * The account pays its own gas from its native ETH (no paymaster), exactly like
 * the trading executor. Nothing here transmits the key: it signs one UserOp
 * locally and only the signed op reaches the bundler.
 */

import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  parseAbi,
  type Address,
  type Chain,
} from "viem";
import { privateKeyToAccount, toAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk";
import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { accountIndexForPurpose, type GrantPurpose, assertDerivedAccount } from "../../packages/core/src/index";
import { CASH, STOCK_TOKENS, CASH_DECIMALS, isValidCustomToken, shortAddress } from "../../packages/core/src/index";
import { userOpGasConfig } from "./gas";
import { errorText } from "./redact-urls";

export interface TokenBalance {
  symbol: string;
  address: Address;
  raw: bigint;
  decimals: number;
  /**
   * Human-readable amount, for display only. "unknown" when the holding is
   * real but not expressible — see the vault leg, where the share count is
   * meaningless and the USDG value could not be read. "<n> raw units" when the
   * count is exact but the token will not state its decimals.
   */
  amount: string;
  /** Extra context for the owner when the number needs it. */
  note?: string;
}

export interface RecoverPlan {
  smartAccount: Address;
  ownerAddress: Address;
  /** Every token the account holds with a non-zero balance. */
  balances: TokenBalance[];
  gasWei: bigint;
  /**
   * What the ETH leg WOULD move, and what would stay to pay for the move.
   *
   * A forecast, from the same `nativeSweep` the sweep itself uses — so the
   * confirmation can name the ETH instead of listing only the tokens. Zero
   * recoverable when the gas price could not be read, which also puts
   * "gas price" in `unreadable`: a disclosure must not promise ETH it cannot
   * price. The settled figures are `nativeSweptWei` on the result.
   */
  nativeRecoverableWei: bigint;
  nativeReserveWei: bigint;
  /**
   * What could not be READ — distinct from what is not held.
   *
   * A recovery that reports "this account is empty" because an RPC blinked is
   * how someone concludes their money is gone. Absence and ignorance are
   * different facts and this is where they are kept apart; `unreadable` being
   * non-empty means the plan is incomplete, not that the account is.
   */
  unreadable: string[];
}

export interface RecoverResult extends RecoverPlan {
  /** null when there was nothing to sweep. */
  txHash: `0x${string}` | null;
  to: Address;
  /** Held, but left behind — with the reason. Never silent. */
  skipped: { symbol: string; reason: string }[];
  /**
   * Native ETH actually swept, in wei. Reported separately from `balances`
   * because it is not a token transfer and cannot be swept in full — the
   * account pays this very operation's gas out of the same balance, so a
   * reserve stays behind on purpose.
   */
  nativeSweptWei: bigint;
  /** What was deliberately left to cover gas, in wei. */
  nativeReservedWei: bigint;
}

/** What EVERY agent can hold without the owner configuring anything. */
interface SweepToken {
  symbol: string;
  address: Address;
  decimals: number;
  /**
   * True for an owner token known only by its ADDRESS, whose `decimals` is then
   * a placeholder. The transfer never reads it — it moves `raw` — but the amount
   * the owner confirms against does, so `planRecovery` reads the real figure on
   * chain rather than formatting at a number nothing established.
   */
  decimalsUnknown?: true;
}

const BUILTIN_SWEEPABLE: SweepToken[] = [
  { symbol: "USDG", address: CASH.USDT as Address, decimals: CASH_DECIMALS },
  ...STOCK_TOKENS.map((t) => ({ symbol: t.symbol, address: t.address as Address, decimals: 18 })),
];

/**
 * The builtin set for this chain plus whatever the owner added themselves.
 *
 * Recovery is the escape hatch, and it swept a list frozen at ship time — so
 * the exact tokens an owner chose, and every quarantined scout position (an
 * owner-added ERC-20 by definition), were stranded by the one command that
 * exists to get money out. The wall has nothing to do with it: this path signs
 * with the sudo validator and can move any ERC-20 the account holds.
 *
 * AN ADDRESS IS A TOKEN; A SYMBOL IS A LABEL. Same address as a row already
 * here → the same token, already swept, so it is skipped. Same SYMBOL at a
 * different address → a different token, and it is swept: dropping it would
 * strand the owner's money on the one path that exists to rescue it. What
 * symbol-dedupe was protecting still holds: no two rows carry the same label.
 * The first row keeps the bare symbol — builtins come first, so the curated
 * address always does — and a later one is labelled with its address, so the
 * confirmation never shows two identical-looking "AAPL" rows on the one screen
 * where the owner is agreeing to move real money.
 *
 * Shape is re-validated here rather than trusted, because a caller reads
 * settings.json off disk directly. That is also why the parameter is `unknown`
 * rather than CustomToken: isValidCustomToken is a type guard over unknown, and
 * demanding a typed value here would only push a cast onto callers holding data
 * they have not checked — which is how an unvalidated address reaches an atomic
 * sweep of someone's whole account.
 *
 * AN ADDRESS WITH NO NAME IS NOT MALFORMED. The browser and the phone recover
 * signed out, so the only token list they hold is the grant's `grantTokens` —
 * addresses, nothing else — and they pass each as `{ address, symbol: "" }`.
 * isValidCustomToken refuses an empty symbol, which is right for settings,
 * where a ticker is required; here it silently dropped every owner-added token
 * from those sweeps and left it in the account. So an address-only entry is
 * accepted, with its address checked exactly as strictly as any other.
 *
 * It is labelled BY ADDRESS, never by a symbol read off the token: a contract
 * chooses its own `symbol()`, so a name the owner never typed — "USDG", say —
 * would lend a stranger's token the look of a curated one on the screen where
 * they agree to move money. A short address cannot collide with a ticker (the
 * `…` is outside the ticker alphabet); if two share one, the later gets its
 * full address — the same last resort a named collision takes.
 */
export function sweepList(extra: readonly unknown[] = []): SweepToken[] {
  const out = [...BUILTIN_SWEEPABLE];
  const floor = out.length;
  const addresses = new Set(out.map((t) => t.address.toLowerCase()));
  const labels = new Set(out.map((t) => t.symbol.toUpperCase()));
  for (const t of extra) {
    const named = isValidCustomToken(t);
    if (!named && !isAddressOnly(t)) continue;
    const addr = t.address.toLowerCase();
    if (addresses.has(addr)) continue;
    // A shortened address can itself repeat; the full one cannot.
    const short = shortAddress(addr);
    const candidates = named ? [t.symbol, `${t.symbol} (${short})`, `${t.symbol} (${addr})`] : [short, addr];
    const symbol = candidates.find((c) => !labels.has(c.toUpperCase())) ?? candidates[candidates.length - 1]!;
    addresses.add(addr);
    labels.add(symbol.toUpperCase());
    out.push(
      named
        ? { symbol, address: t.address as Address, decimals: t.decimals }
        : { symbol, address: t.address, decimals: 18, decimalsUnknown: true },
    );
    // The same ceiling settings.ts puts on customTokens. A recovery is one
    // atomic UserOp, and an unbounded call list is one that runs out of gas
    // and moves nothing at all.
    if (out.length >= floor + 50) break;
  }
  return out;
}

/** `{ address, symbol: "" }` (or no symbol at all), with a well-formed address. */
function isAddressOnly(t: unknown): t is { address: Address } {
  if (!t || typeof t !== "object") return false;
  const c = t as { symbol?: unknown; address?: unknown };
  return (
    (c.symbol === undefined || c.symbol === "") &&
    typeof c.address === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(c.address)
  );
}

export type BalanceOutcome =
  | { kind: "read"; raw: bigint }
  /** Nothing is deployed at that address here. An honest zero. */
  | { kind: "absent" }
  /** We could not find out. NOT a zero — see RecoverPlan.unreadable. */
  | { kind: "unreadable" };

/**
 * THREE OUTCOMES, NOT TWO, and the middle one is the whole point.
 *
 * The original code was `.catch(() => 0n)`, which made an RPC failure
 * indistinguishable from an empty wallet — and a recovery that says "this
 * account is empty" because the network blinked is how somebody concludes their
 * money is gone.
 *
 * But a plain two-way ok/failed split is just as wrong in the other direction.
 * recover-cli accepts chain 46630, where every address in the registry is an
 * undeployed MAINNET address, so every read fails — and a two-way split would
 * flag all twenty-seven as "could not be read, that is NOT a zero balance",
 * which is false, alarming, and unactionable about an account that really is
 * empty. So a failed read asks the chain whether anything is deployed there at
 * all.
 *
 * THE TRAP, and the reason this is injectable rather than inline: viem's
 * getCode returns `undefined` — not "0x" — for an address with no contract; it
 * normalises "0x" away. So writing the probe as `.catch(() => undefined)` makes
 * "nothing is deployed" and "the probe itself failed" the SAME VALUE, and the
 * three-way split silently collapses back into the two-way one. That is exactly
 * the bug this function was extracted to make testable, and recover.test.ts
 * covers all four paths.
 */
export async function classifyBalance(io: {
  balanceOf: () => Promise<bigint>;
  getCode: () => Promise<string | undefined>;
}): Promise<BalanceOutcome> {
  try {
    return { kind: "read", raw: await io.balanceOf() };
  } catch {
    const probe = await io.getCode().then(
      (code) => ({ reached: true as const, code }),
      () => ({ reached: false as const, code: undefined }),
    );
    if (!probe.reached) return { kind: "unreadable" }; // we could not even ask
    if (probe.code === undefined || probe.code === "0x") return { kind: "absent" };
    return { kind: "unreadable" }; // a contract IS there, but it would not answer
  }
}

/**
 * WHO AUTHORISES A RECOVERY — a signer, not a key.
 *
 * This module took a raw `ownerPrivateKey` because there was only one kind of
 * owner: a keypair generated in a browser or written to ~/.agentcap. A hosted
 * agent owned by a PRIVY EMBEDDED WALLET has no such key and never will — the
 * whole point of it — so those accounts were structurally unrecoverable by the
 * one path that exists to get money out. Measured 2026-09-12 on a funded
 * account holding 1,063,408.141815 DOGGOS.
 *
 * `web/src/lib/session.ts:199` already solved this for MINTING, with the same
 * shape and for the same reason; this is that seam reaching recovery.
 *
 * NOT AN EIP-1193 PROVIDER, and that is load-bearing rather than stylistic.
 * ZeroDev's `toSigner` resolves a provider's address with
 * `Promise.any([eth_requestAccounts, eth_accounts])` and takes [0] — whichever
 * RPC answers first. The owner address is the ONLY free variable in the Kernel
 * CREATE2 preimage, so that race would decide which account you derive, and on
 * a recovery path deriving the wrong account means signing a sweep of an empty
 * one while the real funds sit untouched. Privy's `toViemAccount({ wallet })`
 * returns a LocalAccount with a fixed address instead; `usePrivyOwner` already
 * does this and refuses rather than guessing.
 */
export type RecoveryOwner =
  /** A browser- or disk-held key. The existing CLI path. */
  | { kind: "private-key"; privateKey: `0x${string}` }
  /** A LocalAccount that signs without exposing a key — a Privy embedded wallet. */
  | { kind: "signer"; account: LocalAccount }
  /**
   * An ADDRESS ONLY, which can derive but never sign.
   *
   * This is what keeps the planner honest: reconstruction needs the owner's
   * address and nothing more, so a read-only caller can prove which account an
   * owner controls without holding anything capable of authorising a transfer.
   * `recoverFunds` refuses it before it touches a bundler.
   */
  | { kind: "address"; address: Address };

export const ownerFromPrivateKey = (privateKey: `0x${string}`): RecoveryOwner => ({
  kind: "private-key",
  privateKey,
});
export const ownerFromSigner = (account: LocalAccount): RecoveryOwner => ({ kind: "signer", account });
export const ownerFromAddress = (address: Address): RecoveryOwner => ({ kind: "address", address });

/**
 * The viem account the Kernel derivation reads its address from.
 *
 * For `address` the signing methods throw rather than returning something
 * plausible: derivation only ever reads `.address` (the validator's
 * `getEnableData` returns exactly that), so a stub is enough to reconstruct —
 * and anything that tries to SIGN with it must fail loudly rather than
 * silently produce a signature the owner never authorised.
 */
function ownerAccountOf(owner: RecoveryOwner): LocalAccount {
  if (owner.kind === "private-key") return privateKeyToAccount(owner.privateKey);
  if (owner.kind === "signer") return owner.account;
  const refuse = (): never => {
    throw new Error(
      "this recovery owner is address-only: it can reconstruct the account but cannot sign for it.",
    );
  };
  return toAccount({
    address: owner.address,
    signMessage: refuse,
    signTransaction: refuse,
    signTypedData: refuse,
  }) as LocalAccount;
}

/** The owner's address, for every kind — no signing capability required. */
export const ownerAddressOf = (owner: RecoveryOwner): Address =>
  owner.kind === "private-key"
    ? privateKeyToAccount(owner.privateKey).address
    : owner.kind === "signer"
      ? owner.account.address
      : owner.address;

/**
 * THE ONE PLACE THE KERNEL ACCOUNT IS RECONSTRUCTED.
 *
 * `planRecovery` and `recoverFunds` each built this independently with the same
 * three arguments. Identical today, and exactly the kind of duplication that
 * drifts: the plan would show one account's contents and the sweep would sign
 * for another, with nothing in between to notice. The address is a CREATE2
 * derivation whose preimage is (kernelVersion, entryPoint, validator, index,
 * owner address) — so a single differing argument silently produces a different,
 * empty account, and a recovery that "succeeds" having moved nothing.
 *
 * The purpose selects the same account index as wallet creation: Spot 0n,
 * Perps 1n. No address or factory override can redirect recovery.
 */
async function deriveKernelAccount(chain: Chain, rpcUrl: string | undefined, ownerAccount: LocalAccount, purpose: GrantPurpose) {
  const index = accountIndexForPurpose(purpose);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const entryPoint = getEntryPoint("0.7");
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: ownerAccount,
    entryPoint,
    kernelVersion: KERNEL_V3_3,
  });
  return createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo: ecdsaValidator },
    index,
  });
}

/**
 * Rebuild the smart account from the owner and read what it holds. Read-only
 * — no bundler, no signing. Use this to show the user what recovery will move
 * (and to verify the owner actually controls the expected account) before
 * they commit.
 *
 * SIGNER-INDEPENDENT: it reads the owner's ADDRESS and never asks it to sign,
 * so `ownerFromAddress` is a first-class way to call it.
 */
export async function planRecovery(opts: {
  purpose?: GrantPurpose;
  chain: Chain;
  owner: RecoveryOwner;
  rpcUrl?: string;
  /** If given, throw when the derived account doesn't match (wrong owner key). */
  expectedSmartAccount?: Address;
  /** Owner-added tokens from settings. Optional — the builtin set is the floor. */
  extraTokens?: readonly unknown[];
}): Promise<RecoverPlan> {
  const publicClient = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) });
  const ownerAccount = ownerAccountOf(opts.owner);
  const account = await deriveKernelAccount(opts.chain, opts.rpcUrl, ownerAccount, opts.purpose ?? "spot");

  // A sweep aimed at the zero address would be a signed transaction to nothing.
  assertDerivedAccount(account.address, "that owner does not derive an account");

  if (
    opts.expectedSmartAccount &&
    account.address.toLowerCase() !== opts.expectedSmartAccount.toLowerCase()
  ) {
    throw new Error(
      `this owner controls ${account.address}, not the expected ${opts.expectedSmartAccount}. ` +
        `Wrong owner, or the account was created with a different Kernel version.`,
    );
  }

  const tokens = sweepList(opts.extraTokens);
  const unreadable: string[] = [];

  // THREE OUTCOMES, NOT TWO. A read can succeed, or find no contract at that
  // address, or fail. Collapsing the last two into "unreadable" would be just
  // as wrong as the `.catch(() => 0n)` this replaces — recover-cli accepts
  // chain 46630, where every address in the registry is an undeployed mainnet
  // address, so a two-way split would flag all of them and tell the owner to
  // "rerun before you trust it" about an account that is genuinely empty.
  //
  // An EOA-style call to an address with no code returns 0x, which viem raises
  // as a zero-data error. So on failure, ask the chain whether anything is
  // deployed there: no code is an honest zero, code plus a failed read is an
  // honest unknown.
  const readBalance = async (address: Address, label: string): Promise<bigint | null> => {
    const outcome = await classifyBalance({
      balanceOf: () =>
        publicClient.readContract({
          address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account.address],
        }) as Promise<bigint>,
      getCode: () => publicClient.getCode({ address }),
    });
    if (outcome.kind === "read") return outcome.raw;
    if (outcome.kind === "absent") return 0n;
    unreadable.push(label);
    return null;
  };

  const [gas, ...raws] = await Promise.all([
    publicClient
      .getBalance({ address: account.address })
      .then((v) => v as bigint)
      .catch(() => {
        // The gas leg gets the same discipline as the tokens. It is printed to
        // the owner, and a fabricated 0.000000 ETH is what convinces someone
        // their recovery cannot possibly work.
        unreadable.push("eth");
        return null;
      }),
    ...tokens.map((t) => readBalance(t.address, t.symbol)),
  ]);

  const held = tokens
    .map((t, i) => ({ t, raw: raws[i] ?? null }))
    .filter((x): x is { t: (typeof tokens)[number]; raw: bigint } => x.raw !== null && x.raw > 0n);

  const balances: TokenBalance[] = await Promise.all(
    held.map(async ({ t, raw }) => {
      if (t.decimalsUnknown) {
        // ITS OWN DECIMALS, asked of the token, so the amount the owner confirms
        // is never a number we made up: an address-only entry used to carry a guessed
        // 18, and a 9-decimal memecoin formatted at 18 is shown to the owner a
        // billion times smaller than what they are agreeing to move. Bounded as
        // isValidCustomToken bounds a typed-in figure; outside that, or no
        // answer, the amount is the exact raw count rather than a guess.
        //
        // NOT `unreadable`. That list says a BALANCE could not be read, so the
        // plan may be missing money — and the phone refuses to start a
        // withdrawal while it is non-empty. Here the balance was read and the
        // token sweeps; only its display unit is missing, and letting that veto
        // the whole withdrawal would strand everything else over a cosmetic gap.
        const decimals = await publicClient
          .readContract({ address: t.address, abi: erc20Abi, functionName: "decimals" })
          .then((d) => Number(d))
          .catch(() => null);
        if (decimals !== null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36) {
          return { symbol: t.symbol, address: t.address, raw, decimals, amount: formatUnits(raw, decimals) };
        }
        return {
          symbol: t.symbol,
          address: t.address,
          raw,
          decimals: t.decimals,
          amount: `${raw} raw units`,
          note: "held, but the token would not state its decimals, so this is its raw count. It sweeps regardless.",
        };
      }
      return { symbol: t.symbol, address: t.address, raw, decimals: t.decimals, amount: formatUnits(raw, t.decimals) };
    }),
  );

  // ── HOW MUCH NATIVE ETH WOULD ACTUALLY LEAVE ────────────────────────────
  //
  // Forecast here so the CONFIRMATION can state it. The ETH leg moves on every
  // recovery — `recoverFunds` appends a bare value call — and a disclosure that
  // lists the tokens but not the ETH understates what the owner is agreeing to.
  //
  // THE SAME FUNCTION THE SWEEP USES, deliberately: `nativeSweep` is called
  // here and again at execution, so the number shown and the number sent come
  // from one rule rather than two that can drift. They are not guaranteed
  // IDENTICAL — the gas price is read twice and moves in between — which is
  // exactly why the wording is "approximately" and why this is named
  // `recoverable` rather than `swept`. `nativeSweptWei` on the RESULT is the
  // settled fact; these two are the estimate.
  //
  // A failed gas read forecasts ZERO recoverable rather than the whole balance:
  // over-promising on an exit is the direction that turns into a complaint.
  let nativeRecoverableWei = 0n;
  let nativeReserveWei = gas ?? 0n;
  try {
    const split = nativeSweep(gas ?? 0n, await publicClient.getGasPrice());
    nativeRecoverableWei = split.sweep;
    nativeReserveWei = split.reserve;
  } catch {
    unreadable.push("gas price");
  }

  return {
    smartAccount: account.address,
    ownerAddress: ownerAccount.address,
    balances,
    gasWei: gas ?? 0n,
    nativeRecoverableWei,
    nativeReserveWei,
    unreadable,
  };
}

/**
 * Sweep every non-zero token balance AND the account's native ETH to `to` in a
 * single owner-signed UserOp (the account deploys itself on this same op if it
 * never traded). Requires a bundler — a counterfactual smart account cannot
 * move funds any other way.
 *
 * ETH USED TO BE ABANDONED HERE, on the reasoning that it only pays for this
 * op's gas and the remainder is dust. That holds on testnet and is wrong the
 * moment anyone funds a real account: gas money on mainnet is money, and an
 * account funded with ETH and no tokens hit the empty-balances branch below and
 * was told "nothing to recover" while its whole balance sat there. Someone
 * following the fund instructions — which ask for ETH for gas — could be told
 * their funded account was empty.
 *
 * So the ETH goes too, minus a reserve for this operation's own gas. The reserve
 * is deliberately generous: reserving too much leaves a little behind, while
 * reserving too little makes the op unaffordable and moves NOTHING, tokens
 * included. One of those is a rounding error and the other strands the sweep,
 * so the bias is not a close call.
 */
/**
 * How much native ETH can leave, and how much must stay to pay for the move.
 *
 * Pure, because this is the arithmetic that decides whether the sweep happens at
 * all. Reserve too little and the operation cannot be paid for, so NOTHING
 * moves — the tokens included — and the account is left exactly as stuck as
 * before. Reserve too much and a few cents stay behind. Those are not
 * comparable failures, so the buffer is deliberately fat: a gas limit well above
 * what a handful of transfers costs, doubled.
 *
 * Returns a zero sweep when the balance does not clear the reserve, which is the
 * ordinary case for an account holding only gas money.
 */
export function nativeSweep(heldWei: bigint, gasPriceWei: bigint): { sweep: bigint; reserve: bigint } {
  const GAS_LIMIT_GUESS = 900_000n;
  const reserve = gasPriceWei * GAS_LIMIT_GUESS * 2n;
  if (heldWei <= reserve) return { sweep: 0n, reserve: heldWei };
  return { sweep: heldWei - reserve, reserve };
}

export async function recoverFunds(opts: {
  purpose?: GrantPurpose;
  chain: Chain;
  owner: RecoveryOwner;
  bundlerUrl: string;
  rpcUrl?: string;
  to: Address;
  expectedSmartAccount?: Address;
  extraTokens?: readonly unknown[];
}): Promise<RecoverResult> {
  // REFUSED BEFORE ANYTHING ELSE. An address-only owner can reconstruct the
  // account but cannot authorise a transfer, and finding that out at signing
  // time would mean having already read balances, priced gas and built calls
  // against money it was never entitled to move.
  if (opts.owner.kind === "address") {
    throw new Error(
      "recovery needs an owner that can sign: this one is address-only, which can reconstruct " +
        "the account but not authorise moving anything out of it.",
    );
  }
  const plan = await planRecovery({
    purpose: opts.purpose,
    chain: opts.chain,
    owner: opts.owner,
    rpcUrl: opts.rpcUrl,
    expectedSmartAccount: opts.expectedSmartAccount,
    extraTokens: opts.extraTokens,
  });

  const publicClient = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) });

  // ── how much native ETH can leave ────────────────────────────────────────
  // The account pays for this operation out of the same balance it is sending,
  // so a reserve has to stay. Size it from the live gas price against a gas
  // limit comfortably above what a handful of transfers costs, then double it.
  // If the estimate is short the op simply cannot be paid for and NOTHING
  // moves — tokens included — so the buffer is protecting the whole sweep, not
  // just the ETH leg.
  let { sweep: nativeSweptWei, reserve: nativeReservedWei } = { sweep: 0n, reserve: plan.gasWei };
  try {
    ({ sweep: nativeSweptWei, reserve: nativeReservedWei } = nativeSweep(
      plan.gasWei,
      await publicClient.getGasPrice(),
    ));
  } catch {
    // Couldn't price gas — take nothing rather than risk making the op
    // unaffordable. The tokens still move, which is the larger sum.
  }

  if (plan.balances.length === 0 && nativeSweptWei === 0n) {
    return { ...plan, txHash: null, to: opts.to, skipped: [], nativeSweptWei: 0n, nativeReservedWei };
  }
  const ownerAccount = ownerAccountOf(opts.owner);
  const account = await deriveKernelAccount(opts.chain, opts.rpcUrl, ownerAccount, opts.purpose ?? "spot");
  assertDerivedAccount(account.address, "that owner does not derive an account");
  // DERIVED TWICE, CHECKED TWICE. `planRecovery` already compared this against
  // `expectedSmartAccount`, but that was a different derivation a moment
  // earlier; re-asserting here means the account about to be SIGNED FOR is the
  // one the owner was shown, not merely one that matched once.
  if (
    opts.expectedSmartAccount &&
    account.address.toLowerCase() !== opts.expectedSmartAccount.toLowerCase()
  ) {
    throw new Error(
      `this owner controls ${account.address}, not the expected ${opts.expectedSmartAccount}. ` +
        "Refusing to sign a recovery for a different account.",
    );
  }
  const client = createKernelAccountClient({
    account,
    chain: opts.chain,
    bundlerTransport: http(opts.bundlerUrl),
    // See worker/src/gas.ts — required so recovery works with a Pimlico bundler.
    userOperation: userOpGasConfig(publicClient, opts.bundlerUrl),
  });

  // ONE BAD TOKEN MUST NOT STRAND THE REST. The sweep is a single atomic
  // UserOp, so a token that reverts on transfer — a blacklist, a paused
  // contract, a hostile scout buy — takes the whole recovery down with it and
  // there is no partial success to fall back on. So each leg is simulated
  // first, and the ones that cannot move are reported rather than allowed to
  // veto everything else.
  //
  // TWO THINGS THIS DELIBERATELY DOES NOT DO.
  //
  // It does not simulate through viem's `erc20Abi`, whose `transfer` declares a
  // bool return. Plenty of real ERC-20s return nothing at all (the USDT shape),
  // and viem raises a zero-data error for those — which would classify exactly
  // the odd, owner-added memecoins this fix exists to rescue as "reverting" and
  // strand them permanently. The no-output signature accepts both shapes.
  //
  // And it FAILS OPEN: if the simulation itself cannot run — an RPC error, a
  // timeout — the token is swept anyway. On the escape hatch, attempting a move
  // that might fail is strictly better than silently leaving money behind
  // because a network call flaked.
  const TRANSFER_ANY_RETURN = parseAbi(["function transfer(address,uint256)"]);
  const skipped: { symbol: string; reason: string }[] = [];

  const movable: TokenBalance[] = [];
  for (const b of plan.balances) {
    try {
      await publicClient.simulateContract({
        address: b.address,
        abi: TRANSFER_ANY_RETURN,
        functionName: "transfer",
        args: [opts.to, b.raw],
        account: account.address,
      });
      movable.push(b);
    } catch (e) {
      // Redacted: these reasons reach the CLI's output and the web route's JSON,
      // and a viem error names the RPC or bundler URL with its key (redact-urls.ts).
      const msg = errorText(e);
      // NOT EVERY REVERT IS A TOKEN REFUSING TO MOVE. NotOwner() says this key
      // is asking about something it does not own: abort and name it. Everything
      // else keeps the fail-open below: on an escape hatch, attempting a move
      // that might fail beats leaving money behind because a network call flaked.
      if (/NotOwner/.test(msg)) {
        throw new Error(
          `refusing to sweep: ${b.symbol} at ${b.address} answered NotOwner(). This owner key does ` +
            `not control that contract, so nothing here would move and reporting a successful ` +
            `recovery would be a lie. Check the owner key and the chain.`,
        );
      }
      if (/revert|execution reverted/i.test(msg)) {
        skipped.push({ symbol: b.symbol, reason: msg.replace(/\s+/g, " ").slice(0, 120) });
      } else {
        movable.push(b); // couldn't tell — try it rather than abandon it
      }
    }
  }

  if (movable.length === 0 && nativeSweptWei === 0n) {
    // NOT "the account is empty". Everything here is held; none of it would
    // move. Callers must be able to tell those apart — `skipped` is non-empty
    // and says why for each one.
    return { ...plan, txHash: null, to: opts.to, skipped, nativeSweptWei: 0n, nativeReservedWei };
  }

  const calls = movable.map((b) => ({
    to: b.address,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [opts.to, b.raw] }),
  }));

  // The ETH leg goes LAST: a plain value transfer with no calldata. Ordering it
  // after the token moves means a token that reverts unexpectedly takes the ETH
  // down with it rather than the reverse — the account keeps its gas money and
  // the sweep can simply be retried.
  if (nativeSweptWei > 0n) {
    calls.push({ to: opts.to, value: nativeSweptWei, data: "0x" as `0x${string}` });
  }

  const userOpHash = await client.sendUserOperation({ callData: await account.encodeCalls(calls) });
  const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash });
  if (!receipt.success) {
    throw new Error(`recovery UserOp reverted on-chain: ${userOpHash}`);
  }
  return {
    ...plan,
    balances: movable,
    txHash: receipt.receipt.transactionHash,
    to: opts.to,
    skipped,
    nativeSweptWei,
    nativeReservedWei,
  };
}
