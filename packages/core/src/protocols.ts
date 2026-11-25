/**
 * Protocol deployments — BNB Chain mainnet (56).
 * Checked on-chain 2026-11-24: every address has code, and smartRouter,
 * v3QuoterV2 and v3PositionManager report this v3Factory, this
 * v3PoolDeployer and WBNB.
 */

/**
 * PancakeSwap. v3 is a Uniswap v3 fork with three differences that matter:
 *  - fee tiers are 100 / 500 / 2500 / 10000 — there is NO 3000 tier;
 *  - pools are CREATE2-deployed by v3PoolDeployer, not by the factory;
 *  - slot0.feeProtocol is a uint32, so Uniswap's uint8 ABI fails to decode.
 * smartRouter's exactInputSingle / exactInput take no deadline, the same
 * shape as Uniswap's SwapRouter02.
 */
export const PANCAKESWAP = {
  smartRouter: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
  v3Factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
  v3PoolDeployer: "0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9",
  v3QuoterV2: "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997",
  v3PositionManager: "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364",
  v2Factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
} as const;

/** Every PancakeSwap v3 fee tier, in hundredths of a basis point. */
export const PANCAKESWAP_V3_FEE_TIERS = [100, 500, 2500, 10000] as const;
