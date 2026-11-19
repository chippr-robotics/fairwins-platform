const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time, takeSnapshot } = require('@nomicfoundation/hardhat-network-helpers');
const {
  deployPoolFactory,
  defaultParams,
  createPool,
  matrixHash,
  usdc,
  signApprove,
  signRefund,
  signClaim,
} = require('../helpers/wagerpool');
const { sameBlock, positions, minedRevert, at, balancesOf } = require('./race');

// WagerPool — ADVERSARIAL SEQUENCES (spec 112, User Story 5, FR-011).
//
// Every `it()` here is an attack: it names the ATTACKER, the VICTIM and the RACE (the ordering the
// attacker imposes). The suite exists because #1667 shipped at 100% statement / 93% branch coverage:
// `approve()` approved whatever `currentProposalId` was at EXECUTION, so a creator could re-propose a
// self-dealing matrix (already carrying their own approval) ahead of a member's pending approve and
// lock it with the member's vote. Coverage cannot see orderings; these tests state them.
//
// Cast (fixed across the file):
//   creator  — the pool creator; the attacker in the resolution races
//   alice    — an honest member; the usual victim
//   bob      — a second honest member
//   carol    — a third member (used where the threshold needs more voters, or as the griefer)
//   relayer  — submits …WithSig intents on a member's behalf
//
// Revert assertions are always the SPECIFIC custom error (FR-007: no bare `.reverted`).

const STATE = { JoiningOpen: 0n, JoiningClosed: 1n, Resolved: 2n, Cancelled: 3n };
const ZERO32 = ethers.ZeroHash;
const gwei = (n) => ethers.parseUnits(String(n), 'gwei');

