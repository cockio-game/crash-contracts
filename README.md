# Smart Contract Audit Documentation

## Overview
This document provides technical documentation for the Crash Game smart contracts deployed on Abstract testnet. The system consists of two main contracts:
1. **CrashSteps.sol** - Single-player crash game with step-based progression
2. **CrashGamePvP.sol** - Player vs Player variant with matched betting

## Contract: CrashSteps.sol

### Purpose
A provably fair crash gambling game where players deposit ETH and attempt to cash out before "crashing". Uses EIP-712 signatures for oracle-verified payouts.

### Key Components

#### State Variables
- oracle: Address authorized to sign claim receipts
- platformFeeBp: Platform fee in basis points (default 500 = 5%)
- referralFeeBp: Referral fee in basis points (default 50 = 0.5%)
- minDeposit: Minimum wager (0.001 ETH)
- maxDeposit: Maximum wager (0.125 ETH)
- maxPayoutFactorBp: Maximum payout multiplier (default 220000 = 22x)
- totalLiability: Total potential payouts owed
- nonce: Per-player counter for unique game IDs
- netStakes: Mapping of player stakes by nonce
- referrerOf: Tracks referral relationships

#### Core Functions

**deposit(address referrer)**
- Player deposits ETH to start a round
- Accepts referrer address for referral program
- Validates deposit within min/max limits
- Calculates payout cap based on net stake
- Ensures sufficient bankroll for potential payout
- Emits Deposited event with player, amount, nonce, cap

**claim(uint256 n, uint256 reward, bytes sig)**
- Claims winnings with oracle-signed receipt
- Verifies EIP-712 signature from oracle
- Validates reward doesn't exceed calculated cap
- Transfers reward to player
- Emits Claimed event

**forfeit(address player, uint256 n)**
- Cancels an outstanding ticket
- Can be called by player, oracle, or anyone after FORFEIT_DELAY (1 day)
- Releases liability from totalLiability
- Emits Forfeited event

**withdrawReferralBalance()**
- Allows referrers to withdraw accumulated referral fees
- Uses pull payment pattern for failed push payments

**calculateCap(uint256 netStake)**
- Pure function calculating maximum payout for a stake
- Returns (netStake * maxPayoutFactorBp) / 10000

### Security Considerations

1. **EIP-712 Signatures**: Oracle signs typed data for claim verification
2. **Reentrancy Guard**: All payment functions use nonReentrant modifier
3. **Pausable**: Owner can pause deposits and claims in emergency
4. **Bankroll Protection**: Ensures contract has funds for all liabilities
5. **Pull Payment Fallback**: Referral fees use pull pattern if push fails
6. **Nonce System**: Prevents replay attacks and double-claiming

### Oracle System
- Oracle signs receipts containing (player, nonce, reward)
- Signature verified using EIP-712 typed data hashing
- Oracle can rotate via rotateOracle() owner function


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
Created,    // Match created, waiting for player B
Deposited,  // Both players deposited, ready to play
Active,     // Game in progress
Completed   // Game finished, winner determined

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
