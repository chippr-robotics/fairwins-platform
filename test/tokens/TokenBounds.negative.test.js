const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployTokenFactory, deployTokenTemplates } = require("../helpers/proxy");

// Spec 112 (FR-004 / FR-006, #1673) — named reverts on the token contracts, asserted by name with
// their arguments, each next to the call that must still succeed so a moved bound fails too.
//
//   OpenERC721V2.BatchTooLarge(given, max) — batchMint over MAX_BATCH (200)
//   OpenERC721V2.ZeroAddress               — setFrozen(0) and transferOwnership(0)
//   OpenERC721V2.SelfTransfer              — transferOwnership(self): the admin-lockout guard
//   TokenFactory.ZeroAddress               — initialize(admin = 0), setTemplate / setV2Template(impl = 0)

const ZERO = ethers.ZeroAddress;
const DEFAULT_ADMIN = ethers.ZeroHash;
const TokenStandard = { OPEN_ERC20: 0, OPEN_ERC721: 1, RESTRICTED_ERC1404: 2 };

async function deployOpenERC721V2(owner) {
  const Impl = await ethers.getContractFactory("OpenERC721V2");
  const impl = await Impl.deploy();
  await impl.waitForDeployment();
  const data = Impl.interface.encodeFunctionData("initialize", ["Art", "ART", "", owner, ZERO]);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await Proxy.deploy(await impl.getAddress(), data);
  await proxy.waitForDeployment();
  return Impl.attach(await proxy.getAddress());
}

describe("OpenERC721V2 — named reverts (spec 112)", function () {
  let owner, alice, token;

  beforeEach(async () => {
    [owner, alice] = await ethers.getSigners();
    token = await deployOpenERC721V2(owner.address);
  });

  it("BatchTooLarge(given, max): MAX_BATCH + 1 recipients is refused with no mint; MAX_BATCH succeeds", async () => {
    const max = await token.MAX_BATCH();
    expect(max).to.equal(200n);
    const n = Number(max);
    const over = Array(n + 1).fill(alice.address);
    const overUris = Array(n + 1).fill("u");

    await expect(token.connect(owner).batchMint(over, overUris)).to.be.revertedWithCustomError(token, "BatchTooLarge").withArgs(max + 1n, max);
    expect(await token.balanceOf(alice.address)).to.equal(0n);

    await token.connect(owner).batchMint(over.slice(0, n), overUris.slice(0, n));
    expect(await token.balanceOf(alice.address)).to.equal(max);
  });

  it("ZeroAddress: setFrozen(0) is refused and the frozen set stays empty", async () => {
    await expect(token.connect(owner).setFrozen(ZERO, true)).to.be.revertedWithCustomError(token, "ZeroAddress");
    expect(await token.frozenCount()).to.equal(0n);
    await token.connect(owner).setFrozen(alice.address, true);
    expect(await token.frozen(alice.address)).to.equal(true);
  });

  it("ZeroAddress: transferOwnership(0) is refused and the owner keeps DEFAULT_ADMIN_ROLE", async () => {
    await expect(token.connect(owner).transferOwnership(ZERO)).to.be.revertedWithCustomError(token, "ZeroAddress");
    expect(await token.hasRole(DEFAULT_ADMIN, owner.address)).to.equal(true);
  });

  it("SelfTransfer: transferOwnership(self) is refused — it would grant-then-revoke the caller's own admin role", async () => {
    await expect(token.connect(owner).transferOwnership(owner.address)).to.be.revertedWithCustomError(token, "SelfTransfer");
    expect(await token.hasRole(DEFAULT_ADMIN, owner.address)).to.equal(true);

    // A real transfer still works and moves the role.
    await token.connect(owner).transferOwnership(alice.address);
    expect(await token.hasRole(DEFAULT_ADMIN, alice.address)).to.equal(true);
    expect(await token.hasRole(DEFAULT_ADMIN, owner.address)).to.equal(false);
  });
});

describe("TokenFactory — ZeroAddress (spec 112)", function () {
  let admin;

  beforeEach(async () => {
    [admin] = await ethers.getSigners();
  });

  it("initialize(admin = 0) is refused — a proxy with no admin could never be upgraded or configured", async () => {
    const templates = await deployTokenTemplates();
    const Impl = await ethers.getContractFactory("TokenFactory");
    const impl = await Impl.deploy();
    await impl.waitForDeployment();
    const initData = Impl.interface.encodeFunctionData("initialize", [
      ZERO, ZERO, templates.openERC20Impl, templates.openERC721Impl, templates.restrictedERC20Impl,
    ]);
    const Proxy = await ethers.getContractFactory("ERC1967Proxy");
    await expect(Proxy.deploy(await impl.getAddress(), initData)).to.be.revertedWithCustomError(Impl, "ZeroAddress");
  });

  it("setTemplate / setV2Template(impl = 0) are refused and the stored template is unchanged", async () => {
    const { factory, templates } = await deployTokenFactory({ admin: admin.address });
    await expect(factory.connect(admin).setTemplate(TokenStandard.OPEN_ERC721, ZERO)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    expect(await factory.openERC721Impl()).to.equal(templates.openERC721Impl);

    await expect(factory.connect(admin).setV2Template(TokenStandard.OPEN_ERC20, ZERO)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    expect(await factory.openERC20V2Impl()).to.equal(ZERO);
  });

  it("the zero check fires for the admin only after the role check (a stranger gets the role error)", async () => {
    const [, stranger] = await ethers.getSigners();
    const { factory } = await deployTokenFactory({ admin: admin.address });
    await expect(factory.connect(stranger).setTemplate(TokenStandard.OPEN_ERC721, ZERO)).to.be.revertedWithCustomError(factory, "AccessControlUnauthorizedAccount").withArgs(stranger.address, DEFAULT_ADMIN);
  });
});
