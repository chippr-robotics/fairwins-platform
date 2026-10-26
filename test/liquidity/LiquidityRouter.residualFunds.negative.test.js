const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployFeeRouter } = require("../helpers/proxy");

// Spec 112 (FR-004 / FR-006, #1673) — LiquidityRouter.ResidualFunds (LiquidityRouter.sol:395).
//
// The router never takes custody and has NO rescue function (spec 067), so any balance it is left
// holding after a supply is stranded for good. `_supply` therefore ends by requiring its token
// balances to equal what they were on entry. This was expected to be unreachable with conforming
// dependencies, but one real misconfiguration reaches it with production contracts only: the
// FeeRouter's `treasury()` pointed at the LiquidityRouter itself (FeeRouter.setTreasury accepts any
// non-zero address). The fee "transfer" is then a self-transfer, the fee never leaves, and without
// the guard it would be stranded in a contract nobody can withdraw from. The guard turns that into a
// loud revert with the member's funds untouched.

const LIQUIDITY_DEPOSIT = ethers.keccak256(ethers.toUtf8Bytes("liquidity.deposit"));
const PoolKind = { TradingLp: 2 };
const ServiceKind = { ConfigOnly: 2 };
const FEE_TIER = 3000;
const ETH = (n) => ethers.parseEther(n);
const DEADLINE = 4_000_000_000;

describe("LiquidityRouter — ResidualFunds (spec 112)", function () {
  async function fixture() {
    const [admin, member, treasury] = await ethers.getSigners();
    const feeRouter = await deployFeeRouter([admin.address, treasury.address]);
    await feeRouter.connect(admin).registerService(LIQUIDITY_DEPOSIT, 250, ServiceKind.ConfigOnly);
    await feeRouter.connect(admin).setFeeBps(LIQUIDITY_DEPOSIT, 50);

    const Token = await ethers.getContractFactory("MockERC20");
    const a = await Token.deploy("Token A", "TKA", 0);
    const b = await Token.deploy("Token B", "TKB", 0);
    const [token0, token1] = a.target.toLowerCase() < b.target.toLowerCase() ? [a, b] : [b, a];
    const pool = await (await ethers.getContractFactory("MockUniswapV3Pool")).deploy(token0.target, token1.target, FEE_TIER, 60);
    const nfpm = await (await ethers.getContractFactory("MockPositionManager")).deploy();

    const Impl = await ethers.getContractFactory("LiquidityRouter");
    const impl = await Impl.deploy();
    const Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await Proxy.deploy(await impl.getAddress(), Impl.interface.encodeFunctionData("initialize", [admin.address, await feeRouter.getAddress(), await nfpm.getAddress(), ethers.ZeroAddress]));
    const router = Impl.attach(await proxy.getAddress());

    await router.connect(admin).listPool({
      kind: PoolKind.TradingLp, enabled: true, feeTier: FEE_TIER,
      token0: token0.target, token1: token1.target, poolAddress: pool.target,
      maxDeposit0PerTx: 0, maxDeposit1PerTx: 0,
    });
    const poolId = await router.computePoolId(PoolKind.TradingLp, pool.target, token0.target, token1.target);

    for (const t of [token0, token1]) {
      await t.mint(member.address, ETH("1000"));
      await t.connect(member).approve(router.target, ethers.MaxUint256);
    }
    return { router, feeRouter, token0, token1, nfpm, poolId, admin, member, treasury };
  }

  const supply = (fx) => fx.router.connect(fx.member).mintFullRangeWithFee(fx.poolId, ETH("100"), ETH("200"), 0, 0, DEADLINE, 250);

  it("control: with a real treasury the supply settles and the router ends holding nothing", async function () {
    const fx = await loadFixture(fixture);
    await expect(supply(fx)).to.emit(fx.router, "LiquiditySupplied");
    expect(await fx.token0.balanceOf(fx.router.target)).to.equal(0n);
    expect(await fx.token1.balanceOf(fx.router.target)).to.equal(0n);
    expect(await fx.token0.balanceOf(fx.treasury.address)).to.be.greaterThan(0n);
  });

  it("FeeRouter treasury repointed at the router: the self-paid fee would strand — reverts ResidualFunds, member untouched", async function () {
    const fx = await loadFixture(fixture);
    await fx.feeRouter.connect(fx.admin).setTreasury(fx.router.target);
    const before0 = await fx.token0.balanceOf(fx.member.address);
    const before1 = await fx.token1.balanceOf(fx.member.address);

    await expect(supply(fx)).to.be.revertedWithCustomError(fx.router, "ResidualFunds");

    expect(await fx.token0.balanceOf(fx.member.address)).to.equal(before0);
    expect(await fx.token1.balanceOf(fx.member.address)).to.equal(before1);
    expect(await fx.token0.balanceOf(fx.router.target)).to.equal(0n);
    expect(await fx.nfpm.nextTokenId()).to.equal(1n); // no position minted
  });

  it("the same misconfiguration is harmless at a zero fee rate (nothing self-paid, nothing left behind)", async function () {
    const fx = await loadFixture(fixture);
    await fx.feeRouter.connect(fx.admin).setTreasury(fx.router.target);
    await fx.feeRouter.connect(fx.admin).setFeeBps(LIQUIDITY_DEPOSIT, 0);
    await expect(supply(fx)).to.emit(fx.router, "LiquiditySupplied");
    expect(await fx.token0.balanceOf(fx.router.target)).to.equal(0n);
  });
});
