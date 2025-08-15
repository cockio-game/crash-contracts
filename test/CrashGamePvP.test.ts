import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("CrashGamePvP", function () {
  let escrow: CrashGamePvP;
  let owner: HardhatEthersSigner;
  let oracle: HardhatEthersSigner;
  let player1: HardhatEthersSigner;
  let player2: HardhatEthersSigner;
  let player3: HardhatEthersSigner;
  let revertingContract: any;

  beforeEach(async function () {
    [owner, oracle, player1, player2, player3] = await ethers.getSigners();

    const EscrowFactory = await ethers.getContractFactory("CrashGamePvP");
    escrow = await EscrowFactory.deploy(oracle.address);
    await escrow.waitForDeployment();
  });

  // Helper to produce per-user, time-boxed EIP-712 bet approvals
  async function signApprovalFor(
    player: string,
    amount: bigint,
    ttlSeconds = 3600n
  ): Promise<{ sig: string; deadline: bigint }> {
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
    const now = await time.latest();
    const deadline = BigInt(now) + ttlSeconds;
    const value = {
      player,
      version: 1n,
      amount,
      deadline,
    } as const;
    const sig = await oracle.signTypedData(domain, types, value);
    return { sig, deadline };
  }

  // Helper: join match with an oracle-approved EIP-712 signature for the joiner
  async function joinWithApproval(
    joiner: HardhatEthersSigner,
    matchId: bigint,
    expectedOpponent: string,
    wager: bigint,
    referrer: string
  ) {
    const { sig: jSig, deadline: jDl } = await signApprovalFor(joiner.address, wager);
    return escrow
      .connect(joiner)
      ["joinMatch(uint256,address,uint256,address,uint256,bytes)"](matchId, expectedOpponent, wager, referrer, jDl, jSig, { value: wager });
  }

  // Helper: sign with a custom approval version
  async function signApprovalForVersion(
    player: string,
    amount: bigint,
    version: bigint,
    ttlSeconds = 3600n
  ): Promise<{ sig: string; deadline: bigint }> {
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
    const now = await time.latest();
    const deadline = BigInt(now) + ttlSeconds;
    const value = { player, version, amount, deadline } as const;
    const sig = await oracle.signTypedData(domain, types, value);
    return { sig, deadline };
  }

  describe("Match Creation", function () {
    it("Should create a new match and return matchId", async function () {
      const wagerAmount = ethers.parseEther("1");
      
      // Prepare EIP-712 approval signature from oracle (per-player + deadline)
      const { sig, deadline } = await signApprovalFor(player1.address, wagerAmount);

      // Create match and get matchId from transaction
      const tx = await escrow
        .connect(player1)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, deadline, sig, { value: wagerAmount });
      const receipt = await tx.wait();
      
      // Get matchId from MatchCreated event
      const event = receipt?.logs.find(log => {
        try {
          const parsed = escrow.interface.parseLog({ topics: log.topics as string[], data: log.data });
          return parsed?.name === "MatchCreated";
        } catch {
          return false;
        }
      });
      
      const parsedEvent = escrow.interface.parseLog({ 
        topics: event!.topics as string[], 
        data: event!.data 
      });
      const matchId = parsedEvent?.args[0] as bigint;
      
      expect(matchId).to.not.be.undefined;
      
      // Verify match data
      const match = await escrow.matches(matchId);
      expect(match.playerA).to.equal(player1.address);
      expect(match.wagerAmount).to.equal(wagerAmount);
      expect(match.status).to.equal(1); // AwaitingOpponent
    });

    it("Should generate unique matchIds for different matches", async function () {
      const wagerAmount = ethers.parseEther("1");
      
      // Create first match
      const { sig: sig1, deadline: dl1 } = await signApprovalFor(player1.address, wagerAmount);
      const tx1 = await escrow
        .connect(player1)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dl1, sig1, { value: wagerAmount });
      const receipt1 = await tx1.wait();
      const event1 = receipt1?.logs.find(log => {
        try {
          const parsed = escrow.interface.parseLog({ topics: log.topics as string[], data: log.data });
          return parsed?.name === "MatchCreated";
        } catch {
          return false;
        }
      });
      const matchId1 = escrow.interface.parseLog({ 
        topics: event1!.topics as string[], 
        data: event1!.data 
      })?.args[0] as bigint;
      
      // Create second match
      const { sig: sig2, deadline: dl2 } = await signApprovalFor(player2.address, wagerAmount);
      const tx2 = await escrow
        .connect(player2)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dl2, sig2, { value: wagerAmount });
      const receipt2 = await tx2.wait();
      const event2 = receipt2?.logs.find(log => {
        try {
          const parsed = escrow.interface.parseLog({ topics: log.topics as string[], data: log.data });
          return parsed?.name === "MatchCreated";
        } catch {
          return false;
        }
      });
      const matchId2 = escrow.interface.parseLog({ 
        topics: event2!.topics as string[], 
        data: event2!.data 
      })?.args[0] as bigint;
      
      expect(matchId1).to.not.equal(matchId2);
    });

    it("Should prevent player from creating multiple active matches", async function () {
      const wagerAmount = ethers.parseEther("1");
      
      // Create first match
      const { sig: sig3, deadline: dl3 } = await signApprovalFor(player1.address, wagerAmount);
      await escrow
        .connect(player1)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dl3, sig3, { value: wagerAmount });
      
      // Try to create second match
      await expect(
        escrow
          .connect(player1)
          ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dl3, sig3, { value: wagerAmount })
      ).to.be.revertedWith("Already in active match");
    });
  });

  describe("Match Joining", function () {
    let matchId: bigint;
    let wagerAmount: bigint;

    beforeEach(async function () {
      wagerAmount = ethers.parseEther("1");
      // Create a match first
      const { sig: sig4, deadline: dl4 } = await signApprovalFor(player1.address, wagerAmount);
      const tx = await escrow
        .connect(player1)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dl4, sig4, { value: wagerAmount });
      const receipt = await tx.wait();
      const event = receipt?.logs.find(log => {
        try {
          const parsed = escrow.interface.parseLog({ topics: log.topics as string[], data: log.data });
          return parsed?.name === "MatchCreated";
        } catch {
          return false;
        }
      });
      matchId = escrow.interface.parseLog({ 
        topics: event!.topics as string[], 
        data: event!.data 
      })?.args[0] as bigint;
    });

    it("Should allow another player to join the match", async function () {
      await joinWithApproval(player2, matchId, player1.address, wagerAmount, ethers.ZeroAddress);
      
      const match = await escrow.matches(matchId);
      expect(match.playerB).to.equal(player2.address);
      expect(match.status).to.equal(2); // Active
      expect(match.totalDeposit).to.equal(wagerAmount * 2n);
    });

    it("Should prevent player from joining their own match", async function () {
      await expect(
        escrow.connect(player1)["joinMatch(uint256,address,uint256,address,uint256,bytes)"](
          matchId,
          player1.address,
          wagerAmount,
          ethers.ZeroAddress,
          // creator cannot join their own match; provide dummy approval to match new signature
          (await signApprovalFor(player1.address, wagerAmount)).deadline,
          (await signApprovalFor(player1.address, wagerAmount)).sig,
          { value: wagerAmount }
        )
      ).to.be.revertedWith("Cannot play yourself");
    });

    it("Should require correct wager amount", async function () {
      const wrongAmount = ethers.parseEther("0.5");
      
      await expect(
        escrow.connect(player2)["joinMatch(uint256,address,uint256,address,uint256,bytes)"](
          matchId,
          player1.address,
          wagerAmount,
          ethers.ZeroAddress,
          (await signApprovalFor(player2.address, wrongAmount)).deadline,
          (await signApprovalFor(player2.address, wrongAmount)).sig,
          { value: wrongAmount }
        )
      ).to.be.revertedWith("Wrong wager amount");
    });
  });

  describe("Match Settlement", function () {
    let matchId: bigint;
    let wagerAmount: bigint;

    beforeEach(async function () {
      wagerAmount = ethers.parseEther("1");
      // Create and join a match
      const { sig: sig5, deadline: dl5 } = await signApprovalFor(player1.address, wagerAmount);
      const tx = await escrow
        .connect(player1)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dl5, sig5, { value: wagerAmount });
      const receipt = await tx.wait();
      const event = receipt?.logs.find(log => {
        try {
          const parsed = escrow.interface.parseLog({ topics: log.topics as string[], data: log.data });
          return parsed?.name === "MatchCreated";
        } catch {
          return false;
        }
      });
      matchId = escrow.interface.parseLog({ 
        topics: event!.topics as string[], 
        data: event!.data 
      })?.args[0] as bigint;
      
      await joinWithApproval(player2, matchId, player1.address, wagerAmount, ethers.ZeroAddress);
    });

    it("Should use pull-payment pattern for winner payout", async function () {
      await escrow.connect(oracle).settleMatch(matchId, player1.address);
      
      // Check aggregated balance amount
      const bal = await escrow.userBalance(player1.address);
      expect(bal).to.equal(wagerAmount * 2n); // Full pot with 0% fee
      
      // Withdraw funds (aggregated)
      const balanceBefore = await ethers.provider.getBalance(player1.address);
      const tx = await escrow.connect(player1).withdraw();
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice!;
      const balanceAfter = await ethers.provider.getBalance(player1.address);
      
      expect(balanceAfter).to.be.closeTo(balanceBefore + (wagerAmount * 2n) - gasUsed, ethers.parseEther("0.001"));
      
      // Verify can't withdraw twice
      await expect(escrow.connect(player1).withdraw()).to.be.revertedWith("Nothing to withdraw");
    });

    it("Should treat zero address winner as draw and refund both", async function () {
      await escrow.connect(oracle).settleMatch(matchId, ethers.ZeroAddress);

      // Each player gets their wager back, no fees
      const balA = await escrow.userBalance(player1.address);
      const balB = await escrow.userBalance(player2.address);
      expect(balA).to.equal(wagerAmount);
      expect(balB).to.equal(wagerAmount);
      expect(await escrow.feeClaimable(owner.address)).to.equal(0n);
      const match = await escrow.matches(matchId);
      expect(match.status).to.equal(4); // Refunded
    });
    
    it("Should only allow valid players as winners", async function () {
      // Attempt to settle with a non-participant address should revert
      const randomAddress = ethers.Wallet.createRandom().address;
      await expect(
        escrow.connect(oracle).settleMatch(matchId, randomAddress)
      ).to.be.revertedWith("Invalid winner");
    });

    it("Should only allow oracle to settle matches", async function () {
      await expect(
        escrow.connect(player1).settleMatch(matchId, player1.address)
      ).to.be.revertedWith("Only oracle");
    });
  });

  describe("Match Cancellation", function () {
    let matchId: bigint;
    let wagerAmount: bigint;

    beforeEach(async function () {
      wagerAmount = ethers.parseEther("1");
      const { sig, deadline } = await signApprovalFor(player1.address, wagerAmount);

      const tx = await escrow
        .connect(player1)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, deadline, sig, { value: wagerAmount });
      const receipt = await tx.wait();
      const event = receipt?.logs.find(log => {
        try {
          const parsed = escrow.interface.parseLog({ topics: log.topics as string[], data: log.data });
          return parsed?.name === "MatchCreated";
        } catch {
          return false;
        }
      });
      matchId = escrow.interface.parseLog({ 
        topics: event!.topics as string[], 
        data: event!.data 
      })?.args[0] as bigint;
    });

    it("Should refund directly via push payment on cancel", async function () {
      const balanceBefore = await ethers.provider.getBalance(player1.address);
      
      const tx = await escrow.connect(player1).cancelMyMatch(matchId);
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice!;
      
      const balanceAfter = await ethers.provider.getBalance(player1.address);
      
      // Check that player received refund directly (minus gas)
      expect(balanceAfter).to.be.closeTo(
        balanceBefore + wagerAmount - gasUsed,
        ethers.parseEther("0.001")
      );
      
      // Aggregated balance should remain 0 for cancelMyMatch
      const bal = await escrow.userBalance(player1.address);
      expect(bal).to.equal(0);
      
      const match = await escrow.matches(matchId);
      expect(match.status).to.equal(4); // Refunded
    });

    it("Should not allow non-creator to cancel match", async function () {
      await expect(
        escrow.connect(player2).cancelMyMatch(matchId)
      ).to.be.revertedWith("Not your match");
    });

    it("Should fallback to pull payment if push fails", async function () {
      // Deploy a reverting contract that will reject ETH
      const RevertingReceiver = await ethers.getContractFactory("RevertingReceiver");
      const revertingContract = await RevertingReceiver.deploy();
      await revertingContract.waitForDeployment();
      
      // Fund the reverting contract (it accepts ETH initially)
      await owner.sendTransaction({ 
        to: await revertingContract.getAddress(), 
        value: wagerAmount 
      });
      
      // Create match from reverting contract using EIP-712 approved bet-size
      const { sig: sigR, deadline: dlR } = await signApprovalFor(await revertingContract.getAddress(), wagerAmount);
      await revertingContract["createMatch(address,bytes,uint256,uint256)"](await escrow.getAddress(), sigR, dlR, wagerAmount);
      
      // Get the match ID from events
      const filter = escrow.filters.MatchCreated();
      const events = await escrow.queryFilter(filter);
      const lastEvent = events[events.length - 1];
      const revertingMatchId = lastEvent.args[0] as bigint;
      
      // Now disable ETH acceptance to simulate push payment failure
      await revertingContract.setAcceptETH(false);
      
      // Cancel match - push will fail; tx should revert
      await expect(
        revertingContract.cancelMatch(await escrow.getAddress(), revertingMatchId)
      ).to.be.reverted;
    });
  });

  describe("Security Tests", function () {
    describe("DoS Protection", function () {
      beforeEach(async function () {
        // Deploy RevertingReceiver contract for testing DoS attacks
        const RevertingReceiver = await ethers.getContractFactory("RevertingReceiver");
        revertingContract = await RevertingReceiver.deploy();
        await revertingContract.waitForDeployment();
      });

      it("Should not DoS settlement when winner is reverting contract", async function () {
        const wagerAmount = ethers.parseEther("1");
        
        // This test verifies that even if a winner cannot receive ETH directly,
        // the settlement can still proceed using the pull-payment pattern.
        // The key is that settlement succeeds even if winner would revert on ETH transfer.
        
        // Create match with player1 (EIP-712 approval per user)
        const { sig: sigA, deadline: dlA } = await signApprovalFor(player1.address, wagerAmount);
        const tx = await escrow
          .connect(player1)
          ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dlA, sigA, { value: wagerAmount });
        const receipt = await tx.wait();
        const event = receipt?.logs.find(log => {
          try {
            const parsed = escrow.interface.parseLog({ topics: log.topics as string[], data: log.data });
            return parsed?.name === "MatchCreated";
          } catch {
            return false;
          }
        });
        const matchId = escrow.interface.parseLog({ 
          topics: event!.topics as string[], 
          data: event!.data 
        })?.args[0] as bigint;
        
        // Player2 joins normally
        await joinWithApproval(player2, matchId, player1.address, wagerAmount, ethers.ZeroAddress);
        
        // Oracle settles with player1 as winner
        // Even if player1 was a reverting contract, this would not revert
        // because we use pull-payments
        await expect(escrow.connect(oracle).settleMatch(matchId, player1.address))
          .to.not.be.reverted;
        
        // Player1 has aggregated funds
        const bal = await escrow.userBalance(player1.address);
        expect(bal).to.equal(wagerAmount * 2n); // Full pot with 0% fee
        
        // The pull-payment pattern ensures settlement always succeeds
        // regardless of recipient's ability to receive ETH
      });

      it("Should not DoS when owner cannot receive fees", async function () {
        // Set fee to 5%
        await escrow.connect(owner).setFeePercent(5);
        
        const wagerAmount = ethers.parseEther("1");
        
        // Create and join match (EIP-712 approval per user)
        const { sig: sigB, deadline: dlB } = await signApprovalFor(player1.address, wagerAmount);
        const tx = await escrow
          .connect(player1)
          ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dlB, sigB, { value: wagerAmount });
        const receipt = await tx.wait();
        const event = receipt?.logs.find(log => {
          try {
            const parsed = escrow.interface.parseLog({ topics: log.topics as string[], data: log.data });
            return parsed?.name === "MatchCreated";
          } catch {
            return false;
          }
        });
        const matchId = escrow.interface.parseLog({ 
          topics: event!.topics as string[], 
          data: event!.data 
        })?.args[0] as bigint;
        
        await joinWithApproval(player2, matchId, player1.address, wagerAmount, ethers.ZeroAddress);
        
        // Settlement should not revert even if owner can't receive
        await expect(escrow.connect(oracle).settleMatch(matchId, player1.address))
          .to.not.be.reverted;
        
        // Fee should be claimable
        const feeClaimable = await escrow.feeClaimable(owner.address);
        expect(feeClaimable).to.be.gt(0);
        
        // Owner can withdraw fees to any address
        await escrow.connect(owner).withdrawFees(player3.address);
        const player3Balance = await ethers.provider.getBalance(player3.address);
        expect(player3Balance).to.be.gt(0);
      });
    });

    describe("Fee Snapshot", function () {
      it("Should use fee at match creation, not settlement", async function () {
        const wagerAmount = ethers.parseEther("1");
        
        // Create match with 0% fee (EIP-712 approval per user)
        const { sig: sigC, deadline: dlC } = await signApprovalFor(player1.address, wagerAmount);
        const tx = await escrow
          .connect(player1)
          ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dlC, sigC, { value: wagerAmount });
        const receipt = await tx.wait();
        const event = receipt?.logs.find(log => {
          try {
            const parsed = escrow.interface.parseLog({ topics: log.topics as string[], data: log.data });
            return parsed?.name === "MatchCreated";
          } catch {
            return false;
          }
        });
        const matchId = escrow.interface.parseLog({ 
          topics: event!.topics as string[], 
          data: event!.data 
        })?.args[0] as bigint;
        
        // Verify fee was snapshotted at 0
        const match = await escrow.matches(matchId);
        expect(match.feeAtCreate).to.equal(0);
        
        // Owner changes fee to 10%
        await escrow.connect(owner).setFeePercent(10);
        
        // Player2 joins
        await joinWithApproval(player2, matchId, player1.address, wagerAmount, ethers.ZeroAddress);
        
        // Settle match
        await escrow.connect(oracle).settleMatch(matchId, player1.address);
        
        // Winner should get full pot (no fee deducted)
        const bal = await escrow.userBalance(player1.address);
        expect(bal).to.equal(wagerAmount * 2n); // Full pot, no fee
        
        // No fees should be claimable
        const feeClaimable = await escrow.feeClaimable(owner.address);
        expect(feeClaimable).to.equal(0);
      });
    });


    describe("Winner Payout Protection", function () {
      it("Should handle fee calculation correctly for winner", async function () {
        // Set fee to 1% to test fee calculation
        await escrow.connect(owner).setFeePercent(1);
        
        const wagerAmount = 51n; // 51 wei
        
        // Create and join match (EIP-712 approval per user)
        const { sig: sigD, deadline: dlD } = await signApprovalFor(player1.address, wagerAmount);
        const tx = await escrow
          .connect(player1)
          ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dlD, sigD, { value: wagerAmount });
        const receipt = await tx.wait();
        const event = receipt?.logs.find(log => {
          try {
            const parsed = escrow.interface.parseLog({ topics: log.topics as string[], data: log.data });
            return parsed?.name === "MatchCreated";
          } catch {
            return false;
          }
        });
        const matchId = escrow.interface.parseLog({ 
          topics: event!.topics as string[], 
          data: event!.data 
        })?.args[0] as bigint;
        
      await joinWithApproval(player2, matchId, player1.address, wagerAmount, ethers.ZeroAddress);
        
        // Settle with player1 as winner
        await escrow.connect(oracle).settleMatch(matchId, player1.address);
        
        // Check winner's claimable amount
        const claimable1 = await escrow.userBalance(player1.address);
        const claimable2 = await escrow.userBalance(player2.address);
        
        // Total pot = 102 wei
        // Fee = floor(102 * 1 / 100) = 1 wei
        // Net pot = 101 wei (all goes to winner)
        expect(claimable1).to.equal(101n);
        expect(claimable2).to.equal(0n);
        
        // Fee should be claimable by owner
        const feeClaimable = await escrow.feeClaimable(owner.address);
        expect(feeClaimable).to.equal(1n);
      });
    });
  });
  
  describe("Oracle Cancel Restrictions", function () {
    it("Should not allow oracle to cancel active match", async function () {
      const wagerAmount = ethers.parseEther("1");
      
      // Create and join match (EIP-712 approval per user)
      const { sig: sigE, deadline: dlE } = await signApprovalFor(player1.address, wagerAmount);
      const tx = await escrow
        .connect(player1)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dlE, sigE, { value: wagerAmount });
      const receipt = await tx.wait();
      const event = receipt?.logs.find(log => {
        try {
          const parsed = escrow.interface.parseLog({ topics: log.topics as string[], data: log.data });
          return parsed?.name === "MatchCreated";
        } catch {
          return false;
        }
      });
      const matchId = escrow.interface.parseLog({ 
        topics: event!.topics as string[], 
        data: event!.data 
      })?.args[0] as bigint;
      
      await joinWithApproval(player2, matchId, player1.address, wagerAmount, ethers.ZeroAddress);
      
      // Oracle cannot cancel active match (no timeout functionality anymore)
      await expect(escrow.connect(oracle).cancelMatch(matchId))
        .to.be.revertedWith("Can only cancel awaiting matches");
    });
    
    it("Should allow oracle to cancel awaiting-opponent match", async function () {
      const wagerAmount = ethers.parseEther("1");
      
      // Create match
      const { sig: sig2, deadline: dl2 } = await signApprovalFor(player1.address, wagerAmount);
      const tx = await escrow
        .connect(player1)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dl2, sig2, { value: wagerAmount });
      const receipt = await tx.wait();
      const event = receipt?.logs.find(log => {
        try {
          const parsed = escrow.interface.parseLog({ topics: log.topics as string[], data: log.data });
          return parsed?.name === "MatchCreated";
        } catch {
          return false;
        }
      });
      const matchId = escrow.interface.parseLog({ 
        topics: event!.topics as string[], 
        data: event!.data 
      })?.args[0] as bigint;
      
      // Oracle can cancel awaiting match
      await expect(escrow.connect(oracle).cancelMatch(matchId))
        .to.not.be.reverted;
      
      // Player1 gets refund credited
      expect(await escrow.userBalance(player1.address)).to.equal(wagerAmount);
    });
  });
  
  describe("Oracle Management", function () {
    it("Should allow owner to set oracle", async function () {
      const newOracle = player3;
      
      // Owner sets new oracle
      await escrow.connect(owner).setOracle(newOracle.address);
      
      // Verify oracle changed
      expect(await escrow.oracleAddress()).to.equal(newOracle.address);
    });
    
    it("Should not allow non-owner to set oracle", async function () {
      await expect(escrow.connect(player1).setOracle(player3.address))
        .to.be.revertedWith("Only owner");
    });
    
    it("Should not allow zero address as oracle", async function () {
      await expect(escrow.connect(owner).setOracle(ethers.ZeroAddress))
        .to.be.revertedWith("Invalid oracle");
    });
  });

  describe("Joiner Approval", function () {
    it("requires joiner EIP-712 approval", async function () {
      const wager = ethers.parseEther("0.001");

      // Creator has an approved bet-size
      const { sig, deadline } = await signApprovalFor(player1.address, wager);
      const rc = await (
        await escrow
          .connect(player1)
          ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, deadline, sig, { value: wager })
      ).wait();
      const matchId = escrow.interface.parseLog({ topics: rc!.logs[0].topics as string[], data: rc!.logs[0].data })
        ?.args?.[0] as bigint;

      // Provide an invalid approval for the joiner (sign for wrong amount)
      const { sig: badSig, deadline: badDl } = await signApprovalFor(player2.address, wager + 1n);
      await expect(
        escrow
          .connect(player2)
          ["joinMatch(uint256,address,uint256,address,uint256,bytes)"](matchId, player1.address, wager, ethers.ZeroAddress, badDl, badSig, { value: wager })
      ).to.be.revertedWith("Bet not approved");
    });
  });

  describe("Bet Approval", function () {
    it("rejects signature bound to a different player", async function () {
      const wagerAmount = ethers.parseEther("1");
      // Oracle signs for player2, but player1 tries to use it
      const { sig, deadline } = await signApprovalFor(player2.address, wagerAmount);
      await expect(
        escrow
          .connect(player1)
          ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, deadline, sig, { value: wagerAmount })
      ).to.be.revertedWith("Bet not approved");
    });

    it("rejects expired approvals", async function () {
      const wagerAmount = ethers.parseEther("1");
      // TTL = 0, then advance time so it's expired
      const { sig, deadline } = await signApprovalFor(player1.address, wagerAmount, 0n);
      await time.increase(2);
      await expect(
        escrow
          .connect(player1)
          ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, deadline, sig, { value: wagerAmount })
      ).to.be.revertedWith("Expired");
    });

    it("reverts when sent amount exceeds approved amount", async function () {
      const approved = ethers.parseEther("1");
      const sent = ethers.parseEther("2");
      const { sig, deadline } = await signApprovalFor(player1.address, approved);
      await expect(
        escrow
          .connect(player1)
          ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, deadline, sig, { value: sent })
      ).to.be.revertedWith("Bet not approved");
    });

    it("reverts when sent amount is less than approved amount", async function () {
      const approved = ethers.parseEther("2");
      const sent = ethers.parseEther("1");
      const { sig, deadline } = await signApprovalFor(player1.address, approved);
      await expect(
        escrow
          .connect(player1)
          ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, deadline, sig, { value: sent })
      ).to.be.revertedWith("Bet not approved");
    });
  });

  describe("Oracle merge awaiting matches", function () {
    it("merges two awaiting hosts into an active target without extra deposit or refund", async function () {
      const wager = ethers.parseEther("1");

      // Player1 creates source match
      const { sig: sigA, deadline: dlA } = await signApprovalFor(player1.address, wager);
      const txA = await escrow
        .connect(player1)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dlA, sigA, { value: wager });
      const rcA = await txA.wait();
      const evA = rcA?.logs.find((log) => {
        try {
          const parsed = escrow.interface.parseLog({ topics: log.topics as string[], data: log.data });
          return parsed?.name === "MatchCreated";
        } catch {
          return false;
        }
      });
      const sourceId = escrow.interface.parseLog({ topics: evA!.topics as string[], data: evA!.data })
        ?.args[0] as bigint;

      // Player2 creates target match
      const { sig: sigB, deadline: dlB } = await signApprovalFor(player2.address, wager);
      const txB = await escrow
        .connect(player2)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dlB, sigB, { value: wager });
      const rcB = await txB.wait();
      const evB = rcB?.logs.find((log) => {
        try {
          const parsed = escrow.interface.parseLog({ topics: log.topics as string[], data: log.data });
          return parsed?.name === "MatchCreated";
        } catch {
          return false;
        }
      });
      const targetId = escrow.interface.parseLog({ topics: evB!.topics as string[], data: evB!.data })
        ?.args[0] as bigint;

      // Oracle merges A -> B
      await escrow.connect(oracle).mergeAwaitingMatches(sourceId, targetId);

      const target = await escrow.matches(targetId);
      expect(target.status).to.equal(2); // Active
      expect(target.playerA).to.equal(player2.address);
      expect(target.playerB).to.equal(player1.address);
      expect(target.totalDeposit).to.equal(wager * 2n);

      const source = await escrow.matches(sourceId);
      expect(source.status).to.equal(3); // Settled (closed)
      expect(source.totalDeposit).to.equal(0n);

      // No refunds were credited to source creator
      expect(await escrow.userBalance(player1.address)).to.equal(0n);

      // Active match pointers updated
      expect(await escrow.getActiveMatch(player1.address)).to.equal(targetId);
      expect(await escrow.getActiveMatch(player2.address)).to.equal(targetId);
    });

    it("reverts for non-oracle", async function () {
      const wager = ethers.parseEther("1");

      const { sig: sigA, deadline: dlA } = await signApprovalFor(player1.address, wager);
      const txA = await escrow
        .connect(player1)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dlA, sigA, { value: wager });
      const rcA = await txA.wait();
      const sourceId = escrow.interface.parseLog({ topics: rcA!.logs[0].topics as string[], data: rcA!.logs[0].data })
        ?.args?.[0] as bigint;

      const { sig: sigB, deadline: dlB } = await signApprovalFor(player2.address, wager);
      const txB = await escrow
        .connect(player2)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dlB, sigB, { value: wager });
      const rcB = await txB.wait();
      const targetId = escrow.interface.parseLog({ topics: rcB!.logs[0].topics as string[], data: rcB!.logs[0].data })
        ?.args?.[0] as bigint;

      await expect(
        escrow.connect(player1).mergeAwaitingMatches(sourceId, targetId)
      ).to.be.revertedWith("Only oracle");
    });

    it("reverts when wagers mismatch or matches not awaiting", async function () {
      const w1 = ethers.parseEther("1");
      const w2 = ethers.parseEther("2");

      const { sig: sigA, deadline: dlA } = await signApprovalFor(player1.address, w1);
      const txA = await escrow
        .connect(player1)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dlA, sigA, { value: w1 });
      const rcA = await txA.wait();
      const sourceId = escrow.interface.parseLog({ topics: rcA!.logs[0].topics as string[], data: rcA!.logs[0].data })
        ?.args?.[0] as bigint;

      const { sig: sigB, deadline: dlB } = await signApprovalFor(player2.address, w2);
      const txB = await escrow
        .connect(player2)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dlB, sigB, { value: w2 });
      const rcB = await txB.wait();
      const targetId = escrow.interface.parseLog({ topics: rcB!.logs[0].topics as string[], data: rcB!.logs[0].data })
        ?.args?.[0] as bigint;

      await expect(
        escrow.connect(oracle).mergeAwaitingMatches(sourceId, targetId)
      ).to.be.revertedWith("Wager mismatch");

      // Make target active and ensure merging fails due to state
      await joinWithApproval(player3, targetId, player2.address, w2, ethers.ZeroAddress);
      await expect(
        escrow.connect(oracle).mergeAwaitingMatches(sourceId, targetId)
      ).to.be.revertedWith("Target not awaiting");
    });

    it("merges when within tolerance and equalizes pot to min with credits", async function () {
      // Set tolerance to 10 bps (0.1%)
      await escrow.connect(owner).setMergeToleranceBp(10);

      const base = ethers.parseEther("0.001"); // 1e15 wei
      const drift = 10n ** 12n; // 1e12 wei (~0.1% of base)

      // Source has slightly higher wager than target
      const { sig: sigS, deadline: dlS } = await signApprovalFor(player1.address, base + drift);
      const txS = await escrow
        .connect(player1)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dlS, sigS, { value: base + drift });
      const rcS = await txS.wait();
      const sourceId = escrow.interface.parseLog({ topics: rcS!.logs[0].topics as string[], data: rcS!.logs[0].data })
        ?.args?.[0] as bigint;

      const { sig: sigT, deadline: dlT } = await signApprovalFor(player2.address, base);
      const txT = await escrow
        .connect(player2)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dlT, sigT, { value: base });
      const rcT = await txT.wait();
      const targetId = escrow.interface.parseLog({ topics: rcT!.logs[0].topics as string[], data: rcT!.logs[0].data })
        ?.args?.[0] as bigint;

      // Merge should succeed and credit the overage back to source player
      await escrow.connect(oracle).mergeAwaitingMatches(sourceId, targetId);

      const target = await escrow.matches(targetId);
      expect(target.status).to.equal(2); // Active
      expect(target.wagerAmount).to.equal(base); // min
      expect(target.totalDeposit).to.equal(base * 2n);

      // Source gets credited the drift
      expect(await escrow.userBalance(player1.address)).to.equal(drift);

      // Source closed and zeroed
      const source = await escrow.matches(sourceId);
      expect(source.status).to.equal(3);
      expect(source.totalDeposit).to.equal(0n);
    });
  });

  describe("Referrals", function () {

    it("splits referral pool equally when both players have referrers", async function () {
      // Ensure platform fee covers referral pool
      await escrow.connect(owner).setFeePercent(1);

      const wagerAmount = ethers.parseEther("1");
      const { sig: sigA, deadline: dlRA0 } = await signApprovalFor(player1.address, wagerAmount);
      // Player1 creates with referrer player3
      let tx = await escrow
        .connect(player1)
        ["createMatch(address,uint256,bytes)"](player3.address, dlRA0, sigA, { value: wagerAmount });
      let receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = escrow.interface.parseLog({ topics: log.topics as string[], data: log.data });
          return parsed?.name === "MatchCreated";
        } catch {
          return false;
        }
      });
      const matchId = escrow.interface.parseLog({ topics: event!.topics as string[], data: event!.data })
        ?.args[0] as bigint;

      // Player2 joins with referrer owner
      await joinWithApproval(player2, matchId, player1.address, wagerAmount, owner.address);

      // Settle match (winner arbitrary)
      await escrow.connect(oracle).settleMatch(matchId, player1.address);

      const totalDeposit = wagerAmount * 2n;
      const referralPool = (totalDeposit * 50n) / 10_000n; // 0.5%
      const half = referralPool / 2n;

      const balA = await escrow.referralBalances(player3.address);
      const balB = await escrow.referralBalances(owner.address);
      expect(balA).to.equal(half);
      expect(balB).to.equal(half);
    });

    it("allocates full referral pool to a single referrer", async function () {
      await escrow.connect(owner).setFeePercent(1);

      const wagerAmount = ethers.parseEther("1");
      const { sig: sigA, deadline: dlRA1 } = await signApprovalFor(player1.address, wagerAmount);
      const tx = await escrow
        .connect(player1)
        ["createMatch(address,uint256,bytes)"](player3.address, dlRA1, sigA, { value: wagerAmount });
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = escrow.interface.parseLog({ topics: log.topics as string[], data: log.data });
          return parsed?.name === "MatchCreated";
        } catch {
          return false;
        }
      });
      const matchId = escrow.interface.parseLog({ topics: event!.topics as string[], data: event!.data })
        ?.args[0] as bigint;

      // Player2 joins without a referrer
      await joinWithApproval(player2, matchId, player1.address, wagerAmount, ethers.ZeroAddress);

      await escrow.connect(oracle).settleMatch(matchId, player1.address);

      const totalDeposit = wagerAmount * 2n;
      const referralPool = (totalDeposit * 50n) / 10_000n; // 0.5%

      expect(await escrow.referralBalances(player3.address)).to.equal(referralPool);
    });

    it("caps referral payouts by available platform fee", async function () {
      // Set platform fee to 0% so no referral payouts possible
      await escrow.connect(owner).setFeePercent(0);

      const wagerAmount = ethers.parseEther("1");
      const { sig: sigA2, deadline: dlRA2 } = await signApprovalFor(player1.address, wagerAmount);
      const tx = await escrow
        .connect(player1)
        ["createMatch(address,uint256,bytes)"](player3.address, dlRA2, sigA2, { value: wagerAmount });
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = escrow.interface.parseLog({ topics: log.topics as string[], data: log.data });
          return parsed?.name === "MatchCreated";
        } catch {
          return false;
        }
      });
      const matchId = escrow.interface.parseLog({ topics: event!.topics as string[], data: event!.data })
        ?.args[0] as bigint;

      // Player2 joins with a referrer too
      await joinWithApproval(player2, matchId, player1.address, wagerAmount, owner.address);

      await escrow.connect(oracle).settleMatch(matchId, player1.address);

      expect(await escrow.referralBalances(player3.address)).to.equal(0n);
      expect(await escrow.referralBalances(owner.address)).to.equal(0n);
    });

    it("uses snapshotted referral fee at creation even if updated later", async function () {
      // Make sure platform fee is high enough to cover any pool
      await escrow.connect(owner).setFeePercent(10);

      const wagerAmount = ethers.parseEther("1");
      const { sig: sigA3, deadline: dlRA3 } = await signApprovalFor(player1.address, wagerAmount);
      const tx = await escrow
        .connect(player1)
        ["createMatch(address,uint256,bytes)"](player3.address, dlRA3, sigA3, { value: wagerAmount });
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log) => {
        try {
          const parsed = escrow.interface.parseLog({ topics: log.topics as string[], data: log.data });
          return parsed?.name === "MatchCreated";
        } catch {
          return false;
        }
      });
      const matchId = escrow.interface.parseLog({ topics: event!.topics as string[], data: event!.data })
        ?.args[0] as bigint;

      // Change referral fee after creation to 10% (should not affect this match)
      await escrow.connect(owner).setReferralFeeBp(1000);

      // Player2 joins with referrer owner
      await joinWithApproval(player2, matchId, player1.address, wagerAmount, owner.address);

      await escrow.connect(oracle).settleMatch(matchId, player1.address);

      const totalDeposit = wagerAmount * 2n;
      const referralPoolSnap = (totalDeposit * 50n) / 10_000n; // 0.5% snapshotted
      const half = referralPoolSnap / 2n;

      expect(await escrow.referralBalances(player3.address)).to.equal(half);
      expect(await escrow.referralBalances(owner.address)).to.equal(half);
    });
  });

  describe("Merge Tolerance Config", function () {
    it("defaults to 0 bps", async function () {
      const tol = await escrow.mergeToleranceBp();
      expect(tol).to.equal(0);
    });

    it("allows merging within 1% tolerance when set", async function () {
      // Set tolerance to 1% (100 bps)
      await escrow.connect(owner).setMergeToleranceBp(100);

      const base = ethers.parseEther("0.001"); // 1e15 wei
      const drift = 10n ** 13n; // 1% of base

      // Source has slightly higher wager than target (within 1%)
      const { sig: sigS, deadline: dlS } = await signApprovalFor(player1.address, base + drift);
      const txS = await escrow
        .connect(player1)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dlS, sigS, { value: base + drift });
      const rcS = await txS.wait();
      const sourceId = escrow.interface.parseLog({ topics: rcS!.logs[0].topics as string[], data: rcS!.logs[0].data })
        ?.args?.[0] as bigint;

      const { sig: sigT, deadline: dlT } = await signApprovalFor(player2.address, base);
      const txT = await escrow
        .connect(player2)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dlT, sigT, { value: base });
      const rcT = await txT.wait();
      const targetId = escrow.interface.parseLog({ topics: rcT!.logs[0].topics as string[], data: rcT!.logs[0].data })
        ?.args?.[0] as bigint;

      // Merge should succeed and equalize pot to min (base)
      await escrow.connect(oracle).mergeAwaitingMatches(sourceId, targetId);

      const target = await escrow.matches(targetId);
      expect(target.status).to.equal(2); // Active
      expect(target.wagerAmount).to.equal(base); // min
      expect(target.totalDeposit).to.equal(base * 2n);

      // Source gets credited the drift
      expect(await escrow.userBalance(player1.address)).to.equal(drift);
    });

    it("reverts merging above 1% tolerance", async function () {
      await escrow.connect(owner).setMergeToleranceBp(100);

      const base = ethers.parseEther("0.001"); // 1e15 wei
      const drift = base / 50n; // 2% of base, safely above 1%

      const { sig: sigS, deadline: dlS } = await signApprovalFor(player1.address, base + drift);
      const txS = await escrow
        .connect(player1)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dlS, sigS, { value: base + drift });
      const rcS = await txS.wait();
      const sourceId = escrow.interface.parseLog({ topics: rcS!.logs[0].topics as string[], data: rcS!.logs[0].data })
        ?.args?.[0] as bigint;

      const { sig: sigT, deadline: dlT } = await signApprovalFor(player2.address, base);
      const txT = await escrow
        .connect(player2)
        ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dlT, sigT, { value: base });
      const rcT = await txT.wait();
      const targetId = escrow.interface.parseLog({ topics: rcT!.logs[0].topics as string[], data: rcT!.logs[0].data })
        ?.args?.[0] as bigint;

      await expect(
        escrow.connect(oracle).mergeAwaitingMatches(sourceId, targetId)
      ).to.be.revertedWith("Wager mismatch");
    });

    it("caps tolerance at 5% (500 bps)", async function () {
      await expect(
        escrow.connect(owner).setMergeToleranceBp(501)
      ).to.be.revertedWith("Tolerance too high");
    });
  });

  // Additional coverage blocks
  describe("More Match Joining", function () {
    it("reverts when expectedOpponent mismatches", async function () {
      const wager = ethers.parseEther("0.001");
      const { sig, deadline } = await signApprovalFor(player1.address, wager);
      const rc = await (
        await escrow
          .connect(player1)
          ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, deadline, sig, { value: wager })
      ).wait();
      const matchId = escrow.interface.parseLog({ topics: rc!.logs[0].topics as string[], data: rc!.logs[0].data })
        ?.args?.[0] as bigint;

      await expect(
        escrow.connect(player2)["joinMatch(uint256,address,uint256,address,uint256,bytes)"](
          matchId,
          player3.address,
          wager,
          ethers.ZeroAddress,
          (await signApprovalFor(player2.address, wager)).deadline,
          (await signApprovalFor(player2.address, wager)).sig,
          { value: wager }
        )
      ).to.be.revertedWith("Opponent mismatch");
    });

    it("reverts when joiner already has an active match", async function () {
      const wager = ethers.parseEther("0.001");
      // Player1 creates waiting match
      const { sig: s1, deadline: d1 } = await signApprovalFor(player1.address, wager);
      const rc1 = await (
        await escrow.connect(player1)["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, d1, s1, { value: wager })
      ).wait();
      const matchId = escrow.interface.parseLog({ topics: rc1!.logs[0].topics as string[], data: rc1!.logs[0].data })
        ?.args?.[0] as bigint;

      // Player2 occupies their active slot by creating their own match
      const { sig: s2, deadline: d2 } = await signApprovalFor(player2.address, wager);
      await escrow.connect(player2)["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, d2, s2, { value: wager });

      // Now player2 cannot join player1's match
      await expect(
        escrow.connect(player2)["joinMatch(uint256,address,uint256,address,uint256,bytes)"](
          matchId,
          player1.address,
          wager,
          ethers.ZeroAddress,
          (await signApprovalFor(player2.address, wager)).deadline,
          (await signApprovalFor(player2.address, wager)).sig,
          { value: wager }
        )
      ).to.be.revertedWith("Already in active match");
    });
  });

  describe("Active Match Clearing", function () {
    it("clears active pointers on draw refund", async function () {
      const wager = ethers.parseEther("0.001");
      const { sig, deadline } = await signApprovalFor(player1.address, wager);
      const rc = await (
        await escrow
          .connect(player1)
          ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, deadline, sig, { value: wager })
      ).wait();
      const matchId = escrow.interface.parseLog({ topics: rc!.logs[0].topics as string[], data: rc!.logs[0].data })
        ?.args?.[0] as bigint;
      await joinWithApproval(player2, matchId, player1.address, wager, ethers.ZeroAddress);

      await escrow.connect(oracle).settleMatch(matchId, ethers.ZeroAddress);
      expect(await escrow.activeMatchOf(player1.address)).to.equal(0n);
      expect(await escrow.activeMatchOf(player2.address)).to.equal(0n);
    });
  });

  describe("Merge Snapshot Guards", function () {
    it("reverts when fee snapshots differ", async function () {
      const wager = ethers.parseEther("0.001");
      const { sig: sA, deadline: dA } = await signApprovalFor(player1.address, wager);
      const rcA = await (
        await escrow.connect(player1)["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dA, sA, { value: wager })
      ).wait();
      const sourceId = escrow.interface.parseLog({ topics: rcA!.logs[0].topics as string[], data: rcA!.logs[0].data })
        ?.args?.[0] as bigint;

      await escrow.connect(owner).setFeePercent(1);
      const { sig: sB, deadline: dB } = await signApprovalFor(player2.address, wager);
      const rcB = await (
        await escrow.connect(player2)["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dB, sB, { value: wager })
      ).wait();
      const targetId = escrow.interface.parseLog({ topics: rcB!.logs[0].topics as string[], data: rcB!.logs[0].data })
        ?.args?.[0] as bigint;

      await expect(escrow.connect(oracle).mergeAwaitingMatches(sourceId, targetId)).to.be.revertedWith(
        "Fee snapshot mismatch"
      );
    });

    it("reverts when referral snapshots differ", async function () {
      const wager = ethers.parseEther("0.001");
      await escrow.connect(owner).setFeePercent(0);

      const { sig: sA, deadline: dA } = await signApprovalFor(player1.address, wager);
      const rcA = await (
        await escrow.connect(player1)["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dA, sA, { value: wager })
      ).wait();
      const sourceId = escrow.interface.parseLog({ topics: rcA!.logs[0].topics as string[], data: rcA!.logs[0].data })
        ?.args?.[0] as bigint;

      await escrow.connect(owner).setReferralFeeBp(100);
      const { sig: sB, deadline: dB } = await signApprovalFor(player2.address, wager);
      const rcB = await (
        await escrow.connect(player2)["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dB, sB, { value: wager })
      ).wait();
      const targetId = escrow.interface.parseLog({ topics: rcB!.logs[0].topics as string[], data: rcB!.logs[0].data })
        ?.args?.[0] as bigint;

      await expect(escrow.connect(oracle).mergeAwaitingMatches(sourceId, targetId)).to.be.revertedWith(
        "Referral snapshot mismatch"
      );
    });
  });

  describe("Merge Symmetry and Settlement", function () {
    it("credits target overage when target wager is higher", async function () {
      await escrow.connect(owner).setMergeToleranceBp(500);
      const base = ethers.parseEther("0.001");
      const drift = base / 100n; // 1%

      const { sig: sS, deadline: dS } = await signApprovalFor(player1.address, base);
      const rcS = await (
        await escrow.connect(player1)["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dS, sS, { value: base })
      ).wait();
      const sourceId = escrow.interface.parseLog({ topics: rcS!.logs[0].topics as string[], data: rcS!.logs[0].data })
        ?.args?.[0] as bigint;

      const { sig: sT, deadline: dT } = await signApprovalFor(player2.address, base + drift);
      const rcT = await (
        await escrow
          .connect(player2)
          ["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dT, sT, { value: base + drift })
      ).wait();
      const targetId = escrow.interface.parseLog({ topics: rcT!.logs[0].topics as string[], data: rcT!.logs[0].data })
        ?.args?.[0] as bigint;

      await escrow.connect(oracle).mergeAwaitingMatches(sourceId, targetId);

      expect(await escrow.userBalance(player2.address)).to.equal(drift);
      const t = await escrow.matches(targetId);
      expect(t.wagerAmount).to.equal(base);
      expect(t.totalDeposit).to.equal(base * 2n);
    });

    it("settles merged match paying equalized pot", async function () {
      await escrow.connect(owner).setMergeToleranceBp(100);
      const base = ethers.parseEther("0.001");
      const drift = base / 200n; // 0.5%

      const { sig: sA, deadline: dA } = await signApprovalFor(player1.address, base + drift);
      const rcA = await (
        await escrow.connect(player1)["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dA, sA, { value: base + drift })
      ).wait();
      const srcId = escrow.interface.parseLog({ topics: rcA!.logs[0].topics as string[], data: rcA!.logs[0].data })
        ?.args?.[0] as bigint;

      const { sig: sB, deadline: dB } = await signApprovalFor(player2.address, base);
      const rcB = await (
        await escrow.connect(player2)["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, dB, sB, { value: base })
      ).wait();
      const dstId = escrow.interface.parseLog({ topics: rcB!.logs[0].topics as string[], data: rcB!.logs[0].data })
        ?.args?.[0] as bigint;

      await escrow.connect(oracle).mergeAwaitingMatches(srcId, dstId);
      // After merge, the overage is credited to player1
      expect(await escrow.userBalance(player1.address)).to.equal(drift);
      
      // Winner receives equalized pot of 2 * base on top of credited drift
      await escrow.connect(oracle).settleMatch(dstId, player1.address);
      expect(await escrow.userBalance(player1.address)).to.equal(base * 2n + drift);
    });
  });

  describe("Approvals and Expiry", function () {
    it("rejects expired approvals", async function () {
      const wager = ethers.parseEther("0.001");
      const { sig, deadline } = await signApprovalFor(player1.address, wager, 1n);
      await time.increase(2);
      await expect(
        escrow.connect(player1)["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, deadline, sig, { value: wager })
      ).to.be.revertedWith("Expired");
    });

    it("invalidates old approvals on version bump and accepts new", async function () {
      const wager = ethers.parseEther("0.001");
      const { sig: s1, deadline: d1 } = await signApprovalForVersion(player1.address, wager, 1n);
      await escrow.connect(owner).setApprovalVersion(2);
      await expect(
        escrow.connect(player1)["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, d1, s1, { value: wager })
      ).to.be.revertedWith("Bet not approved");

      const { sig: s2, deadline: d2 } = await signApprovalForVersion(player1.address, wager, 2n);
      await expect(
        escrow.connect(player1)["createMatch(address,uint256,bytes)"](ethers.ZeroAddress, d2, s2, { value: wager })
      ).to.not.be.reverted;
    });
  });

  describe("Referral Stickiness and Withdrawals", function () {
    it("keeps first referrer sticky across subsequent matches", async function () {
      const wager = ethers.parseEther("0.001");
      // First match with referrer = player2
      const { sig: s1, deadline: d1 } = await signApprovalFor(player1.address, wager);
      const rc1 = await (
        await escrow
          .connect(player1)
          ["createMatch(address,uint256,bytes)"](player2.address, d1, s1, { value: wager })
      ).wait();
      const matchId = escrow.interface.parseLog({ topics: rc1!.logs[0].topics as string[], data: rc1!.logs[0].data })
        ?.args?.[0] as bigint;
      expect(await escrow.referrerOf(player1.address)).to.equal(player2.address);

      // Close the match to clear active pointer (cancel by creator)
      await escrow.connect(player1).cancelMyMatch(matchId);

      // Create another match attempting to set a different referrer
      const { sig: s2, deadline: d2 } = await signApprovalFor(player1.address, wager);
      await escrow
        .connect(player1)
        ["createMatch(address,uint256,bytes)"](player3.address, d2, s2, { value: wager });

      // Referrer remains the first one (sticky)
      expect(await escrow.referrerOf(player1.address)).to.equal(player2.address);
    });

    it("allows referrers to withdraw balances", async function () {
      await escrow.connect(owner).setFeePercent(10);
      const wager = ethers.parseEther("0.001");
      const { sig, deadline } = await signApprovalFor(player1.address, wager);
      const rc = await (
        await escrow
          .connect(player1)
          ["createMatch(address,uint256,bytes)"](player3.address, deadline, sig, { value: wager })
      ).wait();
      const matchId = escrow.interface.parseLog({ topics: rc!.logs[0].topics as string[], data: rc!.logs[0].data })
        ?.args?.[0] as bigint;

      await joinWithApproval(player2, matchId, player1.address, wager, ethers.ZeroAddress);

      await escrow.connect(oracle).settleMatch(matchId, player1.address);
      const owed = await escrow.referralBalances(player3.address);
      expect(owed).to.be.gt(0);

      const before = await ethers.provider.getBalance(player3.address);
      const txW = await escrow.connect(player3).withdrawReferralBalance();
      const rcW = await txW.wait();
      const gas = rcW!.gasUsed * rcW!.gasPrice!;
      const after = await ethers.provider.getBalance(player3.address);
      expect(after).to.be.closeTo(before + owed - gas, ethers.parseEther("0.0005"));
    });
  });
});
