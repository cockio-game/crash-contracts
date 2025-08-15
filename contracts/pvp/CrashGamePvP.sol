// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/**
 * @dev PvP escrow that reduces transactions by combining match creation with deposits
 *
 * Referral model (mirrors CrashSteps intent, adapted for escrow):
 * - Players can set a sticky referrer on first deposit (cannot self-refer).
 * - Snapshot referralFeeBp at match creation in referralFeeAtCreate.
 * - Referral pool = totalDeposit * referralFeeAtCreate / 10_000; split equally if two referrers, otherwise all to the single referrer.
 * - Payouts are funded from the platform fee at settlement; capped by available fee so the winner’s pot stays intact.
 */
contract CrashGamePvP is ReentrancyGuard, EIP712 {
    using ECDSA for bytes32;

    // --- Constants ---
    uint256 public constant MAX_FEE_PERCENT = 10; // Maximum 10% fee to protect players
    uint16 public constant BP_DENOM = 10_000;     // Basis points denominator (100% = 10_000)

    // --- Types ---
    enum MatchStatus {
        None,           // 0: Match doesn't exist
        AwaitingOpponent, // 1: First player committed, waiting for second
        Active,         // 2: Both players committed, game active
        Settled,        // 3: Game settled by oracle
        Refunded       // 4: Refunded
    }

    struct Match {
        address playerA;        // First player to commit
        address playerB;        // Second player (zero if awaiting)
        uint256 wagerAmount;    // Amount each player wagers
        uint256 totalDeposit;   // Total deposited (can be 1x or 2x wager)
        MatchStatus status;
        uint256 createdAt;      // When first player committed
        uint256 activeAt;       // When second player committed2
        uint8 feeAtCreate;      // Fee percentage at match creation time
        uint16 referralFeeAtCreate; // Referral fee bp snapshotted at creation
    }

    // --- State Variables ---
    address public immutable owner;
    address public oracleAddress;

    // Approval versioning for bet-size signatures
    uint256 public approvalVersion = 1;

    // EIP712 typed data for bet approvals (per-player + deadline)
    // BetApproval(address player,uint256 version,uint256 amount,uint256 deadline)
    bytes32 public constant BET_TYPEHASH =
        keccak256("BetApproval(address player,uint256 version,uint256 amount,uint256 deadline)");
    
    // Minimal storage: only active matches
    mapping(uint256 => Match) public matches;
    
    // Track player's single active match (0 means none)
    mapping(address => uint256) public activeMatchOf;
    
    // Counter for generating unique match IDs
    uint256 public matchCounter;
    
    // Dynamic fee percentage (starts at 0%)
    uint256 public feePercent = 0;

    // Aggregated user balances for winnings/refunds (pull-payment)
    mapping(address => uint256) public userBalance;
    mapping(address => uint256) public feeClaimable;

    // --- Referral State ---
    // Referral fee in basis points (default 0.5%)
    uint16 public referralFeeBp = 50;
    // Player -> referrer address (sticky once set)
    mapping(address => address) public referrerOf;
    // Accounting: total referral earned (lifetime)
    mapping(address => uint256) public referralEarned;
    // Pull-payment balance for referrers (credited from platform fees)
    mapping(address => uint256) public referralBalances;

    // Tolerance for merging awaiting matches with slightly different wagers (in basis points of the larger wager)
    // Default 0 = exact-match required.
    uint16 public mergeToleranceBp = 0;

    // --- Events ---
    event MatchCreated(uint256 indexed matchId, address indexed playerA, uint256 wagerAmount);
    event MatchReady(uint256 indexed matchId, address indexed playerA, address indexed playerB);
    event MatchSettled(uint256 indexed matchId, address indexed winner, uint256 payout);
    event MatchRefunded(uint256 indexed matchId, address indexed player, uint256 amount);
    event MatchCanceled(uint256 indexed matchId, address playerA, address playerB);
    event FeePercentUpdated(uint256 oldFee, uint256 newFee);
    event BalanceCredited(address indexed user, uint256 amount, uint256 indexed matchId);
    event BalanceWithdrawn(address indexed user, uint256 amount);
    event FeeWithdrawn(address indexed to, uint256 amount);
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    // Referral events/config
    event ReferralFeeChanged(uint16 oldBp, uint16 newBp);
    event ReferralPaid(address indexed referrer, address indexed player, uint256 amount);

    // --- Modifiers ---
    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }
    
    modifier onlyOracle() {
        require(msg.sender == oracleAddress, "Only oracle");
        _;
    }

    constructor(address _oracleAddress) EIP712("CrashGamePvP", "1") {
        require(_oracleAddress != address(0), "Invalid oracle");
        owner = msg.sender;
        oracleAddress = _oracleAddress;
    }

    /**
     * @dev Create a new match with explicit referrer address (pass address(0) for none).
     */
    function createMatch(address referrer, uint256 deadline, bytes calldata sig)
        external
        payable
        nonReentrant
        returns (uint256 matchId)
    {
        _verifyBetApproval(msg.sender, msg.value, deadline, sig);
        require(msg.value > 0, "Invalid wager");
        require(activeMatchOf[msg.sender] == 0, "Already in active match");

        // Generate sequential matchId
        matchCounter++;
        matchId = matchCounter;

        Match storage matchData = matches[matchId];
        require(matchData.status == MatchStatus.None, "Match ID collision");

        matchData.playerA = msg.sender;
        matchData.wagerAmount = msg.value;
        matchData.totalDeposit = msg.value;
        matchData.status = MatchStatus.AwaitingOpponent;
        matchData.createdAt = block.timestamp;
        matchData.feeAtCreate = uint8(feePercent);
        matchData.referralFeeAtCreate = referralFeeBp;

        activeMatchOf[msg.sender] = matchId;

        // Sticky referrer for playerA
        _handleReferrerOnDeposit(msg.sender, referrer, msg.value);

        emit MatchCreated(matchId, msg.sender, msg.value);

        return matchId;
    }
    
    /**
     * @dev Join an existing match as playerB
     * @param matchId The match to join
     * @param expectedOpponent Expected opponent address to prevent front-running
     *                        Pass address(0) to skip this check (less secure)
     * @param expectedWager Expected wager amount to prevent front-running
     */
    /**
     * @dev Join an existing match as playerB, optionally passing a referrer (use address(0) for none)
     */
    function joinMatch(
        uint256 matchId,
        address expectedOpponent,
        uint256 expectedWager,
        address referrer
    ) external payable nonReentrant {
        Match storage matchData = matches[matchId];

        require(matchData.status == MatchStatus.AwaitingOpponent, "Match not awaiting opponent");
        require(msg.sender != matchData.playerA, "Cannot play yourself");
        require(msg.value == matchData.wagerAmount, "Wrong wager amount");
        require(expectedWager == matchData.wagerAmount, "Wager mismatch");
        require(
            expectedOpponent == address(0) || expectedOpponent == matchData.playerA,
            "Opponent mismatch"
        );
        require(activeMatchOf[msg.sender] == 0, "Already in active match");

        matchData.playerB = msg.sender;
        matchData.totalDeposit += msg.value;
        matchData.status = MatchStatus.Active;
        matchData.activeAt = block.timestamp;

        // Sticky referrer for playerB
        _handleReferrerOnDeposit(msg.sender, referrer, msg.value);

        activeMatchOf[msg.sender] = matchId;

        emit MatchReady(matchId, matchData.playerA, msg.sender);
    }

    /**
     * @dev Oracle-only: Merge two awaiting matches into one active match by pairing
     *      source.playerA as target.playerB. Requires equal wagers; no new deposits.
     *      Source match is closed with no refund; its deposit is added to target's totalDeposit.
     *      Merged match wagers can be a bit off so we "equalize" the wager amounts to ensure probability is always equal
     */
    function mergeAwaitingMatches(uint256 sourceId, uint256 targetId)
        external
        onlyOracle
        nonReentrant
    {
        require(sourceId != targetId, "Invalid ids");
        Match storage src = matches[sourceId];
        Match storage dst = matches[targetId];

        require(src.status == MatchStatus.AwaitingOpponent, "Source not awaiting");
        require(dst.status == MatchStatus.AwaitingOpponent, "Target not awaiting");
        require(src.playerA != address(0) && dst.playerA != address(0), "Invalid players");

        // Allow small drift based on configurable mergeToleranceBp
        uint256 wA = src.wagerAmount;
        uint256 wB = dst.wagerAmount;
        uint256 maxW = wA >= wB ? wA : wB;
        uint256 minW = wA >= wB ? wB : wA;
        uint256 diff = maxW - minW;
        require(diff * BP_DENOM <= maxW * mergeToleranceBp, "Wager mismatch");
        require(dst.playerB == address(0), "Target has opponent");

        // Sanity: active pointers must match ids (prevents merging stale entries)
        require(activeMatchOf[src.playerA] == sourceId, "Source pointer mismatch");
        require(activeMatchOf[dst.playerA] == targetId, "Target pointer mismatch");

        // ensure fee/referral snapshots align to avoid confusion
        require(src.feeAtCreate == dst.feeAtCreate, "Fee snapshot mismatch");
        require(src.referralFeeAtCreate == dst.referralFeeAtCreate, "Referral snapshot mismatch");

        // Equalize stakes to minW by crediting any overage back to the heavier depositor(s)
        // and setting the target match's wagerAmount to minW.
        address srcA = src.playerA;
        // If target's wager is higher, reduce target's deposit and credit back the difference
        if (wB > minW) {
            uint256 deltaB = wB - minW;
            dst.totalDeposit -= deltaB;
            userBalance[dst.playerA] += deltaB;
            emit BalanceCredited(dst.playerA, deltaB, targetId);
        }
        // If source's wager is higher, credit back the difference to source and only add minW
        uint256 addedFromSrc = minW;
        if (wA > minW) {
            uint256 deltaA = wA - minW;
            userBalance[srcA] += deltaA;
            emit BalanceCredited(srcA, deltaA, sourceId);
        }

        // Pair players and finalize target as active with equalized pot
        dst.playerB = srcA;
        dst.totalDeposit += addedFromSrc; // now equals minW (possibly adjusted) + minW = 2*minW
        dst.wagerAmount = minW;
        dst.status = MatchStatus.Active;
        dst.activeAt = block.timestamp;

        // Update active match pointer for source player to point at target
        activeMatchOf[srcA] = targetId;

        // Close source without refund; zero out to avoid any accidental accounting
        src.totalDeposit = 0;
        src.status = MatchStatus.Settled; // mark closed; no payouts/refunds from source
        src.playerA = address(0);

        // Emit events mirroring a normal join and a source close
        emit MatchReady(targetId, dst.playerA, dst.playerB);
    }

    /**
     * @dev Oracle settles the match
     * @param matchId Match to settle
     * @param winner Winner address (must be one of the two players)
     */
    function settleMatch(
        uint256 matchId,
        address winner
    ) external onlyOracle nonReentrant {
        Match storage matchData = matches[matchId];
        require(matchData.status == MatchStatus.Active, "Match not active");

        // Draw path: refund both players fully, no fees
        if (winner == address(0)) {
            matchData.status = MatchStatus.Refunded;

            _clearActiveMatch(matchData.playerA, matchId);
            _clearActiveMatch(matchData.playerB, matchId);

            uint256 refundEach = matchData.wagerAmount;
            userBalance[matchData.playerA] += refundEach;
            userBalance[matchData.playerB] += refundEach;

            emit MatchRefunded(matchId, matchData.playerA, refundEach);
            emit MatchRefunded(matchId, matchData.playerB, refundEach);
            emit BalanceCredited(matchData.playerA, refundEach, matchId);
            emit BalanceCredited(matchData.playerB, refundEach, matchId);
            return;
        }

        // Winner path: fees apply
        require(
            winner == matchData.playerA || 
            winner == matchData.playerB,
            "Invalid winner"
        );
        matchData.status = MatchStatus.Settled;
        
        uint256 totalPot = matchData.totalDeposit;
        uint256 fee = (totalPot * matchData.feeAtCreate) / 100;
        uint256 netPot = totalPot - fee;

        // Allocate referral payouts from fee (does not reduce pot)
        uint256 remainingFee = fee;
        address refA = referrerOf[matchData.playerA];
        address refB = referrerOf[matchData.playerB];
        uint256 referralPool = (totalPot * matchData.referralFeeAtCreate) / BP_DENOM;
        uint256 allocatable = remainingFee < referralPool ? remainingFee : referralPool;
        if (allocatable > 0) {
            if (refA != address(0) && refB != address(0)) {
                uint256 half = allocatable / 2;
                if (half > 0) {
                    referralBalances[refA] += half;
                    referralEarned[refA] += half;
                    referralBalances[refB] += half;
                    referralEarned[refB] += half;
                    remainingFee -= (half * 2);
                }
            } else if (refA != address(0)) {
                referralBalances[refA] += allocatable;
                referralEarned[refA] += allocatable;
                remainingFee -= allocatable;
            } else if (refB != address(0)) {
                referralBalances[refB] += allocatable;
                referralEarned[refB] += allocatable;
                remainingFee -= allocatable;
            }
        }
        
        _clearActiveMatch(matchData.playerA, matchId);
        _clearActiveMatch(matchData.playerB, matchId);
        
        userBalance[winner] += netPot;
        
        emit MatchSettled(matchId, winner, netPot);
        emit BalanceCredited(winner, netPot, matchId);
        
        if (remainingFee > 0) {
            feeClaimable[owner] += remainingFee;
        }
    }

    /**
     * @dev Cancel a match if you're the creator and no opponent has joined yet
     * @param matchId Match to cancel
     */
    function cancelMyMatch(uint256 matchId) external nonReentrant {
        Match storage matchData = matches[matchId];
        
        require(matchData.status == MatchStatus.AwaitingOpponent, "Invalid state");
        require(msg.sender == matchData.playerA, "Not your match");
        
        matchData.status = MatchStatus.Refunded;
        uint256 refundAmount = matchData.wagerAmount;
        
        _clearActiveMatch(msg.sender, matchId);
        // Directly refund to creator (user-controlled recipient)
        (bool success, ) = payable(msg.sender).call{value: refundAmount}("");
        require(success, "Refund failed");
        
        emit MatchRefunded(matchId, msg.sender, refundAmount);
    }

    /**
     * @dev Oracle can cancel match only for awaiting-opponent matches
     * @param matchId Match to cancel
     */
    function cancelMatch(
        uint256 matchId
    ) external onlyOracle nonReentrant {
        Match storage matchData = matches[matchId];
        
        // Oracle can only cancel awaiting-opponent matches
        require(
            matchData.status == MatchStatus.AwaitingOpponent,
            "Can only cancel awaiting matches"
        );
        
        matchData.status = MatchStatus.Refunded;
        
        // Remove from active matches
        _clearActiveMatch(matchData.playerA, matchId);
        
        // Refund playerA's deposit to aggregated balance
        userBalance[matchData.playerA] += matchData.totalDeposit;
        
        emit MatchCanceled(matchId, matchData.playerA, address(0));
        emit BalanceCredited(matchData.playerA, matchData.totalDeposit, matchId);
    }

    /**
     * @dev Clear player's active match if it matches the provided matchId
     */
    function _clearActiveMatch(address player, uint256 matchId) private {
        if (activeMatchOf[player] == matchId) {
            activeMatchOf[player] = 0;
        }
    }

    // --- View Functions ---
    
    /**
     * @dev Get match details
     */
    function getMatch(uint256 matchId) external view returns (
        address playerA,
        address playerB,
        uint256 wagerAmount,
        uint256 totalDeposit,
        MatchStatus status,
        uint256 createdAt,
        uint256 activeAt
    ) {
        Match memory m = matches[matchId];
        return (
            m.playerA,
            m.playerB,
            m.wagerAmount,
            m.totalDeposit,
            m.status,
            m.createdAt,
            m.activeAt
        );
    }

    /**
     * @dev Get player's active matches
     */
    function getActiveMatch(address player) external view returns (uint256) {
        return activeMatchOf[player];
    }


    /**
     * @dev Check if player can commit to a new match
     */
    function canPlayerCommit(address player) external view returns (bool) {
        return activeMatchOf[player] == 0;
    }
    
    /**
     * @dev Check if player has any active matches
     */
    function hasActiveMatch(address player) external view returns (bool) {
        return activeMatchOf[player] != 0;
    }
    
    /**
     * @dev Get match status for frontend
     */
    function getMatchState(uint256 matchId) external view returns (MatchStatus status) {
        return matches[matchId].status;
    }
    
    // --- Owner Functions ---
    
    /**
     * @dev Update the platform fee percentage
     * @param newFeePercent New fee percentage (0-10)
     */
    function setFeePercent(uint256 newFeePercent) external onlyOwner {
        require(newFeePercent <= MAX_FEE_PERCENT, "Fee too high");
        
        uint256 oldFee = feePercent;
        feePercent = newFeePercent;
        
        emit FeePercentUpdated(oldFee, newFeePercent);
    }
    
    /**
     * @dev Withdraw full aggregated balance (winnings/refunds)
     */
    function withdraw() external nonReentrant {
        uint256 amount = userBalance[msg.sender];
        require(amount > 0, "Nothing to withdraw");
        userBalance[msg.sender] = 0;
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Withdrawal failed");
        emit BalanceWithdrawn(msg.sender, amount);
    }
    
    /**
     * @dev Owner withdraws accumulated fees to specified address
     * @param to Address to send fees to
     */
    function withdrawFees(address to) external nonReentrant onlyOwner {
        require(to != address(0), "Invalid recipient");
        uint256 amount = feeClaimable[owner];
        require(amount > 0, "No fees to withdraw");
        
        feeClaimable[owner] = 0;
        
        (bool success, ) = to.call{value: amount}("");
        require(success, "Fee withdrawal failed");
        
        emit FeeWithdrawn(to, amount);
    }
    
    /**
     * @dev Owner sets the oracle directly.
     * Emits OracleUpdated(oldOracle, newOracle).
     * @param newOracle Address of the new oracle
     */
    function setOracle(address newOracle) external onlyOwner {
        require(newOracle != address(0), "Invalid oracle");
        require(newOracle != oracleAddress, "No change");
        address oldOracle = oracleAddress;
        oracleAddress = newOracle;
        emit OracleUpdated(oldOracle, newOracle);
    }

    /**
     * @dev Owner updates the approval version to invalidate old bet-size approvals.
     */
    function setApprovalVersion(uint256 newVersion) external onlyOwner {
        require(newVersion > 0, "Invalid version");
        require(newVersion != approvalVersion, "No change");
        approvalVersion = newVersion;
    }

    // --- Referral Functions ---
    
    /**
     * @dev Owner sets allowed merge tolerance for wager mismatches in basis points (max 5%).
     */
    event MergeToleranceChanged(uint16 oldBp, uint16 newBp);
    function setMergeToleranceBp(uint16 newBp) external onlyOwner {
        require(newBp <= 500, "Tolerance too high"); // cap at 5%
        uint16 old = mergeToleranceBp;
        mergeToleranceBp = newBp;
        emit MergeToleranceChanged(old, newBp);
    }

    /**
     * @dev Allows a referrer to withdraw their accumulated referral balance.
     */
    function withdrawReferralBalance() external nonReentrant {
        uint256 amount = referralBalances[msg.sender];
        require(amount > 0, "No balance to withdraw");
        referralBalances[msg.sender] = 0;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Withdrawal failed");
    }

    /**
     * @dev Owner sets referral fee in basis points (max 10%).
     */
    function setReferralFeeBp(uint16 newBp) external onlyOwner {
        require(newBp <= 1_000, "Fee too high"); // max 10%
        uint16 old = referralFeeBp;
        referralFeeBp = newBp;
        emit ReferralFeeChanged(old, newBp);
    }

    // --- Internal helpers ---
    function _handleReferrerOnDeposit(
        address player,
        address referrer,
        uint256 amount
    ) internal returns (address ref, uint256 cut) {
        // Set sticky referrer if not set and valid
        if (referrerOf[player] == address(0) && referrer != address(0) && referrer != player) {
            referrerOf[player] = referrer;
        }

        ref = referrerOf[player];
        if (ref != address(0) && referralFeeBp > 0) {
            cut = (amount * referralFeeBp) / BP_DENOM;
        }
    }

    function _verifyBetApproval(
        address player,
        uint256 amount,
        uint256 deadline,
        bytes calldata sig
    ) internal view {
        // Sign over player, current approvalVersion, amount and deadline
        if (block.timestamp > deadline) revert("Expired");
        bytes32 structHash = keccak256(abi.encode(BET_TYPEHASH, player, approvalVersion, amount, deadline));
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, sig);
        if (signer != oracleAddress) revert("Bet not approved");
    }
}
