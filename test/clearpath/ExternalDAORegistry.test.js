const { expect } = require("chai");
const { ethers } = require("hardhat");

// Spec 030 (US3) — ExternalDAORegistry: register/validate/track DAOs deployed by other platforms (Olympia + any
// OZ Governor). Tier-gated; ERC-165 IGovernor validation (primary) + IGovernor-view fallback; rejects
// EOAs / non-governors / duplicates / sub-tier; confers no authority (INV-4 — registry stores metadata only).

const Tier = { None: 0, Bronze: 1, Silver: 2, Gold: 3, Platinum: 4 };

async function deployRegistry(admin, membership) {
  const Impl = await ethers.getContractFactory("ExternalDAORegistry");
  const impl = await Impl.deploy();
  await impl.waitForDeployment();
  const initData = Impl.interface.encodeFunctionData("initialize", [admin, membership]);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await Proxy.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();
  return Impl.attach(await proxy.getAddress());
}

describe("ExternalDAORegistry (spec 030 / US3)", () => {
  let owner, member, outsider, membership, registry;

  beforeEach(async () => {
    [owner, member, outsider] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory("MockMembershipTier");
    membership = await Mock.deploy();
    await membership.waitForDeployment();
    await membership.setTier(member.address, Tier.Silver); // eligible
    await membership.setTier(outsider.address, Tier.Bronze); // sub-tier
    registry = await deployRegistry(owner.address, await membership.getAddress());
  });

  async function deployGovernor(supports165) {
    const G = await ethers.getContractFactory("MockGovernorLike");
    const g = await G.deploy(supports165);
    await g.waitForDeployment();
    return g;
  }

  it("registers a Governor validated via ERC-165 and records it (no authority conferred)", async () => {
    const gov = await deployGovernor(true);
    const govAddr = await gov.getAddress();
    await expect(registry.connect(member).registerExternalDAO(govAddr, 0, "Olympia"))
      .to.emit(registry, "ExternalDAORegistered")
      .withArgs(1n, govAddr, 0, member.address, "Olympia");
    expect(await registry.externalCount()).to.equal(1n);
    expect(await registry.isRegistered(govAddr)).to.equal(true);
    const [dao, framework, label, registrant] = await registry.getExternalDAO(1);
    expect(dao).to.equal(govAddr);
    expect(framework).to.equal(0);
    expect(label).to.equal("Olympia");
    expect(registrant).to.equal(member.address);
    expect(await registry.getExternalDAOsByRegistrant(member.address)).to.deep.equal([1n]);
  });

  it("registers a Governor that lacks ERC-165 via the IGovernor-view fallback", async () => {
    const gov = await deployGovernor(false);
    await expect(registry.connect(member).registerExternalDAO(await gov.getAddress(), 0, "NoERC165"))
      .to.emit(registry, "ExternalDAORegistered");
    expect(await registry.externalCount()).to.equal(1n);
  });

  it("rejects an EOA (no code)", async () => {
    await expect(
      registry.connect(member).registerExternalDAO(outsider.address, 0, "eoa")
    ).to.be.revertedWithCustomError(registry, "NotAGovernor");
  });

  it("rejects a non-governor contract", async () => {
    const NG = await ethers.getContractFactory("MockNonGovernor");
    const ng = await NG.deploy();
    await ng.waitForDeployment();
    await expect(
      registry.connect(member).registerExternalDAO(await ng.getAddress(), 0, "x")
    ).to.be.revertedWithCustomError(registry, "NotAGovernor");
  });

  it("rejects the zero address and duplicates", async () => {
    await expect(
      registry.connect(member).registerExternalDAO(ethers.ZeroAddress, 0, "z")
    ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    const gov = await deployGovernor(true);
    await registry.connect(member).registerExternalDAO(await gov.getAddress(), 0, "first");
    await expect(
      registry.connect(member).registerExternalDAO(await gov.getAddress(), 0, "again")
    ).to.be.revertedWithCustomError(registry, "AlreadyRegistered");
  });

  it("enforces the membership tier gate (>= Silver)", async () => {
    const gov = await deployGovernor(true);
    await expect(
      registry.connect(outsider).registerExternalDAO(await gov.getAddress(), 0, "x")
    ).to.be.revertedWithCustomError(registry, "InsufficientMembershipTier");
  });

  it("only UPGRADER_ROLE can upgrade the registry", async () => {
    const Impl2 = await ethers.getContractFactory("ExternalDAORegistry");
    const impl2 = await Impl2.deploy();
    await impl2.waitForDeployment();
    await expect(
      registry.connect(member).upgradeToAndCall(await impl2.getAddress(), "0x")
    ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount").withArgs(member.address, await registry.UPGRADER_ROLE());
    await expect(registry.connect(owner).upgradeToAndCall(await impl2.getAddress(), "0x")).to.not.be.reverted;
  });
});
