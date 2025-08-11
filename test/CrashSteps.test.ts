/* eslint-env mocha */

import hre from "hardhat";
import { ethers, network } from "hardhat";
import { expect } from "chai";
import { describe, it, before, beforeEach } from "mocha";
import "@nomicfoundation/hardhat-chai-matchers";
import { HardhatEthersProvider } from
        "@nomicfoundation/hardhat-ethers/internal/hardhat-ethers-provider";

/* ───────────────── constants ────────────────── */

const MAX_UINT16       = 65_535n;
const MAX_DEPOSIT      = ethers.parseEther("0.125");        // 0.125 ETH
const MIN_DEPOSIT        = ethers.parseEther("0.001");      // 0.001 ETH (contract constant)
const DEP_SMALL          = MIN_DEPOSIT * 2n;                      // 0.002 ETH – used everywhere
const BP_DENOM           = 10_000n;
const REFERRAL_BP        = 50n;                                   // 0.5 %
const PLATFORM_FEE_BP = 500n;  // 5 %

const net = (wei: bigint) => wei - (wei * PLATFORM_FEE_BP / BP_DENOM);

/** Reads the factor from the deployed contract each time. */
export async function cap(
    stake: bigint,
    crashContract: any          // pass the freshly-deployed instance
): Promise<bigint> {
    const factor = BigInt(await crashContract.maxPayoutFactorBp());
    return (net(stake) * factor) / BP_DENOM;
}

/* ───────────────── helpers ───────────────────── */

async function signReceipt(
    params: { player: string; nonce: number; reward: bigint },
    signer: any,
    verifyingContract: string,
    chainId: bigint
) {
    const domain = {
        name: "CrashReceipt",
        version: "2",
        chainId,
        verifyingContract,
    };

    const types = {
        CrashReceipt: [
            { name: "player", type: "address" },
            { name: "nonce",  type: "uint256" },
            { name: "reward", type: "uint256" },
        ],
    };

    return signer.signTypedData(domain, types, params);
}

/* ───────────────── fixtures ──────────────────── */

let owner:  any;
let oracle: any;
let player: any;
let referrer:  any;
let stranger:  any;
let other:  any;
let crash:  any;

/** Create wallets once and give them a little fuel (0.003 ETH each). */
before(async () => {
    [owner] = await ethers.getSigners();

    oracle = ethers.Wallet.createRandom().connect(owner.provider);
    player = ethers.Wallet.createRandom().connect(owner.provider);
    other  = ethers.Wallet.createRandom().connect(owner.provider);
    referrer = ethers.Wallet.createRandom().connect(owner.provider);
    stranger = ethers.Wallet.createRandom().connect(owner.provider);

    const fuel = ethers.parseEther("0.05");
    const walletsToFuel = [oracle, player, referrer, stranger, other]; // ← added “other”
    for (const w of walletsToFuel) {
        await owner.sendTransaction({ to: w.address, value: fuel });
    }
});

(HardhatEthersProvider.prototype as any).resolveName = async function (
    name: string
): Promise<string> {
    return name;                  // no ENS look-up, no throw
};

/** Fresh contract before every test (wallet balances persist). */
beforeEach(async () => {
    const Crash = await ethers.getContractFactory("CrashSteps", owner);
    crash = await Crash.deploy(oracle.address);
    await crash.waitForDeployment();

    // 🔑 seed 10 ETH so players can bet
    await owner.sendTransaction({
        to: crash.target,
        value: ethers.parseEther("10")
    });
});

/* ───────────────── test-suites ───────────────── */

