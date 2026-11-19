const { expect } = require("chai");
const { ethers } = require("hardhat");

// Spec 112 (FR-004 / FR-006, #1673) — StandardDAOFactory.ZeroAddress at every raise site:
//   initialize (each of the six addresses), setMembershipManager, setSanctionsGuard, setDeployers.
// Each refusal is followed by a read proving nothing was written, and each setter's happy path
// runs too, so the test fails if the guard is dropped OR if it starts refusing a real address.

const ZERO = ethers.ZeroAddress;

describe("StandardDAOFactory — ZeroAddress (spec 112)", function () {
  let owner, Impl, impl, Proxy, addrs, factory;

  beforeEach(async () => {
    [owner] = await ethers.getSigners();
    const membership = await (await ethers.getContractFactory("MockMembershipTier")).deploy();
    const sanctions = await (await ethers.getContractFactory("MockPoolSanctions")).deploy();
    const timelockDeployer = await (await ethers.getContractFactory("StandardDAOTimelockDeployer")).deploy();
    const tokenDeployer = await (await ethers.getContractFactory("StandardDAOTokenDeployer")).deploy();
    const governorDeployer = await (await ethers.getContractFactory("StandardDAOGovernorDeployer")).deploy();
    addrs = [
      owner.address,
      await membership.getAddress(),
      await sanctions.getAddress(),
      await timelockDeployer.getAddress(),
      await tokenDeployer.getAddress(),
      await governorDeployer.getAddress(),
    ];

    Impl = await ethers.getContractFactory("StandardDAOFactory");
    impl = await Impl.deploy();
    await impl.waitForDeployment();
    Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await Proxy.deploy(await impl.getAddress(), Impl.interface.encodeFunctionData("initialize", addrs));
    await proxy.waitForDeployment();
    factory = Impl.attach(await proxy.getAddress());
  });

  it("initialize refuses a zero in EACH of its six address parameters", async () => {
    for (let i = 0; i < addrs.length; i++) {
      const args = [...addrs];
      args[i] = ZERO;
      const data = Impl.interface.encodeFunctionData("initialize", args);
      await expect(Proxy.deploy(await impl.getAddress(), data), `zero at index ${i}`).to.be.revertedWithCustomError(Impl, "ZeroAddress");
    }
  });

  it("setMembershipManager(0) is refused; the stored manager is unchanged; a real address is accepted", async () => {
    await expect(factory.connect(owner).setMembershipManager(ZERO)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    expect(await factory.membershipManager()).to.equal(addrs[1]);
    const other = ethers.Wallet.createRandom().address;
    await factory.connect(owner).setMembershipManager(other);
    expect(await factory.membershipManager()).to.equal(other);
  });

  it("setSanctionsGuard(0) is refused — screening cannot be silently switched off here", async () => {
    await expect(factory.connect(owner).setSanctionsGuard(ZERO)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    expect(await factory.sanctionsGuard()).to.equal(addrs[2]);
  });

  it("setDeployers refuses a zero in each slot and keeps all three modules", async () => {
    const [, , , tl, tk, gv] = addrs;
    for (const args of [[ZERO, tk, gv], [tl, ZERO, gv], [tl, tk, ZERO]]) {
      await expect(factory.connect(owner).setDeployers(...args)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    }
    expect(await factory.timelockDeployer()).to.equal(tl);
    expect(await factory.tokenDeployer()).to.equal(tk);
    expect(await factory.governorDeployer()).to.equal(gv);
    await expect(factory.connect(owner).setDeployers(tl, tk, gv)).to.emit(factory, "DeployersUpdated").withArgs(tl, tk, gv);
  });
});
