# Smart Contract Audit Documentation

## Overview
This document provides technical documentation for the Crash Game smart contracts deployed on Abstract testnet. The system consists of two main contracts:
1. **CrashSteps.sol** - Single-player crash game with step-based progression
2. **CrashGamePvP.sol** - Player vs Player variant with matched betting

## Contract: CrashSteps.sol

### Purpose
A single-player gambling game where players attempt to progress through 10 steps, with each step having decreasing survival probability. Players can cash out at any time or risk continuing for higher rewards.

### Key Components

#### State Variables
- owner: Contract owner address
- currentGameId: Counter for unique game IDs  
- games: Mapping of game data by ID
- FEE_PERCENTAGE: Platform fee (5%)

#### Core Functions

**startGame(uint256 _steps)**
- Creates new game with specified target steps
- Accepts ETH wager via msg.value
- Validates steps (1-10) and minimum bet (0.0001 ETH)
- Emits GameStarted event

**claim(uint256 _gameId)**
- Allows player to cash out at current position
- Calculates payout based on steps completed
- Applies 5% platform fee
- Transfers winnings to player
- Emits GameClaimed event

**emergencyClaim(uint256 _gameId)**
- Fallback claim mechanism if regular claim fails
- Same payout logic as claim()
- Additional safety mechanism

**getPayoutForStep(uint256 _step, uint256 _wager)**
- Pure function calculating potential payout
- Uses exponential multiplier formula
- Returns payout after fee deduction

### Security Considerations

1. **Reentrancy Protection**: Uses checks-effects-interactions pattern
2. **Integer Overflow**: Solidity 0.8+ automatic overflow protection
3. **Access Control**: Only game creator can claim their game
4. **Minimum Bet**: Prevents dust attacks (0.0001 ETH minimum)
5. **Game State Validation**: Prevents double-claiming via isClaimed flag

### Payout Formula
multiplier = 10000 / SURVIVAL_BP[step]
scaledMultiplier = multiplier^numberOfSteps
payout = (wager * scaledMultiplier) - fee


---

## Contract: CrashGamePvP.sol

### Purpose
A competitive PvP variant where two players with matched wagers compete. Both players choose how many steps to attempt each round. The last player standing wins the entire pot (minus fees).

### Key Components

#### State Variables
- owner: Contract owner address
- currentMatchId: Counter for unique match IDs
- matches: Mapping of match data by ID
- playerActiveMatch: Tracks active match per player
- FEE_PERCENTAGE: Platform fee (5%)

#### Match States
solidity
enum MatchStatus {
    Created,    // Match created, waiting for player B
    Deposited,  // Both players deposited, ready to play
    Active,     // Game in progress
    Completed   // Game finished, winner determined
}


#### Core Functions

**createMatch(uint256 _wagerAmount)**
- Player A creates match with specified wager
- Deposits wager via msg.value
- Validates minimum bet and no active matches
- Returns unique matchId

**joinMatch(bytes32 _matchId, address _playerA, uint256 _wagerAmount)**
- Player B joins existing match
- Must match exact wager amount
- Deposits via msg.value
- Changes status to Deposited

**settleMatch(bytes32 _matchId, address _winner, uint256 _stepsA, uint256 _stepsB)**
- Only callable by authorized game server
- Determines winner and calculates payout
- Updates match status to Completed

**claimReward(bytes32 _matchId)**
- Winner claims their payout
- Validates caller is the winner
- Prevents double-claiming
- Transfers winnings

**cancelMatch(bytes32 _matchId)**
- Allows match creator to cancel before player B joins
- Full refund of wager
- Only works in Created state

### Security Considerations

1. **Server Authorization**: Only authorized server can settle matches via onlyGameServer modifier
2. **Double-Spend Prevention**: playerActiveMatch ensures one match per player
3. **Exact Wager Matching**: Player B must match exact wager amount
4. **State Machine**: Strict state transitions prevent invalid operations
5. **Claim Validation**: Multiple checks ensure only winner can claim
6. **Reentrancy**: CEI pattern in all payment functions

### PvP Game Flow
1. Player A creates match with wager
2. Player B joins with matching wager  
3. Off-chain game server manages gameplay
4. Server calls settleMatch() with results
5. Winner calls claimReward() to collect pot

### Fee Structure
- 5% platform fee on all payouts
- Winner receives: (wagerA + wagerB) * 0.95

---

## Common Security Patterns

Both contracts implement:
1. **Checks-Effects-Interactions**: State changes before external calls
2. **Pull Payment**: Users must claim winnings (not pushed automatically)
3. **Minimum Wager**: 0.0001 ETH to prevent dust/spam
4. **Event Emission**: All critical actions emit events for monitoring
5. **Explicit State Management**: Clear game/match status tracking
