// Spec 112 (FR-004) — role-gate assertion helper for the negative-path suites.
//
// Asserts the SPECIFIC OpenZeppelin AccessControl error, WITH its arguments (the rejected account and
// the role it lacked). A bare `.to.be.reverted` would also pass on a zero-address check or a paused
// contract firing first, which is exactly the confusion spec 112 removes.

const { expect } = require("chai");

/**
 * @param {import("ethers").Contract} contract the contract whose ABI declares the error
 * @param {Promise} txPromise                   the call made FROM `account`
 * @param {string} account                      the caller lacking the role
 * @param {string} role                         bytes32 role id
 */
async function expectMissingRole(contract, txPromise, account, role) {
  await expect(txPromise)
    .to.be.revertedWithCustomError(contract, "AccessControlUnauthorizedAccount")
    .withArgs(account, role);
}

module.exports = { expectMissingRole };