describe('WagerPool — adversarial sequences (spec 112 / FR-011)', function () {
  let admin, creator, alice, bob, carol, outsider, relayer;
  let factory, token;

  beforeEach(async function () {
    [admin, creator, alice, bob, carol, outsider, relayer] = await ethers.getSigners();

    // Production posture: screening REQUIRED, so the buy-in token must be curated by the admin
    // (FR-024). Every token used below is allow-listed explicitly, the way an operator would.
    const sanctions = await (await ethers.getContractFactory('MockPoolSanctions')).deploy();
    const membership = await (await ethers.getContractFactory('MockPoolMembership')).deploy();
    ({ factory } = await deployPoolFactory({
      admin: admin.address,
      screeningRequired: true,
      sanctionsGuard: await sanctions.getAddress(),
      membershipManager: await membership.getAddress(),
    }));

    const Token = await ethers.getContractFactory('MockUSDCPermit');
    token = await Token.deploy();
    for (const s of [creator, alice, bob, carol, outsider]) await token.mint(s.address, usdc(1000));
    await factory.connect(admin).setAllowedToken(await token.getAddress(), true);
  });

  // --- builders -------------------------------------------------------------

  async function makePool(tok, overrides = {}) {
    const params = await defaultParams(tok, { buyIn: usdc(10), ...overrides });
    const { pool } = await createPool(factory, creator, params);
    return { pool, params };
  }
  async function joinAs(tok, pool, signer) {
    await tok.connect(signer).approve(await pool.getAddress(), await pool.buyIn());
    return pool.connect(signer).join();
  }

  /**
   * A 3-member pool, auto-closed on the third join, escrow 30, threshold 60% ⇒ 2 approvals needed.
   * The creator's own approval is therefore exactly ONE vote short of locking anything — the #1667 shape.
   */
  async function threeMemberClosedPool(tok = token, overrides = {}) {
    const { pool, params } = await makePool(tok, { maxMembers: 3, thresholdBips: 6000, ...overrides });
    await joinAs(tok, pool, creator);
    await joinAs(tok, pool, alice);
    await joinAs(tok, pool, bob); // auto-close: frozenDenominator 3, escrow 30
    return { pool, params };
  }

  // Matrix A: self-dealing — the whole pot to the creator.
  const selfDealing = () => [{ winner: creator.address, amount: usdc(30) }];
  // Matrix B: fair — even split.
  const fair = () => [
    { winner: creator.address, amount: usdc(10) },
    { winner: alice.address, amount: usdc(10) },
    { winner: bob.address, amount: usdc(10) },
  ];

  async function expectUnlocked(pool) {
    expect(await pool.state()).to.equal(STATE.JoiningClosed);
    expect(await pool.lockedOutcome()).to.equal(ZERO32);
  }

  // ===========================================================================
  // 1. The #1667 regression — a member's approval can never land on a matrix they did not see
  // ===========================================================================

  describe('#1667: creator re-proposes a self-dealing matrix ahead of a pending approval', function () {
    it('attacker=creator, victim=alice, race: creator pre-approves A, proposes fair B, then re-proposes A before alice’s approve(B) lands → OutcomeMismatch, pool stays unlocked', async function () {
      const { pool } = await threeMemberClosedPool();
      const A = selfDealing();
      const B = fair();
      const idA = matrixHash(A);
      const idB = matrixHash(B);

      // Setup: the creator's own vote is already parked on A.
      await pool.connect(creator).proposeOutcome(A);
      await pool.connect(creator).approve(idA);
      expect(await pool.proposalApprovals(idA)).to.equal(1n);

      // Alice reads B from the chain.
      await pool.connect(creator).proposeOutcome(B);
      expect(await pool.currentProposalId()).to.equal(idB);

      // The race, as a block builder would order it: alice broadcasts approve(B); the creator, watching
      // the mempool, broadcasts proposeOutcome(A) with a higher tip, so it lands FIRST in the same block.
      const [aliceTx, creatorTx] = await sameBlock([
        { send: (o) => pool.connect(alice).approve(idB, o), tip: gwei(1) },
        { send: (o) => pool.connect(creator).proposeOutcome(A, o), tip: gwei(50) },
      ]);
      const [pAlice, pCreator] = await positions([aliceTx, creatorTx]);
      expect(pAlice.block).to.equal(pCreator.block);
      expect(pCreator.index).to.be.lessThan(pAlice.index); // front-run confirmed
      expect(pCreator.status).to.equal(1);
      expect((await minedRevert(pool, aliceTx)).name).to.equal('OutcomeMismatch');

      // Alice's vote went NOWHERE: not onto A (which would have locked it, 2 of 2), not onto B.
      await expectUnlocked(pool);
      expect(await pool.currentProposalId()).to.equal(idA);
      expect(await pool.proposalApprovals(idA)).to.equal(1n);
      expect(await pool.approvedBy(idA, alice.address)).to.equal(false);
      expect(await pool.proposalApprovals(idB)).to.equal(0n);
      expect(await pool.approvedBy(idB, alice.address)).to.equal(false);

      // And the creator cannot now cash A: it is not locked.
      await expect(pool.connect(creator).claim(A, 0, creator.address)).to.be.revertedWithCustomError(pool, 'WrongState');
    });

    it('attacker=creator, victim=alice, race: same re-proposal, landed sequentially (no mempool trickery) → OutcomeMismatch, pool stays unlocked', async function () {
      const { pool } = await threeMemberClosedPool();
      const idA = matrixHash(selfDealing());
      const idB = matrixHash(fair());
      await pool.connect(creator).proposeOutcome(selfDealing());
      await pool.connect(creator).approve(idA);
      await pool.connect(creator).proposeOutcome(fair());
      await pool.connect(creator).proposeOutcome(selfDealing()); // lands before alice's approve(B)

      await expect(pool.connect(alice).approve(idB)).to.be.revertedWithCustomError(pool, 'OutcomeMismatch');
      await expectUnlocked(pool);
      expect(await pool.proposalApprovals(idA)).to.equal(1n);
    });

    it('attacker=creator, victim=alice (gasless), race: alice signs approve(B), relayer submits, creator re-proposes A first → approveWithSig reverts OutcomeMismatch, pool stays unlocked', async function () {
      const { pool } = await threeMemberClosedPool();
      const A = selfDealing();
      const idA = matrixHash(A);
      const idB = matrixHash(fair());
      await pool.connect(creator).proposeOutcome(A);
      await pool.connect(creator).approve(idA);
      await pool.connect(creator).proposeOutcome(fair());

      const s = await signApprove(pool, alice, idB);
      const [relayTx, creatorTx] = await sameBlock([
        {
          send: (o) => pool.connect(relayer).approveWithSig(idB, alice.address, s.nonce, s.validAfter, s.validBefore, s.sig, o),
          tip: gwei(1),
        },
        { send: (o) => pool.connect(creator).proposeOutcome(A, o), tip: gwei(50) },
      ]);
      const [pRelay, pCreator] = await positions([relayTx, creatorTx]);
      expect(pCreator.index).to.be.lessThan(pRelay.index);
      expect((await minedRevert(pool, relayTx)).name).to.equal('OutcomeMismatch');

      await expectUnlocked(pool);
      expect(await pool.approvedBy(idA, alice.address)).to.equal(false);
      expect(await pool.proposalApprovals(idA)).to.equal(1n);
      // The failed submission did not burn alice's nonce (the whole tx reverted).
      expect(await pool.authorizationState(alice.address, s.nonce)).to.equal(false);
    });

    it('attacker=relayer, victim=alice, race: relayer replays alice’s approve(B) signature as approve(A) after the creator re-proposes A → InvalidIntentSignature', async function () {
      const { pool } = await threeMemberClosedPool();
      const idA = matrixHash(selfDealing());
      const idB = matrixHash(fair());
      await pool.connect(creator).proposeOutcome(selfDealing());
      await pool.connect(creator).approve(idA);
      await pool.connect(creator).proposeOutcome(fair());
      const s = await signApprove(pool, alice, idB);
      await pool.connect(creator).proposeOutcome(selfDealing());

      // Retargeting the signed id to the now-current A breaks the signature.
      await expect(
        pool.connect(relayer).approveWithSig(idA, alice.address, s.nonce, s.validAfter, s.validBefore, s.sig)
      ).to.be.revertedWithCustomError(pool, 'InvalidIntentSignature');
      await expectUnlocked(pool);
    });

    it('attacker=creator, victim=alice (gasless via the factory forwarder), race: re-proposal ahead of approveWithSigFor → OutcomeMismatch, pool stays unlocked', async function () {
      const { pool } = await threeMemberClosedPool();
      const idA = matrixHash(selfDealing());
      const idB = matrixHash(fair());
      await pool.connect(creator).proposeOutcome(selfDealing());
      await pool.connect(creator).approve(idA);
      await pool.connect(creator).proposeOutcome(fair());
      const s = await signApprove(pool, alice, idB);
      await pool.connect(creator).proposeOutcome(selfDealing());

      await expect(
        factory
          .connect(relayer)
          .approveWithSigFor(await pool.getAddress(), idB, alice.address, s.nonce, s.validAfter, s.validBefore, s.sig)
      ).to.be.revertedWithCustomError(pool, 'OutcomeMismatch');
      await expectUnlocked(pool);
    });
  });

  // ===========================================================================
  // 2. Proposal churn — approvals never migrate between ids
  // ===========================================================================

  describe('proposal churn', function () {
    it('attacker=creator, victims=alice+bob+carol, race: creator flips A→B→A→B→A between members’ approvals; every approval counts ONLY toward the id that member approved', async function () {
      // 4 members, threshold 100% ⇒ 4 approvals; nothing can lock mid-churn, so the counters are pure.
      const { pool } = await makePool(token, { maxMembers: 4, thresholdBips: 10000 });
      for (const s of [creator, alice, bob, carol]) await joinAs(token, pool, s);
      const A = [{ winner: creator.address, amount: usdc(40) }];
      const B = [
        { winner: alice.address, amount: usdc(20) },
        { winner: bob.address, amount: usdc(20) },
      ];
      const idA = matrixHash(A);
      const idB = matrixHash(B);

      await pool.connect(creator).proposeOutcome(A);
      await pool.connect(creator).approve(idA); // creator → A

      await pool.connect(creator).proposeOutcome(B);
      await pool.connect(alice).approve(idB); // alice → B
      // alice's B-vote does not exist on A, and her approve(A) is refused while B is current.
      await expect(pool.connect(alice).approve(idA)).to.be.revertedWithCustomError(pool, 'OutcomeMismatch');

      await pool.connect(creator).proposeOutcome(A);
      // bob intended B; he submits approve(B) after the flip — refused, does not land on A.
      await expect(pool.connect(bob).approve(idB)).to.be.revertedWithCustomError(pool, 'OutcomeMismatch');

      await pool.connect(creator).proposeOutcome(B);
      await pool.connect(bob).approve(idB); // bob → B

      await pool.connect(creator).proposeOutcome(A);
      // carol, who approves nothing, stays out of both tallies.

      // Ledger after five flips.
      expect(await pool.proposalApprovals(idA)).to.equal(1n);
      expect(await pool.proposalApprovals(idB)).to.equal(2n);
      expect(await pool.approvedBy(idA, creator.address)).to.equal(true);
      expect(await pool.approvedBy(idA, alice.address)).to.equal(false);
      expect(await pool.approvedBy(idA, bob.address)).to.equal(false);
      expect(await pool.approvedBy(idA, carol.address)).to.equal(false);
      expect(await pool.approvedBy(idB, creator.address)).to.equal(false);
      expect(await pool.approvedBy(idB, alice.address)).to.equal(true);
      expect(await pool.approvedBy(idB, bob.address)).to.equal(true);
      expect(await pool.approvedBy(idB, carol.address)).to.equal(false);
      await expectUnlocked(pool);
    });

    it('attacker=creator, victim=alice, race: alice approves B, creator churns to A and back; alice cannot be made to vote twice on B, and her B-vote never appears on A', async function () {
      const { pool } = await threeMemberClosedPool(token, { thresholdBips: 10000 }); // 3 of 3
      const idA = matrixHash(selfDealing());
      const idB = matrixHash(fair());
      await pool.connect(creator).proposeOutcome(fair());
      await pool.connect(alice).approve(idB);
      for (let i = 0; i < 3; i++) {
        await pool.connect(creator).proposeOutcome(selfDealing());
        await pool.connect(creator).proposeOutcome(fair());
      }
      await expect(pool.connect(alice).approve(idB)).to.be.revertedWithCustomError(pool, 'AlreadyApproved');
      expect(await pool.proposalApprovals(idB)).to.equal(1n);
      expect(await pool.proposalApprovals(idA)).to.equal(0n);
      await expectUnlocked(pool);
    });

    it('attacker=creator, victim=alice+bob, race: an outcome locks ONLY on the id whose OWN approvals reach the threshold — never by summing approvals across ids', async function () {
      const { pool } = await threeMemberClosedPool(); // 2 of 3
      const idA = matrixHash(selfDealing());
      const idB = matrixHash(fair());
      await pool.connect(creator).proposeOutcome(selfDealing());
      await pool.connect(creator).approve(idA); // A: 1
      await pool.connect(creator).proposeOutcome(fair());
      await pool.connect(alice).approve(idB); // B: 1 — total votes cast = 2 = threshold, yet nothing locks
      await expectUnlocked(pool);
      await pool.connect(bob).approve(idB); // B: 2 ⇒ locks B
      expect(await pool.state()).to.equal(STATE.Resolved);
      expect(await pool.lockedOutcome()).to.equal(idB);
      // The creator's A cannot be claimed against the B lock.
      await expect(pool.connect(creator).claim(selfDealing(), 0, creator.address)).to.be.revertedWithCustomError(
        pool,
        'OutcomeMismatch'
      );
    });
  });

  // ===========================================================================
  // 3. Re-proposing the identical matrix — CURRENT BEHAVIOUR, pinned on purpose
  // ===========================================================================

  describe('re-proposing an identical matrix (current behaviour, pinned)', function () {
    it('attacker=creator, victim=alice, race: alice approves A, creator flips to B and back to the byte-identical A → alice’s earlier A-approval STILL COUNTS (approvals are keyed by id and persist)', async function () {
      // CURRENT BEHAVIOUR (documented, not endorsed or rejected here): proposalId = keccak(entries), so
      // the "same" matrix re-proposed IS the same proposal and keeps every approval it ever received.
      // Revising "restarts approvals" only in the sense that the NEW id starts at zero. A member cannot
      // revoke an approval. If this ever changes (e.g. approvals scoped per proposal ROUND), this test
      // fails and the change is visible.
      const { pool } = await threeMemberClosedPool(); // 2 of 3
      const A = fair(); // here A is the matrix alice actually agreed to
      const idA = matrixHash(A);
      const B = [
        { winner: bob.address, amount: usdc(20) },
        { winner: creator.address, amount: usdc(10) },
      ];

      await pool.connect(creator).proposeOutcome(A);
      await pool.connect(alice).approve(idA);
      await pool.connect(creator).proposeOutcome(B);
      await pool.connect(creator).proposeOutcome(A); // identical bytes ⇒ identical id

      expect(await pool.currentProposalId()).to.equal(idA);
      expect(await pool.proposalApprovals(idA)).to.equal(1n);
      expect(await pool.approvedBy(idA, alice.address)).to.equal(true);
      await expect(pool.connect(alice).approve(idA)).to.be.revertedWithCustomError(pool, 'AlreadyApproved');

      // One more vote locks it — alice's persisted approval is the first of the two.
      await pool.connect(creator).approve(idA);
      expect(await pool.state()).to.equal(STATE.Resolved);
      expect(await pool.lockedOutcome()).to.equal(idA);
    });

    it('attacker=none (documents a consequence), victim=alice, race: alice’s stale approveWithSig(B) that failed OutcomeMismatch becomes VALID again the moment the creator re-proposes B (nonce was never burned)', async function () {
      // CURRENT BEHAVIOUR: the signature binds proposalId, not a proposal ROUND, and a reverted
      // submission does not consume the nonce. Alice consented to B, so this lands where she signed —
      // but the signature remains live until `validBefore` unless she calls `invalidateNonce`.
      const { pool } = await threeMemberClosedPool();
      const idB = matrixHash(fair());
      await pool.connect(creator).proposeOutcome(fair());
      const s = await signApprove(pool, alice, idB);
      await pool.connect(creator).proposeOutcome(selfDealing());
      await expect(
        pool.connect(relayer).approveWithSig(idB, alice.address, s.nonce, s.validAfter, s.validBefore, s.sig)
      ).to.be.revertedWithCustomError(pool, 'OutcomeMismatch');

      await pool.connect(creator).proposeOutcome(fair());
      await pool.connect(relayer).approveWithSig(idB, alice.address, s.nonce, s.validAfter, s.validBefore, s.sig);
      expect(await pool.approvedBy(idB, alice.address)).to.equal(true);
      expect(await pool.authorizationState(alice.address, s.nonce)).to.equal(true);
    });

    it('attacker=relayer, victim=alice, race: alice cancels her pending approval intent with invalidateNonce before the relayer lands it → IntentReplayed', async function () {
      const { pool } = await threeMemberClosedPool();
      const idB = matrixHash(fair());
      await pool.connect(creator).proposeOutcome(fair());
      const s = await signApprove(pool, alice, idB);
      await pool.connect(alice).invalidateNonce(s.nonce);
      await expect(
        pool.connect(relayer).approveWithSig(idB, alice.address, s.nonce, s.validAfter, s.validBefore, s.sig)
      )
        .to.be.revertedWithCustomError(pool, 'IntentReplayed')
        .withArgs(alice.address, s.nonce);
    });
  });

  // ===========================================================================
  // 4. Hostile, re-entering ERC-20 (allow-listed by the admin, as curation would have to)
  // ===========================================================================

  describe('hostile re-entering token', function () {
    let rt;

    beforeEach(async function () {
      const RT = await ethers.getContractFactory('ReentrantToken');
      rt = await RT.deploy();
      for (const s of [creator, alice, bob]) await rt.mint(s.address, usdc(1000));
      // The curated list is the only thing between a creator and an arbitrary token; model the case
      // where a hostile token got past curation.
      await factory.connect(admin).setAllowedToken(await rt.getAddress(), true);
    });

    async function disarm() {
      // ReentrantToken has no disarm; a reverted attack rolls its one-shot flag back to armed. Re-arm it
      // with a harmless self-call so the next honest transfer does not fire the attack.
      await rt.arm(await rt.getAddress(), rt.interface.encodeFunctionData('decimals'));
    }

    async function resolvedHostilePool() {
      const { pool } = await threeMemberClosedPool(rt);
      const M = fair();
      const id = matrixHash(M);
      await pool.connect(creator).proposeOutcome(M);
      await pool.connect(alice).approve(id);
      await pool.connect(bob).approve(id); // locks
      return { pool, M };
    }

    async function holders(pool) {
      return { pool: await pool.getAddress(), creator: creator.address, alice: alice.address, bob: bob.address };
    }

    it('attacker=token, victim=every winner, race: during alice’s claim transfer the token re-enters claim(same index) to double-pay → ReentrancyGuardReentrantCall, balances conserved', async function () {
      const { pool, M } = await resolvedHostilePool();
      const before = await balancesOf(rt, await holders(pool));
      await rt.arm(await pool.getAddress(), pool.interface.encodeFunctionData('claim', [M, 1, alice.address]));
      await expect(pool.connect(alice).claim(M, 1, alice.address)).to.be.revertedWithCustomError(
        pool,
        'ReentrancyGuardReentrantCall'
      );
      expect(await balancesOf(rt, await holders(pool))).to.deep.equal(before);
      expect(await pool.claimedIndex(1)).to.equal(false);

      // Nothing stranded: once the attack stops, every row pays exactly once and the pool empties.
      await disarm();
      for (const [i, s] of [[0, creator], [1, alice], [2, bob]]) await pool.connect(s).claim(M, i, s.address);
      expect(await rt.balanceOf(await pool.getAddress())).to.equal(0n);
      const after = await balancesOf(rt, await holders(pool));
      expect(after.alice - before.alice).to.equal(usdc(10));
      expect(after.creator - before.creator).to.equal(usdc(10));
      expect(after.bob - before.bob).to.equal(usdc(10));
    });

    it('attacker=token, victim=bob, race: during alice’s claim the token re-enters claim for ANOTHER row (bob’s index) → ReentrancyGuardReentrantCall, balances conserved', async function () {
      const { pool, M } = await resolvedHostilePool();
      const before = await balancesOf(rt, await holders(pool));
      await rt.arm(await pool.getAddress(), pool.interface.encodeFunctionData('claim', [M, 2, bob.address]));
      await expect(pool.connect(alice).claim(M, 1, alice.address)).to.be.revertedWithCustomError(
        pool,
        'ReentrancyGuardReentrantCall'
      );
      expect(await balancesOf(rt, await holders(pool))).to.deep.equal(before);
    });

    it('attacker=token, victim=every member, race: during claim the token re-enters refund (cross-function) → ReentrancyGuardReentrantCall, balances conserved', async function () {
      const { pool, M } = await resolvedHostilePool();
      const before = await balancesOf(rt, await holders(pool));
      await rt.arm(await pool.getAddress(), pool.interface.encodeFunctionData('refund'));
      await expect(pool.connect(creator).claim(M, 0, creator.address)).to.be.revertedWithCustomError(
        pool,
        'ReentrancyGuardReentrantCall'
      );
      expect(await balancesOf(rt, await holders(pool))).to.deep.equal(before);
    });

    it('attacker=token, victim=every winner, race: during a RELAYED claimWithSig the token re-enters claim → ReentrancyGuardReentrantCall, nonce not burned, balances conserved', async function () {
      const { pool, M } = await resolvedHostilePool();
      const before = await balancesOf(rt, await holders(pool));
      const s = await signClaim(pool, alice, 1, alice.address);
      await rt.arm(await pool.getAddress(), pool.interface.encodeFunctionData('claim', [M, 1, alice.address]));
      await expect(
        pool.connect(relayer).claimWithSig(M, 1, alice.address, alice.address, s.nonce, s.validAfter, s.validBefore, s.sig)
      ).to.be.revertedWithCustomError(pool, 'ReentrancyGuardReentrantCall');
      expect(await balancesOf(rt, await holders(pool))).to.deep.equal(before);
      expect(await pool.authorizationState(alice.address, s.nonce)).to.equal(false);
    });

    it('attacker=token, victim=every member, race: during alice’s refund (cancelled pool) the token re-enters refund to drain → ReentrancyGuardReentrantCall, balances conserved', async function () {
      const { pool } = await makePool(rt, { maxMembers: 5 });
      await joinAs(rt, pool, creator);
      await joinAs(rt, pool, alice);
      await joinAs(rt, pool, bob);
      await pool.connect(creator).cancel();
      const before = await balancesOf(rt, await holders(pool));
      await rt.arm(await pool.getAddress(), pool.interface.encodeFunctionData('refund'));
      await expect(pool.connect(alice).refund()).to.be.revertedWithCustomError(pool, 'ReentrancyGuardReentrantCall');
      expect(await balancesOf(rt, await holders(pool))).to.deep.equal(before);
      expect(await pool.refunded(alice.address)).to.equal(false);

      await disarm();
      for (const s of [creator, alice, bob]) await pool.connect(s).refund();
      expect(await rt.balanceOf(await pool.getAddress())).to.equal(0n);
      expect(await balancesOf(rt, await holders(pool))).to.deep.equal({
        ...before,
        pool: 0n,
        creator: before.creator + usdc(10),
        alice: before.alice + usdc(10),
        bob: before.bob + usdc(10),
      });
    });

    it('attacker=token, victim=every member, race: during a deadline refund (resolveDeadline elapsed) the token re-enters refund via refundWithSig → ReentrancyGuardReentrantCall, balances conserved', async function () {
      const { pool, params } = await threeMemberClosedPool(rt);
      await time.increaseTo(params.resolveDeadline);
      const before = await balancesOf(rt, await holders(pool));
      const s = await signRefund(pool, alice);
      await rt.arm(await pool.getAddress(), pool.interface.encodeFunctionData('refund'));
      await expect(
        pool.connect(relayer).refundWithSig(alice.address, s.nonce, s.validAfter, s.validBefore, s.sig)
      ).to.be.revertedWithCustomError(pool, 'ReentrancyGuardReentrantCall');
      expect(await balancesOf(rt, await holders(pool))).to.deep.equal(before);
    });

    it('attacker=token, victim=the pool, race: during join’s transferFrom the token re-enters join → ReentrancyGuardReentrantCall, no membership recorded, balances conserved', async function () {
      const { pool } = await makePool(rt, { maxMembers: 5 });
      await joinAs(rt, pool, creator);
      await rt.connect(alice).approve(await pool.getAddress(), usdc(10));
      const before = await balancesOf(rt, await holders(pool));
      await rt.arm(await pool.getAddress(), pool.interface.encodeFunctionData('join'));
      await expect(pool.connect(alice).join()).to.be.revertedWithCustomError(pool, 'ReentrancyGuardReentrantCall');
      expect(await balancesOf(rt, await holders(pool))).to.deep.equal(before);
      expect(await pool.hasJoined(alice.address)).to.equal(false);
      expect(await pool.memberCount()).to.equal(1n);
    });
  });

  // ===========================================================================
  // 5. Deadline boundaries — the rule on BOTH sides of every edge
  // ===========================================================================
  //
  // The rule the contract implements (and these tests pin):
  //   join / joinWithAuthorization   allowed iff  block.timestamp <  acceptDeadline   (exclusive)
  //   pokeDeadline                   allowed iff  block.timestamp >= acceptDeadline   (inclusive)
  //   propose / approve (+ twins)    allowed iff  block.timestamp <  resolveDeadline  (exclusive)
  //   refund (JoiningClosed)         allowed iff  block.timestamp >= resolveDeadline  (inclusive)
  // so at every edge exactly ONE side is live — no instant where both, or neither, apply.

  describe('deadline boundaries', function () {
    it('attacker=late joiner (carol), victim=members who saw the roster close, race: join at acceptDeadline-1 / acceptDeadline / acceptDeadline+1 → succeeds / JoinClosed / JoinClosed', async function () {
      const { pool, params } = await makePool(token, { maxMembers: 5 });
      await joinAs(token, pool, creator);
      await token.connect(carol).approve(await pool.getAddress(), usdc(10));
      const aD = Number(params.acceptDeadline);

      const snap = await takeSnapshot();
      await at(aD - 1, () => pool.connect(carol).join());
      expect(await pool.hasJoined(carol.address)).to.equal(true);
      await snap.restore();

      await expect(at(aD, () => pool.connect(carol).join())).to.be.revertedWithCustomError(pool, 'JoinClosed');
      await snap.restore();
      await expect(at(aD + 1, () => pool.connect(carol).join())).to.be.revertedWithCustomError(pool, 'JoinClosed');
      expect(await pool.hasJoined(carol.address)).to.equal(false);
    });

    it('attacker=anyone poking early, victim=a member about to join, race: pokeDeadline at acceptDeadline-1 / acceptDeadline → DeadlineNotPassed / closes', async function () {
      const { pool, params } = await makePool(token, { maxMembers: 5 });
      await joinAs(token, pool, creator);
      await joinAs(token, pool, alice);
      const aD = Number(params.acceptDeadline);
      await expect(at(aD - 1, () => pool.connect(outsider).pokeDeadline())).to.be.revertedWithCustomError(
        pool,
        'DeadlineNotPassed'
      );
      expect(await pool.state()).to.equal(STATE.JoiningOpen);
      await at(aD, () => pool.connect(outsider).pokeDeadline());
      expect(await pool.state()).to.equal(STATE.JoiningClosed);
      expect(await pool.frozenDenominator()).to.equal(2n);
    });

    it('attacker=creator, victim=members already entitled to a refund, race: propose / approve at resolveDeadline-1 / resolveDeadline → succeed / ResolutionWindowClosed', async function () {
      const { pool, params } = await threeMemberClosedPool();
      const rD = Number(params.resolveDeadline);
      const id = matrixHash(fair());
      const snap = await takeSnapshot();

      // -1: both resolution actions are still live.
      await at(rD - 2, () => pool.connect(creator).proposeOutcome(fair()));
      await at(rD - 1, () => pool.connect(alice).approve(id));
      expect(await pool.approvedBy(id, alice.address)).to.equal(true);
      await snap.restore();

      // exactly at the deadline: both refused.
      await expect(at(rD, () => pool.connect(creator).proposeOutcome(fair()))).to.be.revertedWithCustomError(
        pool,
        'ResolutionWindowClosed'
      );
      await snap.restore();
      await pool.connect(creator).proposeOutcome(fair());
      await expect(at(rD, () => pool.connect(alice).approve(id))).to.be.revertedWithCustomError(
        pool,
        'ResolutionWindowClosed'
      );
    });

    it('attacker=creator racing a lock past the deadline, victim=alice who already refunded, race: at resolveDeadline alice refunds, then a would-be locking approve lands → ResolutionWindowClosed (no refund-then-payout double spend)', async function () {
      const { pool, params } = await threeMemberClosedPool();
      const id = matrixHash(fair());
      await pool.connect(creator).proposeOutcome(fair());
      await pool.connect(creator).approve(id); // one short of locking
      await time.increaseTo(params.resolveDeadline);
      await pool.connect(alice).refund();
      await expect(pool.connect(bob).approve(id)).to.be.revertedWithCustomError(pool, 'ResolutionWindowClosed');
      await expectUnlocked(pool);
    });

    it('attacker=impatient member, victim=the resolution, race: refund at resolveDeadline-1 / resolveDeadline → WrongState / refunds', async function () {
      const { pool, params } = await threeMemberClosedPool();
      const rD = Number(params.resolveDeadline);
      await expect(at(rD - 1, () => pool.connect(alice).refund())).to.be.revertedWithCustomError(pool, 'WrongState');
      const b = await token.balanceOf(alice.address);
      await at(rD, () => pool.connect(alice).refund());
      expect(await token.balanceOf(alice.address)).to.equal(b + usdc(10));
    });

    it('attacker=nobody (liveness), victim=a winner who waits, race: a RESOLVED pool’s claims stay open long after resolveDeadline', async function () {
      const { pool, params } = await threeMemberClosedPool();
      const M = fair();
      await pool.connect(creator).proposeOutcome(M);
      await pool.connect(alice).approve(matrixHash(M));
      await pool.connect(bob).approve(matrixHash(M));
      await time.increaseTo(Number(params.resolveDeadline) + 365 * 24 * 3600);
      await pool.connect(bob).claim(M, 2, bob.address);
      // ...and a Resolved pool never becomes refundable.
      await expect(pool.connect(alice).refund()).to.be.revertedWithCustomError(pool, 'WrongState');
    });
  });

  // ===========================================================================
  // 6. Griefing — refusing to act can delay a pool, never strand it
  // ===========================================================================

  describe('griefing', function () {
    it('attacker=carol (refuses to approve), victims=creator+alice+bob, race: a unanimity pool where one member never votes → resolveDeadline flips it to refund, every member exits whole, pool empties', async function () {
      const { pool, params } = await makePool(token, { maxMembers: 4, thresholdBips: 10000 });
      for (const s of [creator, alice, bob, carol]) await joinAs(token, pool, s);
      const M = [
        { winner: alice.address, amount: usdc(20) },
        { winner: bob.address, amount: usdc(20) },
      ];
      const id = matrixHash(M);
      await pool.connect(creator).proposeOutcome(M);
      for (const s of [creator, alice, bob]) await pool.connect(s).approve(id);
      await expectUnlocked(pool); // 3 of 4 — carol's silence holds it open

      const before = await balancesOf(token, { creator: creator.address, alice: alice.address, bob: bob.address, carol: carol.address });
      await time.increaseTo(params.resolveDeadline);
      for (const s of [creator, alice, bob, carol]) await pool.connect(s).refund();
      expect(await token.balanceOf(await pool.getAddress())).to.equal(0n);
      const after = await balancesOf(token, { creator: creator.address, alice: alice.address, bob: bob.address, carol: carol.address });
      for (const k of Object.keys(before)) expect(after[k] - before[k]).to.equal(usdc(10));
    });

    it('attacker=carol (refuses to approve AND to refund), victims=everyone else, race: one member never calls refund → the others still exit; only carol’s own buy-in remains, still claimable by her', async function () {
      const { pool, params } = await makePool(token, { maxMembers: 4, thresholdBips: 10000 });
      for (const s of [creator, alice, bob, carol]) await joinAs(token, pool, s);
      await time.increaseTo(params.resolveDeadline);
      for (const s of [creator, alice, bob]) await pool.connect(s).refund();
      expect(await token.balanceOf(await pool.getAddress())).to.equal(usdc(10));
      await pool.connect(carol).refund();
      expect(await token.balanceOf(await pool.getAddress())).to.equal(0n);
    });

    it('attacker=creator (never proposes, never closes joining), victims=alice+bob, race: absent creator → anyone pokes after acceptDeadline, refunds open at resolveDeadline, nothing stranded', async function () {
      const { pool, params } = await makePool(token, { maxMembers: 5 });
      for (const s of [creator, alice, bob]) await joinAs(token, pool, s);
      // Nobody poked by the resolve deadline either: the pool is still JoiningOpen.
      await time.increaseTo(params.resolveDeadline);
      await expect(pool.connect(alice).refund()).to.be.revertedWithCustomError(pool, 'WrongState');
      await pool.connect(outsider).pokeDeadline(); // permissionless
      expect(await pool.state()).to.equal(STATE.JoiningClosed);
      for (const s of [alice, bob, creator]) await pool.connect(s).refund();
      expect(await token.balanceOf(await pool.getAddress())).to.equal(0n);
    });

    it('attacker=creator, victim=alice, race: creator proposes then keeps re-proposing to reset momentum until the deadline → the pool still ends in refund, nobody is stuck', async function () {
      const { pool, params } = await threeMemberClosedPool(); // 2 of 3
      const idB = matrixHash(fair());
      await pool.connect(creator).proposeOutcome(fair());
      await pool.connect(alice).approve(idB);
      await pool.connect(creator).proposeOutcome(selfDealing()); // bob's pending approve(B) will now fail
      await expect(pool.connect(bob).approve(idB)).to.be.revertedWithCustomError(pool, 'OutcomeMismatch');
      await time.increaseTo(params.resolveDeadline);
      await expect(pool.connect(creator).proposeOutcome(fair())).to.be.revertedWithCustomError(
        pool,
        'ResolutionWindowClosed'
      );
      for (const s of [creator, alice, bob]) await pool.connect(s).refund();
      expect(await token.balanceOf(await pool.getAddress())).to.equal(0n);
    });

    it('attacker=outsider, victims=members, race: a non-member tries to pad approvals or refund → NotMember / NothingToRefund', async function () {
      const { pool, params } = await threeMemberClosedPool();
      const id = matrixHash(fair());
      await pool.connect(creator).proposeOutcome(fair());
      await expect(pool.connect(outsider).approve(id)).to.be.revertedWithCustomError(pool, 'NotMember');
      await time.increaseTo(params.resolveDeadline);
      await expect(pool.connect(outsider).refund()).to.be.revertedWithCustomError(pool, 'NothingToRefund');
      await pool.connect(alice).refund();
      await expect(pool.connect(alice).refund()).to.be.revertedWithCustomError(pool, 'NothingToRefund');
    });
  });
});
