const { expect } = require("chai");
const { ethers } = require("hardhat");

// Spec 112 (FR-004 / FR-006, #1673) — named bound reverts on the custody contracts, each asserted
// by name AND paired with the accept-at-the-bound case, so the test fails if the bound moves in
// either direction (an off-by-one that rejects the maximum is as wrong as one that admits max+1).
//
//   SafePolicyGuardV2.CooldownTooLong  — setRules cooldown > MAX_COOLDOWN (365 days)
//   SafePolicyGuardV2.TooManyTargets   — a rule naming more than MAX_TARGETS (16) targets
//   SafeProposalHub.InvalidOperation   — operation other than 0 (call) / 1 (delegatecall)
//   SafeProposalHub.DataTooLong        — preimage data longer than 8192 bytes

const ANY = "0x0000000000000000000000000000000000000001";

function rule(over = {}) {
  return {
    asset: ANY,
    perTxLimit: 1n,
    windowLimit: 0n,
    approvalsRequired: 0,
    banded: false,
    approvers: [],
    targets: [],
    ...over,
  };
}

const addrs = (n) => Array.from({ length: n }, (_, i) => ethers.getAddress(ethers.toBeHex(0x1000 + i, 20)));

describe("SafePolicyGuardV2 — configuration bounds (spec 112)", function () {
  let guard, vault;

  beforeEach(async () => {
    [vault] = await ethers.getSigners();
    guard = await (await ethers.getContractFactory("SafePolicyGuardV2")).deploy();
    await guard.waitForDeployment();
  });

  it("CooldownTooLong: rejects MAX_COOLDOWN + 1 and writes nothing; MAX_COOLDOWN itself is accepted", async () => {
    const max = await guard.MAX_COOLDOWN();
    expect(max).to.equal(365n * 24n * 60n * 60n);

    await expect(guard.connect(vault).setRules([rule()], max + 1n)).to.be.revertedWithCustomError(guard, "CooldownTooLong");
    expect(await guard.ruleCount(vault.address)).to.equal(0n);

    await expect(guard.connect(vault).setRules([rule()], max)).to.emit(guard, "RulesSet");
    expect(await guard.ruleCount(vault.address)).to.equal(1n);
  });

  it("TooManyTargets: a rule naming MAX_TARGETS + 1 targets is rejected; exactly MAX_TARGETS is accepted", async () => {
    const max = Number(await guard.MAX_TARGETS());
    expect(max).to.equal(16);

    // The offending rule is the SECOND one: validation runs per rule, so a valid first rule must not mask it.
    const bad = [rule(), rule({ targets: addrs(max + 1) })];
    await expect(guard.connect(vault).setRules(bad, 0)).to.be.revertedWithCustomError(guard, "TooManyTargets");
    expect(await guard.ruleCount(vault.address)).to.equal(0n);

    await guard.connect(vault).setRules([rule({ targets: addrs(max) })], 0);
    expect(await guard.ruleCount(vault.address)).to.equal(1n);
  });
});

describe("SafeProposalHub — preimage bounds (spec 112)", function () {
  const SAFE = "0x1111111111111111111111111111111111111111";
  const TO = "0x2222222222222222222222222222222222222222";
  const HASH = "0x" + "cd".repeat(32);
  let hub;

  beforeEach(async () => {
    hub = await (await ethers.getContractFactory("SafeProposalHub")).deploy();
    await hub.waitForDeployment();
  });

  it("InvalidOperation: every operation byte above 1 is refused (2 and 255); 0 and 1 are broadcast", async () => {
    for (const op of [2, 255]) {
      await expect(hub.propose(SAFE, TO, 0, "0x", op, 0, HASH)).to.be.revertedWithCustomError(hub, "InvalidOperation");
    }
    for (const op of [0, 1]) {
      await expect(hub.propose(SAFE, TO, 0, "0x", op, 0, HASH)).to.emit(hub, "Proposed");
    }
  });

  it("DataTooLong: 8193 bytes of data is refused; exactly 8192 is broadcast", async () => {
    const atLimit = "0x" + "11".repeat(8192);
    const overLimit = "0x" + "11".repeat(8193);
    await expect(hub.propose(SAFE, TO, 0, overLimit, 0, 0, HASH)).to.be.revertedWithCustomError(hub, "DataTooLong");
    await expect(hub.propose(SAFE, TO, 0, atLimit, 0, 0, HASH)).to.emit(hub, "Proposed");
  });

  it("checks operation BEFORE data length (an invalid op with oversized data reports InvalidOperation)", async () => {
    const overLimit = "0x" + "11".repeat(8193);
    await expect(hub.propose(SAFE, TO, 0, overLimit, 2, 0, HASH)).to.be.revertedWithCustomError(hub, "InvalidOperation");
  });
});
