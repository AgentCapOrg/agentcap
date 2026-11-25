/**
 * A current, indicative quote for an owner trade, computed the way the agent's
 * worker would route it — and nothing more.
 *
 * Same venue code the worker executes with (PancakeSwap v3 QuoterV2 via
 * eth_call simulation: no state changes, nothing signed), the same grant gate
 * (a WETH hop only when the signed permission carries multi-hop), the same
 * impact probe and the same minOut rule.
 *
 * A quote is not permission. The worker re-quotes at execution, re-applies the
 * owner's caps and the policy, and the on-chain wall has the last word.
 */
import { createPublicClient, erc20Abi, parseAbi, type PublicClient } from "viem";
import { CASH, STOCK_TOKENS, SETTINGS_DEFAULTS, CASH_FEEDS, CASH_DECIMALS, bnbChain, cashNumber, grantHasMultihop, usdgUnits } from "@agentcap/core";
import { webChainRead } from "../chain-read";
import { bestRoute, minOutWithSlippage, requoteRoute, type Quote } from "../../../../worker/src/venues/uniswap";
import { impactBps, judgeImpact, probeAmountIn } from "../../../../worker/src/impact";
import { expectedTradeGasUsdg, STEADY_SWAP_GAS_UNITS } from "../../../../worker/src/execution-cost";

export type Side = "buy" | "sell";

export interface QuoteInput {
  side: Side;
  token: `0x${string}`;
  /** Buy: USDG to spend. Sell: USDG value of the holding to sell. */
  amountUsdg: number;
  /** The agent's own settings (slippage and impact cap); null → the defaults the worker uses. */
  slippageBps: number | null;
  maxImpactBps: number | null;
  /** Grant features decide which routes the agent's key can reach. */
  grantFeatures: string[];
  /** For sells: the agent's holding of this token, from the ledger. */
  holding: { rawBalance: bigint; valueUsdg: number | null } | null;
}

export interface TradeQuote {
  quoted: boolean;
  why_not: string | null;
  side: Side;
  token: string;
  token_decimals: number | null;
  amount_in: { token: string; raw: string; human: number | null };
  expected_out: { token: string; raw: string; human: number | null } | null;
  min_out: { raw: string; human: number | null; slippage_bps: number } | null;
  implied_price_usd: number | null;
  price_impact_bps: number | null;
  impact_verdict: { ok: boolean; rule: string | null; detail: string | null; cap_bps: number };
  route: { venue: "pancakeswap-v3"; fee_tier_bps: number | null; hops: string[] } | null;
  routes_considered: { direct_v3: boolean; via_weth: boolean };
  gas: { units_estimate: string | null; swap_leg_units: string | null; expected_usdg: number | null; note: string };
  agentcap_trade_fee: { bps: number; usdg: number; note: string };
  block_number: string | null;
  quoted_at: string;
  source: string;
  caveats: string[];
}

const CHAINLINK_ABI = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);
const USDG = CASH.USDT as `0x${string}`;
const WETH = CASH.WBNB as `0x${string}`;

let client: PublicClient | null = null;
export function quoteClient(): PublicClient {
  if (!client) client = createPublicClient({ chain: bnbChain, transport: webChainRead(process.env.AGENTCAP_RPC_MAINNET) }) as PublicClient;
  return client;
}
/** Test seam: a fake chain for quotes. No test reaches a real RPC. */
export function setQuoteClientForTest(c: PublicClient | null): void {
  client = c;
}

const human = (raw: bigint, decimals: number | null): number | null =>
  decimals === null ? null : Number(raw) / 10 ** decimals;

async function decimalsOf(c: PublicClient, token: `0x${string}`): Promise<number | null> {
  const known = STOCK_TOKENS.find((t) => t.address.toLowerCase() === token.toLowerCase());
  if (known) return 18;
  if (token.toLowerCase() === USDG.toLowerCase()) return 6;
  try {
    const d = await c.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
    return Number(d);
  } catch {
    return null;
  }
}

async function ethPrice8(c: PublicClient): Promise<bigint | null> {
  try {
    const [, answer, , updatedAt] = await c.readContract({ address: CASH_FEEDS.BNB_USD as `0x${string}`, abi: CHAINLINK_ABI, functionName: "latestRoundData" });
    // A feed older than two hours is not a price to cost gas with.
    if (answer <= 0n || Number(updatedAt) < Date.now() / 1000 - 7200) return null;
    return answer;
  } catch {
    return null;
  }
}

