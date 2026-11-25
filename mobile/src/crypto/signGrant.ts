import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createKernelAccount } from "@zerodev/sdk";
import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { serializePermissionAccount, toPermissionValidator } from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import {
  GRANT_SCOPED_SPENDERS,
  TRADEABLE_V2,
  buildWallPolicies,
  buildCallPermissions,
  wallShape,
  wallSignable,
  perpFits,
  grantPerp,
  GRANT_PERP_LIGHTER,
  LIGHTER_ROUTE_V1,
  WALL_POLICY_FLAG,
  robinhoodChain,
  usableExtraTokens,
  officialCoinTokens,
  assertDerivedAccount,
  type CustomToken,
  type GrantCaps,
  type StoredGrant,
} from "@agentcap/core";
import { accountFromMnemonic } from "./mnemonic";
import { readGrant } from "./grantStore";
import { isMock } from "@/net/api";

/**
 * Sign a grant on the phone.
 *
 * THE ONE RULE: the owner key never leaves this device. It is derived from the
 * mnemonic in memory, used to build the sudo validator, and dropped. What comes
 * out is a serialized SESSION account — capped on-chain, self-expiring, revocable
 * — and that is the only thing safe to hand to a server.
 *
 * This deliberately does NOT mirror the dashboard's session.ts, which puts
 * `demoOwnerPrivateKey` on the grant object and POSTs the whole thing to
 * /api/grants. On a self-hosted install that is a localhost round trip to a 0600
 * file on the same machine, so it is not a leak. From a phone talking to a hosted
 * API it would upload the owner key to someone else's server, which would make the
 * product's central claim false. So the field is simply absent here.
 *
 * The policy set itself comes from packages/core so the phone and the dashboard
 * sign the IDENTICAL wall — see packages/core/src/wall.ts, pinned by
 * worker/src/wall.test.ts.
 */

export type SignProgress = (step: string) => void;

/**
 * THE PERPS BLOCK A PREVIOUS GRANT FOR THIS ACCOUNT CARRIED — CARRY-FORWARD ONLY.
 *
 * The phone offers no perps opt-in (docs/perps.md, rollout: the dashboard
 * offers it; there is no keygen on this path, and there is no field here a key
 * could arrive in). What it must never do is DROP one: a Lighter API key the
 * worker registered stays valid at the venue whatever the grant says, so a
 * phone re-sign that quietly lost the block would leave a live venue account
 * with no worker holding its key. So the phone mirrors web/src/lib/session.ts
 * exactly on the one thing it does — the previous grant's PUBLIC key is carried
 * forward into the same wall option, under the same marker, from one value —
 * and refuses where the dashboard would refuse, pointing the owner at the
 * dashboard for everything else (turning perps off needs a flat-venue check the
 * phone does not make).
 *
 * Read through core's `grantPerp`, the worker's own reader. Sources in the
 * dashboard's order: the server's projection when the caller has one and it
 * names this account, else this phone's stored grant. `apiKeySealed` rides
 * along when the copy has one (the server's own opaque blob, bound to this
 * account and key); a projection never does, and the server re-attaches it
 * from its store by equal public key.
 */
function priorPerpOnPhone(
  account: string,
  server: unknown,
  stored: unknown,
): { apiPublicKey: `0x${string}`; apiKeySealed?: string } | null {
  const same = (g: unknown): g is Record<string, unknown> =>
    typeof g === "object" &&
    g !== null &&
    typeof (g as Record<string, unknown>).smartAccount === "string" &&
    ((g as Record<string, unknown>).smartAccount as string).toLowerCase() === account.toLowerCase();
  const from = same(server) ? "server" : same(stored) ? "phone" : null;
  if (!from) return null;
  const g = (from === "server" ? server : stored) as Record<string, unknown>;
  const features = Array.isArray(g.grantFeatures) ? g.grantFeatures.filter((f): f is string => typeof f === "string") : [];
  if (!features.includes(GRANT_PERP_LIGHTER)) return null;
  const read = grantPerp({ grantFeatures: features, chainId: typeof g.chainId === "number" ? g.chainId : Number.NaN, perp: g.perp });
  if (!read) {
    // A grant that claims perps and cannot say which key: never "none".
    throw new Error(
      "Your agent's current permission includes perpetuals, but its Lighter key could not be read on this phone. " +
        "Nothing was signed — re-sign from the dashboard, which can check Lighter before changing it.",
    );
  }
  return {
    apiPublicKey: read.apiPublicKey,
    ...(read.apiKeySealed ? { apiKeySealed: read.apiKeySealed } : {}),
  };
}

