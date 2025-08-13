// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @dev PvP escrow that reduces transactions by combining match creation with deposits
 */
contract CrashGamePvP is ReentrancyGuard {

    // --- Constants ---
    uint256 public constant MAX_FEE_PERCENT = 10; // Maximum 10% fee to protect players

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
    }

    // --- State Variables ---
    address public immutable owner;
    address public oracleAddress;
    
    // Minimal storage: only active matches
    mapping(uint256 => Match) public matches;
    
    // Track player's single active match (0 means none)
    mapping(address => uint256) public activeMatchOf;
    
    // Counter for generating unique match IDs
    uint256 public matchCounter;
    
    // Dynamic fee percentage (starts at 0%)
    uint256 public feePercent = 0;
    
    // Pull-payment pattern: track claimable amounts
    mapping(uint256 => mapping(address => uint256)) public claimable;
    mapping(address => uint256) public feeClaimable;

    // --- Events ---
    event MatchCreated(uint256 indexed matchId, address indexed playerA, uint256 wagerAmount);
    event MatchReady(uint256 indexed matchId, address indexed playerA, address indexed playerB);
    event MatchSettled(uint256 indexed matchId, address indexed winner, uint256 payout);
    event MatchRefunded(uint256 indexed matchId, address indexed player, uint256 amount);
    event MatchCanceled(uint256 indexed matchId, address playerA, address playerB);
    event FeePercentUpdated(uint256 oldFee, uint256 newFee);
    event Withdrawn(address indexed user, uint256 indexed matchId, uint256 amount);
    event FeeWithdrawn(address indexed to, uint256 amount);
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);

    // --- Modifiers ---
    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }
    
    modifier onlyOracle() {
        require(msg.sender == oracleAddress, "Only oracle");
        _;
    }

    constructor(address _oracleAddress) {
        require(_oracleAddress != address(0), "Invalid oracle");
        owner = msg.sender;
        oracleAddress = _oracleAddress;
    }

    /**
     * @dev Create a new match with deposit. Returns the generated matchId.
     * @return matchId The unique identifier generated for this match
     */
    function createMatch() external payable nonReentrant returns (uint256 matchId) {
        require(msg.value > 0, "Invalid wager");
        require(activeMatchOf[msg.sender] == 0, "Already in active match");
        
        // Generate sequential matchId
        matchCounter++;
        matchId = matchCounter;
        
        Match storage matchData = matches[matchId];
        require(matchData.status == MatchStatus.None, "Match ID collision"); // Should never happen
        
        matchData.playerA = msg.sender;
        matchData.wagerAmount = msg.value;
        matchData.totalDeposit = msg.value;
        matchData.status = MatchStatus.AwaitingOpponent;
        matchData.createdAt = block.timestamp;
        matchData.feeAtCreate = uint8(feePercent);
        
        activeMatchOf[msg.sender] = matchId;
        
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
    function joinMatch(
        uint256 matchId,
        address expectedOpponent,
        uint256 expectedWager
    ) external payable nonReentrant {
        Match storage matchData = matches[matchId];
        
        require(matchData.status == MatchStatus.AwaitingOpponent, "Match not awaiting opponent");
        require(msg.sender != matchData.playerA, "Cannot play yourself");
        require(msg.value == matchData.wagerAmount, "Wrong wager amount");
        require(expectedWager == matchData.wagerAmount, "Wager mismatch");
        // Front-running protection: expectedOpponent can be 0 to skip check
        require(
            expectedOpponent == address(0) || expectedOpponent == matchData.playerA,
            "Opponent mismatch"
        );
        require(activeMatchOf[msg.sender] == 0, "Already in active match");
        
        matchData.playerB = msg.sender;
        matchData.totalDeposit += msg.value;
        matchData.status = MatchStatus.Active;
        matchData.activeAt = block.timestamp;
        
        activeMatchOf[msg.sender] = matchId;
        
        emit MatchReady(matchId, matchData.playerA, msg.sender);
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
            claimable[matchId][matchData.playerA] += refundEach;
            claimable[matchId][matchData.playerB] += refundEach;

            emit MatchRefunded(matchId, matchData.playerA, refundEach);
            emit MatchRefunded(matchId, matchData.playerB, refundEach);
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
        
        _clearActiveMatch(matchData.playerA, matchId);
        _clearActiveMatch(matchData.playerB, matchId);
        
        claimable[matchId][winner] += netPot;
        
        emit MatchSettled(matchId, winner, netPot);
        
        if (fee > 0) {
            feeClaimable[owner] += fee;
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
        
        // Try to push first (1-tx UX). Don't revert the whole tx if it fails.
        (bool success, ) = payable(msg.sender).call{value: refundAmount}("");
        if (!success) {
            // Fallback to pull so the cancel still succeeds.
            claimable[matchId][msg.sender] += refundAmount;
        }
        
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
        
        // Refund playerA's deposit
        claimable[matchId][matchData.playerA] += matchData.totalDeposit;
        
        emit MatchCanceled(matchId, matchData.playerA, address(0));
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
    
    // --- Pull-Payment Functions ---
    
    /**
     * @dev Withdraw claimable amount from a match
     * @param matchId The match to withdraw from
     */
    function withdraw(uint256 matchId) external nonReentrant {
        uint256 amount = claimable[matchId][msg.sender];
        require(amount > 0, "Nothing to withdraw");
        
        claimable[matchId][msg.sender] = 0;
        
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Withdrawal failed");
        
        emit Withdrawn(msg.sender, matchId, amount);
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
}
