/**
 * PancakeSwap v3 direct execution — the one swap venue.
 *
 * It needs nobody's permission. Flow per swap: QuoterV2 simulation across fee tiers (this IS the
 * pre-trade simulation — it reverts where the swap would revert and returns a
 * gas estimate we store as the receipt) → slippage-bounded minOut →
 * exactInputSingle through the smart router.
 *
 * LIQUIDITY REALITY (2026-07): stock-token v3 pools are seed-sized. The quoter
 * tells us the truth about impact before any money moves — a missing pool shows
 * up as no-quote and the trade is skipped.
 *
 * A TERRIBLE quote IS now skipped — by worker/src/impact.ts, which this comment
 * spent a long time claiming existed before it did. For most of this file's
 * life the sentence here read "skipped by the impact guard upstream" and there
 * was no such guard anywhere in the repo. The two settings that sound like one
 * — minPoolLiquidityUsdg and maxPriceDivergenceBps — gate whether a FEEDLESS
 * token can be PRICED (see venues/pool-price.ts); they have nothing to say
 * about whether a trade can be SIZED. So a quote 40% through the book got a
 * minOut 1% below itself and executed happily.
 *
 * The guard re-prices the chosen route at a small probe size (requoteRoute,
 * below) and compares average execution price to marginal — the pool fee
 * cancels between the two, leaving impact alone. minOut remains what it always
 * was and defends what it always defended: the price MOVING between the quote
 * and the fill. It was never able to judge the quote itself.
 *
 * Trades also record fill_slippage_bps (quoted vs received), so the flat
 * slippage constant can eventually be replaced by a measured distribution. The
 * depth engine in venues/depth.ts computes the same impact number exactly, and
 * is deliberately barred from reaching policy (see depth.invariant.test.ts) —
 * which is why the guard measures from the quoter instead.
 */

import { encodeFunctionData, erc20Abi, parseAbi, type Hex, type PublicClient } from "viem";
import { PANCAKESWAP, PANCAKESWAP_V3_FEE_TIERS, UNISWAP_SWAP_ROUTER_ABI } from "../../../packages/core/src/index";

/**
 * Fee tiers to scan: every tier PancakeSwap v3 has. It uses 2500 where Uniswap
 * uses 3000, so a Uniswap list silently misses every 0.25% pool.
 *
 * The list has to cover whatever discovery can admit: the autonomous Trencher
 * verifies pools against the factory at the fee each pool REPORTS
 * (trencher-discovery.ts), and a coin nothing here can price is never bought.
 *
 * The wall does not pin a tier (wall.ts: "fee — any tier the pool actually
 * has"), so every tier here is one the owner's signature already allows.
 */
export const FEE_TIERS = PANCAKESWAP_V3_FEE_TIERS;

