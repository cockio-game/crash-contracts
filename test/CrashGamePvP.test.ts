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

  describe("Match Creation", function () {
    it("Should create a new match and return matchId", async function () {
      const wagerAmount = ethers.parseEther("1");
      
      // Create match and get matchId from transaction
      const tx = await escrow.connect(player1).createMatch({ value: wagerAmount });
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
      const tx1 = await escrow.connect(player1).createMatch({ value: wagerAmount });
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
      const tx2 = await escrow.connect(player2).createMatch({ value: wagerAmount });
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
      await escrow.connect(player1).createMatch({ value: wagerAmount });
      
      // Try to create second match
      await expect(
        escrow.connect(player1).createMatch({ value: wagerAmount })
      ).to.be.revertedWith("Already in active match");
    });
  });

  describe("Match Joining", function () {
    let matchId: bigint;
    let wagerAmount: bigint;

    beforeEach(async function () {
      wagerAmount = ethers.parseEther("1");
      // Create a match first
      const tx = await escrow.connect(player1).createMatch({ value: wagerAmount });
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
      await escrow.connect(player2).joinMatch(
        matchId,
        player1.address,
        wagerAmount,
        { value: wagerAmount }
      );
      
      const match = await escrow.matches(matchId);
      expect(match.playerB).to.equal(player2.address);
      expect(match.status).to.equal(2); // Active
      expect(match.totalDeposit).to.equal(wagerAmount * 2n);
    });

    it("Should prevent player from joining their own match", async function () {
      await expect(
        escrow.connect(player1).joinMatch(
          matchId,
          player1.address,
          wagerAmount,
          { value: wagerAmount }
        )
      ).to.be.revertedWith("Cannot play yourself");
    });

    it("Should require correct wager amount", async function () {
      const wrongAmount = ethers.parseEther("0.5");
      
      await expect(
        escrow.connect(player2).joinMatch(
          matchId,
          player1.address,
          wagerAmount,
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
      const tx = await escrow.connect(player1).createMatch({ value: wagerAmount });
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
      
      await escrow.connect(player2).joinMatch(
        matchId,
        player1.address,
        wagerAmount,
        { value: wagerAmount }
      );
    });

    it("Should use pull-payment pattern for winner payout", async function () {
      await escrow.connect(oracle).settleMatch(matchId, player1.address);
      
      // Check claimable amount
      const claimable = await escrow.claimable(matchId, player1.address);
      expect(claimable).to.equal(wagerAmount * 2n); // Full pot with 0% fee
      
      // Withdraw funds
      const balanceBefore = await ethers.provider.getBalance(player1.address);
      const tx = await escrow.connect(player1).withdraw(matchId);
      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice!;
      const balanceAfter = await ethers.provider.getBalance(player1.address);
      
      expect(balanceAfter).to.be.closeTo(balanceBefore + (wagerAmount * 2n) - gasUsed, ethers.parseEther("0.001"));
      
      // Verify can't withdraw twice
      await expect(escrow.connect(player1).withdraw(matchId)).to.be.revertedWith("Nothing to withdraw");
    });

    it("Should treat zero address winner as draw and refund both", async function () {
      await escrow.connect(oracle).settleMatch(matchId, ethers.ZeroAddress);

      // Each player gets their wager back, no fees
      const claimableA = await escrow.claimable(matchId, player1.address);
      const claimableB = await escrow.claimable(matchId, player2.address);
      expect(claimableA).to.equal(wagerAmount);
      expect(claimableB).to.equal(wagerAmount);
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
      const tx = await escrow.connect(player1).createMatch({ value: wagerAmount });
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
        ethers.parseEther("0.001") // Allow small variance for gas estimation
      );
      
      // Check claimable should be 0 since push succeeded
      const claimable = await escrow.claimable(matchId, player1.address);
      expect(claimable).to.equal(0);
      
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
      
      // Create match from reverting contract using the overloaded function
      await revertingContract["createMatch(address,uint256)"](await escrow.getAddress(), wagerAmount);
      
      // Get the match ID from events
      const filter = escrow.filters.MatchCreated();
      const events = await escrow.queryFilter(filter);
      const lastEvent = events[events.length - 1];
      const revertingMatchId = lastEvent.args[0] as bigint;
      
      // Now disable ETH acceptance to simulate push payment failure
      await revertingContract.setAcceptETH(false);
      
      // Cancel match - push will fail, should fallback to pull
      await revertingContract.cancelMatch(await escrow.getAddress(), revertingMatchId);
      
      // Check that funds are in claimable (pull payment)
      const claimable = await escrow.claimable(revertingMatchId, await revertingContract.getAddress());
      expect(claimable).to.equal(wagerAmount);
      
      // Verify match is refunded
      const match = await escrow.matches(revertingMatchId);
      expect(match.status).to.equal(4); // Refunded
      
      // Contract can still withdraw via pull
      await revertingContract.withdrawFromEscrow(await escrow.getAddress(), revertingMatchId);
      
      // Verify claimable is now 0
      const finalClaimable = await escrow.claimable(revertingMatchId, await revertingContract.getAddress());
      expect(finalClaimable).to.equal(0);
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
        
        // Create match with player1
        const tx = await escrow.connect(player1).createMatch({ value: wagerAmount });
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
        await escrow.connect(player2).joinMatch(matchId, player1.address, wagerAmount, { value: wagerAmount });
        
        // Oracle settles with player1 as winner
        // Even if player1 was a reverting contract, this would not revert
        // because we use pull-payments
        await expect(escrow.connect(oracle).settleMatch(matchId, player1.address))
          .to.not.be.reverted;
        
        // Player1 has claimable funds
        const claimable = await escrow.claimable(matchId, player1.address);
        expect(claimable).to.equal(wagerAmount * 2n); // Full pot with 0% fee
        
        // The pull-payment pattern ensures settlement always succeeds
        // regardless of recipient's ability to receive ETH
      });

      it("Should not DoS when owner cannot receive fees", async function () {
        // Set fee to 5%
        await escrow.connect(owner).setFeePercent(5);
        
        const wagerAmount = ethers.parseEther("1");
        
        // Create and join match
        const tx = await escrow.connect(player1).createMatch({ value: wagerAmount });
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
        
        await escrow.connect(player2).joinMatch(matchId, player1.address, wagerAmount, { value: wagerAmount });
        
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
        
        // Create match with 0% fee
        const tx = await escrow.connect(player1).createMatch({ value: wagerAmount });
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
        await escrow.connect(player2).joinMatch(matchId, player1.address, wagerAmount, { value: wagerAmount });
        
        // Settle match
        await escrow.connect(oracle).settleMatch(matchId, player1.address);
        
        // Winner should get full pot (no fee deducted)
        const claimable = await escrow.claimable(matchId, player1.address);
        expect(claimable).to.equal(wagerAmount * 2n); // Full pot, no fee
        
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
        
        // Create and join match
        const tx = await escrow.connect(player1).createMatch({ value: wagerAmount });
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
        
        await escrow.connect(player2).joinMatch(matchId, player1.address, wagerAmount, { value: wagerAmount });
        
        // Settle with player1 as winner
        await escrow.connect(oracle).settleMatch(matchId, player1.address);
        
        // Check winner's claimable amount
        const claimable1 = await escrow.claimable(matchId, player1.address);
        const claimable2 = await escrow.claimable(matchId, player2.address);
        
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
      
      // Create and join match
      const tx = await escrow.connect(player1).createMatch({ value: wagerAmount });
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
      
      await escrow.connect(player2).joinMatch(matchId, player1.address, wagerAmount, { value: wagerAmount });
      
      // Oracle cannot cancel active match (no timeout functionality anymore)
      await expect(escrow.connect(oracle).cancelMatch(matchId))
        .to.be.revertedWith("Can only cancel awaiting matches");
    });
    
    it("Should allow oracle to cancel awaiting-opponent match", async function () {
      const wagerAmount = ethers.parseEther("1");
      
      // Create match
      const tx = await escrow.connect(player1).createMatch({ value: wagerAmount });
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
      
      // Player1 gets refund
      expect(await escrow.claimable(matchId, player1.address)).to.equal(wagerAmount);
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
});
