// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/*//////////////////////////////////////////////////////////////
                          CRASH WITH STEPS
//////////////////////////////////////////////////////////////*/

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract CrashSteps is EIP712, Ownable, Pausable, ReentrancyGuard {
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

    uint16 public platformFeeBp         = 500;                  // default 5% fee
    uint16 public referralFeeBp         = 50;                   // default 0.5%

    uint256 public minDeposit           = 0.001 ether;          // 0.001 ETH
    uint256 public maxDeposit           = 0.125 ether;          // 0.125 ETH

    uint32 public riskBurstBp           = 1_273_000;             // 127.3 x 10 000
    uint32 public maxPayoutFactorBp     = 22_0000;              /// 22x

    /// @dev Oracle signs claims
    address public oracle;

    /*//////////////////////////////////////////////////////////////
                               STORAGE
    //////////////////////////////////////////////////////////////*/

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

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address _oracle) EIP712("CrashReceipt", "2") Ownable(msg.sender) {
        oracle = _oracle;
    }

    /*//////////////////////////////////////////////////////////////
                           PLAYER INTERACTION
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Start a round by sending ETH.
     */
    function deposit(address referrer) external payable whenNotPaused nonReentrant {
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
        totalLiability += cap;
        nonce[msg.sender] = n + 1;

        emit Deposited(msg.sender, netStake, n, cap);

        address ref = referrerOf[msg.sender];
        if (ref != address(0)) {
            uint256 referralCut = (stake * referralFeeBp) / BP_DENOM;
            referralEarned[ref] += referralCut;
            (bool success, ) = payable(ref).call{value: referralCut}("");

            if (success) {
                emit ReferralPaid(ref, msg.sender, referralCut);
            } else {
                referralBalances[ref] += referralCut;
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
    ) external nonReentrant whenNotPaused {
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
        totalLiability -= cap;

        if (address(this).balance < reward) revert InsufficientBankroll();

        payable(msg.sender).sendValue(reward);

        emit Claimed(msg.sender, n, reward);
    }

    function forfeit(address player, uint256 n) external nonReentrant whenNotPaused {
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
        totalLiability -= cap;
        emit Forfeited(player, n, msg.sender);
    }

    /**
     * @notice Allows a referrer to withdraw their accumulated referral balance.
     */
    function withdrawReferralBalance() external nonReentrant {
        uint256 amount = referralBalances[msg.sender];
        require(amount > 0, "No balance to withdraw");

        referralBalances[msg.sender] = 0;
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
        oracle = newOracle;
    }

    function setMaxPayoutFactorBp(uint32 newFactorBp) external onlyOwner {
        if (newFactorBp < BP_DENOM || newFactorBp > 1_500_000) revert InvalidParam(); // 1×–150×
        uint32 old = maxPayoutFactorBp;
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

    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidParam();
        require(amount <= _surplus(), "Exceeds surplus");
        payable(msg.sender).sendValue(amount);
    }

    function withdrawAll() external onlyOwner nonReentrant {
        uint256 surplus = _surplus();
        require(surplus > 0, "No surplus");
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
