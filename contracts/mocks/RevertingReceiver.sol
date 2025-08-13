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
                "joinMatch(uint256,address,uint256)",
                matchId,
                expectedOpponent,
                expectedWager
            )
        );
        require(success, "Join match failed");
    }
    
    // Function to create a match
    function createMatch(address escrow) external payable returns (uint256) {
        (bool success, bytes memory data) = escrow.call{value: msg.value}(
            abi.encodeWithSignature("createMatch()")
        );
        require(success, "Create match failed");
        
        // Decode and return the matchId
        return abi.decode(data, (uint256));
    }
    
    // Overloaded function to create match with specific wager (for testing)
    function createMatch(address escrow, uint256 wagerAmount) external returns (uint256) {
        require(address(this).balance >= wagerAmount, "Insufficient balance");
        (bool success, bytes memory data) = escrow.call{value: wagerAmount}(
            abi.encodeWithSignature("createMatch()")
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
    function withdrawFromEscrow(address escrow, uint256 matchId) external {
        // Temporarily enable ETH acceptance for withdrawal
        bool previousAcceptETH = acceptETH;
        acceptETH = true;
        
        (bool success, ) = escrow.call(
            abi.encodeWithSignature("withdraw(uint256)", matchId)
        );
        
        // Restore previous state
        acceptETH = previousAcceptETH;
        
        require(success, "Withdraw failed");
    }
}
