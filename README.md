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
PvP escrow for matched bets between two players. Reduces transactions by combining match creation with the initial deposit, enforces at most one active match per player, and uses pull-payments for all payouts to prevent DoS.

### Match Status
- None: Match does not exist
- AwaitingOpponent: Player A deposited; waiting for Player B
- Active: Both players deposited; game active
- Settled: Oracle settled the match; winnings credited to pull-payment
- Refunded: Match canceled and funds refunded/credited

### Storage (key items)
- `owner`: Contract owner
- `oracleAddress`: Address authorized to settle/cancel
- `matchCounter`: Sequential counter for match IDs
- `mapping(uint256 => Match) matches`: Match data keyed by `uint256 matchId`
- `mapping(address => uint256) activeMatchOf`: Single active match per player (0 = none)
- `mapping(uint256 => mapping(address => uint256)) claimable`: Pull-payment credits per match/user
- `mapping(address => uint256) feeClaimable`: Accrued platform fees
- `uint256 feePercent`: Current fee percentage (capped by `MAX_FEE_PERCENT = 10`)

### Events
- `MatchCreated(uint256 matchId, address playerA, uint256 wagerAmount)`
- `MatchReady(uint256 matchId, address playerA, address playerB)`
- `MatchSettled(uint256 matchId, address winner, uint256 payout)`
- `MatchRefunded(uint256 matchId, address player, uint256 amount)`
- `MatchCanceled(uint256 matchId, address playerA, address playerB)`
- `Withdrawn(address user, uint256 matchId, uint256 amount)`
- `FeePercentUpdated(uint256 oldFee, uint256 newFee)`
- `FeeWithdrawn(address to, uint256 amount)`
- `OracleUpdated(address oldOracle, address newOracle)`

### Core Functions

Creation and joining
- `function createMatch() external payable returns (uint256 matchId)`
  - Requires `activeMatchOf[msg.sender] == 0`
  - Increments `matchCounter` and uses it as `matchId`
  - Snapshots `feePercent` into `feeAtCreate`

- `function joinMatch(uint256 matchId, address expectedOpponent, uint256 expectedWager) external payable`
  - Requires `matches[matchId].status == AwaitingOpponent`
  - Requires `msg.value == expectedWager == matches[matchId].wagerAmount`
  - Optional front-run protection via `expectedOpponent`
  - Requires `activeMatchOf[msg.sender] == 0`

Settlement and cancelation
- `function settleMatch(uint256 matchId, address winner) external onlyOracle`
  - Requires `Active`
  - Draw (winner == 0): marks Refunded; clears both active slots; credits both players their full wager; emits two MatchRefunded events; no fees charged
  - Winner path: credits full net pot to `claimable[matchId][winner]` (pull-payment) and accrues fees into `feeClaimable[owner]`

- `function cancelMyMatch(uint256 matchId) external`
  - Only Player A; only while `AwaitingOpponent`
  - Attempts push refund; falls back to pull-credit if push fails

- `function cancelMatch(uint256 matchId) external onlyOracle`
  - Only `AwaitingOpponent`; credits Player A’s deposit to pull-payment

Withdrawals and admin
- `function withdraw(uint256 matchId) external`
- `function withdrawFees(address to) external onlyOwner`
- `function setFeePercent(uint256 newFeePercent) external onlyOwner`
- `function setOracle(address newOracle) external onlyOwner`

### Views
- `function getMatch(uint256 matchId) external view returns (...)`
- `function getActiveMatch(address player) external view returns (uint256)`
- `function canPlayerCommit(address player) external view returns (bool)`
- `function hasActiveMatch(address player) external view returns (bool)`
- `function getMatchState(uint256 matchId) external view returns (MatchStatus)`

### ID Format and Migration Notes
- Match IDs are now `uint256` (previously `bytes32`). IDs are sequential (`matchId = ++matchCounter`).
- Update app/ABIs to pass/read `uint256`/BigInt.
- Store `matchId` in your DB as a decimal string (`matchId.toString()`) to avoid JSON BigInt issues.
- Do not pre-generate IDs off-chain. Create on-chain first, then read `matchId` from the `MatchCreated` event in the receipt.

### Design Note: Active Matches and History
- The contract intentionally tracks only active matches on-chain. When a match settles or is canceled, it remains in `matches[matchId]` with its final status.
- History per player is not enumerated on-chain. Index and query history off-chain using events (`MatchCreated/Ready/Settled/Refunded/Canceled`).
- With `MAX_ACTIVE_MATCHES = 1`, use `getActiveMatch(address)` to read a player’s current match (or 0 if none). If you later allow multiple concurrent matches per player, prefer pagination-friendly views or rely on events rather than returning large arrays on-chain.

---

## Common Security Patterns

Both contracts implement:
1. **Checks-Effects-Interactions**: State changes before external calls
2. **Pull Payment**: Users claim funds; push falls back to pull when needed
3. **Event Emission**: All critical actions emit events for monitoring
4. **Explicit State Management**: Clear game/match status tracking
