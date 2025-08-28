# Smart Contract Audit Documentation

## Overview
This document provides technical documentation for the Crash Game smart contracts deployed on Abstract testnet. The system consists of two main contracts:
1. `contracts/CrashSteps.sol` — Single-player crash game with step-based progression
2. `contracts/pvp/CrashGamePvP.sol` — Player vs Player escrow with matched betting

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
- View function calculating maximum payout for a stake
- Returns `(netStake * maxPayoutFactorBp) / 10000`

#### Admin Functions
- `rotateOracle(address newOracle)` — updates the oracle signer
- `setMaxPayoutFactorBp(uint32 newFactorBp)` — set cap multiplier (1×–150×)
- `setPlatformFeeBp(uint16 newFeeBp)` — max 10%
- `setReferralFeeBp(uint16 newBp)` — max 10%
- `setDepositLimits(uint256 newMin, uint256 newMax)`
- `setRiskBurstBp(uint32 newBp)` — bankroll risk budgeting
- `pause()` / `unpause()` — gate `deposit/claim/forfeit`
- `withdraw(uint256 amount)` / `withdrawAll()` — owner may withdraw only the current surplus (contract balance minus totalLiability)

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
PvP escrow for matched bets between two players. Reduces transactions by combining match creation with the initial deposit, enforces at most one active match per player, and uses pull‑payments for payouts and referral rewards to prevent DoS.

### Match Status
- None: Match does not exist
- AwaitingOpponent: Player A deposited; waiting for Player B
- Active: Both players deposited; game active
- Settled: Oracle settled the match; winnings credited to pull-payment
- Refunded: Match canceled and funds refunded/credited

### Storage (key items)
- `owner`: Contract owner
- `oracleAddress`: Address authorized to approve bets, settle, and cancel
- `matchCounter`: Sequential counter for match IDs
- `mapping(uint256 => Match) matches`: Match data by `matchId`
- `mapping(address => uint256) activeMatchOf`: One active match per player (0 = none)
- `mapping(address => uint256) userBalance`: Aggregated pull‑payment credits (winnings/refunds)
- `mapping(address => uint256) referralBalances`: Pull‑payment credits for referrers
 - `mapping(address => uint256) feeClaimable`: Accrued platform fees (owner)
 - `uint16 feeBp`: Platform fee in basis points (0–1000 bps = 0–10%)
 - `uint256 feePercent`: Legacy whole‑percent fee (soft‑deprecated; kept for compatibility)
- `uint16 referralFeeBp`: Referral fee in basis points (default 50 = 0.5%)
- `uint16 mergeToleranceBp`: Allowed wager mismatch for merging awaiting matches (default 0; max 5%)
- `uint256 approvalVersion`: Version to invalidate prior EIP‑712 bet approvals

### Events
- `MatchCreated(uint256 matchId, address playerA, uint256 wagerAmount)`
- `MatchReady(uint256 matchId, address playerA, address playerB)`
- `MatchSettled(uint256 matchId, address winner, uint256 payout)`
- `MatchRefunded(uint256 matchId, address player, uint256 amount)`
- `MatchCanceled(uint256 matchId, address playerA, address playerB)`
- `BalanceCredited(address user, uint256 amount, uint256 matchId)`
- `BalanceWithdrawn(address user, uint256 amount)`
- `FeeBpUpdated(uint16 oldFeeBp, uint16 newFeeBp)`
- `FeePercentUpdated(uint256 oldFee, uint256 newFee)`
- `FeeWithdrawn(address to, uint256 amount)`
- `OracleUpdated(address oldOracle, address newOracle)`
- `ReferralFeeChanged(uint16 oldBp, uint16 newBp)`
- `ReferralPaid(address referrer, address player, uint256 amount)`
- `MergeToleranceChanged(uint16 oldBp, uint16 newBp)`

### Core Functions

Creation and joining
- `createMatch(address referrer, uint256 deadline, bytes sig) external payable returns (uint256 matchId)`
  - Requires `activeMatchOf[msg.sender] == 0`
  - Requires a valid oracle EIP‑712 approval for the exact `msg.value`
    - Domain: `EIP712("CrashGamePvP","1")`
    - Typehash: `BetApproval(address player,uint256 version,uint256 amount,uint256 deadline)`
  - Snapshots `feeBpAtCreate` and `referralFeeAtCreate`; sets sticky `referrer`

- `joinMatch(uint256 matchId, address expectedOpponent, uint256 expectedWager, address referrer, uint256 deadline, bytes sig) external payable`
  - Requires `matches[matchId].status == AwaitingOpponent`
  - Requires `msg.value == expectedWager == matches[matchId].wagerAmount`
  - Optional front‑run protection via `expectedOpponent`
  - Requires `activeMatchOf[msg.sender] == 0`
  - Requires a valid oracle EIP‑712 approval for the joiner’s `msg.value`; sets sticky `referrer`

Merging
- `mergeAwaitingMatches(uint256 sourceId, uint256 targetId) external onlyOracle`
  - Pairs two `AwaitingOpponent` matches into one `Active` match
  - Allows small wager drift up to `mergeToleranceBp`; equalizes both wagers to the minimum and credits overage back to players’ `userBalance`
  - Requires `feeBpAtCreate` and `referralFeeAtCreate` snapshots to match; updates source player's active pointer to target

Settlement and cancellation
- `settleMatch(uint256 matchId, address winner) external onlyOracle`
  - Draw (`winner == address(0)`): marks Refunded; clears both active slots; credits both players their full wager; no fee charged
  - Winner path: charges `fee = totalDeposit * feeBpAtCreate / 10_000`, allocates referral rewards from the fee (never from player pot), credits `userBalance[winner]` with net pot, accrues remaining fee into `feeClaimable[owner]`

- `cancelMyMatch(uint256 matchId) external`
  - Only Player A; only while `AwaitingOpponent`
  - Attempts direct push refund; on failure credits `userBalance`

- `cancelMatch(uint256 matchId) external onlyOracle`
  - Only `AwaitingOpponent`; credits Player A’s deposit to `userBalance[playerA]`

Withdrawals and admin
 - `withdraw()` — player withdraws their entire aggregated balance (`userBalance[msg.sender]` is set to 0)
 - `withdrawReferralBalance()` — referrers withdraw accumulated referral rewards
 - `withdrawFees(address to) onlyOwner` — owner withdraws accumulated fees
 - `setFeeBp(uint16 newFeeBp) onlyOwner` — max 1000 bps (10%); preferred
 - `setFeePercent(uint256 newFeePercent) onlyOwner` — legacy; also syncs `feeBp = newFeePercent * 100`
- `setOracle(address newOracle) onlyOwner`
- `setApprovalVersion(uint256 newVersion) onlyOwner` — invalidate older bet approvals
- `setMergeToleranceBp(uint16 newBp) onlyOwner` — max 500 (5%)
- `setReferralFeeBp(uint16 newBp) onlyOwner` — max 1,000 (10%)

### Views
- `getMatch(uint256 matchId)` — returns playerA, playerB, wagerAmount, totalDeposit, status, createdAt, activeAt
- `getActiveMatch(address player)` — returns the player’s active `matchId` (0 if none)
- Public getters for mappings: `userBalance(address)`, `referralBalances(address)`, etc.

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
2. **Pull Payment**: PvP winnings/refunds always via `userBalance` withdrawal; CrashSteps referral payouts fall back to pull on push failure
3. **Event Emission**: All critical actions emit events for monitoring
4. **Explicit State Management**: Clear game/match status tracking
