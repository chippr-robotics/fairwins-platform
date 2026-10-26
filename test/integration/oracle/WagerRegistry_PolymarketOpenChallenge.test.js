const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployWagerRegistry, deployMembershipManager } = require("../../helpers/proxy");

// Spec 041 — oracle-settled OPEN challenges (Polymarket). No Solidity changes: this
// suite proves the deployed path end-to-end under the new usage pattern (constitution
// Principle I treats oracle-resolution paths as highest-risk, and no prior test created
// an open wager with an oracle resolution type). Equivalence target: an accepted oracle
// open challenge behaves identically to the named-opponent Polymarket suite
// (test/integration/oracle/WagerRegistry_Polymarket.test.js).

const Tier = { None: 0, Bronze: 1, Silver: 2 };
const Resolution = {
  Either: 0, Creator: 1, Opponent: 2, ThirdParty: 3, Polymarket: 4,
  ChainlinkDataFeed: 5, ChainlinkFunctions: 6, UMA: 7,
};
const Status = { None: 0, Open: 1, Active: 2, Resolved: 3, Cancelled: 4, Refunded: 5, Draw: 6 };
const WAGER_PARTICIPANT_ROLE = ethers.keccak256(ethers.toUtf8Bytes("WAGER_PARTICIPANT_ROLE"));
const usdc = (n) => ethers.parseUnits(String(n), 6);

