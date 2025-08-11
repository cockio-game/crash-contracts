// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ICrashSteps {
    function deposit(address referrer) external payable;
    function claim(uint256 n, uint256 reward, bytes calldata sig) external;
    function payoutCap(address, uint256) external view returns (uint256);
}

contract AttackReenterClaim {
    ICrashSteps public immutable game;
    uint256    public immutable nonce;          // 0
    uint256    public reward;
    bytes      public sig;
    bool       public secondSucceeded;          // <- tells the test what happened

    constructor(ICrashSteps _game) payable {
        game  = _game;
        nonce = 0;
        game.deposit{value: msg.value}(address(0));
    }

    function setReceipt(uint256 _reward, bytes calldata _sig) external {
        reward = _reward;
        sig    = _sig;
    }

    function attack() external {
        game.claim(nonce, reward, sig);         // first call — should succeed
    }

    receive() external payable {
        // re-enter with a *raw* call and swallow any revert
        (bool ok, ) = address(game).call(
            abi.encodeWithSelector(
                game.claim.selector,
                nonce,
                reward,
                sig
            )
        );
        secondSucceeded = ok;                   // will be false if guard fired
        // DO NOT revert – let the transfer succeed
    }
}
