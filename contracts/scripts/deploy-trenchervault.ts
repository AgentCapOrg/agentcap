/** Explicit operator deployment. No tenant/session keys are read by this script. */
import hre from "hardhat";
import { keccak256, erc20Abi } from "viem";
import { writeFileSync } from "node:fs";

const infrastructure = [
  // packages/core tokens.ts CASH and protocols.ts PANCAKESWAP.
  "0x55d398326f99059fF775485246999027B3197955", // USDT (18dp)
  "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
  "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4", // PancakeSwap smart router
  "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865", // PancakeSwap v3 factory
] as const;

async function main() {
  const client=await hre.viem.getPublicClient();
  const chainId=await client.getChainId();
  if (chainId!==56) throw new Error("This deployment manifest targets BNB Chain mainnet 56 only");
  const [deployer]=await hre.viem.getWalletClients();
  if (!deployer) throw new Error("Set AGENTCAP_DEPLOYER_PRIVATE_KEY in the operator environment; never use a tenant session key");
  for (const address of infrastructure) {
    const code=await client.getCode({address});
    if (!code||code==="0x") throw new Error(`Infrastructure is absent at ${address}`);
  }
  if (await client.readContract({address:infrastructure[0],abi:erc20Abi,functionName:"decimals"})!==18) throw new Error("Unexpected cash precision");
  // The explicit flag avoids an inspection command accidentally spending deployment gas.
  if (process.env.TRENCHER_DEPLOY!=="1") throw new Error("Preflight passed. Set TRENCHER_DEPLOY=1 to deploy the reviewed contract");
  const factory=await hre.viem.deployContract("TrencherVaultFactory",[...infrastructure]);
  const code=await client.getCode({address:factory.address});
  if (!code||code==="0x") throw new Error("Deployment has no runtime bytecode");
  const codeHash=keccak256(code);
  const manifest={chainId,factory:factory.address,codeHash,infrastructure,compiler:"0.8.28",perBuyUsdg:5,dailyBuysUsdg:25};
  writeFileSync("trencher-deployment.json",JSON.stringify(manifest,null,2)+"\n");
  console.log(JSON.stringify(manifest,null,2));
  console.log("Publish the factory address and runtime hash together after verifying the deployed source. No agent permissions were changed.");
}
main().catch(error=>{console.error(error instanceof Error?error.message:"Deployment failed");process.exitCode=1;});
