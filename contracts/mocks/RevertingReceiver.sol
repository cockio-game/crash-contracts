// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @dev Mock contract that reverts on receiving ETH for testing DoS protection
 */
contract RevertingReceiver {
    bool public acceptETH = true;
    
    // Toggle whether to accept ETH
    function setAcceptETH(bool _accept) external {
        acceptETH = _accept;
    }
    
    // Conditionally accept or reject ETH
    receive() external payable {
        if (!acceptETH) {
            revert("ETH not accepted");
        }
    }
    
    // Also conditionally revert in fallback
    fallback() external payable {
        if (!acceptETH) {
            revert("ETH not accepted");
        }
    }
    
    // Function to participate in PvP matches
    function joinMatch(
        address escrow,
        uint256 matchId,
        address expectedOpponent,
        uint256 expectedWager
    ) external {
        // Note: msg.value is already sent to this contract before calling this function
        // We need to forward it to the escrow
        (bool success, ) = escrow.call{value: expectedWager}(
            abi.encodeWithSignature(
                "joinMatch(uint256,address,uint256,address)",
                matchId,
                expectedOpponent,
                expectedWager,
                address(0)
            )
        );
        require(success, "Join match failed");
    }

    // New helper matching the updated join signature that requires EIP-712 approval
    function joinMatchWithApproval(
        address escrow,
        uint256 matchId,
        address expectedOpponent,
        uint256 expectedWager,
        address referrer,
        uint256 deadline,
        bytes calldata sig
    ) external {
        (bool success, ) = escrow.call{value: expectedWager}(
            abi.encodeWithSignature(
                "joinMatch(uint256,address,uint256,address,uint256,bytes)",
                matchId,
                expectedOpponent,
                expectedWager,
                referrer,
                deadline,
                sig
            )
        );
        require(success, "Join match failed");
    }
    
    // Function to create a match (no-referrer) with explicit approval deadline
    function createMatch(address escrow, bytes memory sig, uint256 deadline) external payable returns (uint256) {
        (bool success, bytes memory data) = escrow.call{value: msg.value}(
            abi.encodeWithSignature("createMatch(address,uint256,bytes)", address(0), deadline, sig)
        );
        require(success, "Create match failed");
        
        // Decode and return the matchId
        return abi.decode(data, (uint256));
    }
    
    // Overloaded function to create match with specific wager (for testing)
    function createMatch(address escrow, bytes memory sig, uint256 deadline, uint256 wagerAmount) external returns (uint256) {
        require(address(this).balance >= wagerAmount, "Insufficient balance");
        (bool success, bytes memory data) = escrow.call{value: wagerAmount}(
            abi.encodeWithSignature("createMatch(address,uint256,bytes)", address(0), deadline, sig)
        );
        require(success, "Create match failed");
        
        // Decode and return the matchId
        return abi.decode(data, (uint256));
    }
    
    // Function to cancel a match
    function cancelMatch(address escrow, uint256 matchId) external {
        (bool success, ) = escrow.call(
            abi.encodeWithSignature("cancelMyMatch(uint256)", matchId)
        );
        require(success, "Cancel match failed");
    }
    
    // Function to withdraw from escrow (pull payment)
    function withdrawFromEscrow(address escrow) external {
        // Temporarily enable ETH acceptance for withdrawal
        bool previousAcceptETH = acceptETH;
        acceptETH = true;
        
        (bool success, ) = escrow.call(
            abi.encodeWithSignature("withdraw()")
        );
        
        // Restore previous state
        acceptETH = previousAcceptETH;
        
        require(success, "Withdraw failed");
    }

    // Helper to withdraw referral balance from CrashSteps
    function withdrawReferralFromSteps(address steps) external {
        bool previousAcceptETH = acceptETH;
        acceptETH = true;
        (bool success, ) = steps.call(abi.encodeWithSignature("withdrawReferralBalance()"));
        acceptETH = previousAcceptETH;
        require(success, "Withdraw referral failed");
    }
}
