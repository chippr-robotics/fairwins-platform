// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

import {StandardDAOGovernor} from "./StandardDAOGovernor.sol";
import {StandardDAOToken} from "./StandardDAOToken.sol";

/// @dev WHY THESE EXIST — the EIP-170 code-size limit, measured, not guessed.
///
///      A contract that writes `new X(...)` carries X's ENTIRE creation code inside its own deployed
///      bytecode. `StandardDAOFactory` creates three children, and with all three inlined it compiled
///      to **44,706 bytes** of deployed code against a 24,576-byte limit — deployable on a Hardhat node
///      with `allowUnlimitedContractSize` and on no real chain. Splitting the creation code out is the
///      only fix that keeps one-transaction DAO creation.
///
///      EACH IS STATELESS, PERMISSIONLESS AND HOLDS NOTHING. Anyone may call them; doing so deploys a
///      stock OpenZeppelin contract owned by nobody, which confers no authority over any existing DAO.
///      The authority in this system is created entirely by the ROLE WIRING that `StandardDAOFactory`
///      performs on a timelock in the same transaction — never by who called a deployer.
///
///      The factory nonetheless verifies what it is handed back (`StandardDAOFactory` asserts the
///      governor's own `token()`/`timelock()` views), so a mis-set deployer address fails creation
///      loudly instead of producing a DAO wired to something else.
///
///      Cancun-only, like the rest of the spec-030 pillar-A closure — see the cancun override block in
///      hardhat.config.js and the 2026-08-30 amendment (issue #1268).

/// @title StandardDAOTimelockDeployer
/// @notice Deploys a bare `TimelockController` with NO proposers and NO executors, administered by
///         `admin` (the factory, which renounces that role before the creating transaction ends).
contract StandardDAOTimelockDeployer {
    function deployTimelock(uint256 minDelay, address admin) external returns (address) {
        return address(new TimelockController(minDelay, new address[](0), new address[](0), admin));
    }
}

/// @title StandardDAOTokenDeployer
/// @notice Deploys a fixed-supply {StandardDAOToken}. No owner, no mint function: the supply is fixed
///         at construction and nobody can dilute the electorate afterwards.
contract StandardDAOTokenDeployer {
    function deployToken(
        string calldata name,
        string calldata symbol,
        address mintTo,
        uint256 initialSupply
    ) external returns (address) {
        return address(new StandardDAOToken(name, symbol, mintTo, initialSupply));
    }
}

/// @title StandardDAOGovernorDeployer
/// @notice Deploys a stock {StandardDAOGovernor} bound to a votes token and a timelock.
contract StandardDAOGovernorDeployer {
    function deployGovernor(
        string calldata name,
        address token,
        address payable timelock,
        uint48 votingDelay,
        uint32 votingPeriod,
        uint256 proposalThreshold,
        uint256 quorumPercent
    ) external returns (address) {
        return address(
            new StandardDAOGovernor(
                name,
                IVotes(token),
                TimelockController(timelock),
                votingDelay,
                votingPeriod,
                proposalThreshold,
                quorumPercent
            )
        );
    }
}