describe("WagerRegistry — oracle-settled open challenges (041, Polymarket)", function () {
  async function deployFixture() {
    const [admin, silverCreator, taker, otherTaker, treasury] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdcToken = await MockERC20.deploy("USD Coin", "USDC", 0);

    const Ctf = await ethers.getContractFactory("MockPolymarketCTF");
    const ctf = await Ctf.deploy();
    const PolymarketAdapter = await ethers.getContractFactory("PolymarketOracleAdapter");
    const pmAdapter = await PolymarketAdapter.deploy(admin.address, await ctf.getAddress());

    const mgr = await deployMembershipManager([admin.address, await usdcToken.getAddress(), treasury.address]);
    const limits = { monthlyMarketCreation: 100, maxConcurrentMarkets: 20 };
    await mgr.connect(admin).setTier(WAGER_PARTICIPANT_ROLE, Tier.Bronze, usdc(50), 30, limits, true);
    await mgr.connect(admin).setTier(WAGER_PARTICIPANT_ROLE, Tier.Silver, usdc(100), 30, limits, true);

    const reg = await deployWagerRegistry([
      admin.address, await mgr.getAddress(), await pmAdapter.getAddress(),
      [await usdcToken.getAddress()],
    ]);
    await mgr.connect(admin).setAuthorizedCaller(await reg.getAddress(), true);

    for (const u of [silverCreator, taker, otherTaker]) {
      await usdcToken.mint(u.address, usdc(10_000));
      await usdcToken.connect(u).approve(await mgr.getAddress(), ethers.MaxUint256);
      await usdcToken.connect(u).approve(await reg.getAddress(), ethers.MaxUint256);
    }
    await mgr.connect(silverCreator).purchaseTier(WAGER_PARTICIPANT_ROLE, Tier.Silver);
    await mgr.connect(taker).purchaseTier(WAGER_PARTICIPANT_ROLE, Tier.Bronze);
    await mgr.connect(otherTaker).purchaseTier(WAGER_PARTICIPANT_ROLE, Tier.Bronze);

    return { reg, mgr, usdcToken, ctf, pmAdapter, admin, silverCreator, taker, otherTaker };
  }

  /** Prepare a fresh (unresolved) CTF condition and return its id. */
  async function prepareCondition(fx) {
    const oracle = fx.admin.address;
    const questionId = ethers.id("open-q-" + Math.random());
    const conditionId = await fx.ctf.getConditionId(oracle, questionId, 2);
    await fx.ctf.prepareCondition(oracle, questionId, 2);
    return conditionId;
  }

  // The code-derived claim key (production derives it from the four-word code).
  function newClaimKey() {
    return ethers.Wallet.createRandom();
  }

  async function signOpenAccept(claimKey, regAddr, wagerId, takerAddr) {
    const { chainId } = await ethers.provider.getNetwork();
    const domain = { name: "FairWins WagerRegistry", version: "1", chainId, verifyingContract: regAddr };
    const types = { OpenAccept: [{ name: "wagerId", type: "uint256" }, { name: "taker", type: "address" }] };
    return claimKey.signTypedData(domain, types, { wagerId, taker: takerAddr });
  }

  /** Create an oracle-settled open challenge; returns { wagerId, key }. */
  async function createOracleOpen(fx, conditionId, overrides = {}) {
    const now = await time.latest();
    const key = overrides.key || newClaimKey();
    const p = {
      stake: usdc(10),
      acceptDeadline: now + 3600,
      resolveDeadline: now + 86400,
      resolutionType: Resolution.Polymarket,
      creatorIsYes: true,
      ...overrides,
    };
    const tx = await fx.reg.connect(fx.silverCreator).createOpenWager(
      key.address, ethers.ZeroAddress, await fx.usdcToken.getAddress(),
      p.stake, p.acceptDeadline, p.resolveDeadline, p.resolutionType,
      conditionId, p.creatorIsYes, ethers.id("oracle-open-terms"), "ipfs://bafyOracleOpen"
    );
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return fx.reg.interface.parseLog(l); } catch { return null; } })
      .find((p2) => p2 && p2.name === "OpenWagerCreated");
    return { wagerId: Number(ev.args.wagerId), key, tx };
  }

  async function acceptWithCode(fx, wagerId, key, taker) {
    const sig = await signOpenAccept(key, await fx.reg.getAddress(), wagerId, taker.address);
    return fx.reg.connect(taker).acceptOpenWager(wagerId, sig);
  }

  describe("creation (FR-008/FR-009 — on-chain linkage validation)", () => {
    it("links an unresolved Polymarket condition and emits OpenWagerCreated + PolymarketLinked", async () => {
      const fx = await loadFixture(deployFixture);
      const conditionId = await prepareCondition(fx);
      const { wagerId, tx } = await createOracleOpen(fx, conditionId, { creatorIsYes: true });

      await expect(tx).to.emit(fx.reg, "PolymarketLinked").withArgs(wagerId, conditionId, true);
      const w = await fx.reg.getWager(wagerId);
      expect(w.status).to.equal(Status.Open);
      expect(w.opponent).to.equal(ethers.ZeroAddress);
      expect(w.resolutionType).to.equal(Resolution.Polymarket);
      expect(w.polymarketConditionId).to.equal(conditionId);
      expect(w.creatorIsYes).to.equal(true);
      expect(w.creatorStake).to.equal(usdc(10));
      expect(w.opponentStake).to.equal(usdc(10)); // equal stakes by construction
      expect(await fx.reg.isOpenChallenge(wagerId)).to.equal(true);
    });

    it("reverts PolymarketRequired for a zero condition id", async () => {
      const fx = await loadFixture(deployFixture);
      await expect(createOracleOpen(fx, ethers.ZeroHash))
        .to.be.revertedWithCustomError(fx.reg, "PolymarketRequired");
    });

    it("reverts ConditionAlreadyResolved for a market whose outcome is already public", async () => {
      const fx = await loadFixture(deployFixture);
      const conditionId = await prepareCondition(fx);
      await fx.ctf.resolveCondition(conditionId, [1, 0]);
      await expect(createOracleOpen(fx, conditionId))
        .to.be.revertedWithCustomError(fx.reg, "ConditionAlreadyResolved");
    });

    it("reverts AdapterNotSet when the registry has no Polymarket adapter", async () => {
      const fx = await loadFixture(deployFixture);
      const { admin, silverCreator, usdcToken, mgr } = fx;
      const bare = await deployWagerRegistry([
        admin.address, await mgr.getAddress(), ethers.ZeroAddress,
        [await usdcToken.getAddress()],
      ]);
      await mgr.connect(admin).setAuthorizedCaller(await bare.getAddress(), true);
      await usdcToken.connect(silverCreator).approve(await bare.getAddress(), ethers.MaxUint256);

      const now = await time.latest();
      await expect(bare.connect(silverCreator).createOpenWager(
        newClaimKey().address, ethers.ZeroAddress, await usdcToken.getAddress(),
        usdc(10), now + 3600, now + 86400, Resolution.Polymarket,
        ethers.id("some-condition"), true, ethers.id("t"), ""
      )).to.be.revertedWithCustomError(bare, "AdapterNotSet");
    });

    it("still bars single-party self-resolution on open challenges (FR-016a of 024)", async () => {
      const fx = await loadFixture(deployFixture);
      await expect(createOracleOpen(fx, ethers.ZeroHash, { resolutionType: Resolution.Creator }))
        .to.be.revertedWithCustomError(fx.reg, "OpenResolutionTypeNotAllowed");
      await expect(createOracleOpen(fx, ethers.ZeroHash, { resolutionType: Resolution.Opponent }))
        .to.be.revertedWithCustomError(fx.reg, "OpenResolutionTypeNotAllowed");
    });
  });

  describe("accept → auto-resolve → claim (FR-016/FR-017 — equivalence with named-opponent oracle wagers)", () => {
    it("YES outcome: creator (creatorIsYes=true) wins and claims 2× stake", async () => {
      const fx = await loadFixture(deployFixture);
      const conditionId = await prepareCondition(fx);
      const { wagerId, key } = await createOracleOpen(fx, conditionId, { creatorIsYes: true });

      await acceptWithCode(fx, wagerId, key, fx.taker);
      expect((await fx.reg.getWager(wagerId)).status).to.equal(Status.Active);
      expect((await fx.reg.getWager(wagerId)).opponent).to.equal(fx.taker.address);

      await fx.ctf.resolveCondition(conditionId, [1, 0]); // YES wins
      // Anyone may trigger the auto-resolve — same as named-opponent oracle wagers.
      await fx.reg.connect(fx.otherTaker).autoResolveFromPolymarket(wagerId);

      const w = await fx.reg.getWager(wagerId);
      expect(w.status).to.equal(Status.Resolved);
      expect(w.winner).to.equal(fx.silverCreator.address);

      const before = await fx.usdcToken.balanceOf(fx.silverCreator.address);
      await fx.reg.connect(fx.silverCreator).claimPayout(wagerId);
      expect((await fx.usdcToken.balanceOf(fx.silverCreator.address)) - before).to.equal(usdc(20));
    });

    it("NO outcome: the code-holding taker (opposite side) wins", async () => {
      const fx = await loadFixture(deployFixture);
      const conditionId = await prepareCondition(fx);
      const { wagerId, key } = await createOracleOpen(fx, conditionId, { creatorIsYes: true });
      await acceptWithCode(fx, wagerId, key, fx.taker);

      await fx.ctf.resolveCondition(conditionId, [0, 1]); // NO wins
      await fx.reg.connect(fx.otherTaker).autoResolveFromPolymarket(wagerId);

      const w = await fx.reg.getWager(wagerId);
      expect(w.status).to.equal(Status.Resolved);
      expect(w.winner).to.equal(fx.taker.address);

      const before = await fx.usdcToken.balanceOf(fx.taker.address);
      await fx.reg.connect(fx.taker).claimPayout(wagerId);
      expect((await fx.usdcToken.balanceOf(fx.taker.address)) - before).to.equal(usdc(20));
    });

    it("TIE (invalid market): settles a DRAW and returns both stakes", async () => {
      const fx = await loadFixture(deployFixture);
      const conditionId = await prepareCondition(fx);
      const { wagerId, key } = await createOracleOpen(fx, conditionId, { creatorIsYes: true });
      await acceptWithCode(fx, wagerId, key, fx.taker);

      await fx.ctf.resolveCondition(conditionId, [1, 1]); // 50/50 tie
      const cBefore = await fx.usdcToken.balanceOf(fx.silverCreator.address);
      const tBefore = await fx.usdcToken.balanceOf(fx.taker.address);
      await expect(fx.reg.connect(fx.otherTaker).autoResolveFromPolymarket(wagerId))
        .to.emit(fx.reg, "WagerDrawn");

      expect((await fx.reg.getWager(wagerId)).status).to.equal(Status.Draw);
      expect((await fx.usdcToken.balanceOf(fx.silverCreator.address)) - cBefore).to.equal(usdc(10));
      expect((await fx.usdcToken.balanceOf(fx.taker.address)) - tBefore).to.equal(usdc(10));
    });

    it("UNRESOLVED market: auto-resolve reverts ConditionNotResolved (no premature settle)", async () => {
      const fx = await loadFixture(deployFixture);
      const conditionId = await prepareCondition(fx);
      const { wagerId, key } = await createOracleOpen(fx, conditionId);
      await acceptWithCode(fx, wagerId, key, fx.taker);

      await expect(fx.reg.connect(fx.otherTaker).autoResolveFromPolymarket(wagerId))
        .to.be.revertedWithCustomError(fx.reg, "ConditionNotResolved");
    });

    it("only the first code-holder binds; a second acceptance is cleanly refused", async () => {
      const fx = await loadFixture(deployFixture);
      const conditionId = await prepareCondition(fx);
      const { wagerId, key } = await createOracleOpen(fx, conditionId);

      await acceptWithCode(fx, wagerId, key, fx.taker);
      await expect(acceptWithCode(fx, wagerId, key, fx.otherTaker)).to.be.revertedWithCustomError(fx.reg, "NotOpenChallenge");
      expect((await fx.reg.getWager(wagerId)).opponent).to.equal(fx.taker.address);
    });
  });

  describe("lifecycle edges", () => {
    it("an untaken oracle open challenge expires → creator refund, code slot freed", async () => {
      const fx = await loadFixture(deployFixture);
      const conditionId = await prepareCondition(fx);
      const { wagerId, key } = await createOracleOpen(fx, conditionId);

      const w = await fx.reg.getWager(wagerId);
      await time.increaseTo(Number(w.acceptDeadline) + 1);

      const before = await fx.usdcToken.balanceOf(fx.silverCreator.address);
      await fx.reg.connect(fx.silverCreator).claimRefund(wagerId);
      expect((await fx.reg.getWager(wagerId)).status).to.equal(Status.Refunded);
      expect((await fx.usdcToken.balanceOf(fx.silverCreator.address)) - before).to.equal(usdc(10));
      expect(await fx.reg.openWagerIdForClaim(key.address)).to.equal(0n);
    });

    it("the market resolving while the challenge is still Open does not break expiry/refund", async () => {
      // The claimant-side app blocks taking a publicly-decided market (D8); on-chain, an
      // untaken challenge whose market resolved simply expires and refunds as usual.
      const fx = await loadFixture(deployFixture);
      const conditionId = await prepareCondition(fx);
      const { wagerId } = await createOracleOpen(fx, conditionId);

      await fx.ctf.resolveCondition(conditionId, [1, 0]);
      const w = await fx.reg.getWager(wagerId);
      await time.increaseTo(Number(w.acceptDeadline) + 1);
      await fx.reg.connect(fx.silverCreator).claimRefund(wagerId);
      expect((await fx.reg.getWager(wagerId)).status).to.equal(Status.Refunded);
    });
  });
});
