const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployWagerRegistry, deployMembershipManager } = require("../helpers/proxy");
const { expectMissingRole } = require("./helpers/roles");
const { setPackedVar } = require("./helpers/storage");

// Spec 112 FR-004 / Story 2 — every gasless twin on the WagerRegistryIntents facet carries
// `notFrozen(signer)`, and the money-in twins carry `whenNotPaused`. For each twin this suite:
//   1. puts the wager in a state where the call WOULD succeed,
//   2. freezes the signer (or pauses the registry) and asserts the SPECIFIC error,
//   3. asserts the self-submit sibling fails with the SAME error (twin parity, spec 035 FR-003),
//   4. lifts the freeze/pause and replays the IDENTICAL signed intent, proving the revert happened
//      before any effect (the nonce was not consumed) and that the guard was the only obstacle.
// Step 4 is what makes each test a mutation-proof: delete the modifier and step 2 succeeds instead.
//
// Exit paths (claim/refund/draw/revoke/cancel/decline/declareWinner) deliberately carry NO
// `whenNotPaused` — "a pause stops NEW entries, it never traps value". That is asserted too, on both
// the twin and its sibling, so a pause modifier added to an exit path fails here.
//
// Test titles carry a `[G:<id>]` tag so the recorded mutation check (spec 112 SC-002) can name the
// exact test each neutralised guard must turn red.

const Tier = { None: 0, Bronze: 1, Silver: 2, Gold: 3 };
const Resolution = { Either: 0, Creator: 1, Opponent: 2, ThirdParty: 3, Polymarket: 4 };
const WAGER_PARTICIPANT_ROLE = ethers.keccak256(ethers.toUtf8Bytes("WAGER_PARTICIPANT_ROLE"));
const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
const GUARDIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("GUARDIAN_ROLE"));
const ACCOUNT_MODERATOR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ACCOUNT_MODERATOR_ROLE"));
const usdc = (n) => ethers.parseUnits(String(n), 6);
const randomNonce = () => ethers.hexlify(ethers.randomBytes(32));

const EMPTY_AUTH = { value: 0, validAfter: 0, validBefore: 0, nonce: ethers.ZeroHash, v: 0, r: ethers.ZeroHash, s: ethers.ZeroHash };

