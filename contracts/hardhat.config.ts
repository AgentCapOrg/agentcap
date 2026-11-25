import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-viem";

const config: HardhatUserConfig = {
  solidity: {
    // The `compilers` array form, not the `version`/`settings` shorthand:
    // hardhat only honours `overrides` alongside `compilers`.
    compilers: [{ version: "0.8.28", settings: { optimizer: { enabled: true, runs: 200 } } }],
  },
  // Deploy targets: BNB Chain mainnet 56 / testnet 97.
  //
  // The deployer key comes from the ENVIRONMENT, never a file: set
  // AGENTCAP_DEPLOYER_PRIVATE_KEY in the shell that runs the deploy, and close
  // that shell afterwards. When it is absent, `accounts` is empty and
  // compile/test behave exactly as before — nothing in CI needs the key.
  networks: {
    bscTestnet: {
      url: "https://bsc-testnet-dataseed.bnbchain.org",
      chainId: 97,
      accounts: process.env.AGENTCAP_DEPLOYER_PRIVATE_KEY ? [process.env.AGENTCAP_DEPLOYER_PRIVATE_KEY] : [],
    },
    bsc: {
      url: "https://bsc-dataseed.bnbchain.org",
      chainId: 56,
      accounts: process.env.AGENTCAP_DEPLOYER_PRIVATE_KEY ? [process.env.AGENTCAP_DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};

export default config;
