const { expect } = require("chai");
const { ethers } = require("hardhat");

// Spec 043 — events-only broadcaster of Safe transaction preimages. Holds no funds, no state, no authority.
// Asserts events carry the exact args, invalid operation / oversized data revert, and no state is written.

describe("SafeProposalHub", function () {
  let hub, alice, bob;
  const SAFE = "0x1111111111111111111111111111111111111111";
  const TO = "0x2222222222222222222222222222222222222222";
  const HASH = "0x" + "ab".repeat(32);

  beforeEach(async () => {
    [alice, bob] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("SafeProposalHub");
    hub = await Factory.deploy();
    await hub.waitForDeployment();
  });

  it("emits Proposed with the exact preimage args and msg.sender as proposer", async () => {
    await expect(hub.connect(alice).propose(SAFE, TO, 1000, "0x1234", 0, 7, HASH))
      .to.emit(hub, "Proposed")
      .withArgs(SAFE, alice.address, HASH, TO, 1000n, "0x1234", 0, 7n);
  });

  it("accepts operation 1 (delegatecall) and empty data", async () => {
    await expect(hub.connect(bob).propose(SAFE, TO, 0, "0x", 1, 0, HASH))
      .to.emit(hub, "Proposed")
      .withArgs(SAFE, bob.address, HASH, TO, 0n, "0x", 1, 0n);
  });

  it("reverts on invalid operation (> 1)", async () => {
    await expect(hub.propose(SAFE, TO, 0, "0x", 2, 0, HASH)).to.be.revertedWithCustomError(
      hub,
      "InvalidOperation",
    );
  });

  it("reverts when data exceeds the length bound", async () => {
    const tooLong = "0x" + "00".repeat(8193); // MAX_DATA_LENGTH = 8192
    await expect(hub.propose(SAFE, TO, 0, tooLong, 0, 0, HASH)).to.be.revertedWithCustomError(
      hub,
      "DataTooLong",
    );
  });

  it("emits Cancelled with proposer = msg.sender", async () => {
    await expect(hub.connect(alice).cancel(SAFE, HASH))
      .to.emit(hub, "Cancelled")
      .withArgs(SAFE, alice.address, HASH);
  });

  it("rejects plain ETH transfers (no receive/payable fallback) and holds no balance", async () => {
    // The hub has no receive() and no payable fallback, so an ordinary value transfer reverts. (Forced ETH
    // via SELFDESTRUCT is not preventable by any contract, so we assert the reachable property: normal sends
    // revert and the balance stays zero.)
    const addr = await hub.getAddress();
    // ANY-REVERT: no receive/fallback — refused with empty revert data, so there is no reason to name.
    await expect(alice.sendTransaction({ to: addr, value: 1n })).to.be.revertedWithoutReason();
    expect(await ethers.provider.getBalance(addr)).to.equal(0n);
  });
});
