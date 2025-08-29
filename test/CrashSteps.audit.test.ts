/* eslint-env mocha */

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("CrashSteps – audit follow-ups", () => {
  const BP_DENOM = 10_000n;

  let owner: any;
  let oracle: any;
  let player: any;
  let steps: any;

  before(async () => {
    [owner] = await ethers.getSigners();
    oracle = ethers.Wallet.createRandom().connect(owner.provider);
    player = ethers.Wallet.createRandom().connect(owner.provider);

    // Fund test wallets
    for (const w of [oracle, player]) {
      await owner.sendTransaction({ to: w.address, value: ethers.parseEther("1") });
    }
  });

  beforeEach(async () => {
    const Factory = await ethers.getContractFactory("CrashSteps", owner);
    steps = await Factory.deploy(oracle.address);
    await steps.waitForDeployment();
    // Seed house bankroll
    await owner.sendTransaction({ to: await steps.getAddress(), value: ethers.parseEther("5") });
  });

  it("includes unpaid referral balances in totalLiability and decrements on withdraw", async () => {
    // Deploy a receiver that rejects ETH to force referral push failure
    const RR = await ethers.getContractFactory("RevertingReceiver", owner);
    const rr = await RR.deploy();
    await rr.waitForDeployment();

    // Disable ETH reception so referral push fails
    await rr.setAcceptETH(false);

    const platformBp = BigInt(await steps.platformFeeBp());
    const referralBp = BigInt(await steps.referralFeeBp());
    const amount = ethers.parseEther("0.002");
    const netStake = amount - (amount * platformBp) / BP_DENOM;
    const expectedCap = (netStake * BigInt(await steps.maxPayoutFactorBp())) / BP_DENOM;
    const referralCut = (amount * referralBp) / BP_DENOM;

    await steps.connect(player).deposit(await rr.getAddress(), { value: amount });

    expect(await steps.referralBalances(await rr.getAddress())).to.equal(referralCut);
    expect(await steps.referralEarned(await rr.getAddress())).to.equal(referralCut);
    expect(await steps.capLiability()).to.equal(expectedCap);
    expect(await steps.referralLiability()).to.equal(referralCut);
    expect(await steps.totalLiability()).to.equal(expectedCap + referralCut);

    // Re-enable ETH reception and withdraw referral balance
    await rr.setAcceptETH(true);
    await rr.withdrawReferralFromSteps(await steps.getAddress());

    expect(await steps.referralBalances(await rr.getAddress())).to.equal(0n);
    expect(await steps.referralLiability()).to.equal(0n);
    expect(await steps.totalLiability()).to.equal(expectedCap);
  });

  it("scales outstanding liability when maxPayoutFactorBp changes (H-01)", async () => {
    const amount = ethers.parseEther("0.002");
    const platformBp = BigInt(await steps.platformFeeBp());
    const netStake = amount - (amount * platformBp) / BP_DENOM;
    const old = BigInt(await steps.maxPayoutFactorBp());
    const capOld = (netStake * old) / BP_DENOM;

    await steps.connect(player).deposit(ethers.ZeroAddress, { value: amount });
    expect(await steps.capLiability()).to.equal(capOld);
    expect(await steps.totalLiability()).to.equal(capOld);

    const twice = Number(old) * 2;
    await steps.connect(owner).setMaxPayoutFactorBp(twice);
    const capNew = (netStake * BigInt(twice)) / BP_DENOM;

    expect(await steps.capLiability()).to.equal(capNew);
    expect(await steps.totalLiability()).to.equal(capNew);

    // Claim should clear liability under the new cap
    const reward = amount; // 1x payout within cap
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domain = { name: "CrashReceipt", version: "2", chainId, verifyingContract: await steps.getAddress() } as const;
    const types = { CrashReceipt: [
      { name: "player", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "reward", type: "uint256" },
    ] } as const;
    const value = { player: player.address, nonce: 0n, reward } as const;
    const sig = await oracle.signTypedData(domain, types, value);
    await steps.connect(player).claim(0, reward, sig);

    expect(await steps.capLiability()).to.equal(0n);
    expect(await steps.totalLiability()).to.equal(0n);
  });

  it("emits OracleRotated when oracle changes", async () => {
    const newOracle = ethers.Wallet.createRandom().connect(owner.provider);
    await expect(steps.connect(owner).rotateOracle(newOracle.address))
      .to.emit(steps, "OracleRotated").withArgs(await oracle.getAddress(), newOracle.address);
  });
});

