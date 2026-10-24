const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');
const { deployPoolFactory, deployToken, defaultParams, createPool, usdc, ZERO } = require('../helpers/wagerpool');

// Adversarial + invariant coverage for WagerPool (spec 034) beyond the happy-path suite in
// WagerPool.test.js: reentrancy on every value-moving path, the full illegal-state-transition matrix,
// the escrow-accounting invariant, deadline BOUNDARY behavior, EIP-3009 gasless-join edge cases, claim
// recipient handling, the three close paths' denominator freeze, and the threshold ceil / >=2-floor math.

describe('WagerPool — security & invariants', function () {
  let signers, admin, creator, m2, m3, outsider, relayer, factory, token;

  beforeEach(async function () {
    signers = await ethers.getSigners();
    [admin, creator, m2, m3, , , outsider, relayer] = signers;
    ({ factory } = await deployPoolFactory({ admin: admin.address }));
    token = await deployToken(signers, 100000); // mint to every signer for the multi-member threshold tests
  });

  // --- generic builders (default token) -----------------------------------

  async function makePool(overrides = {}) {
    const params = await defaultParams(token, { maxMembers: 2, thresholdBips: 10000, ...overrides });
    const { pool } = await createPool(factory, creator, params);
    return pool;
  }
  async function joinAs(pool, signer) {
    await token.connect(signer).approve(await pool.getAddress(), await pool.buyIn());
    return pool.connect(signer).join();
  }
  function evenSplit() {
    return [
      { winner: creator.address, amount: usdc(15) },
      { winner: m2.address, amount: usdc(5) },
    ];
  }
  async function openPool() {
    const pool = await makePool({ maxMembers: 5 });
    await joinAs(pool, creator);
    await joinAs(pool, m2);
    return pool; // JoiningOpen, 2 members
  }
  async function closedPool() {
    const pool = await makePool({ maxMembers: 2, thresholdBips: 10000 });
    await joinAs(pool, creator);
    await joinAs(pool, m2); // auto-close, escrow 20
    return pool;
  }
  async function resolvedPool() {
    const pool = await closedPool();
    const entries = evenSplit();
    await pool.connect(creator).proposeOutcome(entries);
    await pool.connect(creator).approve(await pool.currentProposalId());
    await pool.connect(m2).approve(await pool.currentProposalId()); // locks (threshold 100% of 2)
    return { pool, entries };
  }
  async function cancelledPool() {
    const pool = await openPool();
    await pool.connect(creator).cancel();
    return pool;
  }

  /** Sign an EIP-3009 ReceiveWithAuthorization for the MockUSDCPermit token. */
  async function signReceiveAuth(from, to, value, nonce, validAfter, validBefore) {
    const { chainId } = await ethers.provider.getNetwork();
    const domain = {
      name: 'USD Coin',
      version: '1',
      chainId: Number(chainId),
      verifyingContract: await token.getAddress(),
    };
    const types = {
      ReceiveWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    };
    const sig = await from.signTypedData(domain, types, { from: from.address, to, value, validAfter, validBefore, nonce });
    return ethers.Signature.from(sig);
  }

  // =========================================================================
  // Reentrancy safety on join / claim / refund (malicious ERC-20)
  // =========================================================================

  describe('reentrancy safety', function () {
    async function deployReentrant(to) {
      const RT = await ethers.getContractFactory('ReentrantToken');
      const rt = await RT.deploy();
      await rt.waitForDeployment();
      for (const s of to) await rt.mint(s.address, usdc(1000));
      return rt;
    }
    async function poolWith(rt, overrides = {}) {
      const params = await defaultParams(rt, { maxMembers: 2, thresholdBips: 10000, ...overrides });
      const { pool } = await createPool(factory, creator, params);
      return pool;
    }
    async function joinWith(rt, pool, signer) {
      await rt.connect(signer).approve(await pool.getAddress(), await pool.buyIn());
      return pool.connect(signer).join();
    }

    it('claim: a malicious token re-entering claim is stopped by the guard', async function () {
      const rt = await deployReentrant([creator, m2]);
      const pool = await poolWith(rt, { maxMembers: 2 });
      await joinWith(rt, pool, creator);
      await joinWith(rt, pool, m2); // auto-close, escrow 20
      const entries = [
        { winner: creator.address, amount: usdc(15) },
        { winner: m2.address, amount: usdc(5) },
      ];
      await pool.connect(creator).proposeOutcome(entries);
      await pool.connect(creator).approve(await pool.currentProposalId());
      await pool.connect(m2).approve(await pool.currentProposalId()); // resolved
      const data = pool.interface.encodeFunctionData('claim', [entries, 0, creator.address]);
      await rt.arm(await pool.getAddress(), data);
      await expect(pool.connect(creator).claim(entries, 0, creator.address)).to.be.revertedWithCustomError(
        pool,
        'ReentrancyGuardReentrantCall'
      );
    });

    it('refund: a malicious token re-entering refund is stopped by the guard', async function () {
      const rt = await deployReentrant([creator, m2]);
      const pool = await poolWith(rt, { maxMembers: 5 });
      await joinWith(rt, pool, creator);
      await joinWith(rt, pool, m2);
      await pool.connect(creator).cancel(); // Cancelled -> refundable
      const data = pool.interface.encodeFunctionData('refund', []);
      await rt.arm(await pool.getAddress(), data);
      await expect(pool.connect(creator).refund()).to.be.revertedWithCustomError(pool, 'ReentrancyGuardReentrantCall');
    });

    it('join: a malicious token re-entering join is stopped by the guard', async function () {
      const rt = await deployReentrant([creator, m2]);
      const pool = await poolWith(rt, { maxMembers: 5 });
      await joinWith(rt, pool, creator);
      const data = pool.interface.encodeFunctionData('join', []);
      await rt.arm(await pool.getAddress(), data);
      await rt.connect(m2).approve(await pool.getAddress(), await pool.buyIn());
      await expect(pool.connect(m2).join()).to.be.revertedWithCustomError(pool, 'ReentrancyGuardReentrantCall');
    });
  });

  // =========================================================================
  // Illegal state-transition matrix (every action reverts from every wrong state)
  // =========================================================================

  describe('illegal state transitions', function () {
    it('from JoiningOpen: propose/approve/claim/refund/poke are all rejected', async function () {
      const pool = await openPool();
      await expect(pool.connect(creator).proposeOutcome(evenSplit())).to.be.revertedWithCustomError(pool, 'WrongState');
      await expect(pool.connect(creator).approve(await pool.currentProposalId())).to.be.revertedWithCustomError(pool, 'WrongState');
      await expect(pool.connect(creator).claim(evenSplit(), 0, creator.address)).to.be.revertedWithCustomError(
        pool,
        'WrongState'
      );
      await expect(pool.connect(creator).refund()).to.be.revertedWithCustomError(pool, 'WrongState');
      await expect(pool.pokeDeadline()).to.be.revertedWithCustomError(pool, 'DeadlineNotPassed');
    });

    it('from JoiningClosed: join/close/cancel/poke/claim/refund(pre-deadline) are all rejected', async function () {
      const pool = await closedPool();
      await expect(joinAs(pool, m3)).to.be.revertedWithCustomError(pool, 'JoinClosed');
      await expect(pool.connect(creator).closeJoining()).to.be.revertedWithCustomError(pool, 'WrongState'); // double close
      await expect(pool.connect(creator).cancel()).to.be.revertedWithCustomError(pool, 'WrongState');
      await expect(pool.pokeDeadline()).to.be.revertedWithCustomError(pool, 'WrongState');
      await expect(pool.connect(creator).claim(evenSplit(), 0, creator.address)).to.be.revertedWithCustomError(
        pool,
        'WrongState'
      );
      await expect(pool.connect(creator).refund()).to.be.revertedWithCustomError(pool, 'WrongState');
    });

    it('from JoiningClosed with no proposal: approve reverts NoProposal (approve-before-propose)', async function () {
      const pool = await closedPool();
      await expect(pool.connect(creator).approve(await pool.currentProposalId())).to.be.revertedWithCustomError(pool, 'NoProposal');
    });

    it('from Resolved: join/close/cancel/poke/propose/approve/refund are all rejected', async function () {
      const { pool, entries } = await resolvedPool();
      await expect(joinAs(pool, m3)).to.be.revertedWithCustomError(pool, 'JoinClosed');
      await expect(pool.connect(creator).closeJoining()).to.be.revertedWithCustomError(pool, 'WrongState');
      await expect(pool.connect(creator).cancel()).to.be.revertedWithCustomError(pool, 'WrongState');
      await expect(pool.pokeDeadline()).to.be.revertedWithCustomError(pool, 'WrongState');
      await expect(pool.connect(creator).proposeOutcome(entries)).to.be.revertedWithCustomError(pool, 'WrongState');
      await expect(pool.connect(creator).approve(await pool.currentProposalId())).to.be.revertedWithCustomError(pool, 'WrongState');
      await expect(pool.connect(creator).refund()).to.be.revertedWithCustomError(pool, 'WrongState');
    });

    it('from Cancelled: join/close/cancel/poke/propose/approve/claim are all rejected', async function () {
      const pool = await cancelledPool();
      await expect(joinAs(pool, m3)).to.be.revertedWithCustomError(pool, 'JoinClosed');
      await expect(pool.connect(creator).closeJoining()).to.be.revertedWithCustomError(pool, 'WrongState');
      await expect(pool.connect(creator).cancel()).to.be.revertedWithCustomError(pool, 'WrongState'); // double cancel
      await expect(pool.pokeDeadline()).to.be.revertedWithCustomError(pool, 'WrongState');
      await expect(pool.connect(creator).proposeOutcome(evenSplit())).to.be.revertedWithCustomError(pool, 'WrongState');
      await expect(pool.connect(creator).approve(await pool.currentProposalId())).to.be.revertedWithCustomError(pool, 'WrongState');
      await expect(pool.connect(creator).claim(evenSplit(), 0, creator.address)).to.be.revertedWithCustomError(
        pool,
        'WrongState'
      );
    });
  });

  // =========================================================================
  // Escrow-accounting invariant
  // =========================================================================

  describe('escrow accounting invariant', function () {
    it('balance == unclaimed shares at every step; exactly 0 after all claims (duplicate winner + uneven split)', async function () {
      const pool = await makePool({ maxMembers: 3, thresholdBips: 10000 });
      const poolAddr = await pool.getAddress();
      await joinAs(pool, creator);
      expect(await token.balanceOf(poolAddr)).to.equal(usdc(10));
      await joinAs(pool, m2);
      expect(await token.balanceOf(poolAddr)).to.equal(usdc(20));
      await joinAs(pool, m3); // auto-close, escrow 30
      expect(await pool.escrowTotal()).to.equal(usdc(30));
      expect(await token.balanceOf(poolAddr)).to.equal(usdc(30));

      const entries = [
        { winner: creator.address, amount: usdc(7) },
        { winner: m2.address, amount: usdc(8) },
        { winner: creator.address, amount: usdc(15) }, // creator again -> per-index claiming
      ];
      await pool.connect(creator).proposeOutcome(entries);
      await pool.connect(creator).approve(await pool.currentProposalId());
      await pool.connect(m2).approve(await pool.currentProposalId());
      expect(await pool.state()).to.equal(1n); // 2 of 3 required
      await pool.connect(m3).approve(await pool.currentProposalId()); // resolves
      expect(await pool.state()).to.equal(2n);

      let claimed = 0n;
      await pool.connect(creator).claim(entries, 0, creator.address);
      claimed += usdc(7);
      expect(await token.balanceOf(poolAddr)).to.equal(usdc(30) - claimed);
      await pool.connect(m2).claim(entries, 1, m2.address);
      claimed += usdc(8);
      expect(await token.balanceOf(poolAddr)).to.equal(usdc(30) - claimed);
      await pool.connect(creator).claim(entries, 2, creator.address);
      claimed += usdc(15);
      expect(claimed).to.equal(usdc(30)); // fully allocated, nothing strandable
      expect(await token.balanceOf(poolAddr)).to.equal(0);
    });

    it('refund path: each refund releases exactly buyIn; balance hits 0', async function () {
      const pool = await makePool({ maxMembers: 3, thresholdBips: 10000 });
      const poolAddr = await pool.getAddress();
      await joinAs(pool, creator);
      await joinAs(pool, m2);
      await joinAs(pool, m3); // escrow 30
      await time.increaseTo((await pool.resolveDeadline()) + 1n);
      await pool.connect(creator).refund();
      expect(await token.balanceOf(poolAddr)).to.equal(usdc(20));
      await pool.connect(m2).refund();
      expect(await token.balanceOf(poolAddr)).to.equal(usdc(10));
      await pool.connect(m3).refund();
      expect(await token.balanceOf(poolAddr)).to.equal(0);
    });
  });

  // =========================================================================
  // Deadline boundary conditions (off-by-one at the exact timestamps)
  // =========================================================================

  describe('deadline boundaries', function () {
    it('join: succeeds at acceptDeadline-1, reverts at exactly acceptDeadline', async function () {
      const pool = await makePool({ maxMembers: 5 });
      const poolAddr = await pool.getAddress();
      const accept = Number(await pool.acceptDeadline());
      await token.connect(m2).approve(poolAddr, await pool.buyIn());
      await token.connect(m3).approve(poolAddr, await pool.buyIn());
      await time.setNextBlockTimestamp(accept - 1);
      await expect(pool.connect(m2).join()).to.emit(pool, 'Joined');
      await time.setNextBlockTimestamp(accept);
      await expect(pool.connect(m3).join()).to.be.revertedWithCustomError(pool, 'JoinClosed');
    });

    it('pokeDeadline: reverts at acceptDeadline-1, closes at exactly acceptDeadline', async function () {
      const pool = await makePool({ maxMembers: 5 });
      await joinAs(pool, creator);
      const accept = Number(await pool.acceptDeadline());
      await time.setNextBlockTimestamp(accept - 1);
      await expect(pool.pokeDeadline()).to.be.revertedWithCustomError(pool, 'DeadlineNotPassed');
      await time.setNextBlockTimestamp(accept);
      await expect(pool.pokeDeadline()).to.emit(pool, 'JoiningClosedEvent');
    });

    it('propose/approve: allowed at resolveDeadline-1, rejected at exactly resolveDeadline', async function () {
      const pool = await closedPool();
      const resolve = Number(await pool.resolveDeadline());
      const entries = evenSplit();
      await time.setNextBlockTimestamp(resolve - 1);
      await expect(pool.connect(creator).proposeOutcome(entries)).to.emit(pool, 'OutcomeProposed');
      await time.setNextBlockTimestamp(resolve);
      await expect(pool.connect(creator).approve(await pool.currentProposalId())).to.be.revertedWithCustomError(pool, 'ResolutionWindowClosed');
    });

    it('refund: reverts at resolveDeadline-1 (window not elapsed), succeeds at exactly resolveDeadline', async function () {
      const pool = await closedPool();
      const resolve = Number(await pool.resolveDeadline());
      await time.setNextBlockTimestamp(resolve - 1);
      await expect(pool.connect(creator).refund()).to.be.revertedWithCustomError(pool, 'WrongState');
      await time.setNextBlockTimestamp(resolve);
      await expect(pool.connect(creator).refund()).to.emit(pool, 'Refunded');
    });
  });

  // =========================================================================
  // Gasless join (EIP-3009) edge cases
  // =========================================================================

  describe('gasless join (EIP-3009) edge cases', function () {
    it('rejects a wrong-value authorization (BadValue)', async function () {
      const pool = await makePool({ maxMembers: 3 });
      const now = await time.latest();
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const { v, r, s } = await signReceiveAuth(m3, await pool.getAddress(), usdc(5), nonce, 0, now + 3600);
      await expect(
        pool.connect(relayer).joinWithAuthorization(m3.address, usdc(5), 0, now + 3600, nonce, v, r, s)
      ).to.be.revertedWithCustomError(pool, 'BadValue');
    });

    it('rejects an expired authorization (token AuthorizationExpired)', async function () {
      const pool = await makePool({ maxMembers: 3 });
      const buyIn = await pool.buyIn();
      const now = await time.latest();
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const { v, r, s } = await signReceiveAuth(m3, await pool.getAddress(), buyIn, nonce, 0, now - 1);
      await expect(
        pool.connect(relayer).joinWithAuthorization(m3.address, buyIn, 0, now - 1, nonce, v, r, s)
      ).to.be.revertedWithCustomError(token, 'AuthorizationExpired');
    });

    it('rejects a not-yet-valid authorization (token AuthorizationNotYetValid)', async function () {
      const pool = await makePool({ maxMembers: 3 });
      const buyIn = await pool.buyIn();
      const now = await time.latest();
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const { v, r, s } = await signReceiveAuth(m3, await pool.getAddress(), buyIn, nonce, now + 3600, now + 7200);
      await expect(
        pool.connect(relayer).joinWithAuthorization(m3.address, buyIn, now + 3600, now + 7200, nonce, v, r, s)
      ).to.be.revertedWithCustomError(token, 'AuthorizationNotYetValid');
    });

    it('a redirected `to` fails the signature check: funds can only be pulled to the pool', async function () {
      const pool = await makePool({ maxMembers: 3 });
      const buyIn = await pool.buyIn();
      const now = await time.latest();
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      // member signs authorizing `to = outsider`, but the pool hard-codes `to = address(this)`.
      const { v, r, s } = await signReceiveAuth(m3, outsider.address, buyIn, nonce, 0, now + 3600);
      await expect(
        pool.connect(relayer).joinWithAuthorization(m3.address, buyIn, 0, now + 3600, nonce, v, r, s)
      ).to.be.revertedWithCustomError(token, 'InvalidSignature');
    });

    it('a replayed gasless join is blocked by the pool guard (AlreadyJoined) before the token nonce check', async function () {
      const pool = await makePool({ maxMembers: 3 });
      const buyIn = await pool.buyIn();
      const now = await time.latest();
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const { v, r, s } = await signReceiveAuth(m3, await pool.getAddress(), buyIn, nonce, 0, now + 3600);
      await pool.connect(relayer).joinWithAuthorization(m3.address, buyIn, 0, now + 3600, nonce, v, r, s);
      await expect(
        pool.connect(relayer).joinWithAuthorization(m3.address, buyIn, 0, now + 3600, nonce, v, r, s)
      ).to.be.revertedWithCustomError(pool, 'AlreadyJoined');
    });

    it('rejects a gasless join into a full/closed pool (JoinClosed)', async function () {
      const pool = await makePool({ maxMembers: 2 });
      await joinAs(pool, creator);
      await joinAs(pool, m2); // auto-close
      const buyIn = await pool.buyIn();
      const now = await time.latest();
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const { v, r, s } = await signReceiveAuth(m3, await pool.getAddress(), buyIn, nonce, 0, now + 3600);
      await expect(
        pool.connect(relayer).joinWithAuthorization(m3.address, buyIn, 0, now + 3600, nonce, v, r, s)
      ).to.be.revertedWithCustomError(pool, 'JoinClosed');
    });

    it('rejects a gasless join after the accept deadline (JoinClosed)', async function () {
      const pool = await makePool({ maxMembers: 3 });
      await time.increaseTo((await pool.acceptDeadline()) + 1n);
      const buyIn = await pool.buyIn();
      const now = await time.latest();
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const { v, r, s } = await signReceiveAuth(m3, await pool.getAddress(), buyIn, nonce, 0, now + 3600);
      await expect(
        pool.connect(relayer).joinWithAuthorization(m3.address, buyIn, 0, now + 3600, nonce, v, r, s)
      ).to.be.revertedWithCustomError(pool, 'JoinClosed');
    });
  });

  // =========================================================================
  // Claim recipient handling
  // =========================================================================

  describe('claim recipients', function () {
    it('pays an arbitrary recipient; a zero recipient is blocked by the token and leaves the index claimable', async function () {
      const { pool, entries } = await resolvedPool();
      // The pool does NOT guard recipient==0; the ERC-20 rejects the transfer, and because claimedIndex is
      // set only just before the (reverting) transfer, the whole tx rolls back and the index stays claimable.
      await expect(pool.connect(creator).claim(entries, 0, ZERO)).to.be.revertedWithCustomError(
        token,
        'ERC20InvalidReceiver'
      );
      expect(await pool.claimedIndex(0)).to.equal(false);

      const before = await token.balanceOf(outsider.address);
      await pool.connect(creator).claim(entries, 0, outsider.address);
      expect(await token.balanceOf(outsider.address)).to.equal(before + usdc(15));
      expect(await pool.claimedIndex(0)).to.equal(true);
    });
  });

  // =========================================================================
  // Denominator freeze across the three close paths
  // =========================================================================

  describe('memberCount / frozenDenominator across close paths', function () {
    it('auto-close on full freezes denominator = maxMembers', async function () {
      const pool = await makePool({ maxMembers: 3, thresholdBips: 10000 });
      await joinAs(pool, creator);
      await joinAs(pool, m2);
      await joinAs(pool, m3);
      expect(await pool.state()).to.equal(1n);
      expect(await pool.memberCount()).to.equal(3);
      expect(await pool.frozenDenominator()).to.equal(3);
      expect(await pool.escrowTotal()).to.equal(usdc(30));
      expect(await pool.closedAt()).to.be.greaterThan(0n);
    });

    it('manual close freezes denominator = the current (partial) roster', async function () {
      const pool = await makePool({ maxMembers: 5, thresholdBips: 10000 });
      await joinAs(pool, creator);
      await joinAs(pool, m2);
      await joinAs(pool, m3);
      await pool.connect(creator).closeJoining();
      expect(await pool.frozenDenominator()).to.equal(3);
      expect(await pool.memberCount()).to.equal(3);
      expect(await pool.escrowTotal()).to.equal(usdc(30));
    });

    it('pokeDeadline close freezes the roster present at the deadline', async function () {
      const pool = await makePool({ maxMembers: 5, thresholdBips: 10000 });
      await joinAs(pool, creator);
      await joinAs(pool, m2);
      await time.increaseTo((await pool.acceptDeadline()) + 1n);
      await pool.pokeDeadline();
      expect(await pool.frozenDenominator()).to.equal(2);
      expect(await pool.escrowTotal()).to.equal(usdc(20));
    });
  });

  // =========================================================================
  // Threshold ceil math + the >= 2 floor for multi-member pools
  // =========================================================================

  describe('threshold ceil / >=2-floor math', function () {
    async function fillPool(members, bips) {
      const denom = members.length;
      const params = await defaultParams(token, { maxMembers: denom, thresholdBips: bips });
      const { pool } = await createPool(factory, members[0], params);
      for (const mem of members) {
        await token.connect(mem).approve(await pool.getAddress(), await pool.buyIn());
        await pool.connect(mem).join();
      }
      return pool; // auto-closed at denom
    }

    // [maxMembers/denominator, thresholdBips, expected required approvals to lock]
    const combos = [
      [2, 10000, 2], // ceil(2.0) = 2
      [2, 5000, 2], // ceil(1.0) = 1 -> floored to 2
      [2, 1, 2], // ceil(0.0002) = 1 -> floored to 2
      [3, 6000, 2], // ceil(1.8) = 2
      [3, 10000, 3], // ceil(3.0) = 3
      [5, 2000, 2], // ceil(1.0) = 1 -> floored to 2
      [5, 6000, 3], // ceil(3.0) = 3
      [4, 2500, 2], // ceil(1.0) = 1 -> floored to 2
      [7, 3333, 3], // ceil(2.3331) = 3
      [10, 10000, 10], // ceil(10.0) = 10
    ];

    for (const [denom, bips, req] of combos) {
      it(`denom=${denom}, bips=${bips} -> locks at exactly ${req} approval(s)`, async function () {
        const members = signers.slice(1, 1 + denom);
        const pool = await fillPool(members, bips);
        const entries = [{ winner: members[0].address, amount: usdc(10 * denom) }];
        await pool.connect(members[0]).proposeOutcome(entries);
        for (let i = 0; i < req; i++) {
          await pool.connect(members[i]).approve(await pool.currentProposalId());
          expect(await pool.state()).to.equal(i < req - 1 ? 1n : 2n);
        }
      });
    }
  });
});
