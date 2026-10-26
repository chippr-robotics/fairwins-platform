const { expect } = require("chai");
const { ethers } = require("hardhat");

// Unit tests for the role-based ERC-1404 RestrictedERC20V2 (spec 028 expansion, US8):
// COMPLIANCE-gated eligibility/freeze, detector⇄transfer parity, settable default message, caps, roles.

const ZERO = ethers.ZeroAddress;
const tok = (n) => ethers.parseUnits(String(n), 18);
const role = (n) => ethers.keccak256(ethers.toUtf8Bytes(n));
const COMPLIANCE = role("COMPLIANCE_ROLE");
const CODE = { SUCCESS: 0, SENDER_NOT_ELIGIBLE: 1, RECIPIENT_NOT_ELIGIBLE: 2, SENDER_FROZEN: 3, SANCTIONED: 4 };

async function deployR(initArgs) {
  const Impl = await ethers.getContractFactory("RestrictedERC20V2");
  const impl = await Impl.deploy();
  await impl.waitForDeployment();
  const data = Impl.interface.encodeFunctionData("initializeRestricted", initArgs);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await Proxy.deploy(await impl.getAddress(), data);
  await proxy.waitForDeployment();
  return Impl.attach(await proxy.getAddress());
}

describe("RestrictedERC20V2 (role-based ERC-1404)", function () {
  let owner, alice, bob;
  beforeEach(async function () {
    [owner, alice, bob] = await ethers.getSigners();
  });

  it("owner holds COMPLIANCE; owner + initialEligible eligible; supply minted", async function () {
    const t = await deployR(["Reg", "REG", 18, tok(1000), 0, owner.address, ZERO, [alice.address]]);
    expect(await t.hasRole(COMPLIANCE, owner.address)).to.equal(true);
    expect(await t.eligible(owner.address)).to.equal(true);
    expect(await t.eligible(alice.address)).to.equal(true);
    expect(await t.eligible(bob.address)).to.equal(false);
    expect(await t.balanceOf(owner.address)).to.equal(tok(1000));
  });

  it("detector⇄transfer parity: recipient-ineligible, then eligible", async function () {
    const t = await deployR(["Reg", "REG", 18, tok(100), 0, owner.address, ZERO, []]);
    expect(await t.detectTransferRestriction(owner.address, bob.address, tok(1))).to.equal(CODE.RECIPIENT_NOT_ELIGIBLE);
    await expect(t.connect(owner).transfer(bob.address, tok(1)))
      .to.be.revertedWithCustomError(t, "TransferRestricted").withArgs(CODE.RECIPIENT_NOT_ELIGIBLE);
    await t.connect(owner).setEligible(bob.address, true);
    expect(await t.detectTransferRestriction(owner.address, bob.address, tok(1))).to.equal(CODE.SUCCESS);
    await t.connect(owner).transfer(bob.address, tok(2));
    expect(await t.balanceOf(bob.address)).to.equal(tok(2));
  });

  it("eligibility/freeze admin is COMPLIANCE-gated", async function () {
    const t = await deployR(["Reg", "REG", 18, 0, 0, owner.address, ZERO, []]);
    await expect(t.connect(alice).setEligible(bob.address, true))
      .to.be.revertedWithCustomError(t, "AccessControlUnauthorizedAccount");
    await expect(t.connect(alice).setFrozen(bob.address, true))
      .to.be.revertedWithCustomError(t, "AccessControlUnauthorizedAccount");
    await expect(t.connect(alice).setDefaultRestrictionMessage("x"))
      .to.be.revertedWithCustomError(t, "AccessControlUnauthorizedAccount");
  });

  it("setEligibleBatch + settable default message", async function () {
    const t = await deployR(["Reg", "REG", 18, 0, 0, owner.address, ZERO, []]);
    await t.connect(owner).setEligibleBatch([alice.address, bob.address], true);
    expect(await t.eligible(alice.address)).to.equal(true);
    expect(await t.eligible(bob.address)).to.equal(true);
    await t.connect(owner).setDefaultRestrictionMessage("Not permitted: KYC required");
    expect(await t.defaultRestrictionMessage()).to.equal("Not permitted: KYC required");
    expect(await t.messageForTransferRestriction(2)).to.contain("Recipient");
  });

  it("frozen sender blocked; sanctions dominates eligibility", async function () {
    const Oracle = await ethers.getContractFactory("MockSanctionsOracle");
    const oracle = await Oracle.deploy();
    await oracle.waitForDeployment();
    const Guard = await ethers.getContractFactory("SanctionsGuard");
    const guard = await Guard.deploy(owner.address, await oracle.getAddress());
    await guard.waitForDeployment();
    const t = await deployR(["Reg", "REG", 18, tok(100), 0, owner.address, await guard.getAddress(), [alice.address]]);

    await t.connect(owner).transfer(alice.address, tok(10));
    await t.connect(owner).setFrozen(alice.address, true);
    expect(await t.detectTransferRestriction(alice.address, owner.address, tok(1))).to.equal(CODE.SENDER_FROZEN);

    await guard.connect(owner).setDenied(alice.address, true, "test");
    // sanctions evaluated before freeze → SANCTIONED wins
    expect(await t.detectTransferRestriction(alice.address, owner.address, tok(1))).to.equal(CODE.SANCTIONED);
  });

  it("detector reflects pause (SC-003 parity) and matches the transfer outcome", async function () {
    const t = await deployR(["Reg", "REG", 18, tok(100), 0, owner.address, ZERO, [alice.address]]);
    await t.connect(owner).pause();
    expect(await t.detectTransferRestriction(owner.address, alice.address, tok(1))).to.equal(6); // PAUSED
    await expect(t.connect(owner).transfer(alice.address, tok(1)))
      .to.be.revertedWithCustomError(t, "TransferRestricted").withArgs(6);
    expect(await t.messageForTransferRestriction(6)).to.contain("paused");
  });

  it("inherited initialize() is disabled — only initializeRestricted sets up the token", async function () {
    const Impl = await ethers.getContractFactory("RestrictedERC20V2");
    const impl = await Impl.deploy();
    await impl.waitForDeployment();
    const data = Impl.interface.encodeFunctionData("initialize", ["X", "X", 18, 0, 0, owner.address, ZERO]);
    const Proxy = await ethers.getContractFactory("ERC1967Proxy");
    // The proxy constructor runs initialize via delegatecall → reverts WrongInitializer.
    await expect(Proxy.deploy(await impl.getAddress(), data)).to.be.revertedWithCustomError(impl, "WrongInitializer");
  });

  it("mint to an ineligible recipient is blocked by the same policy", async function () {
    const t = await deployR(["Reg", "REG", 18, 0, 0, owner.address, ZERO, []]);
    await expect(t.connect(owner).mint(bob.address, tok(1)))
      .to.be.revertedWithCustomError(t, "TransferRestricted").withArgs(CODE.RECIPIENT_NOT_ELIGIBLE);
    await t.connect(owner).setEligible(bob.address, true);
    await t.connect(owner).mint(bob.address, tok(1));
    expect(await t.balanceOf(bob.address)).to.equal(tok(1));
  });
});
