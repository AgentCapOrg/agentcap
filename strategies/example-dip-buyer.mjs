/**
 * Example strategy — copy me and make me yours:
 *
 *   agentcap strategy new my-bot     # scaffolds ~/.agentcap/strategies/my-bot.mjs
 *   # edit it, pick "my-bot" in /settings (or `agentcap onboard`) — done
 *
 * The contract: default-export { name, tick(snapshot, ctx) }. Every tick
 * (~60s) you get the world and return an array of intents — what you WANT.
 * You never execute anything:
 *
 *   your intents → shape validation → policy wall (per-trade cap, daily cap,
 *   ops cap, drawdown breaker, allowlists) → quote simulation → the on-chain
 *   session-key wall. Your code cannot exceed the caps the user signed.
 *
 * No imports needed — `ctx` injects the verified registry:
 *   ctx.tokenBySymbol.QQQ          token address by symbol
 *   ctx.CASH.USDT                  the cash leg
 *   ctx.PANCAKESWAP.smartRouter    swap router
 *   ctx.usdg(25)                   25 → 25 * 10^18 (USDT is 18dp)
 *
 * snapshot fields:
 *   cashUsdg, vaultUsdg            bigint, USDT 18dp
 *   holdings                       Map<symbol, { token, rawBalance(18dp), valueUsdg(18dp), priceStale }>
 *   prices                         Map<symbol, { price8(8dp USD), stale }>
 *   pausedTokens, staleFeeds       Set — stale is EXPECTED nights/weekends (24/5 feeds, 24/7 tokens)
 *   sequencerUp                    boolean — respect it
 *
 * Edits hot-reload on the next tick. A thrown error or malformed intent just
 * skips the tick with the reason in the activity feed — you can't crash the
 * worker, and you can't exceed the wall.
 */

const WATCHED = "QQQ"; // the stock with real Uniswap v3 liquidity today
const DIP_BPS = 200n; // buy 2% under the slow reference price
const state = { referencePrice8: 0n }; // survives between ticks (not restarts)

export default {
  name: "example-dip-buyer",

  /**
   * @param {object} snap  market + account snapshot (see header)
   * @param {object} ctx   injected registry + helpers (see header)
   * @returns {Array}      intents; [] = do nothing this tick
   */
  tick(snap, ctx) {
    if (!snap.sequencerUp) return [];

    const token = ctx.tokenBySymbol[WATCHED];
    if (!token || snap.pausedTokens.has(token.toLowerCase())) return [];

    const price = snap.prices.get(WATCHED);
    if (!price || price.stale) return []; // no fresh reference → no opinion

    // Slow EMA-ish reference: 95% old, 5% new.
    state.referencePrice8 =
      state.referencePrice8 === 0n
        ? price.price8
        : (state.referencePrice8 * 95n + price.price8 * 5n) / 100n;

    const clip = ctx.usdg(10); // 10 USDG per buy
    const dipLine = (state.referencePrice8 * (10000n - DIP_BPS)) / 10000n;
    if (price.price8 >= dipLine) return []; // not a dip
    if (snap.cashUsdg < clip) return []; // can't afford the clip

    return [
      {
        kind: "swap",
        target: ctx.PANCAKESWAP.smartRouter,
        sellToken: ctx.CASH.USDT, // buying: sell USDG…
        buyToken: token, // …for the stock token
        sellAmountRaw: clip, // raw units of sellToken (USDT = 18dp)
        notionalUsdg: clip, // what the policy caps judge
      },
    ];

    // Other intents you can return:
    //   sell everything:  { kind: "swap", target: ctx.PANCAKESWAP.smartRouter,
    //                       sellToken: token, buyToken: ctx.CASH.USDT,
    //                       sellAmountRaw: snap.holdings.get(WATCHED).rawBalance,
    //                       notionalUsdg: snap.holdings.get(WATCHED).valueUsdg }
    // tick may be async (return a Promise) if you fetch external signals.
  },
};