const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const CREATE_WAGER_INTENT_TYPES = {
  CreateWagerIntent: [
    { name: "creator", type: "address" },
    { name: "opponent", type: "address" },
    { name: "arbitrator", type: "address" },
    { name: "token", type: "address" },
    { name: "creatorStake", type: "uint128" },
    { name: "opponentStake", type: "uint128" },
    { name: "acceptDeadline", type: "uint64" },
    { name: "resolveDeadline", type: "uint64" },
    { name: "resolutionType", type: "uint8" },
    { name: "conditionId", type: "bytes32" },
    { name: "creatorIsYes", type: "bool" },
    { name: "metadataHash", type: "bytes32" },
    { name: "metadataUri", type: "string" },
    { name: "termsVersionHash", type: "bytes32" },
    { name: "paymentNonce", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
  ],
};

const ACCEPT_WAGER_INTENT_TYPES = {
  AcceptWagerIntent: [
    { name: "wagerId", type: "uint256" },
    { name: "taker", type: "address" },
    { name: "paymentNonce", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
  ],
};

const simpleTypes = (structName, actorField) => ({
  [structName]: [
    { name: "wagerId", type: "uint256" },
    { name: actorField, type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
  ],
});

const DECLARE_WINNER_TYPES = {
  DeclareWinnerIntent: [
    { name: "wagerId", type: "uint256" },
    { name: "winner", type: "address" },
    { name: "actor", type: "address" },
    { name: "nonce", type: "bytes32" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
  ],
};

describe("WagerRegistryIntents — negative paths (spec 112 FR-004)", function () {
  async function deployFixture() {
    const [admin, alice, bob, charlie, relayer, treasury, feeSink, stranger] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDCPermit");
    const token = await MockUSDC.deploy();
    await token.waitForDeployment();

    const mgr = await deployMembershipManager([admin.address, await token.getAddress(), treasury.address]);
    const limits = { monthlyMarketCreation: 100, maxConcurrentMarkets: 20 };
    await mgr.connect(admin).setTier(WAGER_PARTICIPANT_ROLE, Tier.Bronze, usdc(50), 30, limits, true);
    await mgr.connect(admin).setTier(WAGER_PARTICIPANT_ROLE, Tier.Silver, usdc(120), 30, limits, true);

    const reg = await deployWagerRegistry([admin.address, await mgr.getAddress(), ethers.ZeroAddress, [await token.getAddress()]]);
    await mgr.connect(admin).setAuthorizedCaller(await reg.getAddress(), true);

    for (const u of [alice, bob, charlie]) {
      await token.mint(u.address, usdc(10_000));
      await mgr.connect(admin).grantMembership(u.address, WAGER_PARTICIPANT_ROLE, Tier.Silver, 365);
    }

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const regDomain = { name: "FairWins WagerRegistry", version: "1", chainId, verifyingContract: await reg.getAddress() };
    const tokenDomain = { name: "USD Coin", version: "1", chainId, verifyingContract: await token.getAddress() };
    return { reg, mgr, token, admin, alice, bob, charlie, relayer, treasury, feeSink, stranger, regDomain, tokenDomain };
  }

  // ---------------------------------------------------------------- signing helpers

  async function signAuth(fx, signer, value, overrides = {}) {
    const now = await time.latest();
    const message = { from: signer.address, to: await fx.reg.getAddress(), value, validAfter: 0, validBefore: now + 86400 * 30, nonce: randomNonce(), ...overrides };
    const sig = ethers.Signature.from(await signer.signTypedData(fx.tokenDomain, RECEIVE_WITH_AUTHORIZATION_TYPES, message));
    return { value: message.value, validAfter: message.validAfter, validBefore: message.validBefore, nonce: message.nonce, v: sig.v, r: sig.r, s: sig.s };
  }

  async function createArgs(fx, overrides = {}) {
    const now = await time.latest();
    return {
      opponent: fx.bob.address,
      arbitrator: ethers.ZeroAddress,
      token: await fx.token.getAddress(),
      creatorStake: usdc(10),
      opponentStake: usdc(10),
      acceptDeadline: now + 3600,
      resolveDeadline: now + 86400,
      resolutionType: Resolution.Either,
      conditionId: ethers.ZeroHash,
      creatorIsYes: false,
      metadataHash: ethers.id("neg"),
      metadataUri: "ipfs://neg",
      termsVersionHash: ethers.ZeroHash,
      ...overrides,
    };
  }

  async function signCreate(fx, creator, argOverrides = {}) {
    const now = await time.latest();
    const args = await createArgs(fx, argOverrides);
    const stakeAuth = await signAuth(fx, creator, args.creatorStake);
    args.paymentNonce = stakeAuth.nonce;
    const intent = { nonce: randomNonce(), validAfter: 0, validBefore: now + 86400 * 30 };
    const sig = await creator.signTypedData(fx.regDomain, CREATE_WAGER_INTENT_TYPES, { creator: creator.address, ...args, ...intent });
    return { args, intent, sig, stakeAuth };
  }

  const submitCreate = (fx, signer, s, feeAuth = EMPTY_AUTH) =>
    fx.reg.connect(fx.relayer).createWagerWithAuthorization(s.args, signer.address, s.intent.nonce, s.intent.validAfter, s.intent.validBefore, s.sig, s.stakeAuth, feeAuth);

  async function signAccept(fx, taker, wagerId, value) {
    const now = await time.latest();
    const stakeAuth = await signAuth(fx, taker, value);
    const intent = { nonce: randomNonce(), validAfter: 0, validBefore: now + 86400 * 30 };
    const sig = await taker.signTypedData(fx.regDomain, ACCEPT_WAGER_INTENT_TYPES, { wagerId, taker: taker.address, paymentNonce: stakeAuth.nonce, ...intent });
    return { intent, sig, stakeAuth };
  }

  async function signSimple(fx, signer, structName, actorField, wagerId) {
    const now = await time.latest();
    const intent = { nonce: randomNonce(), validAfter: 0, validBefore: now + 86400 * 30 };
    const sig = await signer.signTypedData(fx.regDomain, simpleTypes(structName, actorField), { wagerId, [actorField]: signer.address, ...intent });
    return { ...intent, sig };
  }

  async function signDeclareWinner(fx, signer, wagerId, winner) {
    const now = await time.latest();
    const intent = { nonce: randomNonce(), validAfter: 0, validBefore: now + 86400 * 30 };
    const sig = await signer.signTypedData(fx.regDomain, DECLARE_WINNER_TYPES, { wagerId, winner, actor: signer.address, ...intent });
    return { ...intent, sig };
  }

  // ---------------------------------------------------------------- state builders (self-submit)

  function eventArg(fx, receipt, name, field) {
    for (const l of receipt.logs) {
      try {
        const p = fx.reg.interface.parseLog(l);
        if (p && p.name === name) return p.args[field];
      } catch { /* other contract's log */ }
    }
    throw new Error(`${name} not emitted`);
  }

  async function openWager(fx, { creator = fx.alice, resolutionType = Resolution.Either, acceptIn = 3600 } = {}) {
    const now = await time.latest();
    await fx.token.connect(creator).approve(await fx.reg.getAddress(), usdc(10));
    const rc = await (await fx.reg.connect(creator).createWager(
      fx.bob.address, ethers.ZeroAddress, await fx.token.getAddress(), usdc(10), usdc(10),
      now + acceptIn, now + 86400, resolutionType, ethers.ZeroHash, false, ethers.id("neg"), ""
    )).wait();
    return Number(eventArg(fx, rc, "WagerCreated", "wagerId"));
  }

  async function activeWager(fx, opts = {}) {
    const id = await openWager(fx, opts);
    await fx.token.connect(fx.bob).approve(await fx.reg.getAddress(), usdc(10));
    await fx.reg.connect(fx.bob).acceptWager(id);
    return id;
  }

  /** Resolved wager with bob as the winner (Creator resolution: alice declares). */
  async function resolvedForBob(fx) {
    const id = await activeWager(fx, { resolutionType: Resolution.Creator });
    await fx.reg.connect(fx.alice).declareWinner(id, fx.bob.address);
    return id;
  }

  /** Open challenge by alice; returns the id and a claim-code proof bound to `taker`. */
  async function openChallenge(fx, taker) {
    const claimKey = ethers.Wallet.createRandom();
    const now = await time.latest();
    await fx.token.connect(fx.alice).approve(await fx.reg.getAddress(), usdc(10));
    const rc = await (await fx.reg.connect(fx.alice).createOpenWager(
      claimKey.address, ethers.ZeroAddress, await fx.token.getAddress(), usdc(10),
      now + 3600, now + 86400, Resolution.Either, ethers.ZeroHash, false, ethers.id("open"), ""
    )).wait();
    const wagerId = Number(eventArg(fx, rc, "OpenWagerCreated", "wagerId"));
    const claimSig = await claimKey.signTypedData(fx.regDomain, { OpenAccept: [{ name: "wagerId", type: "uint256" }, { name: "taker", type: "address" }] }, { wagerId, taker: taker.address });
    return { wagerId, claimSig };
  }

  const freeze = (fx, who) => fx.reg.connect(fx.admin).freezeAccount(who.address, "spec 112");
  const unfreeze = (fx, who) => fx.reg.connect(fx.admin).unfreezeAccount(who.address);

  async function expectFrozen(fx, p, who) {
    await expect(p).to.be.revertedWithCustomError(fx.reg, "AccountFrozenError").withArgs(who.address);
  }
  async function expectPaused(fx, p) {
    await expect(p).to.be.revertedWithCustomError(fx.reg, "EnforcedPause");
  }

  // =================================================================================================
  // Money-in twins: notFrozen(signer) AND whenNotPaused
  // =================================================================================================

  describe("createWagerWithAuthorization", function () {
    it("[G:WRI.create.frozen] reverts AccountFrozenError for a frozen signer, like createWager/createWagerWithTerms; the same intent succeeds once unfrozen", async function () {
      const fx = await loadFixture(deployFixture);
      const s = await signCreate(fx, fx.alice);
      await freeze(fx, fx.alice);

      await expectFrozen(fx, submitCreate(fx, fx.alice, s), fx.alice);
      // Self-submit siblings: same guard, same error.
      const a = await createArgs(fx);
      await expectFrozen(fx, fx.reg.connect(fx.alice).createWager(a.opponent, a.arbitrator, a.token, a.creatorStake, a.opponentStake, a.acceptDeadline, a.resolveDeadline, a.resolutionType, a.conditionId, a.creatorIsYes, a.metadataHash, a.metadataUri), fx.alice);
      await expectFrozen(fx, fx.reg.connect(fx.alice).createWagerWithTerms(a.opponent, a.arbitrator, a.token, a.creatorStake, a.opponentStake, a.acceptDeadline, a.resolveDeadline, a.resolutionType, a.conditionId, a.creatorIsYes, a.metadataHash, a.metadataUri, ethers.id("terms")), fx.alice);
      expect(await fx.reg.authorizationState(fx.alice.address, s.intent.nonce)).to.equal(false);

      await unfreeze(fx, fx.alice);
      await expect(submitCreate(fx, fx.alice, s)).to.emit(fx.reg, "WagerCreated");
    });

    it("[G:WRI.create.paused] reverts EnforcedPause while paused, like createWager; the same intent succeeds after unpause", async function () {
      const fx = await loadFixture(deployFixture);
      const s = await signCreate(fx, fx.alice);
      await fx.reg.connect(fx.admin).pause();

      await expectPaused(fx, submitCreate(fx, fx.alice, s));
      const a = await createArgs(fx);
      await expectPaused(fx, fx.reg.connect(fx.alice).createWager(a.opponent, a.arbitrator, a.token, a.creatorStake, a.opponentStake, a.acceptDeadline, a.resolveDeadline, a.resolutionType, a.conditionId, a.creatorIsYes, a.metadataHash, a.metadataUri));

      await fx.reg.connect(fx.admin).unpause();
      await expect(submitCreate(fx, fx.alice, s)).to.emit(fx.reg, "WagerCreated");
    });

    it("[G:WRI.pullStake.viaAuth] the relayed leg pulls the stake via EIP-3009 with NO allowance; the self-submit sibling (allowance leg) cannot", async function () {
      // WagerRegistryIntents._pullStake line 74: `if (viaAuth)` routes to the stapled authorization.
      const fx = await loadFixture(deployFixture);
      expect(await fx.token.allowance(fx.alice.address, await fx.reg.getAddress())).to.equal(0);
      const before = await fx.token.balanceOf(fx.alice.address);
      await expect(submitCreate(fx, fx.alice, await signCreate(fx, fx.alice))).to.emit(fx.reg, "WagerCreated");
      expect(await fx.token.balanceOf(fx.alice.address)).to.equal(before - usdc(10));

      const a = await createArgs(fx);
      await expect(fx.reg.connect(fx.alice).createWager(a.opponent, a.arbitrator, a.token, a.creatorStake, a.opponentStake, a.acceptDeadline, a.resolveDeadline, a.resolutionType, a.conditionId, a.creatorIsYes, a.metadataHash, a.metadataUri))
        .to.be.revertedWithCustomError(fx.token, "ERC20InsufficientAllowance")
        .withArgs(await fx.reg.getAddress(), 0, usdc(10));
    });

    it("[G:SIB.feeRecipientUnset] reverts FeeRecipientUnset if fee netting is somehow enabled with no recipient (defence in depth)", async function () {
      // setFeeNetting refuses (true, address(0)), so this state is only reachable by corrupting storage —
      // which is what an upgrade that mis-migrates the fee fields would do. The guard must still hold.
      const fx = await loadFixture(deployFixture);
      await fx.reg.connect(fx.admin).setFeeNetting(true, fx.feeSink.address, usdc(1));
      await setPackedVar(await fx.reg.getAddress(), "contracts/wagers/WagerRegistry.sol:WagerRegistry", "_gasFeeRecipient", 0n);
      expect(await fx.reg.gasFeeRecipient()).to.equal(ethers.ZeroAddress);
      expect(await fx.reg.feeNettingEnabled()).to.equal(true);

      const s = await signCreate(fx, fx.alice);
      const feeAuth = await signAuth(fx, fx.alice, usdc(1));
      await expect(submitCreate(fx, fx.alice, s, feeAuth)).to.be.revertedWithCustomError(fx.reg, "FeeRecipientUnset");
    });
  });

  describe("acceptWagerWithAuthorization", function () {
    it("[G:WRI.accept.frozen] reverts AccountFrozenError for a frozen taker, like acceptWager; succeeds once unfrozen", async function () {
      const fx = await loadFixture(deployFixture);
      const id = await openWager(fx);
      const s = await signAccept(fx, fx.bob, id, usdc(10));
      await freeze(fx, fx.bob);

      const submit = () => fx.reg.connect(fx.relayer).acceptWagerWithAuthorization(id, fx.bob.address, s.intent.nonce, s.intent.validAfter, s.intent.validBefore, s.sig, s.stakeAuth, EMPTY_AUTH);
      await expectFrozen(fx, submit(), fx.bob);
      await expectFrozen(fx, fx.reg.connect(fx.bob).acceptWager(id), fx.bob);

      await unfreeze(fx, fx.bob);
      await expect(submit()).to.emit(fx.reg, "WagerAccepted").withArgs(id, fx.bob.address);
    });

    it("[G:WRI.accept.paused] reverts EnforcedPause while paused, like acceptWager; succeeds after unpause", async function () {
      const fx = await loadFixture(deployFixture);
      const id = await openWager(fx);
      const s = await signAccept(fx, fx.bob, id, usdc(10));
      await fx.reg.connect(fx.admin).pause();

      const submit = () => fx.reg.connect(fx.relayer).acceptWagerWithAuthorization(id, fx.bob.address, s.intent.nonce, s.intent.validAfter, s.intent.validBefore, s.sig, s.stakeAuth, EMPTY_AUTH);
      await expectPaused(fx, submit());
      await expectPaused(fx, fx.reg.connect(fx.bob).acceptWager(id));

      await fx.reg.connect(fx.admin).unpause();
      await expect(submit()).to.emit(fx.reg, "WagerAccepted").withArgs(id, fx.bob.address);
    });
  });

  describe("acceptOpenWagerWithAuthorization", function () {
    it("[G:WRI.acceptOpen.frozen] reverts AccountFrozenError for a frozen taker, like acceptOpenWager; succeeds once unfrozen", async function () {
      const fx = await loadFixture(deployFixture);
      const { wagerId, claimSig } = await openChallenge(fx, fx.bob);
      const s = await signAccept(fx, fx.bob, wagerId, usdc(10));
      await freeze(fx, fx.bob);

      const submit = () => fx.reg.connect(fx.relayer).acceptOpenWagerWithAuthorization(wagerId, fx.bob.address, claimSig, s.intent.nonce, s.intent.validAfter, s.intent.validBefore, s.sig, s.stakeAuth, EMPTY_AUTH);
      await expectFrozen(fx, submit(), fx.bob);
      await expectFrozen(fx, fx.reg.connect(fx.bob).acceptOpenWager(wagerId, claimSig), fx.bob);

      await unfreeze(fx, fx.bob);
      await expect(submit()).to.emit(fx.reg, "WagerAccepted").withArgs(wagerId, fx.bob.address);
    });

    it("[G:WRI.acceptOpen.paused] reverts EnforcedPause while paused, like acceptOpenWager; succeeds after unpause", async function () {
      const fx = await loadFixture(deployFixture);
      const { wagerId, claimSig } = await openChallenge(fx, fx.bob);
      const s = await signAccept(fx, fx.bob, wagerId, usdc(10));
      await fx.reg.connect(fx.admin).pause();

      const submit = () => fx.reg.connect(fx.relayer).acceptOpenWagerWithAuthorization(wagerId, fx.bob.address, claimSig, s.intent.nonce, s.intent.validAfter, s.intent.validBefore, s.sig, s.stakeAuth, EMPTY_AUTH);
      await expectPaused(fx, submit());
      await expectPaused(fx, fx.reg.connect(fx.bob).acceptOpenWager(wagerId, claimSig));

      await fx.reg.connect(fx.admin).unpause();
      await expect(submit()).to.emit(fx.reg, "WagerAccepted").withArgs(wagerId, fx.bob.address);
    });
  });

  // =================================================================================================
  // Exit / settlement twins: notFrozen(signer) only — a pause must NOT block them (never-trap rule)
  // =================================================================================================

  /**
   * Table of the seven no-stake twins. Each entry builds a state in which the action succeeds for
   * `actor`, and knows how to call the twin (signed by `actor`) and its self-submit sibling.
   */
  const EXIT_TWINS = [
    {
      id: "claimPayout",
      actor: (fx) => fx.bob,
      setup: (fx) => resolvedForBob(fx),
      twin: async (fx, id, who) => {
        const i = await signSimple(fx, who, "ClaimPayoutIntent", "claimant", id);
        return () => fx.reg.connect(fx.relayer).claimPayoutWithSig(id, who.address, i.nonce, i.validAfter, i.validBefore, i.sig);
      },
      sibling: (fx, id, who) => fx.reg.connect(who).claimPayout(id),
      event: "PayoutClaimed",
    },
    {
      id: "claimRefund",
      actor: (fx) => fx.alice,
      setup: async (fx) => {
        const id = await openWager(fx, { acceptIn: 600 });
        await time.increase(601);
        return id;
      },
      twin: async (fx, id, who) => {
        const i = await signSimple(fx, who, "ClaimRefundIntent", "actor", id);
        return () => fx.reg.connect(fx.relayer).claimRefundWithSig(id, who.address, i.nonce, i.validAfter, i.validBefore, i.sig);
      },
      sibling: (fx, id, who) => fx.reg.connect(who).claimRefund(id),
      event: "WagerRefunded",
    },
    {
      id: "declareDraw",
      actor: (fx) => fx.alice,
      setup: (fx) => activeWager(fx),
      twin: async (fx, id, who) => {
        const i = await signSimple(fx, who, "DeclareDrawIntent", "actor", id);
        return () => fx.reg.connect(fx.relayer).declareDrawWithSig(id, who.address, i.nonce, i.validAfter, i.validBefore, i.sig);
      },
      sibling: (fx, id, who) => fx.reg.connect(who).declareDraw(id),
      event: "DrawProposed",
    },
    {
      id: "revokeDraw",
      actor: (fx) => fx.alice,
      setup: async (fx) => {
        const id = await activeWager(fx);
        await fx.reg.connect(fx.alice).declareDraw(id);
        return id;
      },
      twin: async (fx, id, who) => {
        const i = await signSimple(fx, who, "RevokeDrawIntent", "actor", id);
        return () => fx.reg.connect(fx.relayer).revokeDrawWithSig(id, who.address, i.nonce, i.validAfter, i.validBefore, i.sig);
      },
      sibling: (fx, id, who) => fx.reg.connect(who).revokeDraw(id),
      event: "DrawRevoked",
    },
    {
      id: "cancelOpen",
      actor: (fx) => fx.alice,
      setup: (fx) => openWager(fx),
      twin: async (fx, id, who) => {
        const i = await signSimple(fx, who, "CancelOpenIntent", "actor", id);
        return () => fx.reg.connect(fx.relayer).cancelOpenWithSig(id, who.address, i.nonce, i.validAfter, i.validBefore, i.sig);
      },
      sibling: (fx, id, who) => fx.reg.connect(who).cancelOpen(id),
      event: "WagerCancelled",
    },
    {
      id: "declineWager",
      actor: (fx) => fx.bob,
      setup: (fx) => openWager(fx),
      twin: async (fx, id, who) => {
        const i = await signSimple(fx, who, "DeclineIntent", "actor", id);
        return () => fx.reg.connect(fx.relayer).declineWagerWithSig(id, who.address, i.nonce, i.validAfter, i.validBefore, i.sig);
      },
      sibling: (fx, id, who) => fx.reg.connect(who).declineWager(id),
      event: "WagerDeclined",
    },
    {
      id: "declareWinner",
      actor: (fx) => fx.alice,
      setup: (fx) => activeWager(fx, { resolutionType: Resolution.Creator }),
      twin: async (fx, id, who) => {
        const i = await signDeclareWinner(fx, who, id, fx.bob.address);
        return () => fx.reg.connect(fx.relayer).declareWinnerWithSig(id, fx.bob.address, who.address, i.nonce, i.validAfter, i.validBefore, i.sig);
      },
      sibling: (fx, id, who) => fx.reg.connect(who).declareWinner(id, fx.bob.address),
      event: "WagerResolved",
    },
  ];

  for (const t of EXIT_TWINS) {
    describe(`${t.id}WithSig`, function () {
      it(`[G:WRI.${t.id}.frozen] reverts AccountFrozenError for a frozen signer, like ${t.id}; the same intent succeeds once unfrozen`, async function () {
        const fx = await loadFixture(deployFixture);
        const who = t.actor(fx);
        const id = await t.setup(fx);
        const submit = await t.twin(fx, id, who);
        await freeze(fx, who);

        await expectFrozen(fx, submit(), who);
        await expectFrozen(fx, t.sibling(fx, id, who), who);

        await unfreeze(fx, who);
        await expect(submit()).to.emit(fx.reg, t.event);
      });

      it(`[G:WRI.${t.id}.notPausable] is NOT blocked by a pause — an exit path, like ${t.id} (never-trap rule)`, async function () {
        const fx = await loadFixture(deployFixture);
        const who = t.actor(fx);
        const viaTwin = await t.setup(fx);
        const viaSibling = await t.setup(fx);
        const submit = await t.twin(fx, viaTwin, who);
        await fx.reg.connect(fx.admin).pause();
        expect(await fx.reg.paused()).to.equal(true);

        await expect(submit()).to.emit(fx.reg, t.event);
        await expect(t.sibling(fx, viaSibling, who)).to.emit(fx.reg, t.event);
      });
    });
  }

  // =================================================================================================
  // Relocated cold path + admin surface served by the Intents facet
  // =================================================================================================

  describe("batchExpireOpen", function () {
    it("[G:WRI.batchExpire.paused] reverts EnforcedPause while paused; expires after unpause", async function () {
      const fx = await loadFixture(deployFixture);
      const id = await openWager(fx, { acceptIn: 600 });
      await time.increase(601);
      await fx.reg.connect(fx.admin).pause();
      await expectPaused(fx, fx.reg.batchExpireOpen([id]));
      await fx.reg.connect(fx.admin).unpause();
      await expect(fx.reg.batchExpireOpen([id])).to.emit(fx.reg, "WagerRefunded");
    });
  });

  describe("setFeeNetting", function () {
    it("[G:WRI.setFeeNetting.role] reverts AccessControlUnauthorizedAccount(caller, DEFAULT_ADMIN_ROLE) for a non-admin", async function () {
      const fx = await loadFixture(deployFixture);
      await expectMissingRole(fx.reg, fx.reg.connect(fx.stranger).setFeeNetting(true, fx.feeSink.address, 1), fx.stranger.address, DEFAULT_ADMIN_ROLE);
    });

    it("[G:WRI.setFeeNetting.zero] reverts ZeroAddress when enabling with a zero recipient", async function () {
      const fx = await loadFixture(deployFixture);
      await expect(fx.reg.connect(fx.admin).setFeeNetting(true, ethers.ZeroAddress, 1)).to.be.revertedWithCustomError(fx.reg, "ZeroAddress");
    });
  });

  // The pause/freeze switches the twins depend on — a twin's guard is only as good as who can flip it.
  describe("guard switches (main facet)", function () {
    it("[G:WR.pause.role] pause/unpause are GUARDIAN_ROLE-only", async function () {
      const fx = await loadFixture(deployFixture);
      await expectMissingRole(fx.reg, fx.reg.connect(fx.stranger).pause(), fx.stranger.address, GUARDIAN_ROLE);
      await fx.reg.connect(fx.admin).pause();
      await expectMissingRole(fx.reg, fx.reg.connect(fx.stranger).unpause(), fx.stranger.address, GUARDIAN_ROLE);
    });

    it("[G:WR.freeze.role] freezeAccount/unfreezeAccount are ACCOUNT_MODERATOR_ROLE-only and reject the zero address", async function () {
      const fx = await loadFixture(deployFixture);
      await expectMissingRole(fx.reg, fx.reg.connect(fx.stranger).freezeAccount(fx.alice.address, "x"), fx.stranger.address, ACCOUNT_MODERATOR_ROLE);
      await expectMissingRole(fx.reg, fx.reg.connect(fx.stranger).unfreezeAccount(fx.alice.address), fx.stranger.address, ACCOUNT_MODERATOR_ROLE);
      await expect(fx.reg.connect(fx.admin).freezeAccount(ethers.ZeroAddress, "x")).to.be.revertedWithCustomError(fx.reg, "ZeroAddress");
      await expect(fx.reg.connect(fx.admin).unfreezeAccount(ethers.ZeroAddress)).to.be.revertedWithCustomError(fx.reg, "ZeroAddress");
    });

    it("[G:WR.reinit] initialize cannot run twice; initializeOpenChallenges runs at most once", async function () {
      const fx = await loadFixture(deployFixture);
      await expect(fx.reg.initialize(fx.admin.address, await fx.mgr.getAddress(), ethers.ZeroAddress, []))
        .to.be.revertedWithCustomError(fx.reg, "InvalidInitialization");
      await fx.reg.initializeOpenChallenges(); // version 1 → 2, once
      await expect(fx.reg.initializeOpenChallenges()).to.be.revertedWithCustomError(fx.reg, "InvalidInitialization");
    });
  });
});
