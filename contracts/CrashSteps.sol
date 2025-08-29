// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/*//////////////////////////////////////////////////////////////
                          CRASH WITH STEPS
//////////////////////////////////////////////////////////////*/

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract CrashSteps is EIP712, Ownable, Pausable {
    using Address for address payable;

    /*//////////////////////////////////////////////////////////////
                              CONSTANTS
    //////////////////////////////////////////////////////////////*/
    uint16 public constant BP_DENOM               = 10_000;        // 100 % in basis-points
    uint32  public constant FORFEIT_DELAY         = 1 days;        // maximum wait period before losing tickets are finalized
    bytes32 public constant TYPE_HASH = keccak256("CrashReceipt(address player,uint256 nonce,uint256 reward)");

    /*//////////////////////////////////////////////////////////////
                                CONFIG
    //////////////////////////////////////////////////////////////*/

    // These are initialized in the constructor for clarity that they may change post-deploy
    uint16 public platformFeeBp;
    uint16 public referralFeeBp;

    uint256 public minDeposit;
    uint256 public maxDeposit;

    uint32 public riskBurstBp;
    uint32 public maxPayoutFactorBp;

    /// @dev Oracle signs claims
    address public oracle;

    /*//////////////////////////////////////////////////////////////
                               STORAGE
    //////////////////////////////////////////////////////////////*/

    // Liability accounting
    // - capLiability tracks outstanding payout caps for active tickets
    // - referralLiability tracks unpaid referral balances (credited on failed payouts)
    // - totalLiability mirrors the sum for external consumers and withdraw logic
    uint256 public capLiability;
    uint256 public referralLiability;
    uint256 public totalLiability;
    mapping(address => uint256) public nonce;
    mapping(address => mapping(uint256 => uint256)) public netStakes;
    mapping(address => address) public referrerOf;
    mapping(address => uint256) public referralEarned;
    mapping(address => uint256) public referralBalances;
    mapping(address => mapping(uint256 => uint256)) public depositedAt;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event Deposited(address indexed player, uint256 amount, uint256 nonce, uint256 cap);
    event Claimed(address indexed player, uint256 nonce, uint256 reward);
    event MaxPayoutFactorChanged(uint32 oldFactorBp, uint32 newFactorBp);
    event Forfeited(address indexed player,uint256 indexed nonce, address indexed caller);
    event PlatformFeeChanged(uint16 oldFeeBp, uint16 newFeeBp);
    event DepositLimitsChanged(uint256 oldMin, uint256 oldMax, uint256 newMin, uint256 newMax);
    event RiskBurstFactorChanged(uint32 oldBp, uint32 newBp);
    event ReferralFeeChanged(uint16 oldBp, uint16 newBp);
    event ReferralPaid(address indexed referrer, address indexed player, uint256 amount);
    event OracleRotated(address indexed oldOracle, address indexed newOracle);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error BadSignature();
    error AlreadyClaimed();
    error RewardExceedsCap();
    error InsufficientBankroll();
    error InvalidParam();
    error DepositTooSmall();
    error DepositTooLarge();
    error OutstandingTicket();
    error TooEarly();
    error NoBalanceToWithdraw();
    error ExceedsSurplus();
    error NoSurplus();

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address _oracle) EIP712("CrashReceipt", "2") Ownable(msg.sender) {
        oracle = _oracle;
        platformFeeBp     = 500;            // 5%
        referralFeeBp     = 50;             // 0.5%
        minDeposit        = 0.001 ether;    // 0.001 ETH
        maxDeposit        = 0.125 ether;    // 0.125 ETH
        riskBurstBp       = 1_273_000;      // 127.3 x 10 000
        maxPayoutFactorBp = 22_0000;        // 22x
    }

    /*//////////////////////////////////////////////////////////////
                           PLAYER INTERACTION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Start a round by sending ETH.
     * @dev Referral fees are paid by the house (from contract liquidity) and do not reduce
     *      a player's betting cap or limits. This effectively reduces the house edge by the
     *      referral fee when active. Referrer is sticky on first set; passing a different nonzero
     *      referrer later is ignored (conflicting referrers do not revert).
     */
    function deposit(address referrer) external payable whenNotPaused {
        uint256 stake = msg.value;

        if (stake < minDeposit) revert DepositTooSmall();
        if (stake > maxDeposit || stake > maxBet()) revert DepositTooLarge();

        uint256 platformCut = (stake * platformFeeBp) / BP_DENOM;
        uint256 netStake    = stake - platformCut;               // wager used for cap math

        uint256 n = nonce[msg.sender];
        if (n > 0 && netStakes[msg.sender][n - 1] != 0) revert OutstandingTicket();

        uint256 cap = calculateCap(netStake);

        if (address(this).balance < totalLiability + cap) revert InsufficientBankroll();

        if (referrerOf[msg.sender] == address(0) && referrer != address(0) && referrer != msg.sender) {
            referrerOf[msg.sender] = referrer;
        }

        netStakes[msg.sender][n] = netStake;
        depositedAt[msg.sender][n] = block.timestamp;
        unchecked { capLiability += cap; }
        unchecked { totalLiability += cap; }
        unchecked { nonce[msg.sender] = n + 1; }

        emit Deposited(msg.sender, netStake, n, cap);

        address ref = referrerOf[msg.sender];
        if (ref != address(0) && referralFeeBp > 0) {
            uint256 referralCut = (stake * referralFeeBp) / BP_DENOM;
            unchecked { referralEarned[ref] += referralCut; }
            (bool success, ) = payable(ref).call{value: referralCut}("");

            if (success) {
                emit ReferralPaid(ref, msg.sender, referralCut);
            } else {
                unchecked { referralBalances[ref] += referralCut; }
                unchecked { referralLiability += referralCut; }
                unchecked { totalLiability += referralCut; }
            }
        }
    }

    /**
     * @notice Claim winnings. A receipt is valid once and only once.
     * @param n      Player nonce that matches the deposit
     * @param reward Payout amount in wei
     * @param sig    Oracle signature over typed data
     */
    function claim(
        uint256 n,
        uint256 reward,
        bytes   calldata sig
    ) external whenNotPaused {
        uint256 netStake = netStakes[msg.sender][n];
        if (netStake == 0) revert AlreadyClaimed();

        uint256 cap = calculateCap(netStake);
        if (reward > cap) revert RewardExceedsCap();

        bytes32 structHash = keccak256(
            abi.encode(
                TYPE_HASH,
                msg.sender,
                n,
                reward
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        if (ECDSA.recover(digest, sig) != oracle) revert BadSignature();

        delete netStakes[msg.sender][n];
        delete depositedAt[msg.sender][n];
        unchecked { capLiability -= cap; }
        unchecked { totalLiability -= cap; }

        if (address(this).balance < reward) revert InsufficientBankroll();

        payable(msg.sender).sendValue(reward);

        emit Claimed(msg.sender, n, reward);
    }

    /**
     * @notice Finalize a losing ticket, releasing its reserved liability.
     * @dev Oracle may invoke without waiting for FORFEIT_DELAY. This is an explicit privilege
     *      and represents a trust assumption in the oracle; non-oracle third parties must wait.
     */
    function forfeit(address player, uint256 n) external whenNotPaused {
        uint256 netStake = netStakes[player][n];
        if (netStake == 0) revert AlreadyClaimed();

        if (
            (msg.sender != player && msg.sender != oracle) &&
            block.timestamp < depositedAt[player][n] + FORFEIT_DELAY
        ) {
            revert TooEarly();
        }

        uint256 cap = calculateCap(netStake);
        delete netStakes[player][n];
        delete depositedAt[player][n];
        unchecked { capLiability -= cap; }
        unchecked { totalLiability -= cap; }
        emit Forfeited(player, n, msg.sender);
    }

    /**
     * @notice Allows a referrer to withdraw their accumulated referral balance.
     */
    function withdrawReferralBalance() external {
        uint256 amount = referralBalances[msg.sender];
        if (amount == 0) revert NoBalanceToWithdraw();

        referralBalances[msg.sender] = 0;
        unchecked { referralLiability -= amount; }
        unchecked { totalLiability -= amount; }
        payable(msg.sender).sendValue(amount);
    }

    function maxBet() public view returns (uint256) {
        uint256 liquid =
            address(this).balance > totalLiability
                ? address(this).balance - totalLiability
                : 0;

        return (liquid * BP_DENOM) / riskBurstBp;
    }

    /*//////////////////////////////////////////////////////////////
                                 ADMIN
    //////////////////////////////////////////////////////////////*/

    function rotateOracle(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert InvalidParam();
        address old = oracle;
        oracle = newOracle;
        emit OracleRotated(old, newOracle);
    }

    function setMaxPayoutFactorBp(uint32 newFactorBp) external onlyOwner {
        if (newFactorBp < BP_DENOM || newFactorBp > 1_500_000) revert InvalidParam(); // 1×–150×
        uint32 old = maxPayoutFactorBp;
        if (newFactorBp == old) return;

        // Scale existing cap liability proportionally to keep accounting consistent
        // newCap = capLiability * new / old
        if (capLiability > 0) {
            uint256 newCap = (capLiability * uint256(newFactorBp)) / uint256(old);
            // Update totalLiability by the delta on the cap portion only
            if (newCap > capLiability) {
                uint256 inc = newCap - capLiability;
                unchecked { totalLiability += inc; }
            } else if (capLiability > newCap) {
                uint256 dec = capLiability - newCap;
                unchecked { totalLiability -= dec; }
            }
            capLiability = newCap;
        }

        maxPayoutFactorBp = newFactorBp;
        emit MaxPayoutFactorChanged(old, newFactorBp);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _surplus() public view returns (uint256) {
        uint256 bal = address(this).balance;
        return bal > totalLiability ? bal - totalLiability : 0;
    }

    function withdraw(uint256 amount) external onlyOwner {
        if (amount == 0) revert InvalidParam();
        if (amount > _surplus()) revert ExceedsSurplus();
        payable(msg.sender).sendValue(amount);
    }

    function withdrawAll() external onlyOwner {
        uint256 surplus = _surplus();
        if (surplus == 0) revert NoSurplus();
        payable(msg.sender).sendValue(surplus);
    }

    function setReferralFeeBp(uint16 newBp) external onlyOwner {
        if (newBp > 1_000) revert InvalidParam();   // Maximum referral fee capped at at 10 %
        uint16 old = referralFeeBp;
        referralFeeBp = newBp;
        emit ReferralFeeChanged(old, newBp);
    }

    function setPlatformFeeBp(uint16 newFeeBp) external onlyOwner {
        if (newFeeBp > 1_000) revert InvalidParam();      // Maximum platform fee capped at 10 %
        uint16 old = platformFeeBp;
        platformFeeBp = newFeeBp;
        emit PlatformFeeChanged(old, newFeeBp);
    }

    function setDepositLimits(uint256 newMin, uint256 newMax) external onlyOwner {
        if (newMin == 0 || newMin > newMax) revert InvalidParam();
        uint256 oldMin = minDeposit;
        uint256 oldMax = maxDeposit;
        minDeposit = newMin;
        maxDeposit = newMax;
        emit DepositLimitsChanged(oldMin, oldMax, newMin, newMax);
    }

    function setRiskBurstBp(uint32 newBp) external onlyOwner {
        if (newBp == 0) revert InvalidParam();
        emit RiskBurstFactorChanged(riskBurstBp, newBp);
        riskBurstBp = newBp;
    }

    /*//////////////////////////////////////////////////////////////
                            INTERNAL HELPERS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Calculate the payout cap for a given net stake
     * @param netStake The net stake amount (after platform fee)
     * @return The maximum payout cap
     */
    function calculateCap(uint256 netStake) public view returns (uint256) {
        return (netStake * maxPayoutFactorBp) / BP_DENOM;
    }

    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}
