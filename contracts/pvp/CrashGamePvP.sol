// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/**
 * @dev PvP escrow that reduces transactions by combining match creation with deposits.
 *
 * Referral model (mirrors CrashSteps intent, adapted for escrow):
 * - Players can set a sticky referrer on first deposit (cannot self-refer).
 * - Passing a different nonzero referrer after the first set is ignored.
 * - Snapshot referralFeeBp at match creation in referralFeeAtCreate.
 * - Referral pool = totalDeposit * referralFeeAtCreate / 10_000; split equally if two referrers, otherwise all to the single referrer.
 * - Referral payouts are funded from the platform fee (house-funded); they do not reduce the winner’s pot.
 */
contract CrashGamePvP is EIP712 {
    using ECDSA for bytes32;

    // --- Constants ---
    uint256 public constant MAX_FEE_PERCENT = 10; // Max 10% legacy percent
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
        uint16 feeBpAtCreate;   // Fee basis points at match creation time
        uint16 referralFeeAtCreate; // Referral fee bp snapshotted at creation
    }

    // --- State Variables ---
    address public immutable owner;
    address public oracleAddress;

    // Approval versioning for bet-size signatures
    uint256 public approvalVersion;

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
    
    // Platform fee, in basis points (0-1000)
    uint16 public feeBp;
    // Legacy whole-percent fee for backward compatibility (0-10)
    uint256 public feePercent;

    // Aggregated user balances for winnings/refunds (pull-payment)
    mapping(address => uint256) public userBalance;
    mapping(address => uint256) public feeClaimable;

    // --- Referral State ---
    // Referral fee in basis points
    uint16 public referralFeeBp;
    // Player -> referrer address (sticky once set)
    mapping(address => address) public referrerOf;
    // Accounting: total referral earned (lifetime)
    mapping(address => uint256) public referralEarned;
    // Pull-payment balance for referrers (credited from platform fees)
    mapping(address => uint256) public referralBalances;

    // Tolerance for merging awaiting matches with slightly different wagers (in basis points of the larger wager)
    // Default 0 = exact-match required.
    uint16 public mergeToleranceBp;

    // --- Events ---
    event MatchCreated(uint256 indexed matchId, address indexed playerA, uint256 wagerAmount);
    event MatchReady(uint256 indexed matchId, address indexed playerA, address indexed playerB);
    event MatchSettled(uint256 indexed matchId, address indexed winner, uint256 payout);
    event MatchRefunded(uint256 indexed matchId, address indexed player, uint256 amount);
    event MatchCanceled(uint256 indexed matchId, address playerA, address playerB);
    event FeePercentUpdated(uint256 oldFee, uint256 newFee);
    event FeeBpUpdated(uint16 oldFeeBp, uint16 newFeeBp);
    event BalanceCredited(address indexed user, uint256 amount, uint256 indexed matchId);
    event BalanceWithdrawn(address indexed user, uint256 amount);
    event FeeWithdrawn(address indexed to, uint256 amount);
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event MergeToleranceChanged(uint16 oldBp, uint16 newBp);
    event ReferralFeeChanged(uint16 oldBp, uint16 newBp);
    event ReferralPaid(address indexed referrer, address indexed player, uint256 amount);
    
    // --- Errors ---
    error OnlyOwner();
    error OnlyOracle();
    error InvalidOracle();
    error InvalidRecipient();
    error InvalidVersion();
    error NoChange();
    error FeeTooHigh();
    error ToleranceTooHigh();
    error InvalidWager();
    error AlreadyInActiveMatch();
    error MatchNotAwaitingOpponent();
    error CannotPlaySelf();
    error WrongWagerAmount();
    error WagerMismatch();
    error OpponentMismatch();
    error InvalidIds();
    error InvalidPlayers();
    error SourcePointerMismatch();
    error TargetPointerMismatch();
    error FeeSnapshotMismatch();
    error ReferralSnapshotMismatch();
    error MatchNotActive();
    error InvalidWinner();
    error NotYourMatch();
    error NothingToWithdraw();
    error NoFeesToWithdraw();
    error NoBalanceToWithdraw();
    error WithdrawFailed();
    error FeeWithdrawalFailed();
    error Expired();
    error BetNotApproved();

    // --- Modifiers ---
    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }
    
    modifier onlyOracle() {
        if (msg.sender != oracleAddress) revert OnlyOracle();
        _;
    }

    constructor(address _oracleAddress) EIP712("CrashGamePvP", "1") {
        if (_oracleAddress == address(0)) revert InvalidOracle();
        owner = msg.sender;
        oracleAddress = _oracleAddress;
        approvalVersion = 1;
        feeBp = 0;
        feePercent = 0;
        referralFeeBp = 50; // 0.5%
        mergeToleranceBp = 100; // 1%
    }

    /**
     * @dev Create a new match with optional referrer (address(0) for none).
     *      Referrer is sticky and cannot be changed later; passing a different nonzero
     *      referrer on subsequent deposits is ignored.
     */
    function createMatch(address referrer, uint256 deadline, bytes calldata sig)
        external
        payable
        returns (uint256 matchId)
    {
        _verifyBetApproval(msg.sender, msg.value, deadline, sig);
        if (msg.value == 0) revert InvalidWager();
        if (activeMatchOf[msg.sender] != 0) revert AlreadyInActiveMatch();

        // Generate sequential matchId
        unchecked { matchCounter++; }
        matchId = matchCounter;

        Match storage matchData = matches[matchId];

        matchData.playerA = msg.sender;
        matchData.wagerAmount = msg.value;
        matchData.totalDeposit = msg.value;
        matchData.status = MatchStatus.AwaitingOpponent;
        matchData.createdAt = block.timestamp;
        // Snapshot fee in basis points only (no percent fallback)
        matchData.feeBpAtCreate = feeBp;
        matchData.referralFeeAtCreate = referralFeeBp;

        activeMatchOf[msg.sender] = matchId;

        // Sticky referrer for playerA
        _handleReferrerOnDeposit(msg.sender, referrer, msg.value);

        emit MatchCreated(matchId, msg.sender, msg.value);

        return matchId;
    }
    
    /**
     * @dev Join an existing match as playerB.
     * Requires an oracle EIP-712 approval for the joiner’s bet-size.
     * - Uses expectedOpponent/expectedWager to protect against front‑running.
     * - Enforces at most one active match per address.
     * @param matchId Match to join.
     * @param expectedOpponent Expected address of playerA; set address(0) to skip check.
     * @param expectedWager Expected wager (must equal match.wagerAmount).
     * @param referrer Optional referrer for the joiner; address(0) for none. If already set, a different nonzero referrer is ignored.
     * @param deadline Approval expiry timestamp (seconds since epoch).
     * @param sig Oracle EIP-712 signature over BetApproval(player,version,amount,deadline).
     */
    function joinMatch(
        uint256 matchId,
        address expectedOpponent,
        uint256 expectedWager,
        address referrer,
        uint256 deadline,
        bytes calldata sig
    ) external payable {
        Match storage matchData = matches[matchId];

        // Enforce per-joiner bet-size approval by oracle
        _verifyBetApproval(msg.sender, msg.value, deadline, sig);

        address playerA = matchData.playerA;
        uint256 wager = matchData.wagerAmount;
        if (matchData.status != MatchStatus.AwaitingOpponent) revert MatchNotAwaitingOpponent();
        if (msg.sender == playerA) revert CannotPlaySelf();
        if (msg.value != wager) revert WrongWagerAmount();
        if (expectedWager != wager) revert WagerMismatch();
        if (!(expectedOpponent == address(0) || expectedOpponent == playerA)) revert OpponentMismatch();
        if (activeMatchOf[msg.sender] != 0) revert AlreadyInActiveMatch();

        matchData.playerB = msg.sender;
        unchecked { matchData.totalDeposit += msg.value; }
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
    {
        if (sourceId == targetId) revert InvalidIds();
        Match storage src = matches[sourceId];
        Match storage dst = matches[targetId];

        if (src.status != MatchStatus.AwaitingOpponent) revert MatchNotAwaitingOpponent();
        if (dst.status != MatchStatus.AwaitingOpponent) revert MatchNotAwaitingOpponent();
        if (src.playerA == address(0) || dst.playerA == address(0)) revert InvalidPlayers();

        // Allow small drift based on configurable mergeToleranceBp
        uint256 wA = src.wagerAmount;
        uint256 wB = dst.wagerAmount;
        uint256 maxW = wA >= wB ? wA : wB;
        uint256 minW = wA >= wB ? wB : wA;
        uint256 diff = maxW - minW;
        if (diff * BP_DENOM > maxW * mergeToleranceBp) revert WagerMismatch();

        // Sanity: active pointers must match ids (prevents merging stale entries)
        if (activeMatchOf[src.playerA] != sourceId) revert SourcePointerMismatch();
        if (activeMatchOf[dst.playerA] != targetId) revert TargetPointerMismatch();

        // ensure fee/referral snapshots align to avoid confusion
        if (src.feeBpAtCreate != dst.feeBpAtCreate) revert FeeSnapshotMismatch();
        if (src.referralFeeAtCreate != dst.referralFeeAtCreate) revert ReferralSnapshotMismatch();

        // Equalize stakes to minW by crediting any overage back to the heavier depositor(s)
        // and setting the target match's wagerAmount to minW.
        address srcA = src.playerA;
        // If target's wager is higher, reduce target's deposit and credit back the difference
        if (wB > minW) {
            uint256 deltaB = wB - minW;
            unchecked { dst.totalDeposit -= deltaB; }
            unchecked { userBalance[dst.playerA] += deltaB; }
            emit BalanceCredited(dst.playerA, deltaB, targetId);
        }
        // If source's wager is higher, credit back the difference to source and only add minW
        uint256 addedFromSrc = minW;
        if (wA > minW) {
            uint256 deltaA = wA - minW;
            unchecked { userBalance[srcA] += deltaA; }
            emit BalanceCredited(srcA, deltaA, sourceId);
        }

        // Pair players and finalize target as active with equalized pot
        dst.playerB = srcA;
        unchecked { dst.totalDeposit += addedFromSrc; } // now equals minW (possibly adjusted) + minW = 2*minW
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
    ) external onlyOracle {
        Match storage matchData = matches[matchId];
        if (matchData.status != MatchStatus.Active) revert MatchNotActive();

        // Draw path: refund both players fully, no fees
        if (winner == address(0)) {
            matchData.status = MatchStatus.Refunded;

            _clearActiveMatch(matchData.playerA, matchId);
            _clearActiveMatch(matchData.playerB, matchId);

            uint256 refundEach = matchData.wagerAmount;
            unchecked { userBalance[matchData.playerA] += refundEach; }
            unchecked { userBalance[matchData.playerB] += refundEach; }

            emit MatchRefunded(matchId, matchData.playerA, refundEach);
            emit MatchRefunded(matchId, matchData.playerB, refundEach);
            emit BalanceCredited(matchData.playerA, refundEach, matchId);
            emit BalanceCredited(matchData.playerB, refundEach, matchId);
            return;
        }

        // Winner path: fees apply
        if (!(winner == matchData.playerA || winner == matchData.playerB)) revert InvalidWinner();
        matchData.status = MatchStatus.Settled;
        
        uint256 totalPot = matchData.totalDeposit;
        uint256 fee = (totalPot * matchData.feeBpAtCreate) / BP_DENOM;
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
                    unchecked { referralBalances[refA] += half; }
                    unchecked { referralEarned[refA] += half; }
                    emit ReferralPaid(refA, matchData.playerA, half);

                    unchecked { referralBalances[refB] += half; }
                    unchecked { referralEarned[refB] += half; }
                    emit ReferralPaid(refB, matchData.playerB, half);

                    unchecked { remainingFee -= (half * 2); }
                }
            } else if (refA != address(0)) {
                unchecked { referralBalances[refA] += allocatable; }
                unchecked { referralEarned[refA] += allocatable; }
                emit ReferralPaid(refA, matchData.playerA, allocatable);
                unchecked { remainingFee -= allocatable; }
            } else if (refB != address(0)) {
                unchecked { referralBalances[refB] += allocatable; }
                unchecked { referralEarned[refB] += allocatable; }
                emit ReferralPaid(refB, matchData.playerB, allocatable);
                unchecked { remainingFee -= allocatable; }
            }
        }
        
        _clearActiveMatch(matchData.playerA, matchId);
        _clearActiveMatch(matchData.playerB, matchId);
        
        unchecked { userBalance[winner] += netPot; }
        
        emit MatchSettled(matchId, winner, netPot);
        emit BalanceCredited(winner, netPot, matchId);
        
        if (remainingFee > 0) {
            unchecked { feeClaimable[owner] += remainingFee; }
        }
    }

    /**
     * @dev Cancel a match if you're the creator and no opponent has joined yet
     * @param matchId Match to cancel
     */
    function cancelMyMatch(uint256 matchId) external {
        Match storage matchData = matches[matchId];
        
        if (matchData.status != MatchStatus.AwaitingOpponent) revert MatchNotAwaitingOpponent();
        if (msg.sender != matchData.playerA) revert NotYourMatch();
        
        matchData.status = MatchStatus.Refunded;
        uint256 refundAmount = matchData.wagerAmount;
        
        _clearActiveMatch(msg.sender, matchId);
        // Try direct push refund to creator; on failure, credit to pull-balance
        (bool success, ) = payable(msg.sender).call{value: refundAmount}("");
        if (!success) {
            unchecked { userBalance[msg.sender] += refundAmount; }
            emit BalanceCredited(msg.sender, refundAmount, matchId);
        }
        
        emit MatchRefunded(matchId, msg.sender, refundAmount);
    }

    /**
     * @dev Oracle can cancel match only for awaiting-opponent matches
     * @param matchId Match to cancel
     */
    function cancelMatch(
        uint256 matchId
    ) external onlyOracle {
        Match storage matchData = matches[matchId];
        
        // Oracle can only cancel awaiting-opponent matches
        if (matchData.status != MatchStatus.AwaitingOpponent) revert MatchNotAwaitingOpponent();
        
        matchData.status = MatchStatus.Refunded;
        
        // Remove from active matches
        _clearActiveMatch(matchData.playerA, matchId);
        
        // Refund playerA's deposit to aggregated balance
        unchecked { userBalance[matchData.playerA] += matchData.totalDeposit; }
        
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
     * @dev Update platform fee in basis points (0-1000 bps).
     * @param newFeeBp New fee in basis points.
     */
    function setFeeBp(uint16 newFeeBp) external onlyOwner {
        if (newFeeBp > 1000) revert FeeTooHigh();
        uint16 old = feeBp;
        feeBp = newFeeBp;
        emit FeeBpUpdated(old, newFeeBp);
    }

    /**
     * @dev Update the platform fee percentage. Soft-deprecated; also syncs feeBp.
     * @param newFeePercent New fee percentage (0-10)
     */
    function setFeePercent(uint256 newFeePercent) external onlyOwner {
        if (newFeePercent > MAX_FEE_PERCENT) revert FeeTooHigh();
        uint256 oldFee = feePercent;
        feePercent = newFeePercent;
        // Keep basis points in sync to avoid fallback ambiguity
        feeBp = uint16(newFeePercent * 100);
        emit FeePercentUpdated(oldFee, newFeePercent);
    }
    
    /**
     * @dev Withdraw full aggregated balance (winnings/refunds)
     */
    function withdraw() external {
        uint256 amount = userBalance[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        userBalance[msg.sender] = 0;
        (bool success, ) = msg.sender.call{value: amount}("");
        if (!success) revert WithdrawFailed();
        emit BalanceWithdrawn(msg.sender, amount);
    }
    
    /**
     * @dev Owner withdraws accumulated fees to specified address
     * @param to Address to send fees to
     */
    function withdrawFees(address to) external onlyOwner {
        if (to == address(0)) revert InvalidRecipient();
        uint256 amount = feeClaimable[owner];
        if (amount == 0) revert NoFeesToWithdraw();
        
        feeClaimable[owner] = 0;
        
        (bool success, ) = to.call{value: amount}("");
        if (!success) revert FeeWithdrawalFailed();
        
        emit FeeWithdrawn(to, amount);
    }
    
    /**
     * @dev Owner sets the oracle directly.
     * Emits OracleUpdated(oldOracle, newOracle).
     * @param newOracle Address of the new oracle
     */
    function setOracle(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert InvalidOracle();
        if (newOracle == oracleAddress) revert NoChange();
        address oldOracle = oracleAddress;
        oracleAddress = newOracle;
        emit OracleUpdated(oldOracle, newOracle);
    }

    /**
     * @dev Owner updates the approval version to invalidate old bet-size approvals.
     */
    function setApprovalVersion(uint256 newVersion) external onlyOwner {
        if (newVersion == 0) revert InvalidVersion();
        if (newVersion == approvalVersion) revert NoChange();
        approvalVersion = newVersion;
    }

    // --- Referral Functions ---
    
    /**
     * @dev Owner sets allowed merge tolerance for wager mismatches in basis points (max 5%).
     */
    function setMergeToleranceBp(uint16 newBp) external onlyOwner {
        if (newBp > 500) revert ToleranceTooHigh(); // cap at 5%
        uint16 old = mergeToleranceBp;
        mergeToleranceBp = newBp;
        emit MergeToleranceChanged(old, newBp);
    }

    /**
     * @dev Allows a referrer to withdraw their accumulated referral balance.
     */
    function withdrawReferralBalance() external {
        uint256 amount = referralBalances[msg.sender];
        if (amount == 0) revert NoBalanceToWithdraw();
        referralBalances[msg.sender] = 0;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        if (!success) revert WithdrawFailed();
    }

    /**
     * @dev Owner sets referral fee in basis points (max 10%).
     */
    function setReferralFeeBp(uint16 newBp) external onlyOwner {
        if (newBp > 1_000) revert FeeTooHigh(); // max 10%
        uint16 old = referralFeeBp;
        referralFeeBp = newBp;
        emit ReferralFeeChanged(old, newBp);
    }

    // --- Internal helpers ---
    function _handleReferrerOnDeposit(
        address player,
        address referrer,
        uint256 /* amount */
    ) internal {
        // Set sticky referrer if not set and valid; conflicting nonzero later referrers are ignored
        if (referrerOf[player] == address(0) && referrer != address(0) && referrer != player) {
            referrerOf[player] = referrer;
        }
    }

    function _verifyBetApproval(
        address player,
        uint256 amount,
        uint256 deadline,
        bytes calldata sig
    ) internal view {
        // Sign over player, current approvalVersion, amount and deadline
        if (block.timestamp > deadline) revert Expired();
        bytes32 structHash = keccak256(abi.encode(BET_TYPEHASH, player, approvalVersion, amount, deadline));
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, sig);
        if (signer != oracleAddress) revert BetNotApproved();
    }
}
