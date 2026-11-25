/**
 * Where the Merry Circle gateway actually lives — the ONE place this is written.
 *
 * The gateway is the holder-utility layer in practice: it fronts the LLM and
 * Bitquery so a holder needs no keys of their own. Its hostname was previously
 * duplicated across the provider registry, the CLI's provider table and the
 * Bitquery client, which meant moving it was four edits and a test, and missing
 * one left some paths pointing at a host that wasn't serving.
 *
 * CURRENTLY the Railway service URL. `ai.agentcap.xyz` is registered and its DNS
 * is correct, but Railway hasn't issued the Let's Encrypt certificate yet, so
 * TLS on that name resets. Both hostnames route to the same service — switch
 * this line back once the cert lands and every path follows.
 */
export const AGENTCAP_GATEWAY_ORIGIN = "https://agentcap-gateway-production.up.railway.app";

/**
 * The $AGENTCAP token on Robinhood Chain. Nothing in the trading product reads
 * it; the site's developer billing mirrors these values (billing.test.ts).
 */
export const AGENTCAP_TOKEN = {
  symbol: "AGENTCAP",
  address: "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32" as `0x${string}`,
  decimals: 18,
  chainId: 4663,
} as const;
