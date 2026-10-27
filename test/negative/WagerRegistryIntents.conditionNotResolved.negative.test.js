const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployWagerRegistry, deployMembershipManager } = require("../helpers/proxy");

// Spec 112 (FR-004 / FR-006, #1673) — WagerRegistryIntents.ConditionNotResolved, both raise sites.
// The relocated cold paths live on the WagerRegistryIntents facet (served through the main facet's
// fallback), so these calls go through the proxy exactly as production does.
//
//   autoResolveFromPolymarket (WagerRegistryIntents.sol:242) — adapter reports resolvedAt == 0 AND the
//     CTF condition is genuinely unresolved. The sibling branch (resolvedAt == 0 because of a resolved
//     TIE) must settle a draw instead, so it is asserted here too: dropping the isConditionResolved
//     disambiguation and dropping the revert must both fail this file.
//   autoResolveFromOracle (WagerRegistryIntents.sol:258) — ChainlinkDataFeed condition not yet evaluated.
//
// In every revert case the wager stays Active with its escrow intact: an unresolved oracle never
// moves funds, and the resolveDeadline refund remains the liveness path.

const Tier = { Bronze: 1 };
const Resolution = { Polymarket: 4, ChainlinkDataFeed: 5 };
const Status = { Active: 2, Resolved: 3 };
const Op = { GT: 0 };
const WAGER_PARTICIPANT_ROLE = ethers.keccak256(ethers.toUtf8Bytes("WAGER_PARTICIPANT_ROLE"));
const usdc = (n) => ethers.parseUnits(String(n), 6);
const CTF_ORACLE = "0x0000000000000000000000000000000000000001";

