const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time, takeSnapshot } = require('@nomicfoundation/hardhat-network-helpers');
const {
  usdc,
  STATE,
  REASON,
  deployFundingFactory,
  defaultParams,
  createPool,
  contribute,
  signVoteRefund,
  signClaimRefund,
  signReceiveAuth,
} = require('../helpers/fundingpool');
const { sameBlock, positions, minedRevert, at, balancesOf } = require('./race');

// FundingPool — ADVERSARIAL SEQUENCES (spec 112, User Story 5, FR-011).
//
// The WagerPool suite's sibling (same file shape, same rule: every `it()` names the ATTACKER, the VICTIM
// and the RACE). A funding pool's organizer may close and collect at ANY time by design, so the races
// worth stating are the ones where a contributor acts on state they read and the organizer (or a
// hostile token, or the clock) changes it before their tx lands. The contributor's action must revert —
// never land on state they did not see — and the never-stranded fallback (`pokeDeadline`) must hold.
//
// Cast (fixed across the file):
//   organizer — the pool organizer; the attacker in most races
//   alice     — an honest contributor; the usual victim
//   bob       — a second contributor
//   carol     — a third contributor / sybil
//   outsider  — never contributed; pokes deadlines, plays sybil
//   relayer   — submits …WithSig / EIP-3009 intents on a contributor's behalf
//
// Revert assertions are always the SPECIFIC custom error (FR-007: no bare `.reverted`).

const gwei = (n) => ethers.parseUnits(String(n), 'gwei');

