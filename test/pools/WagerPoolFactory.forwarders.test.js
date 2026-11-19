const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');
const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs');
const {
  deployPoolFactory,
  deployToken,
  defaultParams,
  createPool,
  matrixHash,
  usdc,
  randNonce,
  signApprove,
  signClaim,
  signPropose,
  signClose,
  signCancel,
  signRefund,
  signCreatePool,
  signReceiveAuth,
} = require('../helpers/wagerpool');

// Tier-2 gasless pools (spec 035/036): the WagerPoolFactory routes a clone's …WithSig / …WithAuthorization
// twin through the STABLE factory address so only the factory is whitelisted at the relayer engine
// (FR-025). Each forwarder enforces pool provenance ON-CHAIN (poolAddressToId != 0) then passes through to
// the clone, which independently verifies the member's EIP-712 signature against its own per-clone domain.
// The clone twins themselves are exhaustively covered by WagerPool.withsig.test.js; here we prove: (1) the
// provenance guard rejects non-pools, (2) each forwarder actually forwards + attributes to the SIGNER not
// the relayer, (3) clone-side guards still bubble up through the forwarder, and (4) the new factory-verified
// createPoolWithSig behaves like an intent (attribution, replay, expiry, wrong-signer, screening).

describe('WagerPoolFactory — relayer forwarders (Tier 2)', function () {
  let admin, creator, m2, m3, outsider, relayer, factory, token;

  beforeEach(async function () {
    [admin, creator, m2, m3, outsider, relayer] = await ethers.getSigners();
    ({ factory } = await deployPoolFactory({ admin: admin.address }));
    token = await deployToken([creator, m2, m3, outsider, relayer]);
  });

  // --- state builders ------------------------------------------------------
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
  async function openWithMembers() {
    const pool = await makePool({ maxMembers: 5 });
    await joinAs(pool, creator);
    await joinAs(pool, m2);
    return pool; // JoiningOpen, 2 members
  }
  async function closedPool() {
    const pool = await makePool({ maxMembers: 2, thresholdBips: 10000 });
    await joinAs(pool, creator);
    await joinAs(pool, m2); // auto-close on full, escrow 20
    return pool;
  }
  async function proposedPool() {
    const pool = await closedPool();
    const entries = evenSplit();
    const pid = matrixHash(entries);
    await pool.connect(creator).proposeOutcome(entries);
    return { pool, entries, pid };
  }
  async function resolvedPool() {
    const { pool, entries, pid } = await proposedPool();
    await pool.connect(creator).approve(await pool.currentProposalId());
    await pool.connect(m2).approve(await pool.currentProposalId()); // locks (100% threshold)
    return { pool, entries, pid };
  }

  const addr = (c) => c.getAddress();

  // =========================================================================
  // 1. On-chain provenance guard — every forwarder rejects a non-pool target
  // =========================================================================
  describe('provenance guard (UnknownPool)', function () {
    it('rejects a target this factory never created', async function () {
      const fake = outsider.address; // never registered → poolAddressToId == 0
      const n = randNonce();
      const now = await time.latest();
      const va = 0;
      const vb = now + 3600;
      const emptySig = '0x';

      await expect(factory.closeJoiningWithSigFor(fake, m2.address, n, va, vb, emptySig)).to.be.revertedWithCustomError(
        factory,
        'UnknownPool'
      );
      await expect(factory.cancelWithSigFor(fake, m2.address, n, va, vb, emptySig)).to.be.revertedWithCustomError(
        factory,
        'UnknownPool'
      );
      await expect(
        factory.proposeOutcomeWithSigFor(fake, evenSplit(), m2.address, n, va, vb, emptySig)
      ).to.be.revertedWithCustomError(factory, 'UnknownPool');
      await expect(
        factory.approveWithSigFor(fake, ethers.ZeroHash, m2.address, n, va, vb, emptySig)
      ).to.be.revertedWithCustomError(factory, 'UnknownPool');
      await expect(
        factory.claimWithSigFor(fake, evenSplit(), 0, outsider.address, m2.address, n, va, vb, emptySig)
      ).to.be.revertedWithCustomError(factory, 'UnknownPool');
      await expect(factory.refundWithSigFor(fake, m2.address, n, va, vb, emptySig)).to.be.revertedWithCustomError(
        factory,
        'UnknownPool'
      );
      await expect(
        factory.joinWithAuthorizationFor(fake, m2.address, usdc(10), va, vb, n, 27, ethers.ZeroHash, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(factory, 'UnknownPool');
      await expect(factory.pokeDeadlineFor(fake)).to.be.revertedWithCustomError(factory, 'UnknownPool');
      await expect(
        factory.invalidateNonceWithSigFor(fake, m2.address, n, vb, emptySig)
      ).to.be.revertedWithCustomError(factory, 'UnknownPool');
    });

    it('accepts a real pool (guard passes, clone-side verification runs)', async function () {
      const pool = await openWithMembers();
      // Bad signature at the clone → NOT UnknownPool (guard passed), but the clone rejects it.
      const s = await signClose(pool, outsider); // outsider is not creator; sig is valid but wrong role bubbles
      await expect(
        factory.connect(relayer).closeJoiningWithSigFor(await addr(pool), outsider.address, s.nonce, s.validAfter, s.validBefore, s.sig)
      ).to.be.revertedWithCustomError(pool, 'NotCreator');
    });
  });

  // =========================================================================
  // 2. Signer-attributed forwarders — relayer submits, signer is attributed
  // =========================================================================
  describe('signer-attributed forwarders (relayer submits, signer attributed)', function () {
    it('closeJoiningWithSigFor — creator signs, relayer closes via factory', async function () {
      const pool = await openWithMembers();
      const s = await signClose(pool, creator);
      await factory
        .connect(relayer)
        .closeJoiningWithSigFor(await addr(pool), creator.address, s.nonce, s.validAfter, s.validBefore, s.sig);
      expect(await pool.state()).to.equal(1); // JoiningClosed
    });

    it('cancelWithSigFor — creator signs, relayer cancels via factory', async function () {
      const pool = await openWithMembers();
      const s = await signCancel(pool, creator);
      await factory
        .connect(relayer)
        .cancelWithSigFor(await addr(pool), creator.address, s.nonce, s.validAfter, s.validBefore, s.sig);
      expect(await pool.state()).to.equal(3); // Cancelled
    });

    it('proposeOutcomeWithSigFor — creator signs matrix, relayer proposes via factory', async function () {
      const pool = await closedPool();
      const entries = evenSplit();
      const pid = matrixHash(entries);
      const s = await signPropose(pool, creator, pid);
      await expect(
        factory
          .connect(relayer)
          .proposeOutcomeWithSigFor(await addr(pool), entries, creator.address, s.nonce, s.validAfter, s.validBefore, s.sig)
      )
        .to.emit(pool, 'OutcomeProposed')
        .withArgs(pid, anyValue);
    });

    it('approveWithSigFor — member signs, relayer approves via factory (proposalId pinned)', async function () {
      const { pool, pid } = await proposedPool();
      const s = await signApprove(pool, m2, pid);
      await expect(
        factory
          .connect(relayer)
          .approveWithSigFor(await addr(pool), pid, m2.address, s.nonce, s.validAfter, s.validBefore, s.sig)
      )
        .to.emit(pool, 'Approved')
        .withArgs(pid, m2.address);
    });

    it('claimWithSigFor — winner signs, funds go to signer-chosen recipient, never the relayer', async function () {
      const { pool, entries } = await resolvedPool();
      const before = await token.balanceOf(outsider.address);
      const relBefore = await token.balanceOf(relayer.address);
      // creator is entries[0].winner (15 USDC), recipient = outsider
      const s = await signClaim(pool, creator, 0, outsider.address);
      await factory
        .connect(relayer)
        .claimWithSigFor(await addr(pool), entries, 0, outsider.address, creator.address, s.nonce, s.validAfter, s.validBefore, s.sig);
      expect(await token.balanceOf(outsider.address)).to.equal(before + usdc(15));
      expect(await token.balanceOf(relayer.address)).to.equal(relBefore); // relayer never receives funds
    });

    it('refundWithSigFor — member signs, buy-in returns to signer via factory', async function () {
      const pool = await openWithMembers();
      await pool.connect(creator).cancel(); // now refundable
      const before = await token.balanceOf(m2.address);
      const s = await signRefund(pool, m2);
      await factory
        .connect(relayer)
        .refundWithSigFor(await addr(pool), m2.address, s.nonce, s.validAfter, s.validBefore, s.sig);
      expect(await token.balanceOf(m2.address)).to.equal(before + usdc(10));
    });

    it('invalidateNonceWithSigFor — member cancels an unused nonce on the clone via factory', async function () {
      const pool = await openWithMembers();
      const nonce = randNonce();
      const now = await time.latest();
      const validBefore = now + 3600;
      // Sign an InvalidateNonce intent against the CLONE domain.
      const domain = {
        name: 'FairWins WagerPool',
        version: '1',
        chainId: Number((await ethers.provider.getNetwork()).chainId),
        verifyingContract: await addr(pool),
      };
      const types = {
        InvalidateNonce: [
          { name: 'signer', type: 'address' },
          { name: 'nonce', type: 'bytes32' },
          { name: 'validBefore', type: 'uint256' },
        ],
      };
      const sig = await m2.signTypedData(domain, types, { signer: m2.address, nonce, validBefore });
      expect(await pool.authorizationState(m2.address, nonce)).to.equal(false);
      await factory.connect(relayer).invalidateNonceWithSigFor(await addr(pool), m2.address, nonce, validBefore, sig);
      expect(await pool.authorizationState(m2.address, nonce)).to.equal(true);
    });
  });

  // =========================================================================
  // 3. Payment + keeper forwarders
  // =========================================================================
  describe('payment + keeper forwarders', function () {
    it('joinWithAuthorizationFor — member signs EIP-3009, relayer joins via factory, escrow funded', async function () {
      const pool = await makePool({ maxMembers: 5 });
      const buyIn = await pool.buyIn();
      const poolAddr = await addr(pool);
      const auth = await signReceiveAuth(token, m3, poolAddr, buyIn);
      const escrowBefore = await token.balanceOf(poolAddr);
      await factory
        .connect(relayer)
        .joinWithAuthorizationFor(poolAddr, m3.address, buyIn, auth.validAfter, auth.validBefore, auth.nonce, auth.v, auth.r, auth.s);
      expect(await token.balanceOf(poolAddr)).to.equal(escrowBefore + buyIn);
      expect(await pool.memberCount()).to.equal(1n);
    });

    it('pokeDeadlineFor — relayer closes joining after acceptDeadline via factory', async function () {
      const pool = await openWithMembers();
      const acceptDeadline = await pool.acceptDeadline();
      await time.increaseTo(acceptDeadline + 1n);
      await factory.connect(relayer).pokeDeadlineFor(await addr(pool));
      expect(await pool.state()).to.equal(1); // JoiningClosed
    });
  });

  // =========================================================================
  // 4. createPoolWithSig — factory-verified intent (attribution + guards)
  // =========================================================================
  describe('createPoolWithSig', function () {
    it('creates a pool attributed to the SIGNER, submitted by the relayer', async function () {
      const params = await defaultParams(token, { maxMembers: 3 });
      const s = await signCreatePool(factory, m2, params); // m2 is the intended creator
      const rc = await (
        await factory
          .connect(relayer)
          .createPoolWithSig(params, m2.address, s.nonce, s.validAfter, s.validBefore, s.sig)
      ).wait();
      const ev = rc.logs
        .map((l) => {
          try {
            return factory.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((e) => e && e.name === 'PoolCreated');
      expect(ev.args.creator).to.equal(m2.address); // attributed to signer, not relayer
      const pool = await ethers.getContractAt('WagerPool', ev.args.pool);
      expect(await pool.creator()).to.equal(m2.address);
      expect(await factory.poolAddressToId(ev.args.pool)).to.equal(ev.args.poolId);
    });

    it('rejects a replayed nonce (IntentReplayed)', async function () {
      const params = await defaultParams(token, { maxMembers: 3 });
      const s = await signCreatePool(factory, m2, params);
      await factory.connect(relayer).createPoolWithSig(params, m2.address, s.nonce, s.validAfter, s.validBefore, s.sig);
      // Re-sign an identical intent reusing the SAME nonce → replay.
      const s2 = await signCreatePool(factory, m2, params, { nonce: s.nonce });
      await expect(
        factory.connect(relayer).createPoolWithSig(params, m2.address, s2.nonce, s2.validAfter, s2.validBefore, s2.sig)
      ).to.be.revertedWithCustomError(factory, 'IntentReplayed');
    });

    it('rejects an expired intent (IntentExpired)', async function () {
      const params = await defaultParams(token, { maxMembers: 3 });
      const now = await time.latest();
      const s = await signCreatePool(factory, m2, params, { validBefore: now - 1, validAfter: 0 });
      await expect(
        factory.connect(relayer).createPoolWithSig(params, m2.address, s.nonce, s.validAfter, s.validBefore, s.sig)
      ).to.be.revertedWithCustomError(factory, 'IntentExpired');
    });

    it('rejects a not-yet-valid intent (IntentNotYetValid)', async function () {
      const params = await defaultParams(token, { maxMembers: 3 });
      const now = await time.latest();
      const s = await signCreatePool(factory, m2, params, { validAfter: now + 3600, validBefore: now + 7200 });
      await expect(
        factory.connect(relayer).createPoolWithSig(params, m2.address, s.nonce, s.validAfter, s.validBefore, s.sig)
      ).to.be.revertedWithCustomError(factory, 'IntentNotYetValid');
    });

    it('rejects a signature that does not recover the claimed signer (InvalidIntentSignature)', async function () {
      const params = await defaultParams(token, { maxMembers: 3 });
      const s = await signCreatePool(factory, m3, params); // signed by m3
      await expect(
        // ...but claims m2 as the signer
        factory.connect(relayer).createPoolWithSig(params, m2.address, s.nonce, s.validAfter, s.validBefore, s.sig)
      ).to.be.revertedWithCustomError(factory, 'InvalidIntentSignature');
    });

    it('rejects tampered params (signature no longer recovers signer)', async function () {
      const params = await defaultParams(token, { maxMembers: 3 });
      const s = await signCreatePool(factory, m2, params);
      const tampered = { ...params, buyIn: usdc(999) }; // relayer bumps the buy-in
      await expect(
        factory.connect(relayer).createPoolWithSig(tampered, m2.address, s.nonce, s.validAfter, s.validBefore, s.sig)
      ).to.be.revertedWithCustomError(factory, 'InvalidIntentSignature');
    });
  });

  // =========================================================================
  // 5. createPoolWithSig screens the SIGNER (compliance on the real wallet, FR-021)
  // =========================================================================
  describe('createPoolWithSig screening (FR-021)', function () {
    it('screens the signer (not the relayer) when screening is required', async function () {
      // Deploy a screening-required factory with a sanctions guard that blocks m2.
      const Guard = await ethers.getContractFactory('MockPoolSanctions');
      const guard = await Guard.deploy();
      await guard.waitForDeployment();
      const Membership = await ethers.getContractFactory('MockPoolMembership');
      const membership = await Membership.deploy();
      await membership.waitForDeployment(); // setAllowed defaults true

      const { factory: sfactory } = await deployPoolFactory({
        admin: admin.address,
        screeningRequired: true,
        sanctionsGuard: await guard.getAddress(),
        membershipManager: await membership.getAddress(),
      });
      await sfactory.connect(admin).setAllowedToken(await token.getAddress(), true);

      const params = await defaultParams(token, { maxMembers: 3 });

      // Block the SIGNER (m2). Even though the relayer is clean, the create must revert.
      await guard.setDenied(m2.address, true);
      const s = await signCreatePool(sfactory, m2, params);
      await expect(
        sfactory.connect(relayer).createPoolWithSig(params, m2.address, s.nonce, s.validAfter, s.validBefore, s.sig)
      ).to.be.revertedWithCustomError(guard, 'SanctionedAddress'); // sanctions guard blocks m2

      // Unblock m2 → same intent now succeeds (fresh nonce).
      await guard.setDenied(m2.address, false);
      const s2 = await signCreatePool(sfactory, m2, params);
      await expect(
        sfactory.connect(relayer).createPoolWithSig(params, m2.address, s2.nonce, s2.validAfter, s2.validBefore, s2.sig)
      ).to.emit(sfactory, 'PoolCreated');
    });
  });
});
