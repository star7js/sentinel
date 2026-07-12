// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal ERC-4337-style smart account for Sentinel userOp tests: an
/// EntryPoint-gated executor, nothing more. Not for production use.
contract MiniAccount {
    address public immutable entryPoint;

    constructor(address entryPoint_) {
        entryPoint = entryPoint_;
    }

    receive() external payable {}

    function execute(address dest, uint256 value, bytes calldata data) external {
        require(msg.sender == entryPoint, "only entrypoint");
        (bool ok, bytes memory ret) = dest.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