describe('FundingPool — adversarial sequences (spec 112 / FR-011)', function () {
  let admin, organizer, alice, bob, carol, outsider, relayer;
  let factory, token;

  beforeEach(async function () {
    [admin, organizer, alice, bob, carol, outsider, relayer] = await ethers.getSigners();
    // Production posture: screening REQUIRED ⇒ the escrow token must be curated by the admin.
    const sanctions = await (await ethers.getContractFactory('MockPoolSanctions')).deploy();
    const membership = await (await ethers.getContractFactory('MockPoolMembership')).deploy();
    ({ factory } = await deployFundingFactory({
      admin: admin.address,
      screeningRequired: true,
      sanctionsGuard: await sanctions.getAddress(),
      membershipManager: await membership.getAddress(),
    }));
    token = await (await ethers.getContractFactory('MockUSDCPermit')).deploy();
    for (const s of [organizer, alice, bob, carol, outsider]) await token.mint(s.address, usdc(1000));
    await factory.connect(admin).setAllowedToken(await token.getAddress(), true);
  });

  async function newPool(tok = token, overrides = {}) {
    const params = await defaultParams(tok, overrides);
    const { pool } = await createPool(factory, organizer, params);
    return { pool, params };
  }
  const who = (pool) => async () => ({
    pool: await pool.getAddress(),
    organizer: organizer.address,
    alice: alice.address,
    bob: bob.address,
    carol: carol.address,
  });

  // ===========================================================================
  // 1. The organizer changes state between a contributor's read and action
  // ===========================================================================

  describe('organizer front-runs a contributor', function () {
    it('attacker=organizer, victim=alice, race: alice broadcasts contribute(50) on an Open pool; organizer’s close() lands first in the same block → alice’s contribute reverts WrongState, her 50 never leaves her wallet', async function () {
      const { pool } = await newPool();
      await contribute(pool, token, bob, usdc(20));
      await token.connect(alice).approve(await pool.getAddress(), usdc(50));
      const before = await balancesOf(token, await who(pool)());

      const [aliceTx, closeTx] = await sameBlock([
        { send: (o) => pool.connect(alice).contribute(usdc(50), o), tip: gwei(1) },
        { send: (o) => pool.connect(organizer).close(o), tip: gwei(50) },
      ]);
      const [pA, pC] = await positions([aliceTx, closeTx]);
      expect(pC.index).to.be.lessThan(pA.index);
      expect(pC.status).to.equal(1);
      expect((await minedRevert(pool, aliceTx)).name).to.equal('WrongState');

      const after = await balancesOf(token, await who(pool)());
      expect(after.alice).to.equal(before.alice); // alice lost nothing
      expect(after.organizer - before.organizer).to.equal(usdc(20)); // organizer got only what was there
      expect(after.pool).to.equal(0n);
      expect(await pool.contributed(alice.address)).to.equal(0n);
      expect(await pool.state()).to.equal(STATE.Closed);
    });

    it('attacker=organizer, victim=alice, race: alice’s pending contribute vs organizer’s cancel() (flip to Refunding) landing first → WrongState, alice keeps her funds, bob refunds exactly', async function () {
      const { pool } = await newPool();
      await contribute(pool, token, bob, usdc(20));
      await token.connect(alice).approve(await pool.getAddress(), usdc(50));
      const before = await balancesOf(token, await who(pool)());

      const [aliceTx] = await sameBlock([
        { send: (o) => pool.connect(alice).contribute(usdc(50), o), tip: gwei(1) },
        { send: (o) => pool.connect(organizer).cancel(o), tip: gwei(50) },
      ]);
      expect((await minedRevert(pool, aliceTx)).name).to.equal('WrongState');
      expect(await pool.state()).to.equal(STATE.Refunding);
      expect(await pool.refundReason()).to.equal(REASON.Organizer);
      expect(await token.balanceOf(alice.address)).to.equal(before.alice);
      await pool.connect(bob).claimRefund();
      expect(await token.balanceOf(bob.address)).to.equal(before.bob + usdc(20));
      expect(await token.balanceOf(await pool.getAddress())).to.equal(0n);
    });

    it('attacker=organizer, victim=alice (gasless), race: alice’s EIP-3009 contribution is in flight when the organizer closes → WrongState, and the authorization is NOT consumed at the token', async function () {
      const { pool } = await newPool();
      const auth = await signReceiveAuth(token, alice, await pool.getAddress(), usdc(30));
      await pool.connect(organizer).close();
      await expect(
        pool
          .connect(relayer)
          .contributeWithAuthorization(alice.address, usdc(30), auth.validAfter, auth.validBefore, auth.nonce, auth.v, auth.r, auth.s)
      ).to.be.revertedWithCustomError(pool, 'WrongState');
      expect(await token.authorizationState(alice.address, auth.nonce)).to.equal(false);
      expect(await token.balanceOf(alice.address)).to.equal(usdc(1000));
    });

    it('attacker=organizer, victims=alice+bob, race: the deciding refund vote is pending and the organizer’s close() lands first → voteRefund reverts WrongState and the organizer collects (BY DESIGN: close is allowed at any time — the vote is not a lock)', async function () {
      // Pinned design property (docs/developer-guide/funding-pools.md: "close() [organizer, any time]"):
      // a majority refund vote offers NO protection against an organizer who watches the mempool. If the
      // vote is ever meant to bind, this test must change.
      const { pool } = await newPool();
      await contribute(pool, token, alice, usdc(10));
      await contribute(pool, token, bob, usdc(10));
      await contribute(pool, token, carol, usdc(10));
      await pool.connect(alice).voteRefund(); // 1 of 2 needed
      const before = await balancesOf(token, await who(pool)());

      const [bobVote] = await sameBlock([
        { send: (o) => pool.connect(bob).voteRefund(o), tip: gwei(1) },
        { send: (o) => pool.connect(organizer).close(o), tip: gwei(50) },
      ]);
      expect((await minedRevert(pool, bobVote)).name).to.equal('WrongState');
      expect(await pool.state()).to.equal(STATE.Closed);
      expect((await balancesOf(token, await who(pool)())).organizer - before.organizer).to.equal(usdc(30));
    });

    it('attacker=organizer, victim=alice, race: majority vote lands first, organizer’s close() second → close reverts WrongState and every contributor refunds exactly', async function () {
      const { pool } = await newPool();
      await contribute(pool, token, alice, usdc(10));
      await contribute(pool, token, bob, usdc(15));
      await contribute(pool, token, carol, usdc(5));
      await pool.connect(alice).voteRefund();
      const before = await balancesOf(token, await who(pool)());

      const [, closeTx] = await sameBlock([
        { send: (o) => pool.connect(bob).voteRefund(o), tip: gwei(50) },
        { send: (o) => pool.connect(organizer).close(o), tip: gwei(1) },
      ]);
      expect((await minedRevert(pool, closeTx)).name).to.equal('WrongState');
      expect(await pool.refundReason()).to.equal(REASON.Majority);
      for (const s of [alice, bob, carol]) await pool.connect(s).claimRefund();
      const after = await balancesOf(token, await who(pool)());
      expect(after.alice - before.alice).to.equal(usdc(10));
      expect(after.bob - before.bob).to.equal(usdc(15));
      expect(after.carol - before.carol).to.equal(usdc(5));
      expect(after.organizer).to.equal(before.organizer);
      expect(after.pool).to.equal(0n);
    });
  });

  // ===========================================================================
  // 2. The majority-refund vote
  // ===========================================================================

  describe('majority-refund vote', function () {
    it('attacker=alice (double-counting), victim=organizer, race: alice votes, then contributes MORE → her vote is not re-counted, contributorCount does not grow, a second vote reverts AlreadyVoted', async function () {
      const { pool } = await newPool();
      await contribute(pool, token, alice, usdc(10));
      await contribute(pool, token, bob, usdc(10));
      await contribute(pool, token, carol, usdc(10));
      await pool.connect(alice).voteRefund();
      await contribute(pool, token, alice, usdc(40));
      expect(await pool.refundVotes()).to.equal(1n);
      expect(await pool.contributorCount()).to.equal(3n);
      expect(await pool.votedRefund(alice.address)).to.equal(true);
      await expect(pool.connect(alice).voteRefund()).to.be.revertedWithCustomError(pool, 'AlreadyVoted');
      expect(await pool.state()).to.equal(STATE.Open);
      // ...and her refund, when it comes, is exactly the SUM she put in — no more.
      await pool.connect(organizer).cancel();
      const b = await token.balanceOf(alice.address);
      await pool.connect(alice).claimRefund();
      expect(await token.balanceOf(alice.address)).to.equal(b + usdc(50));
    });

    it('attacker=alice (double-counting across rails), victim=organizer, race: alice votes directly AND via a relayed voteRefundWithSig (fresh nonce) → AlreadyVoted, tally stays 1', async function () {
      const { pool } = await newPool();
      await contribute(pool, token, alice, usdc(10));
      await contribute(pool, token, bob, usdc(10));
      await contribute(pool, token, carol, usdc(10));
      await pool.connect(alice).voteRefund();
      const s = await signVoteRefund(pool, alice);
      await expect(
        pool.connect(relayer).voteRefundWithSig(alice.address, s.nonce, s.validAfter, s.validBefore, s.sig)
      ).to.be.revertedWithCustomError(pool, 'AlreadyVoted');
      // and via the factory forwarder
      await expect(
        factory
          .connect(relayer)
          .voteRefundWithSigFor(await pool.getAddress(), alice.address, s.nonce, s.validAfter, s.validBefore, s.sig)
      ).to.be.revertedWithCustomError(pool, 'AlreadyVoted');
      expect(await pool.refundVotes()).to.equal(1n);
    });

    it('attacker=relayer, victim=organizer, race: a relayer replays alice’s signed vote → IntentReplayed', async function () {
      const { pool } = await newPool();
      await contribute(pool, token, alice, usdc(10));
      await contribute(pool, token, bob, usdc(10));
      await contribute(pool, token, carol, usdc(10));
      const s = await signVoteRefund(pool, alice);
      await pool.connect(relayer).voteRefundWithSig(alice.address, s.nonce, s.validAfter, s.validBefore, s.sig);
      await expect(
        pool.connect(relayer).voteRefundWithSig(alice.address, s.nonce, s.validAfter, s.validBefore, s.sig)
      )
        .to.be.revertedWithCustomError(pool, 'IntentReplayed')
        .withArgs(alice.address, s.nonce);
      expect(await pool.refundVotes()).to.equal(1n);
    });

    it('attacker=outsider, victim=contributors, race: a non-contributor tries to pad the refund tally → NotContributor', async function () {
      const { pool } = await newPool();
      await contribute(pool, token, alice, usdc(10));
      await expect(pool.connect(outsider).voteRefund()).to.be.revertedWithCustomError(pool, 'NotContributor');
      expect(await pool.refundVotes()).to.equal(0n);
    });

    it('attacker=organizer (sybil dilution), victims=alice+bob, race: after alice votes, the organizer adds fresh contributors so the majority bar rises past the votes in hand → pool stays Open (CURRENT BEHAVIOUR: majority by COUNT, re-evaluated per vote)', async function () {
      // Pinned: research R2 chose ⌊N/2⌋+1 by contributor COUNT with no minimum contribution, so dust
      // contributions from additional (membership-gated) addresses raise the bar. The backstop is
      // `settleDeadline` → pokeDeadline (see section 5).
      const { pool } = await newPool();
      await contribute(pool, token, alice, usdc(10));
      await contribute(pool, token, bob, usdc(10));
      await contribute(pool, token, carol, usdc(10));
      await pool.connect(alice).voteRefund(); // 1 of 2
      await contribute(pool, token, organizer, 1n); // dust sybils
      await contribute(pool, token, outsider, 1n);
      expect(await pool.refundVotesNeeded()).to.equal(3n);
      await pool.connect(bob).voteRefund(); // 2 of 3 — would have flipped at N=3
      expect(await pool.state()).to.equal(STATE.Open);
      await pool.connect(carol).voteRefund(); // 3 of 3
      expect(await pool.state()).to.equal(STATE.Refunding);
    });

    it('attacker=first contributor (griefer), victim=organizer, race: the very first contributor puts in 1 base unit and votes → a 1-of-1 "majority" flips the fresh pool to Refunding for good (CURRENT BEHAVIOUR, potential finding)', async function () {
      // ⌊1/2⌋+1 = 1: any member can terminate a brand-new funding pool for the cost of one base unit of
      // the token and two transactions. No funds are lost (refunds are exact) but the pool is dead —
      // Refunding is terminal. Pinned so a fix (minimum contributors / minimum stake) is visible.
      const { pool } = await newPool();
      await contribute(pool, token, carol, 1n);
      await pool.connect(carol).voteRefund();
      expect(await pool.state()).to.equal(STATE.Refunding);
      expect(await pool.refundReason()).to.equal(REASON.Majority);
      await token.connect(alice).approve(await pool.getAddress(), usdc(10));
      await expect(pool.connect(alice).contribute(usdc(10))).to.be.revertedWithCustomError(pool, 'WrongState');
      await expect(pool.connect(organizer).close()).to.be.revertedWithCustomError(pool, 'WrongState');
    });

    it('attacker=late contributor, victim=refunding contributors, race: contributing into a pool the majority just flipped → WrongState (no new money into a refunding pool)', async function () {
      const { pool } = await newPool();
      await contribute(pool, token, alice, usdc(10));
      await contribute(pool, token, bob, usdc(10));
      await token.connect(carol).approve(await pool.getAddress(), usdc(10));
      const [carolTx] = await sameBlock([
        { send: (o) => pool.connect(carol).contribute(usdc(10), o), tip: gwei(1) },
        { send: (o) => pool.connect(alice).voteRefund(o), tip: gwei(50) },
        { send: (o) => pool.connect(bob).voteRefund(o), tip: gwei(40) },
      ]);
      expect((await minedRevert(pool, carolTx)).name).to.equal('WrongState');
      expect(await pool.state()).to.equal(STATE.Refunding);
      expect(await pool.totalRaised()).to.equal(usdc(20));
    });
  });

  // ===========================================================================
  // 3. Hostile, re-entering ERC-20 (allow-listed by the admin)
  // ===========================================================================

  describe('hostile re-entering token', function () {
    let rt;

    beforeEach(async function () {
      rt = await (await ethers.getContractFactory('ReentrantToken')).deploy();
      for (const s of [organizer, alice, bob, carol]) await rt.mint(s.address, usdc(1000));
      await factory.connect(admin).setAllowedToken(await rt.getAddress(), true);
    });
    async function disarm() {
      await rt.arm(await rt.getAddress(), rt.interface.encodeFunctionData('decimals'));
    }

    it('attacker=token, victim=the pool, race: during alice’s contribute transferFrom the token re-enters contribute → ReentrancyGuardReentrantCall, nothing recorded, balances conserved', async function () {
      const { pool } = await newPool(rt);
      await contribute(pool, rt, bob, usdc(10));
      await rt.connect(alice).approve(await pool.getAddress(), usdc(20));
      const before = await balancesOf(rt, await who(pool)());
      await rt.arm(await pool.getAddress(), pool.interface.encodeFunctionData('contribute', [usdc(1)]));
      await expect(pool.connect(alice).contribute(usdc(20))).to.be.revertedWithCustomError(
        pool,
        'ReentrancyGuardReentrantCall'
      );
      expect(await balancesOf(rt, await who(pool)())).to.deep.equal(before);
      expect(await pool.contributed(alice.address)).to.equal(0n);
      expect(await pool.totalRaised()).to.equal(usdc(10));
      expect(await pool.contributorCount()).to.equal(1n);
    });

    it('attacker=token, victim=the pool, race: during contribute the token re-enters the UNGUARDED voteRefund → refused by the role check (NotContributor), balances conserved', async function () {
      const { pool } = await newPool(rt);
      await rt.connect(alice).approve(await pool.getAddress(), usdc(20));
      const before = await balancesOf(rt, await who(pool)());
      await rt.arm(await pool.getAddress(), pool.interface.encodeFunctionData('voteRefund'));
      await expect(pool.connect(alice).contribute(usdc(20))).to.be.revertedWithCustomError(pool, 'NotContributor');
      expect(await balancesOf(rt, await who(pool)())).to.deep.equal(before);
      expect(await pool.refundVotes()).to.equal(0n);
    });

    it('attacker=token, victims=contributors, race: during the organizer’s close() payout the token re-enters close → ReentrancyGuardReentrantCall, pot not paid twice, balances conserved', async function () {
      const { pool } = await newPool(rt);
      await contribute(pool, rt, alice, usdc(10));
      await contribute(pool, rt, bob, usdc(20));
      const before = await balancesOf(rt, await who(pool)());
      await rt.arm(await pool.getAddress(), pool.interface.encodeFunctionData('close'));
      await expect(pool.connect(organizer).close()).to.be.revertedWithCustomError(pool, 'ReentrancyGuardReentrantCall');
      expect(await balancesOf(rt, await who(pool)())).to.deep.equal(before);
      expect(await pool.state()).to.equal(STATE.Open);

      await disarm();
      await pool.connect(organizer).close();
      const after = await balancesOf(rt, await who(pool)());
      expect(after.organizer - before.organizer).to.equal(usdc(30));
      expect(after.pool).to.equal(0n);
    });

    it('attacker=token, victims=contributors, race: during close() the token re-enters claimRefund (cross-function) → ReentrancyGuardReentrantCall, balances conserved', async function () {
      const { pool } = await newPool(rt);
      await contribute(pool, rt, alice, usdc(10));
      const before = await balancesOf(rt, await who(pool)());
      await rt.arm(await pool.getAddress(), pool.interface.encodeFunctionData('claimRefund'));
      await expect(pool.connect(organizer).close()).to.be.revertedWithCustomError(pool, 'ReentrancyGuardReentrantCall');
      expect(await balancesOf(rt, await who(pool)())).to.deep.equal(before);
    });

    it('attacker=token, victims=other contributors, race: during alice’s claimRefund the token re-enters claimRefund to drain → ReentrancyGuardReentrantCall, balances conserved, then every refund is exact', async function () {
      const { pool } = await newPool(rt);
      await contribute(pool, rt, alice, usdc(10));
      await contribute(pool, rt, bob, usdc(20));
      await contribute(pool, rt, carol, usdc(30));
      await pool.connect(organizer).cancel();
      const before = await balancesOf(rt, await who(pool)());
      await rt.arm(await pool.getAddress(), pool.interface.encodeFunctionData('claimRefund'));
      await expect(pool.connect(alice).claimRefund()).to.be.revertedWithCustomError(
        pool,
        'ReentrancyGuardReentrantCall'
      );
      expect(await balancesOf(rt, await who(pool)())).to.deep.equal(before);
      expect(await pool.refunded(alice.address)).to.equal(false);
      expect(await pool.refundedCount()).to.equal(0n);

      await disarm();
      for (const s of [alice, bob, carol]) await pool.connect(s).claimRefund();
      const after = await balancesOf(rt, await who(pool)());
      expect(after.alice - before.alice).to.equal(usdc(10));
      expect(after.bob - before.bob).to.equal(usdc(20));
      expect(after.carol - before.carol).to.equal(usdc(30));
      expect(after.pool).to.equal(0n);
    });

    it('attacker=token, victims=other contributors, race: during a RELAYED claimRefundWithSig the token re-enters claimRefund → ReentrancyGuardReentrantCall, nonce not burned, balances conserved', async function () {
      const { pool } = await newPool(rt);
      await contribute(pool, rt, alice, usdc(10));
      await contribute(pool, rt, bob, usdc(20));
      await pool.connect(organizer).cancel();
      const before = await balancesOf(rt, await who(pool)());
      const s = await signClaimRefund(pool, alice);
      await rt.arm(await pool.getAddress(), pool.interface.encodeFunctionData('claimRefund'));
      await expect(
        pool.connect(relayer).claimRefundWithSig(alice.address, s.nonce, s.validAfter, s.validBefore, s.sig)
      ).to.be.revertedWithCustomError(pool, 'ReentrancyGuardReentrantCall');
      expect(await balancesOf(rt, await who(pool)())).to.deep.equal(before);
      expect(await pool.authorizationState(alice.address, s.nonce)).to.equal(false);
    });
  });

  // ===========================================================================
  // 4. Deadline boundaries
  // ===========================================================================
  //
  // The rule the contract implements (and these tests pin):
  //   contribute / contributeWithAuthorization  allowed iff  block.timestamp <  contributeDeadline (exclusive)
  //   pokeDeadline                              allowed iff  block.timestamp >= settleDeadline     (inclusive)
  //   close / cancel / voteRefund               NO deadline check — allowed while state == Open

  describe('deadline boundaries', function () {
    it('attacker=late contributor (alice), victim=the organizer’s closed books, race: contribute at contributeDeadline-1 / contributeDeadline / contributeDeadline+1 → succeeds / ContributionsClosed / ContributionsClosed', async function () {
      const { pool, params } = await newPool();
      await token.connect(alice).approve(await pool.getAddress(), usdc(10));
      const cD = Number(params.contributeDeadline);
      const snap = await takeSnapshot();

      await at(cD - 1, () => pool.connect(alice).contribute(usdc(10)));
      expect(await pool.contributed(alice.address)).to.equal(usdc(10));
      await snap.restore();

      await expect(at(cD, () => pool.connect(alice).contribute(usdc(10)))).to.be.revertedWithCustomError(
        pool,
        'ContributionsClosed'
      );
      expect(await pool.contributionOpen()).to.equal(false);
      await snap.restore();
      await expect(at(cD + 1, () => pool.connect(alice).contribute(usdc(10)))).to.be.revertedWithCustomError(
        pool,
        'ContributionsClosed'
      );
    });

    it('attacker=anyone poking early, victim=the organizer, race: pokeDeadline at settleDeadline-1 / settleDeadline → DeadlineNotPassed / Refunding', async function () {
      const { pool, params } = await newPool();
      await contribute(pool, token, alice, usdc(10));
      const sD = Number(params.settleDeadline);
      await expect(at(sD - 1, () => pool.connect(outsider).pokeDeadline())).to.be.revertedWithCustomError(
        pool,
        'DeadlineNotPassed'
      );
      expect(await pool.state()).to.equal(STATE.Open);
      await at(sD, () => pool.connect(outsider).pokeDeadline());
      expect(await pool.state()).to.equal(STATE.Refunding);
      expect(await pool.refundReason()).to.equal(REASON.Deadline);
    });

    it('attacker=organizer, victim=contributors, race: organizer close at settleDeadline-1 → collects (documented: "may close between creation and settleDeadline")', async function () {
      const { pool, params } = await newPool();
      await contribute(pool, token, alice, usdc(10));
      const b = await token.balanceOf(organizer.address);
      await at(Number(params.settleDeadline) - 1, () => pool.connect(organizer).close());
      expect(await token.balanceOf(organizer.address)).to.equal(b + usdc(10));
    });

    it('attacker=organizer, victims=alice+bob, race: AFTER settleDeadline the organizer’s close() out-bids the contributors’ pokeDeadline in the same block → close SUCCEEDS, poke reverts WrongState (CURRENT BEHAVIOUR — contradicts the documented settle window; potential finding)', async function () {
      // docs/developer-guide/funding-pools.md: "The organizer may close between creation and
      // `settleDeadline` ... After `settleDeadline`, anyone can start refunds". FundingPool._closeBy has
      // NO timestamp check, so past the deadline the refund path is not guaranteed — it is a race the
      // organizer can win by paying a higher tip. Pinned to the CURRENT behaviour so a fix (close
      // refused at block.timestamp >= settleDeadline) flips this test visibly.
      const { pool, params } = await newPool();
      await contribute(pool, token, alice, usdc(10));
      await contribute(pool, token, bob, usdc(20));
      await time.increaseTo(Number(params.settleDeadline) + 1);
      const before = await balancesOf(token, await who(pool)());

      const [pokeTx, closeTx] = await sameBlock([
        { send: (o) => pool.connect(alice).pokeDeadline(o), tip: gwei(1) },
        { send: (o) => pool.connect(organizer).close(o), tip: gwei(50) },
      ]);
      const [pP, pC] = await positions([pokeTx, closeTx]);
      expect(pC.index).to.be.lessThan(pP.index);
      expect(pC.status).to.equal(1);
      expect((await minedRevert(pool, pokeTx)).name).to.equal('WrongState');
      expect(await pool.state()).to.equal(STATE.Closed);
      expect((await balancesOf(token, await who(pool)())).organizer - before.organizer).to.equal(usdc(30));
    });

    it('attacker=organizer, victims=contributors, race: once anyone has poked at settleDeadline, the organizer’s close is refused → WrongState', async function () {
      const { pool, params } = await newPool();
      await contribute(pool, token, alice, usdc(10));
      await at(Number(params.settleDeadline), () => pool.connect(outsider).pokeDeadline());
      await expect(pool.connect(organizer).close()).to.be.revertedWithCustomError(pool, 'WrongState');
    });

    it('attacker=nobody (window shape), victim=contributors, race: between contributeDeadline and settleDeadline, contributions are refused but voteRefund still works', async function () {
      const { pool, params } = await newPool();
      await contribute(pool, token, alice, usdc(10));
      await contribute(pool, token, bob, usdc(10));
      await time.increaseTo(params.contributeDeadline);
      await token.connect(carol).approve(await pool.getAddress(), usdc(10));
      await expect(pool.connect(carol).contribute(usdc(10))).to.be.revertedWithCustomError(pool, 'ContributionsClosed');
      await pool.connect(alice).voteRefund();
      await pool.connect(bob).voteRefund();
      expect(await pool.state()).to.equal(STATE.Refunding);
    });
  });

  // ===========================================================================
  // 5. pokeDeadline — the never-stranded fallback
  // ===========================================================================

  describe('pokeDeadline (never stranded)', function () {
    it('attacker=organizer (absent forever), victims=alice+bob+carol, race: nobody acts until settleDeadline → a stranger pokes via the factory forwarder, every contributor pulls back exactly the SUM of their contributions, pool empties', async function () {
      const { pool, params } = await newPool();
      await contribute(pool, token, alice, usdc(10));
      await contribute(pool, token, bob, usdc(25));
      await contribute(pool, token, alice, usdc(5)); // repeat contributor
      await contribute(pool, token, carol, 3n); // dust
      const before = await balancesOf(token, await who(pool)());
      await time.increaseTo(params.settleDeadline);
      await factory.connect(outsider).pokeDeadlineFor(await pool.getAddress());
      expect(await pool.refundReason()).to.equal(REASON.Deadline);
      for (const s of [alice, bob, carol]) await pool.connect(s).claimRefund();
      const after = await balancesOf(token, await who(pool)());
      expect(after.alice - before.alice).to.equal(usdc(15));
      expect(after.bob - before.bob).to.equal(usdc(25));
      expect(after.carol - before.carol).to.equal(3n);
      expect(after.pool).to.equal(0n);
      expect(await pool.refundedCount()).to.equal(3n);
    });

    it('attacker=carol (never claims), victims=alice+bob, race: one contributor never pulls her refund → the others exit regardless; only carol’s own amount remains, still claimable by her', async function () {
      const { pool, params } = await newPool();
      await contribute(pool, token, alice, usdc(10));
      await contribute(pool, token, bob, usdc(20));
      await contribute(pool, token, carol, usdc(30));
      await time.increaseTo(params.settleDeadline);
      await pool.connect(outsider).pokeDeadline();
      await pool.connect(alice).claimRefund();
      await pool.connect(bob).claimRefund();
      expect(await token.balanceOf(await pool.getAddress())).to.equal(usdc(30));
      await time.increase(365 * 24 * 3600); // refunds never expire
      await pool.connect(carol).claimRefund();
      expect(await token.balanceOf(await pool.getAddress())).to.equal(0n);
    });

    it('attacker=alice (double refund), victims=other contributors, race: alice claims, then claims again directly and via a relayed sig → NothingToRefund each time', async function () {
      const { pool, params } = await newPool();
      await contribute(pool, token, alice, usdc(10));
      await contribute(pool, token, bob, usdc(10));
      await time.increaseTo(params.settleDeadline);
      await pool.pokeDeadline();
      await pool.connect(alice).claimRefund();
      await expect(pool.connect(alice).claimRefund()).to.be.revertedWithCustomError(pool, 'NothingToRefund');
      const s = await signClaimRefund(pool, alice);
      await expect(
        pool.connect(relayer).claimRefundWithSig(alice.address, s.nonce, s.validAfter, s.validBefore, s.sig)
      ).to.be.revertedWithCustomError(pool, 'NothingToRefund');
      await expect(pool.connect(outsider).claimRefund()).to.be.revertedWithCustomError(pool, 'NothingToRefund');
      expect(await token.balanceOf(await pool.getAddress())).to.equal(usdc(10)); // bob's, untouched
    });

    it('attacker=anyone, victim=a closed pool’s organizer, race: poking a Closed or already-Refunding pool → WrongState (the fallback cannot reopen a settled pool)', async function () {
      const { pool: closed, params } = await newPool();
      await contribute(closed, token, alice, usdc(10));
      await closed.connect(organizer).close();
      const { pool: cancelled } = await newPool();
      await contribute(cancelled, token, alice, usdc(10));
      await cancelled.connect(organizer).cancel();
      await time.increaseTo(params.settleDeadline);
      await expect(closed.pokeDeadline()).to.be.revertedWithCustomError(closed, 'WrongState');
      await expect(cancelled.pokeDeadline()).to.be.revertedWithCustomError(cancelled, 'WrongState');
      expect(await cancelled.refundReason()).to.equal(REASON.Organizer);
    });
  });
});
