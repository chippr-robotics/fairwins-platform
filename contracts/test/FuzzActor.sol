// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FuzzActor
/// @notice Test-only actor proxy for the Medusa property harnesses (spec 112 FR-010). A harness deploys a
///         handful of these so a value path sees DISTINCT `msg.sender`s (creator, members, a stranger)
///         without cheatcode pranks. Only the deploying harness may drive it.
/// @dev    NOT for production. `exec` never reverts — the harness reads `ok` and decides whether a success
///         was legitimate, which is how "this call must have failed" becomes a property.
contract FuzzActor {
    address public immutable owner;

    constructor() {
        owner = msg.sender;
    }

    function exec(address target, bytes calldata data) external returns (bool ok, bytes memory ret) {
        require(msg.sender == owner, "FuzzActor: not owner");
        (ok, ret) = target.call(data);
    }

    receive() external payable {}
}

/// @notice Medusa/HEVM cheatcode surface used by the harnesses. Always reached through a LOW-LEVEL call
///         (see {FuzzCheats}) so the same harness also deploys on a plain Hardhat network, where the
///         cheatcode address has no code and the call is a harmless no-op.
interface IFuzzHevm {
    function warp(uint256 newTimestamp) external;
    function deal(address account, uint256 amount) external;
}

library FuzzCheats {
    address internal constant HEVM = 0x7109709ECfa91a80626fF3989D68f67F5b1DD12D;

    function warp(uint256 newTimestamp) internal {
        (bool ok, ) = HEVM.call(abi.encodeCall(IFuzzHevm.warp, (newTimestamp)));
        ok; // no-op outside Medusa
    }

    function deal(address account, uint256 amount) internal {
        (bool ok, ) = HEVM.call(abi.encodeCall(IFuzzHevm.deal, (account, amount)));
        ok; // no-op outside Medusa
    }

    function bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        if (hi <= lo) return lo;
        return lo + (x % (hi - lo + 1));
    }
}
