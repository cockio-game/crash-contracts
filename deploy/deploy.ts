import { Wallet }                          from "zksync-ethers";
import { Deployer }                        from "@matterlabs/hardhat-zksync-deploy"; // <-- THE FIX IS HERE
import type { HardhatRuntimeEnvironment }  from "hardhat/types";
import { ethers }                          from "ethers";

/**
 * Deploys the CrashSteps contract to the specified network.
 *
 * Example command:
 * npx hardhat deploy-zksync --script deploy.ts --network abstractTestnet
 */
export default async function (hre: HardhatRuntimeEnvironment) {
    console.log("🚀 Starting deployment script...");

    // --- 1. Check for environment variables ---
    if (!process.env.DEPLOYER_PK) {
        throw new Error("❌ DEPLOYER_PK is not set in the .env file. Please add it.");
    }
    if (!process.env.ORACLE_ADDR) {
        throw new Error("❌ ORACLE_ADDR is not set in the .env file. Please add it.");
    }
    if (!ethers.isAddress(process.env.ORACLE_ADDR)) {
        throw new Error(`❌ Invalid ORACLE_ADDR: ${process.env.ORACLE_ADDR}. It must be a valid Ethereum address.`);
    }

    // --- 2. Initialize the deployer ---
    const wallet = new Wallet(process.env.DEPLOYER_PK);
    const deployer = new Deployer(hre, wallet);
    console.log(`✅ Deployer initialized with wallet: ${wallet.address}`);

    // --- 3. Load artifact and deploy ---
    const artifact = await deployer.loadArtifact("CrashSteps");
    const oracleAddress = process.env.ORACLE_ADDR;
    const args = [oracleAddress];
    
    console.log(`\nDeploying ${artifact.contractName} with oracle address: ${oracleAddress}...`);
    const contract = await deployer.deploy(artifact, args);

    const contractAddress = await contract.getAddress();
    console.log(`✅ ${artifact.contractName} deployed to => ${contractAddress}`);

    // --- 4. Wait for block explorer to index the transaction ---
    console.log("\n⏳ Waiting 15 seconds for block finalization before verification...");
    await new Promise(r => setTimeout(r, 15_000));

    // --- 5. Verify the contract on the block explorer ---
    console.log("🕵️ Verifying contract on the block explorer...");
    try {
        await hre.run("verify:verify", {
            address: contractAddress,
            contract: "contracts/CrashSteps.sol:CrashSteps", // Fully qualified name
            constructorArguments: args,
        });
        console.log("✅ Contract verified successfully!");
    } catch (error) {
        console.error("❌ Verification failed. The contract is still deployed, but you may need to verify it manually.");
    }

    console.log("\n🎉 Deployment script finished successfully!");
}