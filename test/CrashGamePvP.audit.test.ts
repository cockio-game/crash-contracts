import { expect } from "chai";
import { ethers } from "hardhat";

describe("CrashGamePvP – audit follow-ups", function () {
  let escrow: CrashGamePvP;
  let owner: any;
  let oracle: any;
  let p1: any;
  let p2: any;

  beforeEach(async function () {
    [owner, oracle, p1, p2] = await ethers.getSigners();
    const EscrowFactory = await ethers.getContractFactory("CrashGamePvP");
    escrow = await EscrowFactory.deploy(oracle.address, owner.address);
    await escrow.waitForDeployment();
  });

  async function signApprovalFor(player: string, amount: bigint) {
    const domain = {
      name: "CrashGamePvP",
      version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: await escrow.getAddress(),
    } as const;
    const types = {
      BetApproval: [
        { name: "player", type: "address" },
        { name: "version", type: "uint256" },
        { name: "amount", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    } as const;
    const now = (await ethers.provider.getBlock("latest"))!.timestamp;
    const deadline = BigInt(now) + 3600n;
    const value = { player, version: 1n, amount, deadline } as const;
    const sig = await oracle.signTypedData(domain, types, value);
    return { sig, deadline };
  }

  it("uses fractional fee basis points in payouts (I-06)", async function () {
    // Set fractional fee 1.23%
    await escrow.connect(owner).setFeeBp(123);

    const wager = ethers.parseEther("0.01");
    const { sig: s1, deadline: d1 } = await signApprovalFor(p1.address, wager);
    const tx = await escrow
      .connect(p1)
      ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, d1, s1, { value: wager });
    const rc = await tx.wait();
    const matchId = escrow.interface.parseLog({ topics: rc!.logs[0].topics as string[], data: rc!.logs[0].data })
      ?.args?.[0] as bigint;

    const { sig: s2, deadline: d2 } = await signApprovalFor(p2.address, wager);
    await escrow
      .connect(p2)
      ["joinMatch(uint256,address,uint256,address,uint256,bytes)"](matchId, p1.address, wager, ethers.ZeroAddress, d2, s2, { value: wager });

    // Settle with p1 as winner
    await escrow.connect(oracle).settleMatch(matchId, p1.address);

    const totalPot = wager * 2n;
    const fee = (totalPot * 123n) / 10_000n;
    const netPot = totalPot - fee;

    expect(await escrow.userBalance(p1.address)).to.equal(netPot);
    expect(await escrow.feeClaimable(await owner.getAddress())).to.equal(fee);
  });
});