describe("WagerRegistryIntents — ConditionNotResolved (spec 112)", function () {
  async function deployFixture() {
    const [admin, alice, bob, charlie, treasury] = await ethers.getSigners();

    const usdcToken = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 0);
    const ctf = await (await ethers.getContractFactory("MockPolymarketCTF")).deploy();
    const pmAdapter = await (await ethers.getContractFactory("PolymarketOracleAdapter")).deploy(admin.address, await ctf.getAddress());
    const feed = await (await ethers.getContractFactory("MockChainlinkAggregator")).deploy(0n, 8, await time.latest());
    const clAdapter = await (await ethers.getContractFactory("ChainlinkDataFeedOracleAdapter")).deploy(admin.address);
    await clAdapter.setFeedAllowed(await feed.getAddress(), true);

    const mgr = await deployMembershipManager([admin.address, await usdcToken.getAddress(), treasury.address]);
    await mgr.connect(admin).setTier(WAGER_PARTICIPANT_ROLE, Tier.Bronze, usdc(50), 30, { monthlyMarketCreation: 100, maxConcurrentMarkets: 10 }, true);

    const reg = await deployWagerRegistry([admin.address, await mgr.getAddress(), await pmAdapter.getAddress(), [await usdcToken.getAddress()]]);
    await mgr.connect(admin).setAuthorizedCaller(await reg.getAddress(), true);
    await reg.connect(admin).setOracleAdapter(Resolution.ChainlinkDataFeed, await clAdapter.getAddress());

    for (const u of [alice, bob, charlie]) {
      await usdcToken.mint(u.address, usdc(10_000));
      await usdcToken.connect(u).approve(await mgr.getAddress(), ethers.MaxUint256);
      await usdcToken.connect(u).approve(await reg.getAddress(), ethers.MaxUint256);
      await mgr.connect(u).purchaseTier(WAGER_PARTICIPANT_ROLE, Tier.Bronze);
    }
    return { reg, usdcToken, ctf, clAdapter, feed, alice, bob, charlie };
  }

  async function activeWager(fx, resolutionType, conditionId) {
    const now = await time.latest();
    const tx = await fx.reg.connect(fx.alice).createWager(
      fx.bob.address, ethers.ZeroAddress, await fx.usdcToken.getAddress(),
      usdc(10), usdc(10), now + 1800, now + 7200,
      resolutionType, conditionId, true, ethers.id("meta"), ""
    );
    const rcpt = await tx.wait();
    const ev = rcpt.logs.map((l) => { try { return fx.reg.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "WagerCreated");
    const wagerId = Number(ev.args.wagerId);
    await fx.reg.connect(fx.bob).acceptWager(wagerId);
    return wagerId;
  }

  async function polymarketWager(fx) {
    const qid = ethers.id("spec112 Q" + Math.random());
    await fx.ctf.prepareCondition(CTF_ORACLE, qid, 2);
    const cid = ethers.keccak256(ethers.solidityPacked(["address", "bytes32", "uint256"], [CTF_ORACLE, qid, 2]));
    return { cid, wagerId: await activeWager(fx, Resolution.Polymarket, cid) };
  }

  describe("autoResolveFromPolymarket", function () {
    it("reverts ConditionNotResolved while the CTF condition is unresolved; escrow and status untouched", async function () {
      const fx = await loadFixture(deployFixture);
      const { wagerId } = await polymarketWager(fx);
      const escrow = await fx.usdcToken.balanceOf(await fx.reg.getAddress());

      await expect(fx.reg.connect(fx.charlie).autoResolveFromPolymarket(wagerId)).to.be.revertedWithCustomError(fx.reg, "ConditionNotResolved");

      expect((await fx.reg.getWager(wagerId)).status).to.equal(Status.Active);
      expect(await fx.usdcToken.balanceOf(await fx.reg.getAddress())).to.equal(escrow);
    });

    it("a RESOLVED tie (also resolvedAt == 0) settles a draw instead of reverting", async function () {
      const fx = await loadFixture(deployFixture);
      const { wagerId, cid } = await polymarketWager(fx);
      await fx.ctf.resolveCondition(cid, [1, 1]);
      await expect(fx.reg.connect(fx.charlie).autoResolveFromPolymarket(wagerId)).to.emit(fx.reg, "WagerDrawn");
    });

    it("once the condition resolves decisively, the same call settles the winner", async function () {
      const fx = await loadFixture(deployFixture);
      const { wagerId, cid } = await polymarketWager(fx);
      await fx.ctf.resolveCondition(cid, [1, 0]);
      await fx.reg.connect(fx.charlie).autoResolveFromPolymarket(wagerId);
      const w = await fx.reg.getWager(wagerId);
      expect(w.status).to.equal(Status.Resolved);
      expect(w.winner).to.equal(fx.alice.address);
    });
  });

  describe("autoResolveFromOracle (ChainlinkDataFeed)", function () {
    it("reverts ConditionNotResolved before the adapter evaluates; settles after", async function () {
      const fx = await loadFixture(deployFixture);
      const conditionId = ethers.id("spec112 c" + Math.random());
      const evalDeadline = (await time.latest()) + 3600;
      await fx.clAdapter.registerCondition(conditionId, await fx.feed.getAddress(), 2500_00000000n, Op.GT, evalDeadline);
      const wagerId = await activeWager(fx, Resolution.ChainlinkDataFeed, conditionId);
      const escrow = await fx.usdcToken.balanceOf(await fx.reg.getAddress());

      await expect(fx.reg.connect(fx.charlie).autoResolveFromOracle(wagerId)).to.be.revertedWithCustomError(fx.reg, "ConditionNotResolved");
      expect((await fx.reg.getWager(wagerId)).status).to.equal(Status.Active);
      expect(await fx.usdcToken.balanceOf(await fx.reg.getAddress())).to.equal(escrow);

      await time.increaseTo(evalDeadline + 1);
      await fx.feed.setAnswer(3000_00000000n, evalDeadline + 1);
      await fx.clAdapter.evaluate(conditionId);
      await fx.reg.connect(fx.charlie).autoResolveFromOracle(wagerId);
      expect((await fx.reg.getWager(wagerId)).winner).to.equal(fx.alice.address);
    });
  });
});
