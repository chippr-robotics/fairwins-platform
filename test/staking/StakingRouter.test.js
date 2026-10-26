const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployFeeRouter, deployStakingRouter } = require("../helpers/proxy");

// spec 066 — StakingRouter: control surface + LIQUID fee-and-forward router.
describe("StakingRouter", function () {
  const STAKE_LIDO = ethers.keccak256(ethers.toUtf8Bytes("stake.lido"));
  const STAKE_POLYGON = ethers.keccak256(ethers.toUtf8Bytes("stake.polygon"));
  const Kind = { Unregistered: 0, Wrapped: 1, ConfigOnly: 2 };
  const ETH = (n) => ethers.parseEther(n);

  let admin, guardian, stakingAdmin, member, treasury, stranger;
  let feeRouter, router, steth, wsteth, pol, spol, spolController, stakeManager;

  async function deployMocks() {
    const StETH = await ethers.getContractFactory("MockLidoStETH");
    steth = await StETH.deploy();
    const WstETH = await ethers.getContractFactory("MockWstETH");
    wsteth = await WstETH.deploy(await steth.getAddress());
    const Mintable = await ethers.getContractFactory("MintableToken");
    pol = await Mintable.deploy("Polygon", "POL");
    spol = await Mintable.deploy("Staked POL", "sPOL");
    const Controller = await ethers.getContractFactory("MockSpolController");
    spolController = await Controller.deploy(await pol.getAddress(), await spol.getAddress());
  }

  async function newRouter(feeRouterAddr) {
    return deployStakingRouter([
      admin.address,
      feeRouterAddr,
      await steth.getAddress(),
      await wsteth.getAddress(),
      await spolController.getAddress(),
      await spol.getAddress(),
      await pol.getAddress(),
      stakeManager.address,
    ]);
  }

  beforeEach(async function () {
    [admin, guardian, stakingAdmin, member, treasury, stranger] = await ethers.getSigners();
    stakeManager = stranger; // any non-zero address for the delegated-config slot

    feeRouter = await deployFeeRouter([admin.address, treasury.address]);
    await feeRouter.connect(admin).registerService(STAKE_LIDO, 250, Kind.ConfigOnly);
    await feeRouter.connect(admin).registerService(STAKE_POLYGON, 250, Kind.ConfigOnly);

    await deployMocks();
    router = await newRouter(await feeRouter.getAddress());
    await router.connect(admin).grantRole(await router.STAKING_ADMIN_ROLE(), stakingAdmin.address);
    await router.connect(admin).grantRole(await router.GUARDIAN_ROLE(), guardian.address);
  });

  describe("initialize", function () {
    it("grants the four roles to admin and stores config + service ids", async function () {
      expect(await router.hasRole(await router.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await router.hasRole(await router.UPGRADER_ROLE(), admin.address)).to.equal(true);
      expect(await router.hasRole(await router.STAKING_ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await router.hasRole(await router.GUARDIAN_ROLE(), admin.address)).to.equal(true);
      expect(await router.feeRouter()).to.equal(await feeRouter.getAddress());
      expect(await router.lidoSteth()).to.equal(await steth.getAddress());
      expect(await router.stakeLidoServiceId()).to.equal(STAKE_LIDO);
      expect(await router.stakeSpolServiceId()).to.equal(STAKE_POLYGON);
    });

    it("reverts on a zero admin or feeRouter", async function () {
      await expect(newRouter(ethers.ZeroAddress)).to.be.revertedWithCustomError(router, "ZeroAddress"); // feeRouter zero
    });
  });

  describe("config setters", function () {
    it("update + emit and are gated to STAKING_ADMIN_ROLE", async function () {
      await expect(router.connect(stakingAdmin).setFeeRouter(member.address))
        .to.emit(router, "FeeRouterUpdated")
        .withArgs(await feeRouter.getAddress(), member.address, stakingAdmin.address);
      expect(await router.feeRouter()).to.equal(member.address);

      await expect(router.connect(stakingAdmin).setLidoContracts(member.address, treasury.address))
        .to.emit(router, "LidoContractsUpdated");
      await expect(router.connect(stakingAdmin).setSpolContracts(member.address, treasury.address))
        .to.emit(router, "SpolContractsUpdated");
      await expect(router.connect(stakingAdmin).setPolygonContracts(member.address, treasury.address))
        .to.emit(router, "PolygonContractsUpdated");
    });

    it("reject zero addresses on every setter", async function () {
      await expect(router.connect(stakingAdmin).setFeeRouter(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(router, "ZeroAddress");
      await expect(router.connect(stakingAdmin).setLidoContracts(ethers.ZeroAddress, member.address))
        .to.be.revertedWithCustomError(router, "ZeroAddress");
      await expect(router.connect(stakingAdmin).setSpolContracts(member.address, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(router, "ZeroAddress");
      await expect(router.connect(stakingAdmin).setPolygonContracts(ethers.ZeroAddress, member.address))
        .to.be.revertedWithCustomError(router, "ZeroAddress");
    });

    it("reject a non-admin caller", async function () {
      await expect(router.connect(stranger).setFeeRouter(member.address))
        .to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
    });
  });

  describe("validator allowlist", function () {
    const vs = ethers.getAddress("0x000000000000000000000000000000000000a11c");
    const vs2 = ethers.getAddress("0x000000000000000000000000000000000000b0b2");

    it("adds, enumerates, and removes; rejects dup/absent", async function () {
      await expect(router.connect(stakingAdmin).addValidator(vs))
        .to.emit(router, "ValidatorAdded").withArgs(ethers.getAddress(vs), stakingAdmin.address);
      expect(await router.validatorCount()).to.equal(1);
      expect(await router.isValidator(vs)).to.equal(true);
      expect(await router.validatorAt(0)).to.equal(ethers.getAddress(vs));

      await expect(router.connect(stakingAdmin).addValidator(vs))
        .to.be.revertedWithCustomError(router, "AlreadyListed");

      await router.connect(stakingAdmin).addValidator(vs2);
      await expect(router.connect(stakingAdmin).removeValidator(vs))
        .to.emit(router, "ValidatorRemoved");
      expect(await router.isValidator(vs)).to.equal(false);
      expect(await router.validatorCount()).to.equal(1);

      await expect(router.connect(stakingAdmin).removeValidator(vs))
        .to.be.revertedWithCustomError(router, "NotListed");
    });

    it("is gated to STAKING_ADMIN_ROLE and rejects zero", async function () {
      await expect(router.connect(stranger).addValidator(vs))
        .to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
      await expect(router.connect(stakingAdmin).addValidator(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(router, "ZeroAddress");
    });
  });

  describe("emergency pause", function () {
    it("is GUARDIAN-gated and blocks new liquid stakes; unpause restores", async function () {
      await expect(router.connect(stranger).pause())
        .to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");

      await router.connect(guardian).pause();
      expect(await router.paused()).to.equal(true);
      await expect(router.connect(member).stakeLido(50, { value: ETH("1") }))
        .to.be.revertedWithCustomError(router, "EnforcedPause");

      await router.connect(guardian).unpause();
      expect(await router.paused()).to.equal(false);
    });
  });

  describe("stakeLido (ETH → wstETH)", function () {
    it("skims the fee to the treasury, forwards the net, returns wstETH, leaves no residual", async function () {
      await feeRouter.connect(admin).setFeeBps(STAKE_LIDO, 50); // 0.50%
      const gross = ETH("1");
      const fee = (gross * 50n) / 10_000n;
      const net = gross - fee;

      const before = await ethers.provider.getBalance(treasury.address);
      await expect(router.connect(member).stakeLido(50, { value: gross }))
        .to.emit(router, "LiquidStaked")
        .withArgs(await wsteth.getAddress(), member.address, gross, fee, net, net);

      expect(await ethers.provider.getBalance(treasury.address)).to.equal(before + fee);
      expect(await wsteth.balanceOf(member.address)).to.equal(net);
      expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(0);
    });

    it("zero fee is a byte-identical passthrough (no treasury change)", async function () {
      const before = await ethers.provider.getBalance(treasury.address);
      await router.connect(member).stakeLido(0, { value: ETH("1") });
      expect(await ethers.provider.getBalance(treasury.address)).to.equal(before);
      expect(await wsteth.balanceOf(member.address)).to.equal(ETH("1"));
    });

    it("reverts FeeAboveQuoted when the live rate exceeds the member's ceiling", async function () {
      await feeRouter.connect(admin).setFeeBps(STAKE_LIDO, 60);
      await expect(router.connect(member).stakeLido(50, { value: ETH("1") }))
        .to.be.revertedWithCustomError(router, "FeeAboveQuoted");
    });

    it("reverts on a zero amount", async function () {
      await expect(router.connect(member).stakeLido(50, { value: 0 }))
        .to.be.revertedWithCustomError(router, "ZeroAmount");
    });

    it("skips the fee (never lost) when the treasury is unset", async function () {
      const fr = await deployFeeRouter([admin.address, ethers.ZeroAddress]);
      await fr.connect(admin).registerService(STAKE_LIDO, 250, Kind.ConfigOnly);
      await fr.connect(admin).registerService(STAKE_POLYGON, 250, Kind.ConfigOnly);
      await fr.connect(admin).setFeeBps(STAKE_LIDO, 50);
      const r = await newRouter(await fr.getAddress());
      // Even with maxFeeBps=0, a treasury-unset network must not spuriously revert (L2): fee is 0.
      await r.connect(member).stakeLido(0, { value: ETH("1") });
      expect(await wsteth.balanceOf(member.address)).to.equal(ETH("1")); // full amount staked
    });

    it("cannot be bricked by forced/donated ETH (relative residual invariant)", async function () {
      const ForceSend = await ethers.getContractFactory("ForceSend");
      await ForceSend.deploy(await router.getAddress(), { value: 7n }); // grief 7 wei into the router
      await router.connect(member).stakeLido(0, { value: ETH("1") });
      expect(await wsteth.balanceOf(member.address)).to.equal(ETH("1"));
      // The donated 7 wei stays put; the stake still succeeded and left no NEW residual.
      expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(7n);
    });

    it("reverts ProviderCallFailed when the provider returns zero LST", async function () {
      const ZeroWst = await ethers.getContractFactory("MockZeroWstETH");
      const zwst = await ZeroWst.deploy(await steth.getAddress());
      await router.connect(stakingAdmin).setLidoContracts(await steth.getAddress(), await zwst.getAddress());
      await expect(router.connect(member).stakeLido(0, { value: ETH("1") }))
        .to.be.revertedWithCustomError(router, "ProviderCallFailed");
    });

    it("reverts ProviderCallFailed when the treasury rejects the native fee", async function () {
      const Reject = await ethers.getContractFactory("MockRejectETH");
      const badTreasury = await Reject.deploy();
      const fr = await deployFeeRouter([admin.address, await badTreasury.getAddress()]);
      await fr.connect(admin).registerService(STAKE_LIDO, 250, Kind.ConfigOnly);
      await fr.connect(admin).registerService(STAKE_POLYGON, 250, Kind.ConfigOnly);
      await fr.connect(admin).setFeeBps(STAKE_LIDO, 50);
      const r = await newRouter(await fr.getAddress());
      await expect(r.connect(member).stakeLido(50, { value: ETH("1") }))
        .to.be.revertedWithCustomError(r, "ProviderCallFailed");
    });

    it("sweeps stETH share-rounding dust to the member (no dust left in the router)", async function () {
      const DustWst = await ethers.getContractFactory("MockDustWstETH");
      const dwst = await DustWst.deploy(await steth.getAddress());
      await router.connect(stakingAdmin).setLidoContracts(await steth.getAddress(), await dwst.getAddress());
      await router.connect(member).stakeLido(0, { value: ETH("1") });
      // Router keeps no stETH; the member holds the 1-wei dust as stETH.
      expect(await steth.balanceOf(await router.getAddress())).to.equal(0);
      expect(await steth.balanceOf(member.address)).to.equal(1n);
    });
  });

  describe("stakeSpol (POL → sPOL)", function () {
    beforeEach(async function () {
      await pol.mint(member.address, ETH("100"));
      await pol.connect(member).approve(await router.getAddress(), ethers.MaxUint256);
    });

    it("skims the fee to the treasury, forwards the net, returns sPOL, leaves no residual", async function () {
      await feeRouter.connect(admin).setFeeBps(STAKE_POLYGON, 50);
      const gross = ETH("100");
      const fee = (gross * 50n) / 10_000n;
      const net = gross - fee;

      await expect(router.connect(member).stakeSpol(gross, 50))
        .to.emit(router, "LiquidStaked")
        .withArgs(await spol.getAddress(), member.address, gross, fee, net, net);

      expect(await pol.balanceOf(treasury.address)).to.equal(fee);
      expect(await spol.balanceOf(member.address)).to.equal(net);
      expect(await pol.balanceOf(await router.getAddress())).to.equal(0);
    });

    it("reverts FeeAboveQuoted and ZeroAmount", async function () {
      await feeRouter.connect(admin).setFeeBps(STAKE_POLYGON, 60);
      await expect(router.connect(member).stakeSpol(ETH("10"), 50))
        .to.be.revertedWithCustomError(router, "FeeAboveQuoted");
      await expect(router.connect(member).stakeSpol(0, 50))
        .to.be.revertedWithCustomError(router, "ZeroAmount");
    });

    it("skips the fee (never lost) when the treasury is unset", async function () {
      const fr = await deployFeeRouter([admin.address, ethers.ZeroAddress]);
      await fr.connect(admin).registerService(STAKE_LIDO, 250, Kind.ConfigOnly);
      await fr.connect(admin).registerService(STAKE_POLYGON, 250, Kind.ConfigOnly);
      await fr.connect(admin).setFeeBps(STAKE_POLYGON, 50);
      const r = await newRouter(await fr.getAddress());
      await pol.connect(member).approve(await r.getAddress(), ethers.MaxUint256);
      await r.connect(member).stakeSpol(ETH("100"), 0);
      expect(await spol.balanceOf(member.address)).to.equal(ETH("100")); // full amount staked
    });

    it("reverts ResidualFunds when a provider under-pulls the principal", async function () {
      const Leaky = await ethers.getContractFactory("MockLeakySpolController");
      const leaky = await Leaky.deploy(await pol.getAddress(), await spol.getAddress());
      await router.connect(stakingAdmin).setSpolContracts(await leaky.getAddress(), await spol.getAddress());
      await expect(router.connect(member).stakeSpol(ETH("100"), 50))
        .to.be.revertedWithCustomError(router, "ResidualFunds");
    });
  });
});