export async function quoteTrade(input: QuoteInput, c: PublicClient = quoteClient(), nowMs = Date.now()): Promise<TradeQuote> {
  const slippage = input.slippageBps ?? SETTINGS_DEFAULTS.slippageBps;
  const cap = input.maxImpactBps ?? SETTINGS_DEFAULTS.maxImpactBps;
  const multihop = grantHasMultihop({ grantFeatures: input.grantFeatures });
  const feeBps = SETTINGS_DEFAULTS.tradeFeeBps;
  const base: TradeQuote = {
    quoted: false,
    why_not: null,
    side: input.side,
    token: input.token.toLowerCase(),
    token_decimals: null,
    amount_in: { token: input.side === "buy" ? USDG.toLowerCase() : input.token.toLowerCase(), raw: "0", human: null },
    expected_out: null,
    min_out: null,
    implied_price_usd: null,
    price_impact_bps: null,
    impact_verdict: { ok: false, rule: null, detail: null, cap_bps: cap },
    route: null,
    routes_considered: { direct_v3: true, via_weth: multihop },
    gas: { units_estimate: null, swap_leg_units: null, expected_usdg: null, note: "Paid in BNB by the agent's account unless the house sponsors it. Estimated for a whole operation from measured swaps on this chain." },
    agentcap_trade_fee: {
      bps: feeBps,
      usdg: Math.floor(input.amountUsdg * feeBps) / 10_000,
      note: "AgentCap's per-trade fee on the notional, accrued in the ledger (not collected on chain today).",
    },
    block_number: null,
    quoted_at: new Date(nowMs).toISOString(),
    source: "PancakeSwap v3 quoter via eth_call on BNB Chain (a simulation; nothing is signed or sent)",
    caveats: [
      "Indicative only: the agent re-quotes when it executes and refuses if its own limits, policy or the on-chain permission say no.",
    ],
  };
  if (!Number.isFinite(input.amountUsdg) || input.amountUsdg <= 0) return { ...base, why_not: "amount must be a positive USDG figure" };
  if (input.token.toLowerCase() === USDG.toLowerCase()) return { ...base, why_not: "USDG is the cash leg; pick the token to buy or sell" };

  const decimals = await decimalsOf(c, input.token);
  base.token_decimals = decimals;
  let amountIn: bigint;
  if (input.side === "buy") {
    amountIn = usdgUnits(input.amountUsdg);
  } else {
    if (!input.holding || input.holding.rawBalance <= 0n) return { ...base, why_not: "the agent holds none of this token in its current book" };
    if (input.holding.valueUsdg === null || input.holding.valueUsdg <= 0) {
      return { ...base, why_not: "the holding has no current value in the ledger, so a USDG-sized sell cannot be converted to a token amount" };
    }
    const fraction = Math.min(1, input.amountUsdg / input.holding.valueUsdg);
    amountIn = (input.holding.rawBalance * BigInt(Math.round(fraction * 1e6))) / 1_000_000n;
    if (fraction >= 0.999) amountIn = input.holding.rawBalance;
  }
  base.amount_in = { ...base.amount_in, raw: amountIn.toString(), human: input.side === "buy" ? input.amountUsdg : human(amountIn, decimals) };
  if (amountIn <= 0n) return { ...base, why_not: "the amount rounds to nothing at this token's precision" };

  const tokenIn = input.side === "buy" ? USDG : input.token;
  const tokenOut = input.side === "buy" ? input.token : USDG;
  let route: Quote | null = null;
  let block: bigint | null = null;
  try {
    [route, block] = await Promise.all([
      bestRoute(c, { tokenIn, tokenOut, amountIn, via: multihop ? WETH : undefined }),
      c.getBlockNumber().catch(() => null),
    ]);
  } catch {
    return { ...base, why_not: "the chain could not be read right now; try again shortly", caveats: [...base.caveats, "RPC read failed"] };
  }
  base.block_number = block === null ? null : block.toString();
  if (!route) {
    const hint = multihop ? "" : " Many tokens have no direct USDG pool; this agent's permission does not include multi-hop routes.";
    return { ...base, why_not: `no pool the agent's permission can reach quoted this trade.${hint}` };
  }
  const outDecimals = input.side === "buy" ? decimals : CASH_DECIMALS;
  const probeIn = probeAmountIn(amountIn);
  const probeOut = probeIn === null ? null : await requoteRoute(c, route, { tokenIn, tokenOut, amountIn: probeIn }).catch(() => null);
  const impact = probeIn === null || probeOut === null ? null : impactBps({ amountIn, amountOut: route.amountOut, probeIn, probeOut });
  const verdict = judgeImpact({ bps: impact, maxBps: cap, isExit: input.side === "sell" });
  const minOut = minOutWithSlippage(route.amountOut, slippage);
  const outHuman = human(route.amountOut, outDecimals);
  const inHuman = input.side === "buy" ? input.amountUsdg : human(amountIn, decimals);
  const price = outHuman !== null && inHuman !== null && outHuman > 0 && inHuman > 0
    ? (input.side === "buy" ? inHuman / outHuman : outHuman / inHuman)
    : null;

  // The whole UserOperation (validation + approval + swap), measured on this
  // chain — the figure the worker's own economics use for an account with no
  // gas history. The quoter's own number covers the swap leg only.
  let gasUsdg: number | null = null;
  const gasUnits = STEADY_SWAP_GAS_UNITS;
  try {
    const [gasPrice, eth] = await Promise.all([c.getGasPrice(), ethPrice8(c)]);
    const micro = expectedTradeGasUsdg({ gasUnits, gasPriceWei: gasPrice, ethPrice8: eth });
    gasUsdg = micro === null ? null : cashNumber(micro);
  } catch {
    gasUsdg = null;
  }

  return {
    ...base,
    quoted: true,
    expected_out: { token: tokenOut.toLowerCase(), raw: route.amountOut.toString(), human: outHuman },
    min_out: { raw: minOut.toString(), human: human(minOut, outDecimals), slippage_bps: slippage },
    implied_price_usd: price,
    price_impact_bps: impact,
    impact_verdict: verdict.ok
      ? { ok: true, rule: null, detail: verdict.note ?? null, cap_bps: cap }
      : { ok: false, rule: verdict.rule, detail: verdict.detail, cap_bps: cap },
    route: {
      venue: "pancakeswap-v3",
      fee_tier_bps: route.fee / 100,
      hops: route.path ? route.path.tokens.map((t) => t.toLowerCase()) : [tokenIn.toLowerCase(), tokenOut.toLowerCase()],
    },
    gas: { ...base.gas, units_estimate: gasUnits.toString(), expected_usdg: gasUsdg, swap_leg_units: route.gasEstimate.toString() },
  };
}
