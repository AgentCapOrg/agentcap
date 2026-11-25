import {
  CASH,
  STOCK_TOKENS,
  PANCAKESWAP,
  LIGHTER_ROUTE_V1,
  grantHasTransfer,
  grantPerp,
  builtinGrantTargets,
  grantTrencher,
  sellableAssets,
  usdgUnits,
  type StockToken,
  type StoredGrant,
} from "../../packages/core/src/index";
import type { AgentLimits } from "./policy";

/** Build the off-chain mirror of the limits sealed into a signed grant. */
export function limitsFromGrant(
  grant: StoredGrant,
  watchTokens: readonly StockToken[] = STOCK_TOKENS,
): AgentLimits {
  return {
    perTradeUsdg: usdgUnits(grant.caps.perTradeUsdg),
    dailyUsdg: usdgUnits(grant.caps.dailyUsdg),
    allowedTargets: [
      PANCAKESWAP.smartRouter as `0x${string}`,
      CASH.USDT as `0x${string}`,
      ...(grantTrencher(grant) ? [grantTrencher(grant)!.vault] : []),
    ],
    allowedAssets: [CASH.USDT as `0x${string}`, ...watchTokens.map((token) => token.address)],
    sellableAssets: [...sellableAssets(grant)],
    // The quote side only -- see AgentLimits.quoteAssets.
    quoteAssets: [...builtinGrantTargets(grant)],
    ...(grantTrencher(grant) ? {trencherVault:grantTrencher(grant)!.vault,knownTrencherAssets:[]} : {}),
    // THE TRANSFER PERMISSION, MIRRORED. checkPolicy has always known how to
    // judge this — it was simply never told. A grant without the transfer
    // marker has NO USDG transfer permission in its call policy:
    // buildCallPermissions emits one only for withdrawal addresses registered
    // at signing, and neither signer registers any.
    //
    // EMPTY, not undefined. undefined means "a pre-allowlist grant, still
    // free-form" and is deliberately permissive; conflating the two is exactly
    // what let the worker build a transfer the chain refuses. This is the
    // load-bearing half of the fix, because it covers EVERY producer of a
    // transfer intent rather than just the Telegram command — and it turns an
    // opaque on-chain revert into the sentence checkPolicy already writes.
    ...(grantHasTransfer(grant) ? {} : { withdrawalAddresses: [] as string[] }),
    // THE LIGHTER ROUTE, MIRRORED — from the GRANT, and NOT into allowedTargets
    // (docs/perps.md rule 3).
    //
    // grantPerp answers only for the perp-lighter-v1 marker on chain 4663 with
    // the route's key index and a canonical public key — all four, which is
    // exactly when the wall sealed the deposit, key-registration and claim
    // permissions. Settings never reach it: an owner who turns perps on without
    // re-signing has a key that can post no margin, and checkPolicy says so
    // (`perp-not-granted`) instead of building a UserOp the chain refuses. The
    // proxy stays OUT of allowedTargets because the wall reaches it through
    // three exact selectors and the USDG approve's ONE_OF spenders only; listed
    // with the generic targets, any `swap` could name it.
    // The sealed private-key blob (`apiKeySealed`) is deliberately not copied:
    // limits are logged and shown, and nothing that judges needs it.
    ...((): { perp?: { proxy: `0x${string}`; apiKeyIndex: number; apiPublicKey: `0x${string}` } } => {
      const p = grantPerp(grant);
      return p ? { perp: { proxy: LIGHTER_ROUTE_V1.proxy, apiKeyIndex: p.apiKeyIndex, apiPublicKey: p.apiPublicKey } } : {};
    })(),
    // So the breaker can tell a de-risking sell (swap INTO cash) from a buy.
    cashToken: CASH.USDT as string,
    maxDrawdownBps: grant.caps.maxDrawdownPct * 100,
    expiresAt: grant.expiresAt,
    maxOpsPerDay: grant.caps.maxOpsPerDay,
  };
}
