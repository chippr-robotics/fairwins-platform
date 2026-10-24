// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FundingPoolFactory} from "../pools/FundingPoolFactory.sol";

/// @title FundingPoolFactoryV2Mock
/// @notice TEST-ONLY upgrade target proving the funding-pool factory proxy upgrades in place and preserves
///         state (no storage added — trivially layout-compatible). NEVER deploy in production.
contract FundingPoolFactoryV2Mock is FundingPoolFactory {
    function version() external pure returns (uint256) {
        return 2;
    }
}