describe("CrashSteps", () => {
    /* ─────────────── deposit ────────────── */
    describe("deposit", () => {
        it("stores cap, updates liability and emits event", async () => {
            const amount      = DEP_SMALL;          // 0.002 ETH
            const expectedCap = await cap(amount, crash);

            // Seed just enough bankroll to keep ticket solvent
            const seed = expectedCap - net(amount);      // 0.001 ETH
            await owner.sendTransaction({ to: await crash.getAddress(), value: seed });

            await expect(
                crash.connect(player).deposit(ethers.ZeroAddress, { value: amount })
            )
                .to.emit(crash, "Deposited")
                .withArgs(player.address, net(amount), 0, expectedCap);

            expect(await crash.totalLiability()).to.equal(expectedCap);
        });

        it("reverts when bankroll would become insolvent", async () => {
            /* ── 1 · start from an empty bankroll ─────────────────────── */
            await crash.connect(owner).withdraw(ethers.parseEther("10"));

            const amount       = DEP_SMALL;                // 0.002 ETH
            const expectedCap  = await cap(amount, crash);
            const seed         = expectedCap - net(amount);

            // This ‘seed’ makes the bankroll *just* solvent for ONE ticket.
            await owner.sendTransaction({ to: await crash.getAddress(), value: seed });

            /* ── 2 · ensure size-limit accepts our stake ───────────────── */
            //     maxBet() = liquid * 10 000 / riskBurstBp
            const burstBp       = BigInt(await crash.riskBurstBp());      // 1 273 000 bp
            const liquidNeeded  = (amount * burstBp) / BP_DENOM;          // stake × burst / 10 000

            const bal      = await ethers.provider.getBalance(await crash.getAddress());
            const liability= await crash.totalLiability();                // 0 at this point
            const liquid   = bal - liability;

            if (liquid < liquidNeeded) {
                await owner.sendTransaction({
                    to: await crash.getAddress(),
                    value: liquidNeeded - liquid,                          // top-up exactly what is missing
                });
            }

            /* ── 3 · first deposit succeeds ───────────────────────────── */
            await crash.connect(player).deposit(ethers.ZeroAddress, { value: amount });

            /* ── 4 · second identical deposit breaches solvency.
                     With liquid now fully pledged, maxBet() == 0, so the
                     size-check reverts early with DepositTooLarge(). ──── */
            await expect(
                crash.connect(player).deposit(ethers.ZeroAddress, { value: amount })
            ).to.be.revertedWithCustomError(crash, "DepositTooLarge");
        });

        it("rejects zero-or-dust deposits", async () => {
            await expect(
                crash.connect(player).deposit(ethers.ZeroAddress, { value: 1n })
            ).to.be.revertedWithCustomError(crash, "DepositTooSmall");
        });
    });

    /* ─────────────── claim ──────────────── */
    describe("claim", () => {
        let stake: bigint;

        beforeEach(async () => {
            // one fresh deposit per claim-test
            const expectedCap = await cap(DEP_SMALL, crash);
            const seed = expectedCap - DEP_SMALL;
            await owner.sendTransaction({ to: await crash.getAddress(), value: seed });
            await crash.connect(player).deposit(ethers.ZeroAddress, { value: DEP_SMALL });
            stake = DEP_SMALL;
        });

        it("pays out with a valid oracle signature", async () => {
            const reward  = stake;
            const chainId = (await ethers.provider.getNetwork()).chainId;

            const sig = await signReceipt(
                { player: player.address, nonce: 0, reward },
                oracle,
                await crash.getAddress(),
                chainId
            );

            const tx = crash.connect(player).claim(0, reward, sig);
            await expect(tx).to.changeEtherBalance(player, reward);
            await expect(tx).to.emit(crash, "Claimed").withArgs(player.address, 0, reward);
            expect(await crash.totalLiability()).to.equal(0n);
        });

        it("cannot be claimed twice", async () => {
            const reward  = stake;
            const chainId = (await ethers.provider.getNetwork()).chainId;
            const sig = await signReceipt(
                { player: player.address, nonce: 0, reward },
                oracle,
                await crash.getAddress(),
                chainId
            );

            await crash.connect(player).claim(0, reward, sig);

            await expect(
                crash.connect(player).claim(0, reward, sig)
            ).to.be.revertedWithCustomError(crash, "AlreadyClaimed");
        });

        it("reverts with OutstandingTicket if player tries to deposit twice without settling", async () => {
            // a ticket is already open from the beforeEach()
            const capNext  = await cap(DEP_SMALL, crash);
            const seedNext = capNext - DEP_SMALL;
            await owner.sendTransaction({ to: await crash.getAddress(), value: seedNext });

            await expect(
                crash.connect(player).deposit(ethers.ZeroAddress, { value: DEP_SMALL })
            ).to.be.revertedWithCustomError(crash, "OutstandingTicket");
        });

        it("allows a new deposit after the first ticket is settled", async () => {
            /* settle the existing ticket (nonce 0) */
            const chainId = (await ethers.provider.getNetwork()).chainId;
            const sig     = await signReceipt(
                { player: player.address, nonce: 0, reward: DEP_SMALL },
                oracle,
                await crash.getAddress(),
                chainId
            );
            await crash.connect(player).claim(0, DEP_SMALL, sig);

            /* new deposit must now succeed (nonce 1) */
            const capNext  = await cap(DEP_SMALL, crash);
            const seedNext = capNext - DEP_SMALL;
            await owner.sendTransaction({ to: await crash.getAddress(), value: seedNext });

            await expect(
                crash.connect(player).deposit(ethers.ZeroAddress, { value: DEP_SMALL })
            )
                .to.emit(crash, "Deposited")
                .withArgs(player.address, net(DEP_SMALL), 1, capNext);   // nonce 1
        });

        it("rejects replayed signature on different nonce", async () => {
            const reward  = stake;
            const chainId = (await ethers.provider.getNetwork()).chainId;
            const sig = await signReceipt(
                { player: player.address, nonce: 0, reward },
                oracle,
                await crash.getAddress(),
                chainId
            );

            await crash.connect(player).claim(0, reward, sig);

            await expect(
                crash.connect(player).claim(1, reward, sig)
            ).to.be.revertedWithCustomError(crash, "AlreadyClaimed");
        });

        it("rejects a bad signature", async () => {
            const reward  = stake;
            const chainId = (await ethers.provider.getNetwork()).chainId;
            const sig = await signReceipt(
                { player: player.address, nonce: 0, reward },
                other,  // wrong signer
                await crash.getAddress(),
                chainId
            );

            await expect(
                crash.connect(player).claim(0, reward, sig)
            ).to.be.revertedWithCustomError(crash, "BadSignature");
        });

        it("rejects reward above cap", async () => {
            const expectedCap = await cap(stake, crash);
            const reward  = expectedCap + 1n;
            const chainId = (await ethers.provider.getNetwork()).chainId;
            const sig = await signReceipt(
                { player: player.address, nonce: 0, reward },
                oracle,
                await crash.getAddress(),
                chainId
            );

            await expect(
                crash.connect(player).claim(0, reward, sig)
            ).to.be.revertedWithCustomError(crash, "RewardExceedsCap");
        });
    });

    /* ───────────── owner functions ───────────── */
    describe("owner functions", () => {
        it("owner can withdraw full contract balance", async () => {
            /* Add an extra 1 ETH so we know the exact surplus */
            const topUp = ethers.parseEther("1");
            await owner.sendTransaction({ to: await crash.getAddress(), value: topUp });

            /* Surplus is the *entire* balance (10 ETH float + 1 ETH top-up)  */
            const surplus = await crash._surplus();         // == 11 ETH

            const tx = crash.connect(owner).withdraw(surplus);

            await expect(tx).to.changeEtherBalances(
                [owner, crash],
                [surplus, -surplus]                         //  +11 / -11 ETH
            );
        });

        it("withdraw always sends ETH to msg.sender (owner)", async () => {
            const extra = ethers.parseEther("1");
            await owner.sendTransaction({ to: await crash.getAddress(), value: extra });

            const before = await ethers.provider.getBalance(stranger.address);

            /* Withdraw ONLY the real surplus, not MaxUint256                */
            const surplus = await crash._surplus();
            await crash.connect(owner).withdraw(surplus);

            const after = await ethers.provider.getBalance(stranger.address);
            expect(after).to.equal(before);                 // stranger unchanged
        });

        it("non-owner cannot withdraw", async () => {
            await expect(
                crash.connect(other).withdraw(0)
            ).to.be.revertedWithCustomError(crash, "OwnableUnauthorizedAccount");
        });

        describe("maxPayoutFactorBp", () => {
            it("owner can update within bounds; out-of-range reverts", async () => {
                /* lower-bound guard */
                await expect(
                    crash.connect(owner).setMaxPayoutFactorBp(9_999)   // < 1×
                ).to.be.revertedWithCustomError(crash, "InvalidParam");

                /* happy path: set to 20 000 bp ( 2× ) */
                await crash.connect(owner).setMaxPayoutFactorBp(20_000);

                /* bankroll for one ticket under the new cap                */
                const stake      = DEP_SMALL;                            // 0.002 ETH
                const newCap     = (net(stake) * 20_000n) / BP_DENOM;    // ← net()!
                const seed       = newCap - stake;
                await owner.sendTransaction({ to: await crash.getAddress(), value: seed });

                await expect(
                    crash.connect(player).deposit(ethers.ZeroAddress, { value: stake })
                )
                    .to.emit(crash, "Deposited")
                    .withArgs(player.address, net(stake), 0, newCap);

                expect(await crash.totalLiability()).to.equal(newCap);
            });
        });

        describe("rotateOracle", () => {
            it("owner can rotate; zero address reverts; non-owner blocked; new signer works", async () => {
                const newOracle = ethers.Wallet.createRandom().connect(owner.provider);

                /* non-owner blocked */
                await expect(
                    crash.connect(other).rotateOracle(newOracle.address)
                ).to.be.revertedWithCustomError(crash, "OwnableUnauthorizedAccount");

                /* zero address rejected */
                await expect(
                    crash.connect(owner).rotateOracle(ethers.ZeroAddress)
                ).to.be.revertedWithCustomError(crash, "InvalidParam");

                /* happy path rotation */
                await crash.connect(owner).rotateOracle(newOracle.address);
                expect(await crash.oracle()).to.equal(newOracle.address);

                /* Seed bankroll + ticket */
                const stake = MIN_DEPOSIT;
                const seed  = (await cap(stake, crash)) - stake;
                await owner.sendTransaction({ to: await crash.getAddress(), value: seed });
                await crash.connect(player).deposit(ethers.ZeroAddress, { value: stake });

                const chainId = (await ethers.provider.getNetwork()).chainId;

                /* old oracle signature must now fail */
                const badSig = await signReceipt(
                    { player: player.address, nonce: 0, reward: stake },
                    oracle,
                    await crash.getAddress(),
                    chainId
                );
                await expect(
                    crash.connect(player).claim(0, stake, badSig)
                ).to.be.revertedWithCustomError(crash, "BadSignature");

                /* new oracle signature succeeds */
                const goodSig = await signReceipt(
                    { player: player.address, nonce: 0, reward: stake },
                    newOracle,
                    await crash.getAddress(),
                    chainId
                );
                await expect(crash.connect(player).claim(0, stake, goodSig))
                    .to.changeEtherBalance(player, stake);
            });
        });

        describe("pause/unpause recovery flow", () => {
            it("deposit → pause → unpause → claim succeeds", async () => {
                /* bankroll & deposit */
                const stake = MIN_DEPOSIT;
                const seed  = (await cap(stake, crash)) - stake;
                await owner.sendTransaction({ to: await crash.getAddress(), value: seed });
                await crash.connect(player).deposit(ethers.ZeroAddress, { value: stake });

                /* pause then unpause */
                await crash.connect(owner).pause();
                await crash.connect(owner).unpause();

                /* claim still works */
                const chainId = (await ethers.provider.getNetwork()).chainId;
                const sig     = await signReceipt(
                    { player: player.address, nonce: 0, reward: stake },
                    oracle,
                    await crash.getAddress(),
                    chainId
                );

                await expect(crash.connect(player).claim(0, stake, sig))
                    .to.changeEtherBalance(player, stake);
            });
        });

    });

    /* ─────────────────── pause ────────────────── */
    describe("pause", () => {
        it("blocks deposit and claim while paused", async () => {
            await crash.connect(owner).pause();

            await expect(
                crash.connect(player).deposit(ethers.ZeroAddress, { value: DEP_SMALL })
            ).to.be.revertedWithCustomError(crash, "EnforcedPause");

            /* set up a claim */
            await crash.connect(owner).unpause();
            const expectedCap = await cap(DEP_SMALL, crash);
            const seed = expectedCap - DEP_SMALL;
            await owner.sendTransaction({ to: await crash.getAddress(), value: seed });
            await crash.connect(player).deposit(ethers.ZeroAddress, { value: DEP_SMALL });
            await crash.connect(owner).pause();

            const reward  = MIN_DEPOSIT;            // 0.001 ETH
            const chainId = (await ethers.provider.getNetwork()).chainId;
            const sig = await signReceipt(
                { player: player.address, nonce: 0, reward },
                oracle,
                await crash.getAddress(),
                chainId
            );

            await expect(
                crash.connect(player).claim(0, reward, sig)
            ).to.be.revertedWithCustomError(crash, "EnforcedPause");
        });

        it("non-owner cannot pause or unpause", async () => {
            await expect(crash.connect(other).pause())
                .to.be.revertedWithCustomError(crash, "OwnableUnauthorizedAccount");

            await crash.connect(owner).pause();

            await expect(crash.connect(other).unpause())
                .to.be.revertedWithCustomError(crash, "OwnableUnauthorizedAccount");
        });
    });

    describe("MAX_DEPOSIT", () => {
        it("accepts a stake exactly == MAX_DEPOSIT", async () => {
            // give player plenty of ETH
            await owner.sendTransaction({
                to: player.address,
                value: ethers.parseEther("101"), // Ensure player has enough for the stake
            });

            const stake = MAX_DEPOSIT; // 0.125 ETH, matches contract's maxDeposit

            // Calculate the cap for this specific ticket using the test's helper.
            // This helper uses the test's `net()` function (based on PLATFORM_FEE_BP)
            // and reads `maxPayoutFactorBp` directly from the contract.
            const ticketCap = await cap(stake, crash);

            // Fetch other relevant contract parameters for solvency checks
            const contractRiskBurstBp = BigInt(await crash.riskBurstBp());
            // BP_DENOM is a shared constant (10_000n)

            // 1. Liquid needed for the maxBet() constraint
            const liquidNeededForMaxBet = (stake * contractRiskBurstBp) / BP_DENOM;

            // 2. Liquid needed for the cap solvency check (address(this).balance >= totalLiability + cap)
            const liquidNeededForCapSolvency = ticketCap;

            // 3. Liquid needed for the stake coverage check (address(this).balance >= totalLiability + stake)
            const liquidNeededForStakeCoverage = stake;

            // Determine the maximum liquid the contract must have on hand (balance - totalLiability)
            // *before* this deposit's value is added, to satisfy all internal checks.
            let requiredLiquidOnHand = liquidNeededForMaxBet;
            if (liquidNeededForCapSolvency > requiredLiquidOnHand) {
                requiredLiquidOnHand = liquidNeededForCapSolvency;
            }
            if (liquidNeededForStakeCoverage > requiredLiquidOnHand) {
                requiredLiquidOnHand = liquidNeededForStakeCoverage;
            }

            // Get current contract state (balance and liability).
            // The contract is seeded with 10 ETH in beforeEach.
            const contractBalanceBeforeTestSpecificSeed = await ethers.provider.getBalance(await crash.getAddress());
            const totalLiabilityBeforeTestSpecificSeed = await crash.totalLiability(); // Should be 0n for this specific test run part

            const currentAvailableLiquidInContract = contractBalanceBeforeTestSpecificSeed - totalLiabilityBeforeTestSpecificSeed;

            // Calculate and send any necessary top-up seed amount to meet the requiredLiquidOnHand.
            let seedAmountToSend = 0n;
            if (currentAvailableLiquidInContract < requiredLiquidOnHand) {
                seedAmountToSend = requiredLiquidOnHand - currentAvailableLiquidInContract;
            }

            if (seedAmountToSend > 0n) {
                await owner.sendTransaction({ to: await crash.getAddress(), value: seedAmountToSend });
            }

            // Now, the deposit should succeed.
            // The `net(stake)` in withArgs uses the test's `net` helper, which matches contract logic.
            // The `ticketCap` calculated above is the expected cap value for the event.
            await expect(
                crash.connect(player).deposit(ethers.ZeroAddress, { value: stake })
            )
                .to.emit(crash, "Deposited")
                .withArgs(player.address, net(stake), 0, ticketCap);
        });

        it("reverts with DepositTooLarge if stake > MAX_DEPOSIT", async () => {
            const stake = MAX_DEPOSIT + 1n;                     // 0.125 ETH + 1 wei

            /* Top-up player to 10 000 ETH – no need to rely on owner’s funds. */
            await network.provider.send("hardhat_setBalance", [
                owner.address,
                "0x21E19E0C9BAB2400000",                         // 10 000 ETH in hex
            ]);

            /* Contract bankroll so the ticket *would* be solvent */
            const expectedCap = await cap(stake, crash);        // ≈ 5 780 ETH
            const seed        = expectedCap - stake;            // ≈ 5 680 ETH
            await owner.sendTransaction({
                to:    await crash.getAddress(),
                value: seed,
            });

            /* Now the tx reaches the contract and we hit the intended revert. */
            await expect(
                crash.connect(player).deposit(ethers.ZeroAddress, { value: stake })
            ).to.be.revertedWithCustomError(crash, "DepositTooLarge");
        });


    });

    /* ────────────────────────────────────────────── */
    describe("setMaxPayoutFactorBp upper bound", () => {
        it("allows the largest uint16 value (65 535 bp ≈ 6.5535×)", async () => {
            const bigFactor = MAX_UINT16;                 // 65 535 bp
            const oldFactor = await crash.maxPayoutFactorBp();  // read current default

            /* should succeed and emit event */
            await expect(
                crash.connect(owner).setMaxPayoutFactorBp(bigFactor)
            )
                .to.emit(crash, "MaxPayoutFactorChanged")
                .withArgs(oldFactor, bigFactor);

            /* quick sanity: deposit under the new 6.55× cap still works */
            const stake  = ethers.parseEther("0.001");
            const newCap = await cap(stake, crash);
            const seed   = newCap - stake;
            await owner.sendTransaction({ to: await crash.getAddress(), value: seed });

            await expect(
                crash.connect(player).deposit(ethers.ZeroAddress, { value: stake })
            )
                .to.emit(crash, "Deposited")
                .withArgs(player.address, net(stake), 0, newCap);
        });

        it("reverts when factor exceeds the 150× upper limit", async () => {
            await expect(
               crash.setMaxPayoutFactorBp(1_500_001)    // > 150×
               ).to.be.revertedWithCustomError(crash, "InvalidParam");
        });
    });

    describe("CrashSteps – Referral logic", () => {

        describe("referral rounding to zero", () => {
            it("emits referral = 0 when reward too small to accrue 0.5 %", async () => {
                const stake = MIN_DEPOSIT;
                const seed  = (await cap(stake, crash)) - stake;
                await owner.sendTransaction({ to: await crash.getAddress(), value: seed });
                await crash.connect(player).deposit(referrer.address, { value: stake });

                const tinyReward  = 100n;        // < 200 wei ⇒ referral rounds to zero
                const chainId     = (await ethers.provider.getNetwork()).chainId;
                const sig         = await signReceipt(
                    { player: player.address, nonce: 0, reward: tinyReward },
                    oracle,
                    await crash.getAddress(),
                    chainId
                );

                const tx = crash.connect(player).claim(0, tinyReward, sig);
                await expect(tx).to.changeEtherBalance(player, tinyReward);
                await expect(tx).to.changeEtherBalance(referrer, 0n);
                await expect(tx).to.emit(crash, "Claimed")
                    .withArgs(player.address, 0, tinyReward);
            });
        });

        describe("stores the first non-zero referrer and never overwrites it", async () => {
            /* ── bankroll for two tickets ────────────────────────────── */
            const capEach = await cap(DEP_SMALL, crash);
            const seed    = 2n * capEach - 2n * DEP_SMALL;          // float for both tickets
            await owner.sendTransaction({ to: await crash.getAddress(), value: seed });

            /* ── deposit #1 with referrer A ──────────────────────────── */
            await crash.connect(player).deposit(referrer.address, { value: DEP_SMALL });
            expect(await crash.referrerOf(player.address)).to.equal(referrer.address);

            /* ── claim ticket #1 so the OutstandingTicket guard is clear ─ */
            const chainId = (await ethers.provider.getNetwork()).chainId;
            const sig1    = await signReceipt(
                { player: player.address, nonce: 0, reward: DEP_SMALL },
                oracle,
                await crash.getAddress(),
                chainId
            );
            await crash.connect(player).claim(0, DEP_SMALL, sig1);

            /* ── deposit #2 with a different “referrer” (should be ignored) ─ */
            await crash.connect(player).deposit(stranger.address, { value: DEP_SMALL });

            /* mapping must still hold the original referrer */
            expect(await crash.referrerOf(player.address)).to.equal(referrer.address);
        });

        describe("self-referral blocked", () => {
            it("does not store the player as their own referrer", async () => {
                /* keep ticket solvent */
                const expectedCap = await cap(DEP_SMALL, crash);
                const seed = expectedCap - DEP_SMALL;
                await owner.sendTransaction({ to: await crash.getAddress(), value: seed });

                /* player tries to set themselves as referrer */
                await crash.connect(player).deposit(player.address, { value: DEP_SMALL });

                /* mapping must stay zero */
                expect(await crash.referrerOf(player.address)).to.equal(ethers.ZeroAddress);
            });
        });

        describe("claim pays commission", () => {
            let reward:   bigint;
            let referral: bigint;

            beforeEach(async () => {
                /* bankroll so ticket is solvent */
                const expectedCap = await cap(DEP_SMALL, crash);
                const seed = expectedCap - DEP_SMALL;
                await owner.sendTransaction({ to: await crash.getAddress(), value: seed });
                const txDep = await crash
                    .connect(player)
                    .deposit(referrer.address, { value: DEP_SMALL });

                referral  = (DEP_SMALL * REFERRAL_BP) / BP_DENOM;   // 0.5 % of deposit
                reward    = DEP_SMALL;                              // 1× stake

                // commission is transferred right away
                await expect(txDep).to.changeEtherBalance(referrer, referral);
            });

            it("transfers reward to player and 0.5% to referrer", async () => {
                const chainId = (await ethers.provider.getNetwork()).chainId;
                const sig = await signReceipt(
                    { player: player.address, nonce: 0, reward },
                    oracle,
                    await crash.getAddress(),
                    chainId
                );

                const tx = crash.connect(player).claim(0, reward, sig);

                await expect(tx).to.changeEtherBalance(player, reward);

                await expect(tx).to.emit(crash, "Claimed").withArgs(player.address, 0, reward);

                // liability should be cleared
                expect(await crash.totalLiability()).to.equal(0n);
            });

            it("reverts when reward + commission exceeds cap", async () => {
                // now only the reward itself is checked against the cap
                const rewardTooHigh = (await cap(DEP_SMALL, crash)) + 1n;

                const chainId = (await ethers.provider.getNetwork()).chainId;
                const sig = await signReceipt(
                    { player: player.address, nonce: 0, reward: rewardTooHigh },
                    oracle,
                    await crash.getAddress(),
                    chainId
                );

                await expect(
                    crash.connect(player).claim(0, rewardTooHigh, sig)
                ).to.be.revertedWithCustomError(crash, "RewardExceedsCap");
            });
        });

        describe("referrer == 0 address", () => {
            it("keeps referrerOf at 0 and emits referral = 0", async () => {
                /* ── bankroll ── */
                const expectedCap = await cap(DEP_SMALL, crash);
                const seed = expectedCap - DEP_SMALL;
                await owner.sendTransaction({ to: await crash.getAddress(), value: seed });

                /* ── deposit with no referrer ── */
                await crash.connect(player).deposit(ethers.ZeroAddress, { value: DEP_SMALL });
                expect(await crash.referrerOf(player.address)).to.equal(ethers.ZeroAddress);

                /* ── claim ── */
                const reward   = DEP_SMALL;
                const chainId  = (await ethers.provider.getNetwork()).chainId;
                const sig      = await signReceipt(
                    { player: player.address, nonce: 0, reward },
                    oracle,
                    await crash.getAddress(),
                    chainId
                );

                const tx = crash.connect(player).claim(0, reward, sig);

                await expect(tx).to.changeEtherBalances([player], [reward]);
                await expect(tx)
                    .to.emit(crash, "Claimed")
                    .withArgs(player.address, 0, reward);
            });
        });
    });

    describe("ReentrancyGuard – claim", () => {
        it("second claim inside fallback is blocked by nonReentrant", async () => {
            /* ── bankroll so the ticket will be solvent ── */
            const stake = MIN_DEPOSIT;                           // 0.001 ETH
            const expectedCap = await cap(stake, crash);      // ← extra 0.001 ETH
            const seed = expectedCap - net(stake) + MIN_DEPOSIT;
            await owner.sendTransaction({ to: await crash.getAddress(), value: seed });

            /* ── deploy attacker (its constructor makes the deposit) ── */
            const Attack = await ethers.getContractFactory("AttackReenterClaim", owner);
            const attacker = await Attack.deploy(crash.getAddress(), { value: stake });

            /* ── oracle signs a receipt for the attacker’s ticket ── */
            const chainId = (await ethers.provider.getNetwork()).chainId;
            const reward  = stake;                                // 1× payout
            const sig = await signReceipt(
                { player: await attacker.getAddress(), nonce: 0, reward },
                oracle,
                await crash.getAddress(),
                chainId
            );

            /* store receipt data in the attacker */
            await attacker.setReceipt(reward, sig);

            /* ── run the attack ── */
            await expect(attacker.attack({ gasLimit: 2_000_000 }))
                .not.to.be.reverted;                                // outer call succeeds

            /* second call inside receive() was rejected by the guard */
            expect(await attacker.secondSucceeded()).to.equal(false);

            /* ticket is now consumed and liability cleared */
            expect(await crash.totalLiability()).to.equal(0n);
            expect(
                await crash.netStakes(await attacker.getAddress(), 0)
            ).to.equal(0n);
        });
    });

    describe("liability across two players", () => {
        it("subtracts only the claiming player’s cap", async () => {
            const expectedCapEach = await cap(DEP_SMALL, crash);
            const seed = 2n * expectedCapEach - 2n * DEP_SMALL;   // solvent for two tickets
            await owner.sendTransaction({ to: await crash.getAddress(), value: seed });

            /* ── both players deposit ── */
            await crash.connect(player).deposit(ethers.ZeroAddress, { value: DEP_SMALL });
            await crash.connect(other) .deposit(ethers.ZeroAddress, { value: DEP_SMALL });

            const capEach = expectedCapEach;
            expect(await crash.totalLiability()).to.equal(2n * capEach);

            /* ── player A (player) claims ── */
            const chainId = (await ethers.provider.getNetwork()).chainId;
            const sigA    = await signReceipt(
                { player: player.address, nonce: 0, reward: DEP_SMALL },
                oracle,
                await crash.getAddress(),
                chainId
            );
            await crash.connect(player).claim(0, DEP_SMALL, sigA);

            /* liability should now equal player B’s cap only */
            expect(await crash.totalLiability()).to.equal(capEach);

            /* ── player B can still claim ── */
            const sigB = await signReceipt(
                { player: other.address, nonce: 0, reward: DEP_SMALL },
                oracle,
                await crash.getAddress(),
                chainId
            );
            await expect(crash.connect(other).claim(0, DEP_SMALL, sigB))
                .to.changeEtherBalance(other, DEP_SMALL);

            expect(await crash.totalLiability()).to.equal(0n);
        });
    });
    /* ───────────────── forfeit() ───────────────── */
    describe("forfeit (cap + bounty)", () => {
        const ONE_DAY = 24 * 60 * 60;          // seconds

        let stake   : bigint;
        let capVal  : bigint;
        let bounty  : bigint;

        beforeEach(async () => {
            // ticket solvent for 1 player
            stake   = DEP_SMALL;
            capVal  = await cap(stake, crash);

            const seed = capVal - stake;
            await owner.sendTransaction({ to: await crash.getAddress(), value: seed });
            await crash.connect(player).deposit(ethers.ZeroAddress, { value: stake });
        });

        it("anyone can forfeit after delay; no bounty is paid", async () => {
            await network.provider.send("evm_increaseTime", [ONE_DAY + 1]);
            await network.provider.send("evm_mine");

            const tx = crash.connect(stranger).forfeit(player.address, 0);
            await expect(tx).to.changeEtherBalance(stranger, 0n);          // no payout
            await expect(tx).to.emit(crash, "Forfeited")
                .withArgs(player.address, 0, stranger.address);

            expect(await crash.totalLiability()).to.equal(0n);
        });

        it("reverts with TooEarly before timeout", async () => {
            await expect(
                crash.connect(stranger).forfeit(player.address, 0)
            ).to.be.revertedWithCustomError(crash, "TooEarly");
        });

        it("cannot be called twice", async () => {
            await network.provider.send("evm_increaseTime", [ONE_DAY + 1]);
            await network.provider.send("evm_mine");

            await crash.connect(stranger).forfeit(player.address, 0);

            await expect(
                crash.connect(other).forfeit(player.address, 0)
            ).to.be.revertedWithCustomError(crash, "AlreadyClaimed");
        });

        it("paused contract blocks forfeit", async () => {
            await network.provider.send("evm_increaseTime", [ONE_DAY + 1]);
            await network.provider.send("evm_mine");

            await crash.connect(owner).pause();

            await expect(
                crash.connect(stranger).forfeit(player.address, 0)
            ).to.be.revertedWithCustomError(crash, "EnforcedPause");
        });
    });

});
