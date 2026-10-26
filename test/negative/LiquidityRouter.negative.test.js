const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployFeeRouter } = require("../helpers/proxy");
const { expectMissingRole } = require("./helpers/roles");

// Spec 112 FR-004 / Story 2 — LiquidityRouter (spec 067) curation + wiring surface on its FAILING side.
//
// `listPool` is the most consequential validation here: its metadata is what a member is SHOWN before
// supplying, so a listing that names a pool's address with the wrong token or fee tier would mint
// against a different pool than the one curated (reproduced on a Polygon fork in adversarial review).
// Every shape error and every token0/token1/fee mismatch is asserted by name.
//
// Role split asserted with exact arguments: LIQUIDITY_ADMIN_ROLE curates, DEFAULT_ADMIN_ROLE owns the
// fund-path addresses (positionManager/feeRouter/sanctionsGuard), GUARDIAN_ROLE pauses.

const PoolKind = { Unlisted: 0, BridgeLp: 1, TradingLp: 2 };
const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
const LIQUIDITY_ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LIQUIDITY_ADMIN_ROLE"));
const GUARDIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));
const UPGRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UPGRADER_ROLE"));
const FEE_TIER = 3000;

describe("LiquidityRouter — negative paths (spec 112 FR-004)", function () {
  async function deployRouter(args) {
    const Impl = await ethers.getContractFactory("LiquidityRouter");
    const impl = await Impl.deploy();
    const Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await Proxy.deploy(await impl.getAddress(), Impl.interface.encodeFunctionData("initialize", args));
    return Impl.attach(await proxy.getAddress());
  }

  async function fixture() {
    const [admin, curator, guardian, stranger, hubPool, treasury, other] = await ethers.getSigners();
    const feeRouter = await deployFeeRouter([admin.address, treasury.address]);
    const Token = await ethers.getContractFactory("MockERC20");
    const a = await Token.deploy("Token A", "TKA", 0);
    const b = await Token.deploy("Token B", "TKB", 0);
    const c = await Token.deploy("Token C", "TKC", 0);
    const [token0, token1] = a.target.toLowerCase() < b.target.toLowerCase() ? [a, b] : [b, a];
    const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
    const pool = await Pool.deploy(token0.target, token1.target, FEE_TIER, 60);
    const nfpm = await (await ethers.getContractFactory("MockPositionManager")).deploy();
    const router = await deployRouter([admin.address, await feeRouter.getAddress(), await nfpm.getAddress(), ethers.ZeroAddress]);
    await router.connect(admin).grantRole(LIQUIDITY_ADMIN_ROLE, curator.address);
    await router.connect(admin).grantRole(GUARDIAN_ROLE, guardian.address);
    return { router, feeRouter, token0, token1, third: c, pool, nfpm, admin, curator, guardian, stranger, hubPool, other };
  }

  const trading = (fx, o = {}) => ({
    kind: PoolKind.TradingLp, enabled: true, feeTier: FEE_TIER,
    token0: fx.token0.target, token1: fx.token1.target, poolAddress: fx.pool.target,
    maxDeposit0PerTx: 0, maxDeposit1PerTx: 0, ...o,
  });
  const bridge = (fx, o = {}) => ({
    kind: PoolKind.BridgeLp, enabled: true, feeTier: 0,
    token0: fx.token0.target, token1: ethers.ZeroAddress, poolAddress: fx.hubPool.address,
    maxDeposit0PerTx: 0, maxDeposit1PerTx: 0, ...o,
  });

  // -------------------------------------------------------------------------- listPool validation (L114–129)

  describe("listPool validation", function () {
    it("[G:LR.listPool.ok] positive control: a well-formed trading listing and bridge listing both list", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.router.connect(fx.curator).listPool(trading(fx))).to.emit(fx.router, "PoolListed");
      await expect(fx.router.connect(fx.curator).listPool(bridge(fx))).to.emit(fx.router, "PoolListed");
    });

    it("[G:LR.listPool.unlisted] reverts PoolUnknown for kind Unlisted", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.router.connect(fx.curator).listPool(trading(fx, { kind: PoolKind.Unlisted }))).to.be.revertedWithCustomError(fx.router, "PoolUnknown");
    });

    it("[G:LR.listPool.zeroPool] reverts ZeroAddress for a zero poolAddress", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.router.connect(fx.curator).listPool(bridge(fx, { poolAddress: ethers.ZeroAddress }))).to.be.revertedWithCustomError(fx.router, "ZeroAddress");
    });

    it("[G:LR.listPool.zeroToken0] reverts ZeroAddress for a zero token0", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.router.connect(fx.curator).listPool(bridge(fx, { token0: ethers.ZeroAddress }))).to.be.revertedWithCustomError(fx.router, "ZeroAddress");
    });

    it("[G:LR.listPool.tradingNoToken1] TradingLp reverts InvalidPoolListing with no token1", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.router.connect(fx.curator).listPool(trading(fx, { token1: ethers.ZeroAddress }))).to.be.revertedWithCustomError(fx.router, "InvalidPoolListing");
    });

    it("[G:LR.listPool.tradingNoFee] TradingLp reverts InvalidPoolListing with feeTier 0", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.router.connect(fx.curator).listPool(trading(fx, { feeTier: 0 }))).to.be.revertedWithCustomError(fx.router, "InvalidPoolListing");
    });

    it("[G:LR.listPool.mismatchToken0] TradingLp reverts PoolListingMismatch when token0 differs from the pool's", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.router.connect(fx.curator).listPool(trading(fx, { token0: fx.third.target }))).to.be.revertedWithCustomError(fx.router, "PoolListingMismatch");
    });

    it("[G:LR.listPool.mismatchToken1] TradingLp reverts PoolListingMismatch when token1 differs from the pool's", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.router.connect(fx.curator).listPool(trading(fx, { token1: fx.third.target }))).to.be.revertedWithCustomError(fx.router, "PoolListingMismatch");
    });

    it("[G:LR.listPool.mismatchFee] TradingLp reverts PoolListingMismatch when feeTier differs from the pool's (the 0.3%-pool-listed-as-0.05% case)", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.router.connect(fx.curator).listPool(trading(fx, { feeTier: 500 }))).to.be.revertedWithCustomError(fx.router, "PoolListingMismatch");
    });

    it("[G:LR.listPool.bridgeToken1] BridgeLp reverts InvalidPoolListing when a token1 is supplied", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.router.connect(fx.curator).listPool(bridge(fx, { token1: fx.token1.target }))).to.be.revertedWithCustomError(fx.router, "InvalidPoolListing");
    });

    it("[G:LR.listPool.bridgeFee] BridgeLp reverts InvalidPoolListing when a feeTier is supplied", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.router.connect(fx.curator).listPool(bridge(fx, { feeTier: 500 }))).to.be.revertedWithCustomError(fx.router, "InvalidPoolListing");
    });
  });

  // -------------------------------------------------------------------------- PoolUnknown (L154, L163, mint)

  describe("unknown pool ids", function () {
    const unknownId = ethers.id("never listed");

    it("[G:LR.setPoolEnabled.unknown] setPoolEnabled reverts PoolUnknown for an unlisted id; a listed id succeeds", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.router.connect(fx.curator).setPoolEnabled(unknownId, false)).to.be.revertedWithCustomError(fx.router, "PoolUnknown");
      await fx.router.connect(fx.curator).listPool(bridge(fx));
      const id = await fx.router.computePoolId(PoolKind.BridgeLp, fx.hubPool.address, fx.token0.target, ethers.ZeroAddress);
      await expect(fx.router.connect(fx.curator).setPoolEnabled(id, false)).to.emit(fx.router, "PoolEnabledChanged");
    });

    it("[G:LR.setPoolLimit.unknown] setPoolLimit reverts PoolUnknown for an unlisted id; a listed id succeeds", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.router.connect(fx.curator).setPoolLimit(unknownId, 1, 1)).to.be.revertedWithCustomError(fx.router, "PoolUnknown");
      await fx.router.connect(fx.curator).listPool(bridge(fx));
      const id = await fx.router.computePoolId(PoolKind.BridgeLp, fx.hubPool.address, fx.token0.target, ethers.ZeroAddress);
      await expect(fx.router.connect(fx.curator).setPoolLimit(id, 1, 1)).to.emit(fx.router, "PoolLimitChanged");
    });

    it("[G:LR.mint.unknown] mintFullRangeWithFee reverts PoolUnknown for an unlisted id", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.router.connect(fx.stranger).mintFullRangeWithFee(unknownId, 1, 1, 0, 0, 4_000_000_000, 250)).to.be.revertedWithCustomError(fx.router, "PoolUnknown");
    });
  });

  // -------------------------------------------------------------------------- fee ceilings (L283–284)

  describe("fee ceilings against a FeeRouter that misreports itself", function () {
    async function withLyingRouter(fx, reportedBps, actualBps) {
      const lying = await (await ethers.getContractFactory("MockLyingFeeRouter")).deploy(fx.other.address, reportedBps, actualBps);
      await fx.router.connect(fx.admin).setFeeRouter(await lying.getAddress());
      await fx.router.connect(fx.curator).listPool(trading(fx));
      return fx.router.computePoolId(PoolKind.TradingLp, fx.pool.target, fx.token0.target, fx.token1.target);
    }

    it("mintFullRangeWithFee reverts FeeAboveCap when the router REPORTS a rate above MAX_FEE_BPS, whatever the member consented to", async function () {
      const fx = await loadFixture(fixture);
      const id = await withLyingRouter(fx, 251, 0);
      await expect(fx.router.connect(fx.stranger).mintFullRangeWithFee(id, 100, 100, 0, 0, 4_000_000_000, 10_000))
        .to.be.revertedWithCustomError(fx.router, "FeeAboveCap");
    });

    it("a zero-fee supply is NOT blocked by a configured rate above the member's maxFeeBps (consent ceiling only bites when a fee is charged)", async function () {
      const fx = await loadFixture(fixture);
      const id = await withLyingRouter(fx, 200, 0); // reports 2%, charges nothing
      const amt = ethers.parseEther("10");
      for (const t of [fx.token0, fx.token1]) {
        await t.mint(fx.stranger.address, amt);
        await t.connect(fx.stranger).approve(await fx.router.getAddress(), amt);
      }
      await expect(fx.router.connect(fx.stranger).mintFullRangeWithFee(id, amt, amt, 0, 0, 4_000_000_000, 0))
        .to.emit(fx.router, "LiquiditySupplied");
    });
  });

  // -------------------------------------------------------------------------- role gates

  describe("role gates", function () {
    const CURATION = [
      ["listPool", (r, fx) => r.listPool(bridge(fx))],
      ["setPoolEnabled", (r) => r.setPoolEnabled(ethers.id("x"), true)],
      ["setPoolLimit", (r) => r.setPoolLimit(ethers.id("x"), 1, 1)],
    ];
    for (const [name, call] of CURATION) {
      it(`[G:LR.${name}.role] ${name} reverts AccessControlUnauthorizedAccount(caller, LIQUIDITY_ADMIN_ROLE)`, async function () {
        const fx = await loadFixture(fixture);
        await expectMissingRole(fx.router, call(fx.router.connect(fx.stranger), fx), fx.stranger.address, LIQUIDITY_ADMIN_ROLE);
      });
    }

    it("[G:LR.curatorIsNotAdmin] a LIQUIDITY_ADMIN cannot repoint fund-path wiring (DEFAULT_ADMIN_ROLE only)", async function () {
      const fx = await loadFixture(fixture);
      await expectMissingRole(fx.router, fx.router.connect(fx.curator).setFeeRouter(fx.other.address), fx.curator.address, DEFAULT_ADMIN_ROLE);
    });

    const WIRING = [
      ["setPositionManager", (r, fx) => r.setPositionManager(fx.other.address)],
      ["setFeeRouter", (r, fx) => r.setFeeRouter(fx.other.address)],
      ["setSanctionsGuard", (r, fx) => r.setSanctionsGuard(fx.other.address)],
    ];
    for (const [name, call] of WIRING) {
      it(`[G:LR.${name}.role] ${name} reverts AccessControlUnauthorizedAccount(caller, DEFAULT_ADMIN_ROLE); the admin succeeds`, async function () {
        const fx = await loadFixture(fixture);
        await expectMissingRole(fx.router, call(fx.router.connect(fx.stranger), fx), fx.stranger.address, DEFAULT_ADMIN_ROLE);
        await expect(call(fx.router.connect(fx.admin), fx)).to.not.be.reverted;
      });
    }

    it("[G:LR.pause.role] pause/unpause revert AccessControlUnauthorizedAccount(caller, GUARDIAN_ROLE); mint reverts EnforcedPause while paused", async function () {
      const fx = await loadFixture(fixture);
      await expectMissingRole(fx.router, fx.router.connect(fx.stranger).pause(), fx.stranger.address, GUARDIAN_ROLE);
      await fx.router.connect(fx.guardian).pause();
      await expect(fx.router.connect(fx.stranger).mintFullRangeWithFee(ethers.id("x"), 1, 1, 0, 0, 4_000_000_000, 250)).to.be.revertedWithCustomError(fx.router, "EnforcedPause");
      await expectMissingRole(fx.router, fx.router.connect(fx.stranger).unpause(), fx.stranger.address, GUARDIAN_ROLE);
      await fx.router.connect(fx.guardian).unpause();
    });

    it("[G:LR.upgrade.role] upgradeToAndCall reverts AccessControlUnauthorizedAccount(caller, UPGRADER_ROLE)", async function () {
      const fx = await loadFixture(fixture);
      const next = await (await ethers.getContractFactory("LiquidityRouter")).deploy();
      await expectMissingRole(fx.router, fx.router.connect(fx.stranger).upgradeToAndCall(await next.getAddress(), "0x"), fx.stranger.address, UPGRADER_ROLE);
    });
  });

  // -------------------------------------------------------------------------- zero addresses + init

  describe("zero-address checks + initialisation", function () {
    it("[G:LR.setPositionManager.zero] setPositionManager reverts ZeroAddress", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.router.connect(fx.admin).setPositionManager(ethers.ZeroAddress)).to.be.revertedWithCustomError(fx.router, "ZeroAddress");
    });

    it("[G:LR.setFeeRouter.zero] setFeeRouter reverts ZeroAddress", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.router.connect(fx.admin).setFeeRouter(ethers.ZeroAddress)).to.be.revertedWithCustomError(fx.router, "ZeroAddress");
    });

    it("[G:LR.init.zero] initialize reverts ZeroAddress for a zero admin or a zero feeRouter", async function () {
      const [admin, a1] = await ethers.getSigners();
      const Impl = await ethers.getContractFactory("LiquidityRouter");
      const Proxy = await ethers.getContractFactory("ERC1967Proxy");
      for (const args of [[ethers.ZeroAddress, a1.address, a1.address, ethers.ZeroAddress], [admin.address, ethers.ZeroAddress, a1.address, ethers.ZeroAddress]]) {
        const impl = await Impl.deploy();
        await expect(Proxy.deploy(await impl.getAddress(), Impl.interface.encodeFunctionData("initialize", args)))
          .to.be.revertedWithCustomError(impl, "ZeroAddress");
      }
    });

    it("[G:LR.reinit] initialize cannot run twice on the proxy, nor at all on the bare implementation", async function () {
      const fx = await loadFixture(fixture);
      const args = [fx.admin.address, await fx.feeRouter.getAddress(), await fx.nfpm.getAddress(), ethers.ZeroAddress];
      await expect(fx.router.initialize(...args)).to.be.revertedWithCustomError(fx.router, "InvalidInitialization");
      const bare = await (await ethers.getContractFactory("LiquidityRouter")).deploy();
      await expect(bare.initialize(...args)).to.be.revertedWithCustomError(bare, "InvalidInitialization");
    });
  });
});