export const QUOTER_V2_ABI = parseAbi([
  "struct QuoteExactInputSingleParams { address tokenIn; address tokenOut; uint256 amountIn; uint24 fee; uint160 sqrtPriceLimitX96; }",
  "function quoteExactInputSingle(QuoteExactInputSingleParams params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);

export interface Quote {
  fee: number;
  amountOut: bigint;
  gasEstimate: bigint;
  /**
   * The hops, in order, when this quote is multi-hop. Absent = a direct
   * single-hop swap, which is what most of this file's callers still produce.
   */
  path?: { tokens: readonly `0x${string}`[]; fees: readonly number[] };
}

/**
 * Pack a Uniswap v3 path: token(20) fee(3) token(20) [fee(3) token(20)]…
 *
 * The router walks this itself and holds the intermediate leg, which is the
 * detail that matters for the permission wall: a USDG→WETH→CATE swap still only
 * ever pulls USDG from the account, so it needs no approval beyond the one every
 * grant already carries. Multi-hop widens where a trade can GO, never what the
 * key can TOUCH.
 */
export function encodePath(
  tokens: readonly `0x${string}`[],
  fees: readonly number[],
): Hex {
  if (tokens.length < 2 || fees.length !== tokens.length - 1) {
    throw new Error(`bad path: ${tokens.length} tokens, ${fees.length} fees`);
  }
  let out = "0x";
  tokens.forEach((t, i) => {
    out += t.slice(2).toLowerCase();
    if (i < fees.length) out += fees[i]!.toString(16).padStart(6, "0");
  });
  return out as Hex;
}

/** Highest amountOut wins; null when no tier has a pool with liquidity. */
export function pickBestQuote(quotes: readonly (Quote | null)[]): Quote | null {
  let best: Quote | null = null;
  for (const q of quotes) {
    if (q && q.amountOut > 0n && (!best || q.amountOut > best.amountOut)) best = q;
  }
  return best;
}

/** minOut = quoted × (10000 − slippageBps) / 10000, floor semantics. */
export function minOutWithSlippage(amountOut: bigint, slippageBps: number): bigint {
  if (slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error(`slippageBps out of range: ${slippageBps}`);
  }
  return (amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** Quote one tier via eth_call simulation; null = no pool / no liquidity there. */
export async function quoteTier(
  client: PublicClient,
  args: { tokenIn: `0x${string}`; tokenOut: `0x${string}`; amountIn: bigint; fee: number },
): Promise<Quote | null> {
  try {
    const { result } = await client.simulateContract({
      address: PANCAKESWAP.v3QuoterV2 as `0x${string}`,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: args.tokenIn,
          tokenOut: args.tokenOut,
          amountIn: args.amountIn,
          fee: args.fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    const [amountOut, , , gasEstimate] = result;
    return { fee: args.fee, amountOut, gasEstimate };
  } catch {
    return null;
  }
}

/** Quote one explicit multi-hop path. null = some leg has no pool / no liquidity. */
export async function quotePath(
  client: PublicClient,
  args: { tokens: readonly `0x${string}`[]; fees: readonly number[]; amountIn: bigint },
): Promise<Quote | null> {
  try {
    const { result } = await client.simulateContract({
      address: PANCAKESWAP.v3QuoterV2 as `0x${string}`,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInput",
      args: [encodePath(args.tokens, args.fees), args.amountIn],
    });
    const [amountOut, , , gasEstimate] = result;
    if (amountOut <= 0n) return null;
    return {
      // Reported for the receipt only — a multi-hop swap has no single fee.
      fee: args.fees[0]!,
      amountOut,
      gasEstimate,
      path: { tokens: args.tokens, fees: args.fees },
    };
  } catch {
    return null;
  }
}

/** Scan all fee tiers concurrently and return the best executable quote. */
export async function bestQuote(
  client: PublicClient,
  args: { tokenIn: `0x${string}`; tokenOut: `0x${string}`; amountIn: bigint },
): Promise<Quote | null> {
  const quotes = await Promise.all(FEE_TIERS.map((fee) => quoteTier(client, { ...args, fee })));
  return pickBestQuote(quotes);
}

/**
 * Best executable quote allowing ONE intermediate hop through `via` (WETH).
 *
 * Direct-only execution was leaving real tokens untradable. Live pools on
 * Robinhood Chain (2026-07-27): of the tokens agentcap can price, nine — UP,
 * YOLO, APES, MUMU, WEN, TYGR, WISHBONE, KITSU, wire — have no direct USDG pool
 * at all. They could be valued perfectly and never bought or sold, which is the
 * same trapped-position shape the no-exit rule exists to prevent, arrived at
 * from the execution side instead of the permission side.
 *
 * Every direct tier and every two-hop fee combination is quoted, and the best
 * amountOut wins outright — so a direct pool that happens to be better is still
 * chosen, and adding hops can only ever improve the fill the caller gets.
 */
export async function bestRoute(
  client: PublicClient,
  args: {
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    amountIn: bigint;
    /** Intermediate token to try routing through. Omit to stay single-hop. */
    via?: `0x${string}`;
  },
): Promise<Quote | null> {
  const lc = (a: string) => a.toLowerCase();
  const direct = FEE_TIERS.map((fee) => quoteTier(client, { ...args, fee }));

  // Hopping through one of the endpoints is the same swap with extra steps.
  const viaUsable =
    args.via && lc(args.via) !== lc(args.tokenIn) && lc(args.via) !== lc(args.tokenOut);
  const hops = viaUsable
    ? FEE_TIERS.flatMap((a) =>
        FEE_TIERS.map((b) =>
          quotePath(client, {
            tokens: [args.tokenIn, args.via!, args.tokenOut],
            fees: [a, b],
            amountIn: args.amountIn,
          }),
        ),
      )
    : [];

  return pickBestQuote(await Promise.all([...direct, ...hops]));
}

/**
 * Re-price the SAME route at a different size.
 *
 * The impact guard needs a marginal price for the exact route about to execute,
 * and `bestRoute` cannot give it: run at a probe size it re-selects, and a tiny
 * order routes through a different tier than a large one — so the comparison
 * would be between two different pools and the "impact" it measured would be an
 * artefact of the switch. Dispatching on the quote's own shape is what keeps
 * both numbers on one route, the same reason buildTradeCalls dispatches on it
 * rather than being told the venue separately.
 *
 * Returns null when this size finds no liquidity on that route, which the
 * caller must treat as unknown — never as zero impact.
 */
export async function requoteRoute(
  client: PublicClient,
  route: Quote,
  args: { tokenIn: `0x${string}`; tokenOut: `0x${string}`; amountIn: bigint },
): Promise<bigint | null> {
  if (route.path) {
    const q = await quotePath(client, {
      tokens: route.path.tokens,
      fees: route.path.fees,
      amountIn: args.amountIn,
    });
    return q?.amountOut ?? null;
  }
  const q = await quoteTier(client, { ...args, fee: route.fee });
  return q?.amountOut ?? null;
}

/**
 * Every call needed to execute a quote, in order — the ONE place a route turns
 * into calldata.
 *
 * Building the approve and the swap separately at the call site is how you end up
 * approving one router and swapping through another, or executing one path
 * against a minOut computed on a different one. Threading the quote through means
 * the route that was priced is necessarily the route that runs.
 */
export function buildTradeCalls(args: {
  quote: Quote;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  recipient: `0x${string}`;
  amountIn: bigint;
  minAmountOut: bigint;
}): SwapCall[] {
  // Approve the router directly for exactly this trade, then swap.
  const approve: SwapCall = {
    to: args.tokenIn,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [PANCAKESWAP.smartRouter as `0x${string}`, args.amountIn],
    }),
  };
  return [
    approve,
    buildSwapCall({
      tokenIn: args.tokenIn,
      tokenOut: args.tokenOut,
      fee: args.quote.fee,
      recipient: args.recipient,
      amountIn: args.amountIn,
      minAmountOut: args.minAmountOut,
      path: args.quote.path,
    }),
  ];
}

export interface SwapCall {
  to: `0x${string}`;
  value: 0n;
  data: Hex;
}

/**
 * Build the swap call. Caller must have approved amountIn of tokenIn to the router.
 *
 * Pass the quote's `path` to execute the multi-hop route it found — the router
 * still only pulls tokenIn, so this needs no permission the single-hop form
 * didn't. Executing a single-hop call for a quote that was multi-hop would
 * silently trade a DIFFERENT (worse, or non-existent) route than the one whose
 * minOut the caller computed, so the two must be threaded together.
 */
export function buildSwapCall(args: {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  fee: number;
  recipient: `0x${string}`;
  amountIn: bigint;
  minAmountOut: bigint;
  path?: { tokens: readonly `0x${string}`[]; fees: readonly number[] };
}): SwapCall {
  if (args.path) {
    return {
      to: PANCAKESWAP.smartRouter as `0x${string}`,
      value: 0n,
      data: encodeFunctionData({
        abi: UNISWAP_SWAP_ROUTER_ABI,
        functionName: "exactInput",
        args: [
          {
            path: encodePath(args.path.tokens, args.path.fees),
            recipient: args.recipient,
            amountIn: args.amountIn,
            amountOutMinimum: args.minAmountOut,
          },
        ],
      }),
    };
  }
  return {
    to: PANCAKESWAP.smartRouter as `0x${string}`,
    value: 0n,
    data: encodeFunctionData({
      abi: UNISWAP_SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn: args.tokenIn,
          tokenOut: args.tokenOut,
          fee: args.fee,
          recipient: args.recipient,
          amountIn: args.amountIn,
          amountOutMinimum: args.minAmountOut,
          sqrtPriceLimitX96: 0n,
        },
      ],
    }),
  };
}
