const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployFeeRouter, deployStakingRouter } = require("../helpers/proxy");
const { expectMissingRole } = require("./helpers/roles");

// Spec 112 FR-004 / Story 2 — StakingRouter (spec 066) admin surface on its FAILING side.
// STAKING_ADMIN_ROLE owns provider wiring and the validator allowlist, GUARDIAN_ROLE owns the pause,
// UPGRADER_ROLE owns the implementation. Each gate is asserted with the exact
// AccessControlUnauthorizedAccount(caller, role), each zero-address refusal with ZeroAddress, and each
// test also proves the role holder's identical call succeeds (so a removed guard turns it red).

const STAKING_ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("STAKING_ADMIN_ROLE"));
const GUARDIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));
const UPGRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UPGRADER_ROLE"));

describe("StakingRouter — negative paths (spec 112 FR-004)", function () {
  async function fixture() {
    const [admin, stakingAdmin, guardian, stranger, a1, a2, treasury] = await ethers.getSigners();
    const feeRouter = await deployFeeRouter([admin.address, treasury.address]);
    const router = await deployStakingRouter([
      admin.address, await feeRouter.getAddress(),
      a1.address, a2.address, a1.address, a2.address, a1.address, a2.address,
    ]);
    await router.connect(admin).grantRole(STAKING_ADMIN_ROLE, stakingAdmin.address);
    await router.connect(admin).grantRole(GUARDIAN_ROLE, guardian.address);
    return { router, feeRouter, admin, stakingAdmin, guardian, stranger, a1, a2 };
  }

  const ADMIN_SETTERS = [
    ["setFeeRouter", (r, fx) => r.setFeeRouter(fx.a1.address)],
    ["setLidoContracts", (r, fx) => r.setLidoContracts(fx.a1.address, fx.a2.address)],
    ["setSpolContracts", (r, fx) => r.setSpolContracts(fx.a1.address, fx.a2.address)],
    ["setPolygonContracts", (r, fx) => r.setPolygonContracts(fx.a1.address, fx.a2.address)],
    ["addValidator", (r, fx) => r.addValidator(fx.a1.address)],
  ];

  describe("STAKING_ADMIN_ROLE gates", function () {
    for (const [name, call] of ADMIN_SETTERS) {
      it(`[G:SR.${name}.role] ${name} reverts AccessControlUnauthorizedAccount(caller, STAKING_ADMIN_ROLE); the holder succeeds`, async function () {
        const fx = await loadFixture(fixture);
        await expectMissingRole(fx.router, call(fx.router.connect(fx.stranger), fx), fx.stranger.address, STAKING_ADMIN_ROLE);
        await expect(call(fx.router.connect(fx.stakingAdmin), fx)).to.not.be.reverted;
      });
    }

    it("[G:SR.removeValidator.role] removeValidator reverts AccessControlUnauthorizedAccount(caller, STAKING_ADMIN_ROLE); the holder succeeds", async function () {
      const fx = await loadFixture(fixture);
      await fx.router.connect(fx.stakingAdmin).addValidator(fx.a1.address);
      await expectMissingRole(fx.router, fx.router.connect(fx.stranger).removeValidator(fx.a1.address), fx.stranger.address, STAKING_ADMIN_ROLE);
      await expect(fx.router.connect(fx.stakingAdmin).removeValidator(fx.a1.address)).to.emit(fx.router, "ValidatorRemoved");
    });
  });

  describe("zero-address checks", function () {
    const Z = ethers.ZeroAddress;
    const CASES = [
      ["setFeeRouter", (r) => [r.setFeeRouter(Z)]],
      ["setLidoContracts", (r, fx) => [r.setLidoContracts(Z, fx.a2.address), r.setLidoContracts(fx.a1.address, Z)]],
      ["setSpolContracts", (r, fx) => [r.setSpolContracts(Z, fx.a2.address), r.setSpolContracts(fx.a1.address, Z)]],
      ["setPolygonContracts", (r, fx) => [r.setPolygonContracts(Z, fx.a2.address), r.setPolygonContracts(fx.a1.address, Z)]],
      ["addValidator", (r) => [r.addValidator(Z)]],
    ];
    for (const [name, calls] of CASES) {
      it(`[G:SR.${name}.zero] ${name} reverts ZeroAddress for each zero argument`, async function () {
        const fx = await loadFixture(fixture);
        for (const p of calls(fx.router.connect(fx.stakingAdmin), fx)) {
          await expect(p).to.be.revertedWithCustomError(fx.router, "ZeroAddress");
        }
      });
    }

    it("[G:SR.validatorSet] addValidator reverts AlreadyListed on a duplicate; removeValidator reverts NotListed for an unknown address", async function () {
      const fx = await loadFixture(fixture);
      await fx.router.connect(fx.stakingAdmin).addValidator(fx.a1.address);
      await expect(fx.router.connect(fx.stakingAdmin).addValidator(fx.a1.address)).to.be.revertedWithCustomError(fx.router, "AlreadyListed");
      await expect(fx.router.connect(fx.stakingAdmin).removeValidator(fx.a2.address)).to.be.revertedWithCustomError(fx.router, "NotListed");
    });
  });

  describe("GUARDIAN_ROLE + UPGRADER_ROLE gates", function () {
    it("[G:SR.pause.role] pause/unpause revert AccessControlUnauthorizedAccount(caller, GUARDIAN_ROLE); the guardian succeeds", async function () {
      const fx = await loadFixture(fixture);
      await expectMissingRole(fx.router, fx.router.connect(fx.stranger).pause(), fx.stranger.address, GUARDIAN_ROLE);
      await fx.router.connect(fx.guardian).pause();
      await expectMissingRole(fx.router, fx.router.connect(fx.stranger).unpause(), fx.stranger.address, GUARDIAN_ROLE);
      await fx.router.connect(fx.guardian).unpause();
    });

    it("[G:SR.paused] stakeLido and stakeSpol revert EnforcedPause while paused", async function () {
      const fx = await loadFixture(fixture);
      await fx.router.connect(fx.guardian).pause();
      await expect(fx.router.connect(fx.stranger).stakeLido(250, { value: 1 })).to.be.revertedWithCustomError(fx.router, "EnforcedPause");
      await expect(fx.router.connect(fx.stranger).stakeSpol(1, 250)).to.be.revertedWithCustomError(fx.router, "EnforcedPause");
    });

    it("[G:SR.upgrade.role] upgradeToAndCall reverts AccessControlUnauthorizedAccount(caller, UPGRADER_ROLE)", async function () {
      const fx = await loadFixture(fixture);
      const next = await (await ethers.getContractFactory("StakingRouter")).deploy();
      await expectMissingRole(fx.router, fx.router.connect(fx.stranger).upgradeToAndCall(await next.getAddress(), "0x"), fx.stranger.address, UPGRADER_ROLE);
    });
  });

  describe("initialisation guards", function () {
    it("[G:SR.init.zero] initialize reverts ZeroAddress for a zero admin or a zero feeRouter", async function () {
      const [admin, a1] = await ethers.getSigners();
      const Impl = await ethers.getContractFactory("StakingRouter");
      const Proxy = await ethers.getContractFactory("ERC1967Proxy");
      const rest = [a1.address, a1.address, a1.address, a1.address, a1.address, a1.address];
      for (const head of [[ethers.ZeroAddress, a1.address], [admin.address, ethers.ZeroAddress]]) {
        const impl = await Impl.deploy();
        await expect(Proxy.deploy(await impl.getAddress(), Impl.interface.encodeFunctionData("initialize", [...head, ...rest])))
          .to.be.revertedWithCustomError(impl, "ZeroAddress");
      }
    });

    it("[G:SR.reinit] initialize cannot run twice on the proxy, nor at all on the bare implementation", async function () {
      const fx = await loadFixture(fixture);
      const args = [fx.admin.address, await fx.feeRouter.getAddress(), fx.a1.address, fx.a1.address, fx.a1.address, fx.a1.address, fx.a1.address, fx.a1.address];
      await expect(fx.router.initialize(...args)).to.be.revertedWithCustomError(fx.router, "InvalidInitialization");
      const bare = await (await ethers.getContractFactory("StakingRouter")).deploy();
      await expect(bare.initialize(...args)).to.be.revertedWithCustomError(bare, "InvalidInitialization");
    });
  });
});
