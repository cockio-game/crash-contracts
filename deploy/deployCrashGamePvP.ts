import { Wallet } from "zksync-ethers";
import { Deployer } from "@matterlabs/hardhat-zksync-deploy";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { ethers } from "ethers";

/**
 * Deploys the CrashGamePvP contract to the specified network.
 *
 * Example command:
 * npx hardhat deploy-zksync --script deployCrashGamePvP.ts --network abstractTestnet
 */
export default async function (hre: HardhatRuntimeEnvironment) {
    console.log("🚀 Starting CrashGamePvP deployment script...");

    // --- 1. Check for environment variables ---
    if (!process.env.DEPLOYER_PK) {
        throw new Error("❌ DEPLOYER_PK is not set in the .env file. Please add it.");
    }
    
    // Use ORACLE_ADDR if set, otherwise use deployer address
    const oracleAddress = process.env.ORACLE_ADDR || process.env.ORACLE_ADDRESS;
    if (!oracleAddress) {
        console.log("⚠️  ORACLE_ADDR not set, using deployer address as oracle for testing");
    }

    // --- 2. Initialize the deployer ---
    const wallet = new Wallet(process.env.DEPLOYER_PK);
    const deployer = new Deployer(hre, wallet);
    console.log(`✅ Deployer initialized with wallet: ${wallet.address}`);

    // --- 3. Use oracle address or deployer address ---
    const finalOracleAddress = oracleAddress || wallet.address;
    console.log(`📋 Using oracle address: ${finalOracleAddress}`);

    // --- 4. Load artifact and deploy ---
    const artifact = await deployer.loadArtifact("CrashGamePvP");
    const args = [finalOracleAddress];
    
    console.log(`\nDeploying ${artifact.contractName} with oracle address: ${finalOracleAddress}...`);
    const contract = await deployer.deploy(artifact, args);

    const contractAddress = await contract.getAddress();
    console.log(`✅ ${artifact.contractName} deployed to => ${contractAddress}`);

    // --- 5. Configure merge tolerance to 1% (100 bps) ---
    try {
        const currentTol: bigint = await (contract as any).mergeToleranceBp();
        if (currentTol !== 100n) {
            console.log("\n⚙️  Setting mergeToleranceBp to 1% (100 bps)...");
            const tx = await (contract as any).setMergeToleranceBp(100);
            await tx.wait();
            console.log("✅ mergeToleranceBp set to 100 bps");
        } else {
            console.log("\nℹ️  mergeToleranceBp already set to 100 bps");
        }
    } catch (e) {
        console.log("\n⚠️  Could not set mergeToleranceBp automatically (continuing). Error:", e);
    }

    // --- 6. Wait for block explorer to index the transaction ---
    console.log("\n⏳ Waiting 15 seconds for block finalization before verification...");
    await new Promise(r => setTimeout(r, 15_000));

    // --- 7. Verify the contract on the block explorer ---
    console.log("🕵️ Verifying contract on the block explorer...");
    try {
        await hre.run("verify:verify", {
            address: contractAddress,
            contract: "contracts/pvp/CrashGamePvP.sol:CrashGamePvP",
            constructorArguments: args,
        });
        console.log("✅ Contract verified successfully!");
    } catch (error) {
        console.error("❌ Verification failed. The contract is still deployed, but you may need to verify it manually.");
        console.error(error);
    }

    console.log("\n🎉 Deployment script finished successfully!");
    console.log("\n📝 Next steps:");
    console.log(`1. Update your .env file:`);
    console.log(`   NEXT_PUBLIC_CRASH_PVP_CONTRACT=${contractAddress}`);
    console.log(`2. Run: npx prisma migrate dev --name add_match_id_to_queue`);
    console.log(`3. Restart your development server`);
}