export interface SignedGrant {
  /** Safe to transmit: capped, expiring, and useless outside its policies. */
  grant: Omit<StoredGrant, "demoOwnerPrivateKey">;
  /** The session key, which the worker needs in order to act. Not the owner key. */
  sessionPrivateKey: `0x${string}`;
}

export async function signGrant(args: {
  mnemonic: string;
  caps: GrantCaps;
  extraTokens?: readonly CustomToken[];
  /**
   * The server's PUBLIC projection of the current grant (GET /api/grants →
   * `grant`), when the caller has one. Only read to CARRY a perpetuals key
   * forward — see priorPerpOnPhone. This phone's own stored grant is read as
   * well, whether or not this is passed, so no caller can forget.
   */
  previousGrant?: unknown;
  rpcUrl?: string;
  onProgress?: SignProgress;
}): Promise<SignedGrant> {
  // A DEMO BUILD MUST NOT MINT A FUNDABLE ACCOUNT.
  //
  // `isMock` used to gate only what the screens DISPLAY — the feed and the
  // Telegram card. It never reached here, and there is no testnet path: the
  // chain below is Robinhood Chain 4663, mainnet, unconditionally. So a demo
  // build generated a real key, derived a real mainnet smart account, showed
  // the owner its address, and then reported a portfolio that was entirely
  // invented. Anyone who funded that address had put real money somewhere the
  // app was lying about, with one small chip as the only warning.
  //
  // The guard lives at the signing chokepoint rather than on the screen,
  // because the screen is reachable by deep link (`agentcap://onboarding/grant`)
  // and a UI-only check would be routed around rather than enforced.
  //
  // Deliberately NOT applied to recovery: sweeping funds out is the escape
  // hatch, and blocking it would strand anyone who reached this state before
  // the guard existed. Close the trap, keep the exit.
  if (isMock) {
    throw new Error(
      "This is a demo build — it reads generated data, so it will not sign a real permission wall. " +
        "Install a build configured for your own agent to do that.",
    );
  }

  const say = args.onProgress ?? (() => {});
  const chain = robinhoodChain;
  const publicClient = createPublicClient({
    chain,
    transport: http(args.rpcUrl ?? chain.rpcUrls.default.http[0]),
  });
  const entryPoint = getEntryPoint("0.7");

  say("deriving your key");
  const ownerAccount = accountFromMnemonic(args.mnemonic);

  say("building the sudo validator");
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: ownerAccount,
    entryPoint,
    kernelVersion: KERNEL_V3_3,
  });

  say("minting a session key");
  const sessionPrivateKey = generatePrivateKey();
  const sessionSigner = await toECDSASigner({ signer: privateKeyToAccount(sessionPrivateKey) });

  // The address BEFORE the wall, because the wall pins value to it. The Kernel
  // address derives from the sudo validator alone — the permission plugin is
  // enabled at UserOp time and does not affect it — so this is knowable now,
  // and asserted identical below.
  say("deriving your account");
  const sudoOnlyAccount = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo: ecdsaValidator },
  });

  // BEFORE THE WALL PINS VALUE TO IT. createKernelAccount resolves this with a
  // live getSenderAddress eth_call and answers the zero address, without
  // throwing, when the Kernel factory does not respond on this chain. The wall
  // below would then pin its swap recipient and vault receiver to zero, the
  // assertion further down would be satisfied by two zeros, and the phone would
  // seal a grant for an account nobody owns. Identical guard to
  // web/src/lib/session.ts - the two signers must refuse the same things.
  assertDerivedAccount(sudoOnlyAccount.address, "the smart account could not be derived");

  say("assembling the wall");
  /**
   * The platform's official listings, plus whatever the caller passed.
   *
   * THE PHONE NEEDS THIS MORE THAN THE BROWSER DOES, not less: the web signer
   * can at least read /settings, while `onboarding/grant.tsx` passes no tokens.
   */
  const sealedTokens = [...officialCoinTokens(chain.id), ...(args.extraTokens ?? [])];

  // IS THIS A FIRST INSTALL OR A RE-SIGN? A fact about the account, and the
  // same one the other signer reads. `deploying` was hardcoded inside
  // `wallSignable`, so both signers charged every re-sign for a CREATE2 and an
  // initCode it will never pay. A cap only one signer gets right is not a cap,
  // and neither is a cap both get wrong the same way.
  //
  // Unreadable counts as undeployed: over-charging refuses a wall the owner can
  // retry, under-charging mints one the executor refuses forever.
  //
  // Read BEFORE the wall options, because whether carried perps fit depends on
  // this.
  let alreadyDeployed = false;
  try {
    const code = await publicClient.getBytecode({ address: sudoOnlyAccount.address });
    alreadyDeployed = code !== undefined && code !== "0x";
  } catch {
    alreadyDeployed = false;
  }

  // ── PERPETUALS: CARRIED FORWARD, DECIDED ONCE ─────────────────────────────
  //
  // Identical to web/src/lib/session.ts in everything the phone does: the
  // decision comes after the deployment read (whether perps fit depends on it)
  // and BEFORE wallSignable, because perps are REFUSED when they do not fit.
  // The phone never adds perps and never drops them.
  const carriedPerp = priorPerpOnPhone(
    sudoOnlyAccount.address,
    args.previousGrant,
    await readGrant().catch(() => null),
  );
  // The chain below is Robinhood Chain mainnet unconditionally; asserted anyway,
  // because a carried key signed for any other chain is a venue account left
  // without its worker.
  if (carriedPerp && chain.id !== LIGHTER_ROUTE_V1.chainId) {
    throw new Error("Your agent holds a perpetuals permission, which exists only on Robinhood Chain mainnet. Nothing was signed.");
  }
  // The ROUTE'S key index, never a stored one: perp-lighter-v1 names index 16.
  const perpLighter = carriedPerp
    ? { apiKeyIndex: LIGHTER_ROUTE_V1.apiKeyIndex, apiPublicKey: carriedPerp.apiPublicKey }
    : undefined;

  const wallOpts = {
    extraTokens: sealedTokens,
    // Scoped, exactly as web/src/lib/session.ts scopes it, and the marker below
    // is minted from this same field.
    scopedSpenders: true as boolean,
    // Decided just above, from the previous grant, and never reassigned.
    perpLighter,
  };
  // Refused, never dropped, when the carried perps no longer fit (e.g. more
  // tokens than last time): the owner chooses what gives way.
  if (wallOpts.perpLighter && !perpFits(args.caps, sudoOnlyAccount.address, chain.id, !alreadyDeployed, wallOpts)) {
    throw new Error(
      "This permission has no room left for the perpetuals your agent already holds, and they cannot be dropped " +
        "silently — its Lighter key stays registered at the venue. Remove some tokens, or close its Lighter " +
        "positions and turn perpetuals off from the dashboard first. Nothing was signed.",
    );
  }
  // CAN THIS WALL EVER BE INSTALLED? The same question the other signer asks,
  // through the same function, over the same permission objects — because a cap
  // only one signer enforces is not a cap. Both signers already move in lockstep
  // on what they MINT (signer-lockstep.test.ts); this is the same rule applied
  // to what they REFUSE — and on the same `deploying` fact, read above.
  const sealedForWall = (wallOpts.extraTokens ?? []) as readonly unknown[];
  const signable = wallSignable(
    wallShape(buildCallPermissions(args.caps, sudoOnlyAccount.address, wallOpts)),
    {
      deploying: !alreadyDeployed,
      basket: {
        count: sealedForWall.length,
        shapeWith: (n) =>
          wallShape(
            buildCallPermissions(args.caps, sudoOnlyAccount.address, {
              ...wallOpts,
              extraTokens: sealedForWall.slice(0, n) as never,
            }),
          ),
      },
    },
  );
  if (!signable.ok) throw new Error(signable.why);

  const { policies, now, expiresAt } = buildWallPolicies({
    caps: args.caps,
    smartAccount: sudoOnlyAccount.address,
    ...wallOpts,
  });

  say("attaching the permissions");
  const permissionValidator = await toPermissionValidator(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    signer: sessionSigner,
    policies,
    // Execute, but never sign — the same flag the dashboard signs with. Both
    // read it from core so the two signers cannot drift, exactly like the
    // permission list itself. See WALL_POLICY_FLAG in packages/core/src/wall.ts.
    flag: WALL_POLICY_FLAG,
  });

  say("deriving the smart account");
  const account = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo: ecdsaValidator, regular: permissionValidator },
  });

  // Same premise check the dashboard makes: the wall's recipient pins are only
  // correct while the permission plugin leaves the address alone. Fail before
  // sealing, never after.
  assertDerivedAccount(account.address, "the permissioned account could not be derived");
  if (account.address.toLowerCase() !== sudoOnlyAccount.address.toLowerCase()) {
    throw new Error(
      `refusing to sign: the permission plugin changed the account address ` +
        `(${sudoOnlyAccount.address} → ${account.address}), so the wall's recipient pins are wrong.`,
    );
  }

  say("signing");
  const serialized = await serializePermissionAccount(account, sessionPrivateKey);

  return {
    grant: {
      smartAccount: account.address,
      // The owner's ADDRESS, which is public. Not the key.
      owner: ownerAccount.address,
      sessionKeyAddress: sessionSigner.account.address,
      serialized,
      caps: args.caps,
      grantedAt: now,
      expiresAt,
      chainId: chain.id,
      // Tells the worker what this signature actually carries, rather than
      // letting it infer capabilities from a constant that may have moved since.
      // Kept in step with web/src/lib/session.ts — two signers, one wall.
      // No "transfer": this signer registers no withdrawal address either, so
      // the wall carries no transfer permission and claiming one would make the
      // off-chain mirror looser than the chain. See the note in session.ts.
      grantFeatures: [
        TRADEABLE_V2,
        // From the field that scoped the wall above — identical to
        // web/src/lib/session.ts.
        ...(wallOpts.scopedSpenders ? [GRANT_SCOPED_SPENDERS] : []),
        // From the SAME value that sealed the proxy and the key into the wall —
        // identical to web/src/lib/session.ts.
        ...(wallOpts.perpLighter ? [GRANT_PERP_LIGHTER] : []),
      ],
      // The carried key, from that same value: PUBLIC key (lowercase — the
      // bytes the wall pinned), the route's index, and at most the hosted sealed
      // blob. There is no field here a private key fits in.
      ...(wallOpts.perpLighter
        ? {
            perp: {
              route: GRANT_PERP_LIGHTER,
              apiKeyIndex: wallOpts.perpLighter.apiKeyIndex,
              apiPublicKey: wallOpts.perpLighter.apiPublicKey.toLowerCase() as `0x${string}`,
              ...(carriedPerp?.apiKeySealed ? { apiKeySealed: carriedPerp.apiKeySealed } : {}),
            },
          }
        : {}),
      grantTokens: usableExtraTokens(sealedTokens).map((t) => t.address.toLowerCase()),
      demoSessionPrivateKey: sessionPrivateKey,
    },
    sessionPrivateKey,
  };
}
