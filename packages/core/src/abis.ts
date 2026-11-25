/**
 * Uniswap SwapRouter02 exactInputSingle — the one selector agentcap grants
 * session keys permission to call. NOTE: SwapRouter02 has NO deadline field
 * (that was SwapRouter v1). Shared by web (call policy) and worker (execution).
 */
export const UNISWAP_SWAP_ROUTER_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    // Multi-hop. `path` is packed token/fee/token(/fee/token…), and the router
    // holds the intermediate leg itself — so a USDG→WETH→CATE swap still only
    // needs USDG approved. That's why routing through WETH costs no new grant
    // permission and no re-sign.
    type: "function",
    name: "exactInput",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "path", type: "bytes" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

/** Chainlink AggregatorV3Interface — stock feeds run 24/5; check updatedAt for staleness. */
export const CHAINLINK_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  /**
   * One historical round, by id.
   *
   * The id is PHASE-ENCODED: the high 64 bits identify the aggregator behind
   * the proxy and the low 64 the round within it, so walking history means
   * decrementing only the low half. Cross the phase boundary and the answers
   * come back from a different aggregator with a different scale — which is
   * what the magnitude guard in read-feed-history exists to catch.
   */
  {
    type: "function",
    name: "getRoundData",
    stateMutability: "view",
    inputs: [{ name: "_roundId", type: "uint80" }],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

// ── Lighter (Robinhood instance) — see LIGHTER_ROUTE_V1 in perps.ts ─────────
//
// Every selector below was matched against the DEPLOYED bytecode of the proxy's
// implementations on 4663, not just lighter-contracts' source: the instance
// omits the legacy USDC functions and the NIL-account changePubKey shortcut the
// GitHub main branch has. perps.test.ts pins each selector.
//
// ONE FUNCTION PER GRANTED CONSTANT:
// the call-policy builder resolves a selector from the ABI by name, and a list
// holding a second function is a second thing a permission might one day be
// built from. The three the session key may call are separate constants; the
// reads, the owner's escape hatches and the events live apart so none of them
// can be granted by accident.

/**
 * `deposit(_to, _assetIndex, _routeType, _amount)` — posts USDG margin. The
 * Lighter account is keyed on `_to` and created by the first deposit, so the
 * wall pins `_to` to the account itself, asset 3, route 0 (perps), and
 * `_amount ≤ perTradeUsdg` — all four words. Payable in the contract (native
 * ETH deposits share the entry point); every permission has valueLimit 0.
 * `_routeType` is a Solidity enum (TxTypes.RouteType), which the ABI encodes as
 * uint8 — hence the selector 0x8a857083.
 */
export const LIGHTER_DEPOSIT_ABI = [
  {
    type: "function",
    name: "deposit",
    stateMutability: "payable",
    inputs: [
      { name: "_to", type: "address" },
      { name: "_assetIndex", type: "uint16" },
      { name: "_routeType", type: "uint8" },
      { name: "_amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/**
 * `changePubKey(_accountIndex, _apiKeyIndex, _pubKey)` — registers a trading
 * key, authenticated only by msg.sender being the account's L1 address, which
 * is why a Kernel can do it with no EIP-191/1271 signature.
 *
 * THE ONE DYNAMIC ARGUMENT THE WALL PINS. `bytes` puts an offset in word 2 and
 * the length in word 3, with the 40 key bytes in words 4–5 (the tail of word 5
 * zero-padded). The wall pins the offset (0x60), the length (40) and both data
 * words; without the offset pin the decoder could be pointed at other bytes.
 * `pubKeyWords` in perps.ts builds w4/w5 and perps.test.ts proves them against
 * viem's encoder.
 */
export const LIGHTER_CHANGE_PUBKEY_ABI = [
  {
    type: "function",
    name: "changePubKey",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_accountIndex", type: "uint48" },
      { name: "_apiKeyIndex", type: "uint8" },
      { name: "_pubKey", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

/**
 * `withdrawPendingBalance(_owner, _assetIndex, _baseAmount)` — claims a secure
 * withdrawal once it is pending on the contract. Anyone may call it and it
 * always pays `_owner` (Lighter's relayer usually claims first), so with
 * `_owner` pinned to self the amount can stay open: the only reachable effect
 * is paying this account what it is already owed. Emits WithdrawPending.
 */
export const LIGHTER_WITHDRAW_PENDING_ABI = [
  {
    type: "function",
    name: "withdrawPendingBalance",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_owner", type: "address" },
      { name: "_assetIndex", type: "uint16" },
      { name: "_baseAmount", type: "uint128" },
    ],
    outputs: [],
  },
] as const;

/**
 * Views the worker and the recover disclosure read. NEVER GRANTED.
 *
 * `addressToAccountIndex` returns 0 for an address that has never deposited
 * (account indexes start above 0), which is how an agent without perps reads a
 * known-zero venue term without ever calling Lighter's API.
 *
 * `assetConfigs` is the public getter of `mapping(uint16 => AssetConfig)`; it
 * returns the struct's members in declaration order (lighter-contracts
 * ExtendableStorage.sol). A claim pays `baseAmount × tickSize`.
 */
export const LIGHTER_READ_ABI = [
  {
    type: "function",
    name: "addressToAccountIndex",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint48" }],
  },
  {
    type: "function",
    name: "getPendingBalance",
    stateMutability: "view",
    inputs: [
      { name: "_owner", type: "address" },
      { name: "_assetIndex", type: "uint16" },
    ],
    outputs: [{ name: "", type: "uint128" }],
  },
  {
    type: "function",
    name: "assetConfigs",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint16" }],
    outputs: [
      { name: "tokenAddress", type: "address" },
      { name: "withdrawalsEnabled", type: "uint8" },
      { name: "extensionMultiplier", type: "uint56" },
      { name: "tickSize", type: "uint128" },
      { name: "depositCapTicks", type: "uint64" },
      { name: "minDepositTicks", type: "uint64" },
    ],
  },
] as const;

/**
 * The OWNER's escape hatches — L1 priority requests the account's L1 address
 * (the Kernel, in a sudo UserOp signed with the owner key) can make without
 * the API key. NEVER GRANTED to the session key: `withdraw` and
 * `cancelAllOrders` would let it strip the venue stops rule 7 depends on, and
 * on-chain `createOrder`'s semantics on this instance are unproven until the
 * mainnet checklist records them.
 */
export const LIGHTER_OWNER_RECOVER_ABI = [
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_accountIndex", type: "uint48" },
      { name: "_assetIndex", type: "uint16" },
      { name: "_routeType", type: "uint8" },
      { name: "_baseAmount", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancelAllOrders",
    stateMutability: "nonpayable",
    inputs: [{ name: "_accountIndex", type: "uint48" }],
    outputs: [],
  },
  {
    type: "function",
    name: "createOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_accountIndex", type: "uint48" },
      { name: "_marketIndex", type: "uint16" },
      { name: "_baseAmount", type: "uint48" },
      { name: "_price", type: "uint32" },
      { name: "_isAsk", type: "uint8" },
      { name: "_orderType", type: "uint8" },
    ],
    outputs: [],
  },
] as const;

/**
 * The proxy's margin events, which the capital classifier's venue-margin arm
 * and payout recognition read from receipts (rule 12). `Deposit` indexes
 * nothing; `WithdrawPending` indexes `owner`, so a payout to this account is a
 * topic1 match. topic0 of each is pinned in LIGHTER_ROUTE_V1.topics.
 */
export const LIGHTER_EVENTS_ABI = [
  {
    type: "event",
    name: "Deposit",
    inputs: [
      { name: "toAccountIndex", type: "uint48", indexed: false },
      { name: "toAddress", type: "address", indexed: false },
      { name: "assetIndex", type: "uint16", indexed: false },
      { name: "routeType", type: "uint8", indexed: false },
      { name: "baseAmount", type: "uint128", indexed: false },
    ],
  },
  {
    type: "event",
    name: "WithdrawPending",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "assetIndex", type: "uint16", indexed: false },
      { name: "baseAmount", type: "uint128", indexed: false },
    ],
  },
] as const;
