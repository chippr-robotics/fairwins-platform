const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployWagerRegistry, deployMembershipManager } = require("../helpers/proxy");

// Spec 112 FR-004 — validation branches in WagerRegistryCore (shared by both facets) and the
// SignerIntentBase cancellation path that the baseline coverage run (`npm run test:coverage`, BRDA)
// showed as never taken. Each test asserts the specific error AND the adjacent success, so the test
// pins which side of the branch the guard sits on.

const Tier = { Bronze: 1, Silver: 2 };
const R = { Either: 0, Creator: 1, Opponent: 2, ThirdParty: 3 };
const ROLE = ethers.keccak256(ethers.toUtf8Bytes("WAGER_PARTICIPANT_ROLE"));
const usdc = (n) => ethers.parseUnits(String(n), 6);
const DAY = 24 * 60 * 60;

describe("WagerRegistryCore + SignerIntentBase — validation branches (spec 112 FR-004)", function () {
  async function fixture() {
    const [admin, alice, bob, carol, relayer, treasury] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockUSDCPermit")).deploy();
    const mgr = await deployMembershipManager([admin.address, await token.getAddress(), treasury.address]);
    const limits = { monthlyMarketCreation: 100, maxConcurrentMarkets: 20 };
    await mgr.connect(admin).setTier(ROLE, Tier.Bronze, usdc(50), 30, limits, true);
    await mgr.connect(admin).setTier(ROLE, Tier.Silver, usdc(120), 30, limits, true);
    const reg = await deployWagerRegistry([admin.address, await mgr.getAddress(), ethers.ZeroAddress, [await token.getAddress()]]);
    await mgr.connect(admin).setAuthorizedCaller(await reg.getAddress(), true);
    for (const u of [alice, bob, carol]) {
      await token.mint(u.address, usdc(10_000));
      await token.connect(u).approve(await reg.getAddress(), ethers.MaxUint256);
      await mgr.connect(admin).grantMembership(u.address, ROLE, Tier.Silver, 365);
    }
    const chainId = (await ethers.provider.getNetwork()).chainId;
    const regDomain = { name: "FairWins WagerRegistry", version: "1", chainId, verifyingContract: await reg.getAddress() };
    return { reg, mgr, token, admin, alice, bob, carol, relayer, regDomain };
  }

  async function create(fx, o = {}) {
    const now = await time.latest();
    const p = {
      from: fx.alice, opponent: fx.bob.address, arbitrator: ethers.ZeroAddress, rt: R.Either,
      accept: now + 3600, resolve: now + 86400, ...o,
    };
    return fx.reg.connect(p.from).createWager(p.opponent, p.arbitrator, await fx.token.getAddress(), usdc(10), usdc(10), p.accept, p.resolve, p.rt, ethers.ZeroHash, false, ethers.id("m"), "");
  }

  async function idOf(fx, txp, ev = "WagerCreated") {
    const rc = await (await txp).wait();
    for (const l of rc.logs) {
      try { const p = fx.reg.interface.parseLog(l); if (p && p.name === ev) return Number(p.args.wagerId); } catch { /* foreign log */ }
    }
    throw new Error(`${ev} not emitted`);
  }

  describe("_checkDeadlines (L210–211)", function () {
    it("reverts BadDeadlines past MAX_ACCEPT_WINDOW; exactly at the window is accepted", async function () {
      const fx = await loadFixture(fixture);
      const now = await time.latest();
      const maxAccept = Number(await fx.reg.MAX_ACCEPT_WINDOW());
      // +1s of slack for the next block's timestamp.
      await expect(create(fx, { accept: now + maxAccept + 5, resolve: now + maxAccept + 10 })).to.be.revertedWithCustomError(fx.reg, "BadDeadlines");
      const t = await time.latest();
      await time.setNextBlockTimestamp(t + 1);
      await expect(create(fx, { accept: t + 1 + maxAccept, resolve: t + 1 + maxAccept + 10 })).to.emit(fx.reg, "WagerCreated");
    });

    it("reverts BadDeadlines when resolveDeadline exceeds MAX_RESOLVE_WINDOW", async function () {
      const fx = await loadFixture(fixture);
      const now = await time.latest();
      const maxResolve = Number(await fx.reg.MAX_RESOLVE_WINDOW());
      await expect(create(fx, { accept: now + 3600, resolve: now + maxResolve + 5 })).to.be.revertedWithCustomError(fx.reg, "BadDeadlines");
    });
  });

  describe("arbitrator rules (L306–309)", function () {
    it("ThirdParty reverts ArbitratorRequired with none, ArbitratorDisallowed for the creator AND for the opponent; a neutral arbitrator succeeds", async function () {
      const fx = await loadFixture(fixture);
      await expect(create(fx, { rt: R.ThirdParty })).to.be.revertedWithCustomError(fx.reg, "ArbitratorRequired");
      await expect(create(fx, { rt: R.ThirdParty, arbitrator: fx.alice.address })).to.be.revertedWithCustomError(fx.reg, "ArbitratorDisallowed");
      await expect(create(fx, { rt: R.ThirdParty, arbitrator: fx.bob.address })).to.be.revertedWithCustomError(fx.reg, "ArbitratorDisallowed");
      await expect(create(fx, { rt: R.ThirdParty, arbitrator: fx.carol.address })).to.emit(fx.reg, "WagerCreated");
    });
  });

  describe("accept paths (L377–378, L401)", function () {
    it("acceptWager reverts NotOpen on an already-active wager", async function () {
      const fx = await loadFixture(fixture);
      const id = await idOf(fx, create(fx));
      await fx.reg.connect(fx.bob).acceptWager(id);
      await expect(fx.reg.connect(fx.bob).acceptWager(id)).to.be.revertedWithCustomError(fx.reg, "NotOpen");
    });

    it("acceptOpenWager reverts NotOpenChallenge on a NAMED open wager (status Open, no claim authority)", async function () {
      const fx = await loadFixture(fixture);
      const id = await idOf(fx, create(fx));
      await expect(fx.reg.connect(fx.carol).acceptOpenWager(id, "0x")).to.be.revertedWithCustomError(fx.reg, "NotOpenChallenge");
    });

    it("acceptOpenWager reverts AcceptExpired after the accept deadline, with a valid claim proof", async function () {
      const fx = await loadFixture(fixture);
      const key = ethers.Wallet.createRandom();
      const now = await time.latest();
      const id = await idOf(fx, fx.reg.connect(fx.alice).createOpenWager(key.address, ethers.ZeroAddress, await fx.token.getAddress(), usdc(10), now + 600, now + 86400, R.Either, ethers.ZeroHash, false, ethers.id("o"), ""), "OpenWagerCreated");
      const proof = await key.signTypedData(fx.regDomain, { OpenAccept: [{ name: "wagerId", type: "uint256" }, { name: "taker", type: "address" }] }, { wagerId: id, taker: fx.bob.address });
      await time.increase(601);
      await expect(fx.reg.connect(fx.bob).acceptOpenWager(id, proof)).to.be.revertedWithCustomError(fx.reg, "AcceptExpired");
    });
  });

  describe("draw revocation (L520–527)", function () {
    it("revokeDraw reverts NotActive on an open wager and NotParticipant for a third party", async function () {
      const fx = await loadFixture(fixture);
      const id = await idOf(fx, create(fx));
      await expect(fx.reg.connect(fx.alice).revokeDraw(id)).to.be.revertedWithCustomError(fx.reg, "NotActive");
      await fx.reg.connect(fx.bob).acceptWager(id);
      await fx.reg.connect(fx.alice).declareDraw(id);
      await expect(fx.reg.connect(fx.carol).revokeDraw(id)).to.be.revertedWithCustomError(fx.reg, "NotParticipant");
      // Opponent leg: bob never consented, so NoDrawProposal; alice's revoke succeeds.
      await expect(fx.reg.connect(fx.bob).revokeDraw(id)).to.be.revertedWithCustomError(fx.reg, "NoDrawProposal");
      await expect(fx.reg.connect(fx.alice).revokeDraw(id)).to.emit(fx.reg, "DrawRevoked");
    });
  });

  describe("refund timing (L596, L615)", function () {
    it("claimRefund on an Active wager reverts NotRefundable until the resolve deadline passes, then refunds both sides", async function () {
      const fx = await loadFixture(fixture);
      const now = await time.latest();
      const id = await idOf(fx, create(fx, { resolve: now + 7200 }));
      await fx.reg.connect(fx.bob).acceptWager(id);
      await expect(fx.reg.connect(fx.carol).claimRefund(id)).to.be.revertedWithCustomError(fx.reg, "NotRefundable");
      await time.increase(7200);
      await expect(fx.reg.connect(fx.carol).claimRefund(id)).to.emit(fx.reg, "WagerRefunded").withArgs(id, fx.alice.address, fx.bob.address);
    });

    it("batchExpireOpen skips (does not refund) an Open wager whose accept deadline has not passed", async function () {
      const fx = await loadFixture(fixture);
      const id = await idOf(fx, create(fx));
      await expect(fx.reg.batchExpireOpen([id])).to.not.emit(fx.reg, "WagerRefunded");
      expect((await fx.reg.getWager(id)).status).to.equal(1); // still Open
    });
  });

  describe("initialize zero addresses (WagerRegistry L62, L66)", function () {
    it("reverts ZeroAddress for a zero admin, zero membership manager, or a zero initial token", async function () {
      const [admin, other] = await ethers.getSigners();
      const Impl = await ethers.getContractFactory("WagerRegistry");
      const Proxy = await ethers.getContractFactory("ERC1967Proxy");
      for (const args of [
        [ethers.ZeroAddress, other.address, ethers.ZeroAddress, []],
        [admin.address, ethers.ZeroAddress, ethers.ZeroAddress, []],
        [admin.address, other.address, ethers.ZeroAddress, [other.address, ethers.ZeroAddress]],
      ]) {
        const impl = await Impl.deploy();
        await expect(Proxy.deploy(await impl.getAddress(), Impl.interface.encodeFunctionData("initialize", args)))
          .to.be.revertedWithCustomError(impl, "ZeroAddress");
      }
    });
  });

  describe("SignerIntentBase.invalidateNonceWithSig (L85–88)", function () {
    const TYPES = { InvalidateNonce: [{ name: "signer", type: "address" }, { name: "nonce", type: "bytes32" }, { name: "validBefore", type: "uint256" }] };

    it("reverts IntentSignerZero, IntentExpired and InvalidIntentSignature; a valid cancellation burns the nonce", async function () {
      const fx = await loadFixture(fixture);
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const validBefore = (await time.latest()) + 3600;
      const sig = await fx.alice.signTypedData(fx.regDomain, TYPES, { signer: fx.alice.address, nonce, validBefore });

      await expect(fx.reg.connect(fx.relayer).invalidateNonceWithSig(ethers.ZeroAddress, nonce, validBefore, sig)).to.be.revertedWithCustomError(fx.reg, "IntentSignerZero");
      await expect(fx.reg.connect(fx.relayer).invalidateNonceWithSig(fx.bob.address, nonce, validBefore, sig)).to.be.revertedWithCustomError(fx.reg, "InvalidIntentSignature");
      const stale = (await time.latest()) - 1;
      const staleSig = await fx.alice.signTypedData(fx.regDomain, TYPES, { signer: fx.alice.address, nonce, validBefore: stale });
      await expect(fx.reg.connect(fx.relayer).invalidateNonceWithSig(fx.alice.address, nonce, stale, staleSig)).to.be.revertedWithCustomError(fx.reg, "IntentExpired");

      await expect(fx.reg.connect(fx.relayer).invalidateNonceWithSig(fx.alice.address, nonce, validBefore, sig))
        .to.emit(fx.reg, "NonceInvalidated").withArgs(fx.alice.address, nonce);
      await expect(fx.reg.connect(fx.relayer).invalidateNonceWithSig(fx.alice.address, nonce, validBefore, sig))
        .to.be.revertedWithCustomError(fx.reg, "IntentReplayed").withArgs(fx.alice.address, nonce);
    });
  });
});
