const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');
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
} = require('../helpers/wagerpool');

// Exhaustive relayer-twin (…WithSig) coverage for WagerPool (spec 035/036). For EACH of the six twins
// (approve / claim / proposeOutcome / closeJoining / cancel / refund) this asserts the four intent-guard
// failures (replay, expiry, not-yet-valid, wrong-signer), that the action's OWN authorization still binds
// to the RECOVERED signer (not the relayer), and that invalidateNonce pre-empts it. Plus: claim/refund
// funds route to the signer (never the relayer), approveWithSig is anti-retarget, and the replay nonce is
// namespaced per-signer (shared across action types, independent across signers).

describe('WagerPool — relayer twins (…WithSig)', function () {
  let admin, creator, m2, m3, outsider, relayer, factory, token;

  beforeEach(async function () {
    [admin, creator, m2, m3, outsider, relayer] = await ethers.getSigners();
    ({ factory } = await deployPoolFactory({ admin: admin.address }));
    token = await deployToken([creator, m2, m3, outsider, relayer]);
  });

  // --- builders ------------------------------------------------------------

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
    await joinAs(pool, m2); // auto-close, escrow 20
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
    await pool.connect(m2).approve(await pool.currentProposalId()); // locks
    return { pool, entries, pid };
  }
  async function cancelledPool() {
    const pool = await openWithMembers();
    await pool.connect(creator).cancel();
    return pool;
  }

  // --- per-twin config for the shared failure-mode matrix -------------------
  //   setup()          -> { pool, ctx } in a state where validSigner()'s intent WOULD succeed
  //   validSigner()    -> a signer authorized for the action
  //   badRoleSigner()  -> a signer that yields a VALID signature but fails the action's own auth check
  //   sign(pool,s,ctx,opts) / submit(pool,submitter,signerAddr,signed,ctx)

  const twins = [
    {
      name: 'approveWithSig',
      badRoleError: 'NotMember',
      setup: async () => {
        const { pool, pid } = await proposedPool();
        return { pool, ctx: { pid } };
      },
      validSigner: () => m2,
      badRoleSigner: () => outsider,
      sign: (pool, signer, ctx, opts) => signApprove(pool, signer, ctx.pid, opts),
      submit: (pool, submitter, signerAddr, s, ctx) =>
        pool.connect(submitter).approveWithSig(ctx.pid, signerAddr, s.nonce, s.validAfter, s.validBefore, s.sig),
    },
    {
      name: 'claimWithSig',
      badRoleError: 'NotWinner',
      setup: async () => {
        const { pool, entries } = await resolvedPool();
        return { pool, ctx: { entries, index: 0, recipient: outsider.address } };
      },
      validSigner: () => creator,
      badRoleSigner: () => m2,
      sign: (pool, signer, ctx, opts) => signClaim(pool, signer, ctx.index, ctx.recipient, opts),
      submit: (pool, submitter, signerAddr, s, ctx) =>
        pool
          .connect(submitter)
          .claimWithSig(ctx.entries, ctx.index, ctx.recipient, signerAddr, s.nonce, s.validAfter, s.validBefore, s.sig),
    },
    {
      name: 'proposeOutcomeWithSig',
      badRoleError: 'NotCreator',
      setup: async () => {
        const pool = await closedPool();
        const entries = evenSplit();
        return { pool, ctx: { entries, pid: matrixHash(entries) } };
      },
      validSigner: () => creator,
      badRoleSigner: () => m2,
      sign: (pool, signer, ctx, opts) => signPropose(pool, signer, ctx.pid, opts),
      submit: (pool, submitter, signerAddr, s, ctx) =>
        pool
          .connect(submitter)
          .proposeOutcomeWithSig(ctx.entries, signerAddr, s.nonce, s.validAfter, s.validBefore, s.sig),
    },
    {
      name: 'closeJoiningWithSig',
      badRoleError: 'NotCreator',
      setup: async () => ({ pool: await openWithMembers(), ctx: {} }),
      validSigner: () => creator,
      badRoleSigner: () => m2,
      sign: (pool, signer, ctx, opts) => signClose(pool, signer, opts),
      submit: (pool, submitter, signerAddr, s) =>
        pool.connect(submitter).closeJoiningWithSig(signerAddr, s.nonce, s.validAfter, s.validBefore, s.sig),
    },
    {
      name: 'cancelWithSig',
      badRoleError: 'NotCreator',
      setup: async () => ({ pool: await openWithMembers(), ctx: {} }),
      validSigner: () => creator,
      badRoleSigner: () => m2,
      sign: (pool, signer, ctx, opts) => signCancel(pool, signer, opts),
      submit: (pool, submitter, signerAddr, s) =>
        pool.connect(submitter).cancelWithSig(signerAddr, s.nonce, s.validAfter, s.validBefore, s.sig),
    },
    {
      name: 'refundWithSig',
      badRoleError: 'NothingToRefund',
      setup: async () => ({ pool: await cancelledPool(), ctx: {} }),
      validSigner: () => m2,
      badRoleSigner: () => outsider,
      sign: (pool, signer, ctx, opts) => signRefund(pool, signer, opts),
      submit: (pool, submitter, signerAddr, s) =>
        pool.connect(submitter).refundWithSig(signerAddr, s.nonce, s.validAfter, s.validBefore, s.sig),
    },
  ];

  for (const cfg of twins) {
    describe(cfg.name, function () {
      it('replay of a spent intent -> IntentReplayed', async function () {
        const { pool, ctx } = await cfg.setup();
        const signer = cfg.validSigner();
        const s = await cfg.sign(pool, signer, ctx);
        await cfg.submit(pool, relayer, signer.address, s, ctx); // first submit succeeds
        await expect(cfg.submit(pool, relayer, signer.address, s, ctx)).to.be.revertedWithCustomError(
          pool,
          'IntentReplayed'
        );
      });

      it('expired intent -> IntentExpired', async function () {
        const { pool, ctx } = await cfg.setup();
        const signer = cfg.validSigner();
        const now = await time.latest();
        const s = await cfg.sign(pool, signer, ctx, { validBefore: now - 1 });
        await expect(cfg.submit(pool, relayer, signer.address, s, ctx)).to.be.revertedWithCustomError(
          pool,
          'IntentExpired'
        );
      });

      it('not-yet-valid intent -> IntentNotYetValid', async function () {
        const { pool, ctx } = await cfg.setup();
        const signer = cfg.validSigner();
        const now = await time.latest();
        const s = await cfg.sign(pool, signer, ctx, { validAfter: now + 3600, validBefore: now + 7200 });
        await expect(cfg.submit(pool, relayer, signer.address, s, ctx)).to.be.revertedWithCustomError(
          pool,
          'IntentNotYetValid'
        );
      });

      it('wrong claimed signer -> InvalidIntentSignature', async function () {
        const { pool, ctx } = await cfg.setup();
        const signer = cfg.validSigner();
        const s = await cfg.sign(pool, signer, ctx); // signed by validSigner...
        // ...but submitted claiming `outsider` as the signer: recovery misses.
        await expect(cfg.submit(pool, relayer, outsider.address, s, ctx)).to.be.revertedWithCustomError(
          pool,
          'InvalidIntentSignature'
        );
      });

      it("the action's own authorization binds to the recovered signer (not the relayer)", async function () {
        const { pool, ctx } = await cfg.setup();
        const bad = cfg.badRoleSigner();
        const s = await cfg.sign(pool, bad, ctx); // a VALID signature by the wrong-role signer
        await expect(cfg.submit(pool, relayer, bad.address, s, ctx)).to.be.revertedWithCustomError(
          pool,
          cfg.badRoleError
        );
      });

      it('invalidateNonce pre-empts the twin', async function () {
        const { pool, ctx } = await cfg.setup();
        const signer = cfg.validSigner();
        const s = await cfg.sign(pool, signer, ctx);
        await pool.connect(signer).invalidateNonce(s.nonce);
        await expect(cfg.submit(pool, relayer, signer.address, s, ctx)).to.be.revertedWithCustomError(
          pool,
          'IntentReplayed'
        );
      });
    });
  }

  // --- twin-specific properties --------------------------------------------

  it('approveWithSig is bound to the current proposalId (anti-retarget -> OutcomeMismatch)', async function () {
    const pool = await closedPool();
    const entriesA = evenSplit();
    const entriesB = [
      { winner: creator.address, amount: usdc(20) },
      { winner: m2.address, amount: usdc(0) },
    ];
    const a = matrixHash(entriesA);
    await pool.connect(creator).proposeOutcome(entriesA);
    const signed = await signApprove(pool, m2, a); // m2 signs approval for proposal A
    await pool.connect(creator).proposeOutcome(entriesB); // creator revises to B
    await expect(
      pool.connect(relayer).approveWithSig(a, m2.address, signed.nonce, signed.validAfter, signed.validBefore, signed.sig)
    ).to.be.revertedWithCustomError(pool, 'OutcomeMismatch');
  });

  it('claimWithSig routes funds to the signer-chosen recipient, never the relayer', async function () {
    const { pool, entries } = await resolvedPool();
    const s = await signClaim(pool, creator, 0, outsider.address);
    const relayerBefore = await token.balanceOf(relayer.address);
    const recipBefore = await token.balanceOf(outsider.address);
    await pool
      .connect(relayer)
      .claimWithSig(entries, 0, outsider.address, creator.address, s.nonce, s.validAfter, s.validBefore, s.sig);
    expect(await token.balanceOf(outsider.address)).to.equal(recipBefore + usdc(15));
    expect(await token.balanceOf(relayer.address)).to.equal(relayerBefore); // relayer earns nothing
  });

  it('refundWithSig routes the buy-in to the signer, never the relayer', async function () {
    const pool = await cancelledPool();
    const s = await signRefund(pool, m2);
    const relayerBefore = await token.balanceOf(relayer.address);
    const memberBefore = await token.balanceOf(m2.address);
    await pool.connect(relayer).refundWithSig(m2.address, s.nonce, s.validAfter, s.validBefore, s.sig);
    expect(await token.balanceOf(m2.address)).to.equal(memberBefore + usdc(10));
    expect(await token.balanceOf(relayer.address)).to.equal(relayerBefore);
  });

  it('nonce independence: the same nonce value spends for two different signers', async function () {
    const pool = await closedPool();
    const entries = evenSplit();
    const pid = matrixHash(entries);
    const nonce = randNonce();

    const sp = await signPropose(pool, creator, pid, { nonce });
    await pool
      .connect(relayer)
      .proposeOutcomeWithSig(entries, creator.address, sp.nonce, sp.validAfter, sp.validBefore, sp.sig);
    const sa = await signApprove(pool, m2, pid, { nonce });
    await pool.connect(relayer).approveWithSig(pid, m2.address, sa.nonce, sa.validAfter, sa.validBefore, sa.sig);

    expect(await pool.authorizationState(creator.address, nonce)).to.equal(true);
    expect(await pool.authorizationState(m2.address, nonce)).to.equal(true);
  });

  it("a signer's nonce is shared across action types (reusing it on a second action -> IntentReplayed)", async function () {
    const pool = await openWithMembers();
    const nonce = randNonce();
    // creator closes joining with nonce N
    const sc = await signClose(pool, creator, { nonce });
    await pool.connect(relayer).closeJoiningWithSig(creator.address, sc.nonce, sc.validAfter, sc.validBefore, sc.sig);
    // ...then tries a DIFFERENT action reusing nonce N (pool is now JoiningClosed, so propose is otherwise valid)
    const entries = evenSplit();
    const pid = matrixHash(entries);
    const sp = await signPropose(pool, creator, pid, { nonce });
    await expect(
      pool
        .connect(relayer)
        .proposeOutcomeWithSig(entries, creator.address, sp.nonce, sp.validAfter, sp.validBefore, sp.sig)
    ).to.be.revertedWithCustomError(pool, 'IntentReplayed');
  });
});
