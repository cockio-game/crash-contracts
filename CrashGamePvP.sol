// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @dev PvP escrow that reduces transactions by combining match creation with deposits
 */
contract CrashGamePvP is ReentrancyGuard {

    // --- Constants ---
    uint256 public constant SETTLEMENT_TIMEOUT = 1 hours;
    uint256 public constant AWAITING_TIMEOUT = 24 hours; // Timeout for awaiting-opponent matches
    uint256 public constant MAX_FEE_PERCENT = 10; // Maximum 10% fee to protect players

    // --- Types ---
    enum MatchStatus {
        None,           // 0: Match doesn't exist
        AwaitingOpponent, // 1: First player committed, waiting for second
        Active,         // 2: Both players committed, game active
        Settled,        // 3: Game settled by oracle
        Refunded       // 4: Refunded due to timeout
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
    mapping(bytes32 => Match) public matches;
    
    // Track player's active matches to prevent double-spending
    mapping(address => bytes32[]) public playerActiveMatches;
    
    // Counter for generating unique match IDs
    uint256 public matchCounter;
    
    // Maximum active matches per player (set to 1 for strict enforcement)
    uint256 public constant MAX_ACTIVE_MATCHES = 1;
    
    // Dynamic fee percentage (starts at 0%)
    uint256 public feePercent = 0;
    
    // Pull-payment pattern: track claimable amounts
    mapping(bytes32 => mapping(address => uint256)) public claimable;
    mapping(address => uint256) public feeClaimable;

    // --- Events ---
    event MatchCreated(bytes32 indexed matchId, address indexed playerA, uint256 wagerAmount);
    event MatchReady(bytes32 indexed matchId, address indexed playerA, address indexed playerB);
    event MatchSettled(bytes32 indexed matchId, address indexed winner, uint256 payout);
    event MatchRefunded(bytes32 indexed matchId, address indexed player, uint256 amount);
    event MatchDraw(bytes32 indexed matchId, uint256 refundAmount);
    event MatchCanceled(bytes32 indexed matchId, address playerA, address playerB);
    event FeePercentUpdated(uint256 oldFee, uint256 newFee);
    event Withdrawn(address indexed user, bytes32 indexed matchId, uint256 amount);
    event FeeWithdrawn(address indexed to, uint256 amount);
    event MatchTimedOut(bytes32 indexed matchId);
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
    function createMatch() external payable nonReentrant returns (bytes32 matchId) {
        require(msg.value > 0, "Invalid wager");
        require(
            playerActiveMatches[msg.sender].length < MAX_ACTIVE_MATCHES,
            "Already in active match"
        );
        
        // Generate unique matchId from contract address + counter
        // Simple and deterministic
        matchCounter++;
        matchId = keccak256(abi.encodePacked(
            address(this),
            matchCounter
        ));
        
        Match storage matchData = matches[matchId];
        require(matchData.status == MatchStatus.None, "Match ID collision"); // Should never happen
        
        matchData.playerA = msg.sender;
        matchData.wagerAmount = msg.value;
        matchData.totalDeposit = msg.value;
        matchData.status = MatchStatus.AwaitingOpponent;
        matchData.createdAt = block.timestamp;
        matchData.feeAtCreate = uint8(feePercent);
        
        playerActiveMatches[msg.sender].push(matchId);
        
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
        bytes32 matchId,
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
        require(
            playerActiveMatches[msg.sender].length < MAX_ACTIVE_MATCHES,
            "Already in active match"
        );
        
        matchData.playerB = msg.sender;
        matchData.totalDeposit += msg.value;
        matchData.status = MatchStatus.Active;
        matchData.activeAt = block.timestamp;
        
        playerActiveMatches[msg.sender].push(matchId);
        
        emit MatchReady(matchId, matchData.playerA, msg.sender);
    }

    /**
     * @dev Oracle settles the match
     * @param matchId Match to settle
     * @param winner Winner address (0x0 for draw)
     */
    function settleMatch(
        bytes32 matchId,
        address winner
    ) external onlyOracle nonReentrant {
        Match storage matchData = matches[matchId];
        require(matchData.status == MatchStatus.Active, "Match not active");
        require(
            winner == matchData.playerA || 
            winner == matchData.playerB || 
            winner == address(0),
            "Invalid winner"
        );

        matchData.status = MatchStatus.Settled;
        
        uint256 totalPot = matchData.totalDeposit;
        uint256 fee = (totalPot * matchData.feeAtCreate) / 100;
        uint256 netPot = totalPot - fee;
        
        // Clear player active matches
        _removeActiveMatch(matchData.playerA, matchId);
        _removeActiveMatch(matchData.playerB, matchId);
        
        if (winner == address(0)) {
            // Draw - split pot minus fee
            uint256 refundAmount = netPot / 2;
            uint256 remainder = netPot % 2; // Handle odd amounts
            
            // Credit refunds (pull-payment pattern)
            claimable[matchId][matchData.playerA] += refundAmount + remainder;
            claimable[matchId][matchData.playerB] += refundAmount;
            
            emit MatchDraw(matchId, refundAmount);
        } else {
            // Credit winner payout
            claimable[matchId][winner] += netPot;
            
            emit MatchSettled(matchId, winner, netPot);
        }
        
        // Credit fee to owner
        if (fee > 0) {
            feeClaimable[owner] += fee;
        }
    }

    /**
     * @dev Cancel a match if you're the creator and no opponent has joined yet
     * @param matchId Match to cancel
     */
    function cancelMyMatch(bytes32 matchId) external nonReentrant {
        Match storage matchData = matches[matchId];
        
        require(matchData.status == MatchStatus.AwaitingOpponent, "Invalid state");
        require(msg.sender == matchData.playerA, "Not your match");
        
        matchData.status = MatchStatus.Refunded;
        uint256 refundAmount = matchData.wagerAmount;
        
        _removeActiveMatch(msg.sender, matchId);
        
        // Try to push first (1-tx UX). Don't revert the whole tx if it fails.
        (bool success, ) = payable(msg.sender).call{value: refundAmount}("");
        if (!success) {
            // Fallback to pull so the cancel still succeeds.
            claimable[matchId][msg.sender] += refundAmount;
        }
        
        emit MatchRefunded(matchId, msg.sender, refundAmount);
    }

    /**
     * @dev Oracle can cancel match only pre-start or after timeout
     * @param matchId Match to cancel
     */
    function cancelMatch(
        bytes32 matchId
    ) external onlyOracle nonReentrant {
        Match storage matchData = matches[matchId];
        
        // Oracle can only cancel:
        // 1. Awaiting-opponent matches (pre-start)
        // 2. Active matches that have timed out
        require(
            matchData.status == MatchStatus.AwaitingOpponent || 
            (matchData.status == MatchStatus.Active && 
             block.timestamp >= matchData.activeAt + SETTLEMENT_TIMEOUT),
            "Oracle cancel only pre-start or after timeout"
        );
        
        // Store original status before changing it
        bool isAwaitingOpponent = matchData.status == MatchStatus.AwaitingOpponent;
        matchData.status = MatchStatus.Refunded;
        
        // Remove from active matches
        _removeActiveMatch(matchData.playerA, matchId);
        if (matchData.playerB != address(0)) {
            _removeActiveMatch(matchData.playerB, matchId);
        }
        
        // Active matches already removed above
        
        // Refund based on match state
        if (isAwaitingOpponent || matchData.playerB == address(0)) {
            // Only playerA deposited
            claimable[matchId][matchData.playerA] += matchData.totalDeposit;
            
            emit MatchCanceled(matchId, matchData.playerA, address(0));
        } else {
            // Both players deposited - refund each their wager
            claimable[matchId][matchData.playerA] += matchData.wagerAmount;
            claimable[matchId][matchData.playerB] += matchData.wagerAmount;
            
            emit MatchCanceled(matchId, matchData.playerA, matchData.playerB);
        }
    }

    /**
     * @dev Remove match from player's active matches array
     */
    function _removeActiveMatch(address player, bytes32 matchId) private {
        bytes32[] storage activeMatches = playerActiveMatches[player];
        uint256 length = activeMatches.length;
        
        for (uint256 i = 0; i < length; i++) {
            if (activeMatches[i] == matchId) {
                // Move last element to this position and pop
                activeMatches[i] = activeMatches[length - 1];
                activeMatches.pop();
                break;
            }
        }
    }

    // --- View Functions ---
    
    /**
     * @dev Get match details
     */
    function getMatch(bytes32 matchId) external view returns (
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
    function getPlayerActiveMatches(address player) external view returns (bytes32[] memory) {
        return playerActiveMatches[player];
    }

    /**
     * @dev Check if player can commit to a new match
     */
    function canPlayerCommit(address player) external view returns (bool) {
        return playerActiveMatches[player].length < MAX_ACTIVE_MATCHES;
    }
    
    /**
     * @dev Check if player has any active matches
     */
    function hasActiveMatch(address player) external view returns (bool) {
        return playerActiveMatches[player].length > 0;
    }
    
    /**
     * @dev Get match status for frontend
     */
    function getMatchState(bytes32 matchId) external view returns (
        MatchStatus status,
        uint256 timeRemaining
    ) {
        Match memory m = matches[matchId];
        
        if (m.status == MatchStatus.AwaitingOpponent) {
            // Show time until awaiting timeout
            uint256 expiry = m.createdAt + AWAITING_TIMEOUT;
            timeRemaining = expiry > block.timestamp ? expiry - block.timestamp : 0;
        } else if (m.status == MatchStatus.Active) {
            // Show time until settlement timeout
            uint256 expiry = m.activeAt + SETTLEMENT_TIMEOUT;
            timeRemaining = expiry > block.timestamp ? expiry - block.timestamp : 0;
        }
        
        return (m.status, timeRemaining);
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
    function withdraw(bytes32 matchId) external nonReentrant {
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
     * @dev Timeout a match that hasn't been settled within SETTLEMENT_TIMEOUT
     * @param matchId The match to timeout
     */
    function timeoutMatch(bytes32 matchId) external nonReentrant {
        Match storage matchData = matches[matchId];
        require(matchData.status == MatchStatus.Active, "Match not active");
        require(
            block.timestamp >= matchData.activeAt + SETTLEMENT_TIMEOUT,
            "Timeout not reached"
        );
        
        matchData.status = MatchStatus.Settled;
        
        uint256 totalPot = matchData.totalDeposit;
        uint256 fee = (totalPot * matchData.feeAtCreate) / 100;
        uint256 netPot = totalPot - fee;
        uint256 refundAmount = netPot / 2;
        uint256 remainder = netPot % 2;
        
        // Clear player active matches
        _removeActiveMatch(matchData.playerA, matchId);
        _removeActiveMatch(matchData.playerB, matchId);
        
        // Credit refunds as a draw (pull-payment pattern)
        claimable[matchId][matchData.playerA] += refundAmount + remainder;
        claimable[matchId][matchData.playerB] += refundAmount;
        
        // Credit fee to owner
        if (fee > 0) {
            feeClaimable[owner] += fee;
        }
        
        emit MatchTimedOut(matchId);
        emit MatchDraw(matchId, refundAmount);
    }
    
    /**
     * @dev Timeout an awaiting-opponent match after AWAITING_TIMEOUT
     * @param matchId The match to timeout
     */
    function timeoutAwaitingMatch(bytes32 matchId) external nonReentrant {
        Match storage matchData = matches[matchId];
        require(matchData.status == MatchStatus.AwaitingOpponent, "Not awaiting opponent");
        require(
            block.timestamp >= matchData.createdAt + AWAITING_TIMEOUT,
            "Timeout not reached"
        );
        
        matchData.status = MatchStatus.Refunded;
        
        // Clear player active matches
        _removeActiveMatch(matchData.playerA, matchId);
        
        // Credit refund (pull-payment pattern)
        claimable[matchId][matchData.playerA] += matchData.wagerAmount;
        
        emit MatchTimedOut(matchId);
        emit MatchRefunded(matchId, matchData.playerA, matchData.wagerAmount);
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