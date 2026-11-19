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
  signApprove,
  signClaim,
  signPropose,
  signClose,
  signCancel,
  signRefund,
} = require('../helpers/wagerpool');

// WagerPool (spec 034, address-based, Semaphore removed). Members join/approve/claim with their real
// wallet; the payout matrix keys on the winner's public address. Timing mirrors WagerRegistry
// (acceptDeadline + resolveDeadline). Every actor action has a relayer-submittable …WithSig twin.

const ZERO = ethers.ZeroAddress;

/** Sign an EIP-3009 ReceiveWithAuthorization for the MockUSDCPermit token. */
async function signReceiveAuth(token, from, to, value, nonce, validAfter, validBefore) {
  const { chainId } = await ethers.provider.getNetwork();
  const domain = { name: 'USD Coin', version: '1', chainId: Number(chainId), verifyingContract: await token.getAddress() };
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

describe('WagerPool (address-based)', function () {
  let admin, creator, m2, m3, outsider, relayer, factory, token, pool;

  beforeEach(async function () {
    [admin, creator, m2, m3, outsider, relayer] = await ethers.getSigners();
    ({ factory } = await deployPoolFactory({ admin: admin.address }));
    token = await deployToken([creator, m2, m3, outsider]);
  });

  async function newPool(overrides = {}) {
    const params = await defaultParams(token, { maxMembers: 2, thresholdBips: 10000, ...overrides });
    ({ pool } = await createPool(factory, creator, params));
    return pool;
  }

  async function join(signer) {
    await token.connect(signer).approve(await pool.getAddress(), await pool.buyIn());
    return pool.connect(signer).join();
  }

  // ---- Init / drop-in -----------------------------------------------------

  it('is a clone template: factory clones + initializes it (open state, correct config)', async function () {
    await newPool({ maxMembers: 5, thresholdBips: 6000 });
    expect(await pool.state()).to.equal(0n); // JoiningOpen
    expect(await pool.creator()).to.equal(creator.address);
    expect(await pool.maxMembers()).to.equal(5);
    expect(await pool.thresholdBips()).to.equal(6000);
    expect(await pool.token()).to.equal(await token.getAddress());
  });

  it('cannot be re-initialized', async function () {
    await newPool();
    const p = await defaultParams(token);
    await expect(
      pool.initialize(p.token, creator.address, p.buyIn, p.maxMembers, p.thresholdBips, p.acceptDeadline, p.resolveDeadline)
    ).to.be.revertedWithCustomError(pool, 'InvalidInitialization');
  });

  // ---- Join ---------------------------------------------------------------

  it('members join with their wallet; the pool auto-closes when full', async function () {
    await newPool({ maxMembers: 2 });
    await expect(join(creator)).to.emit(pool, 'Joined').withArgs(creator.address);
    expect(await pool.state()).to.equal(0n);
    await join(m2);
    expect(await pool.memberCount()).to.equal(2);
    expect(await pool.state()).to.equal(1n); // JoiningClosed (auto)
    expect(await pool.frozenDenominator()).to.equal(2);
    expect(await pool.escrowTotal()).to.equal(usdc(20));
  });

  it('rejects double join, join after close, and join after the accept deadline', async function () {
    await newPool({ maxMembers: 3 });
    await join(creator);
    await expect(join(creator)).to.be.revertedWithCustomError(pool, 'AlreadyJoined');
    // late join (accept deadline passed) — poke first would close; here we test the deadline guard directly
    const p2 = await newPool({ maxMembers: 3 });
    await join(creator);
    await time.increaseTo((await pool.acceptDeadline()) + 1n);
    await expect(join(m2)).to.be.revertedWithCustomError(pool, 'JoinClosed');
  });

  it('rejects joining a full pool', async function () {
    await newPool({ maxMembers: 2 });
    await join(creator);
    await join(m2); // auto-closes
    await expect(join(m3)).to.be.revertedWithCustomError(pool, 'JoinClosed');
  });

  // ---- Close / poke -------------------------------------------------------

  it('creator can close joining manually; non-creator cannot', async function () {
    await newPool({ maxMembers: 5 });
    await join(creator);
    await join(m2);
    await expect(pool.connect(outsider).closeJoining()).to.be.revertedWithCustomError(pool, 'NotCreator');
    await expect(pool.connect(creator).closeJoining()).to.emit(pool, 'JoiningClosedEvent').withArgs(2);
    expect(await pool.state()).to.equal(1n);
    expect(await pool.frozenDenominator()).to.equal(2);
  });

  it('pokeDeadline: reverts before the accept deadline, closes after (permissionless)', async function () {
    await newPool({ maxMembers: 5 });
    await join(creator);
    await expect(pool.connect(outsider).pokeDeadline()).to.be.revertedWithCustomError(pool, 'DeadlineNotPassed');
    await time.increaseTo((await pool.acceptDeadline()) + 1n);
    await expect(pool.connect(outsider).pokeDeadline()).to.emit(pool, 'JoiningClosedEvent').withArgs(1);
    expect(await pool.state()).to.equal(1n);
  });

  // ---- Resolution ---------------------------------------------------------

  async function closedPool(overrides = {}) {
    await newPool({ maxMembers: 2, thresholdBips: 10000, ...overrides });
    await join(creator);
    await join(m2); // auto-close, escrow = 20
    return pool;
  }

  function evenSplit() {
    return [
      { winner: creator.address, amount: usdc(15) },
      { winner: m2.address, amount: usdc(5) },
    ];
  }

  it('runs the resolution loop: creator proposes, members approve to threshold, winner claims by address', async function () {
    await closedPool();
    const entries = evenSplit();
    const pid = matrixHash(entries);

    await expect(pool.connect(creator).proposeOutcome(entries)).to.emit(pool, 'OutcomeProposed');
    expect(await pool.currentProposalId()).to.equal(pid);
    await expect(pool.connect(m2).proposeOutcome(entries)).to.be.revertedWithCustomError(pool, 'NotCreator');

    await expect(pool.connect(creator).approve(await pool.currentProposalId())).to.emit(pool, 'Approved').withArgs(pid, creator.address);
    expect(await pool.proposalApprovals(pid)).to.equal(1);
    expect(await pool.state()).to.equal(1n);
    await expect(pool.connect(creator).approve(await pool.currentProposalId())).to.be.revertedWithCustomError(pool, 'AlreadyApproved');
    await expect(pool.connect(m2).approve(await pool.currentProposalId())).to.emit(pool, 'OutcomeLocked').withArgs(pid);
    expect(await pool.state()).to.equal(2n); // Resolved
    expect(await pool.lockedOutcome()).to.equal(pid);

    // winners claim to any recipient
    const before = await token.balanceOf(outsider.address);
    await expect(pool.connect(creator).claim(entries, 0, outsider.address))
      .to.emit(pool, 'Claimed')
      .withArgs(creator.address, outsider.address, usdc(15));
    expect(await token.balanceOf(outsider.address)).to.equal(before + usdc(15));
    await pool.connect(m2).claim(entries, 1, m2.address);
    expect(await token.balanceOf(await pool.getAddress())).to.equal(0);
  });

  it('threshold is ceil(frozenDenominator * bips / 1e4), floored to 2 for multi-member pools', async function () {
    await newPool({ maxMembers: 3, thresholdBips: 6000 }); // ceil(3*0.6)=2
    await join(creator);
    await join(m2);
    await join(m3); // auto-close, denominator 3
    const entries = [
      { winner: creator.address, amount: usdc(30) },
      { winner: m2.address, amount: usdc(0) },
      { winner: m3.address, amount: usdc(0) },
    ];
    await pool.connect(creator).proposeOutcome(entries);
    await pool.connect(creator).approve(await pool.currentProposalId());
    expect(await pool.state()).to.equal(1n); // 1 of 2 required — not yet
    await pool.connect(m2).approve(await pool.currentProposalId());
    expect(await pool.state()).to.equal(2n); // 2 approvals locks
  });

  it('revising the proposal restarts the tally', async function () {
    await closedPool();
    const entriesA = evenSplit();
    const entriesB = [
      { winner: creator.address, amount: usdc(20) },
      { winner: m2.address, amount: usdc(0) },
    ];
    const a = matrixHash(entriesA);
    const b = matrixHash(entriesB);
    await pool.connect(creator).proposeOutcome(entriesA);
    await pool.connect(creator).approve(await pool.currentProposalId());
    expect(await pool.proposalApprovals(a)).to.equal(1);
    await pool.connect(creator).proposeOutcome(entriesB); // revise
    expect(await pool.proposalApprovals(b)).to.equal(0);
    await pool.connect(creator).approve(await pool.currentProposalId());
    await pool.connect(m2).approve(await pool.currentProposalId());
    expect(await pool.lockedOutcome()).to.equal(b);
  });

  it('approve binds the proposalId: a re-proposal ahead of a pending approve cannot capture it (#1667)', async function () {
    await closedPool(); // 2 members ⇒ 2 approvals required
    const selfDeal = [
      { winner: creator.address, amount: usdc(20) },
      { winner: m2.address, amount: usdc(0) },
    ];
    const fair = evenSplit();
    const a = matrixHash(selfDeal);
    const b = matrixHash(fair);

    // Creator pre-approves the self-dealing matrix, then shows the fair one.
    await pool.connect(creator).proposeOutcome(selfDeal);
    await pool.connect(creator).approve(a);
    await pool.connect(creator).proposeOutcome(fair);
    expect(await pool.currentProposalId()).to.equal(b);

    // m2 reads B and signs approve(B); the creator re-proposes A before it lands.
    await pool.connect(creator).proposeOutcome(selfDeal);
    await expect(pool.connect(m2).approve(b)).to.be.revertedWithCustomError(pool, 'OutcomeMismatch');
    expect(await pool.state()).to.equal(1n); // still JoiningClosed — nothing locked
    expect(await pool.proposalApprovals(a)).to.equal(1);
    expect(await pool.approvedBy(a, m2.address)).to.equal(false);
  });

  it('approve rejects any id other than the current proposal', async function () {
    await closedPool();
    const entries = evenSplit();
    await pool.connect(creator).proposeOutcome(entries);
    await expect(pool.connect(m2).approve(ethers.ZeroHash)).to.be.revertedWithCustomError(pool, 'OutcomeMismatch');
    await expect(pool.connect(m2).approve(ethers.id('not-a-matrix'))).to.be.revertedWithCustomError(pool, 'OutcomeMismatch');
    await expect(pool.connect(m2).approve(matrixHash(entries))).to.emit(pool, 'Approved');
  });

  it('guards resolution state: propose/approve only while closed and before the resolve deadline', async function () {
    await newPool({ maxMembers: 5 });
    await join(creator);
    // still JoiningOpen
    await expect(pool.connect(creator).proposeOutcome(evenSplit())).to.be.revertedWithCustomError(
      pool,
      'WrongState'
    );
    await pool.connect(creator).closeJoining();
    // approve with no proposal
    await expect(pool.connect(creator).approve(await pool.currentProposalId())).to.be.revertedWithCustomError(pool, 'NoProposal');
    // non-member approve
    const soloEntries = [{ winner: creator.address, amount: usdc(10) }];
    await pool.connect(creator).proposeOutcome(soloEntries);
    await expect(pool.connect(outsider).approve(await pool.currentProposalId())).to.be.revertedWithCustomError(pool, 'NotMember');
    // after the resolve deadline: refund-only
    await time.increaseTo((await pool.resolveDeadline()) + 1n);
    await expect(pool.connect(creator).approve(await pool.currentProposalId())).to.be.revertedWithCustomError(pool, 'ResolutionWindowClosed');
    await expect(pool.connect(creator).proposeOutcome(soloEntries)).to.be.revertedWithCustomError(pool, 'ResolutionWindowClosed');
  });

  // ---- Claim guards + the duplicate-winner stranding fix -------------------

  async function resolvedPool(entries) {
    await closedPool();
    const pid = matrixHash(entries);
    await pool.connect(creator).proposeOutcome(entries);
    await pool.connect(creator).approve(await pool.currentProposalId());
    await pool.connect(m2).approve(await pool.currentProposalId()); // locks
    return pid;
  }

  it('claim guards: wrong matrix, bad sum, OOB index, non-winner, double-claim, pre-resolve', async function () {
    const entries = evenSplit();
    await resolvedPool(entries);

    await expect(pool.connect(creator).claim([{ winner: creator.address, amount: usdc(20) }], 0, creator.address))
      .to.be.revertedWithCustomError(pool, 'OutcomeMismatch'); // hash != locked
    await expect(pool.connect(creator).claim(entries, 5, creator.address)).to.be.revertedWithCustomError(pool, 'IndexOOB');
    await expect(pool.connect(m2).claim(entries, 0, m2.address)).to.be.revertedWithCustomError(pool, 'NotWinner');
    await pool.connect(creator).claim(entries, 0, creator.address);
    await expect(pool.connect(creator).claim(entries, 0, creator.address)).to.be.revertedWithCustomError(
      pool,
      'AlreadyClaimed'
    );
  });

  it('proposeOutcome validates the matrix on-chain (sum, zero-winner, empty) so a locked outcome is always claimable', async function () {
    await closedPool(); // escrow = 20
    // sum != escrow
    await expect(
      pool.connect(creator).proposeOutcome([
        { winner: creator.address, amount: usdc(15) },
        { winner: m2.address, amount: usdc(4) },
      ])
    ).to.be.revertedWithCustomError(pool, 'MatrixSumMismatch');
    // zero-address winner row (would strand that share)
    await expect(pool.connect(creator).proposeOutcome([{ winner: ZERO, amount: usdc(20) }])).to.be.revertedWithCustomError(
      pool,
      'ZeroWinner'
    );
    // empty matrix
    await expect(pool.connect(creator).proposeOutcome([])).to.be.revertedWithCustomError(pool, 'EmptyMatrix');
    // a valid full-escrow matrix is accepted
    await expect(pool.connect(creator).proposeOutcome(evenSplit())).to.emit(pool, 'OutcomeProposed');
  });

  it('a single member (the creator) cannot unilaterally lock a payout — multi-member pools need >=2 approvals (FR-020b)', async function () {
    await newPool({ maxMembers: 2, thresholdBips: 5000 }); // 50%: ceil(2*0.5)=1, but the min-2 floor applies
    await join(creator);
    await join(m2); // auto-close, denominator 2
    const entries = evenSplit();
    await pool.connect(creator).proposeOutcome(entries);
    await pool.connect(creator).approve(await pool.currentProposalId());
    expect(await pool.state()).to.equal(1n); // the creator's lone approval does NOT resolve
    await pool.connect(m2).approve(await pool.currentProposalId());
    expect(await pool.state()).to.equal(2n); // it takes the other member too
  });

  it('FUND-STRANDING FIX: a matrix listing the same winner twice is fully claimable (per-index, not per-address)', async function () {
    // creator appears in two rows; escrow = 20 = 12 + 8.
    const entries = [
      { winner: creator.address, amount: usdc(12) },
      { winner: creator.address, amount: usdc(8) },
    ];
    await resolvedPool(entries);
    const before = await token.balanceOf(creator.address);
    await pool.connect(creator).claim(entries, 0, creator.address);
    await pool.connect(creator).claim(entries, 1, creator.address); // second row still claimable
    expect(await token.balanceOf(creator.address)).to.equal(before + usdc(20));
    expect(await token.balanceOf(await pool.getAddress())).to.equal(0); // nothing stranded
    // and neither index can be claimed twice
    await expect(pool.connect(creator).claim(entries, 0, creator.address)).to.be.revertedWithCustomError(
      pool,
      'AlreadyClaimed'
    );
  });

  it('claim before Resolved reverts', async function () {
    await closedPool();
    await expect(pool.connect(creator).claim(evenSplit(), 0, creator.address)).to.be.revertedWithCustomError(
      pool,
      'WrongState'
    );
  });

  // ---- Refund / cancel ----------------------------------------------------

  it('refunds every member after the resolve deadline elapses with no outcome', async function () {
    await closedPool();
    await time.increaseTo((await pool.resolveDeadline()) + 1n);
    const b1 = await token.balanceOf(creator.address);
    await expect(pool.connect(creator).refund()).to.emit(pool, 'Refunded').withArgs(creator.address, usdc(10));
    expect(await token.balanceOf(creator.address)).to.equal(b1 + usdc(10));
    await pool.connect(m2).refund();
    await expect(pool.connect(creator).refund()).to.be.revertedWithCustomError(pool, 'NothingToRefund'); // double
    expect(await token.balanceOf(await pool.getAddress())).to.equal(0);
  });

  it('creator cancels before joining closes; members refund; non-creator/late cancel revert', async function () {
    await newPool({ maxMembers: 5 });
    await join(creator);
    await join(m2);
    await expect(pool.connect(outsider).cancel()).to.be.revertedWithCustomError(pool, 'NotCreator');
    await expect(pool.connect(creator).cancel()).to.emit(pool, 'PoolCancelled');
    await expect(pool.connect(creator).cancel()).to.be.revertedWithCustomError(pool, 'WrongState'); // already cancelled
    const b = await token.balanceOf(m2.address);
    await pool.connect(m2).refund();
    expect(await token.balanceOf(m2.address)).to.equal(b + usdc(10));
    await expect(pool.connect(outsider).refund()).to.be.revertedWithCustomError(pool, 'NothingToRefund'); // never joined
  });

  // ---- Gasless join (EIP-3009) -------------------------------------------

  it('gasless join: a relayer submits an EIP-3009 authorization the member signed', async function () {
    await newPool({ maxMembers: 3 });
    const poolAddr = await pool.getAddress();
    const now = (await ethers.provider.getBlock('latest')).timestamp;
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const { v, r, s } = await signReceiveAuth(token, m3, poolAddr, await pool.buyIn(), nonce, 0, now + 3600);
    // relayer (outsider) submits; funds pulled from m3
    await expect(pool.connect(outsider).joinWithAuthorization(m3.address, await pool.buyIn(), 0, now + 3600, nonce, v, r, s))
      .to.emit(pool, 'Joined')
      .withArgs(m3.address);
    expect(await pool.hasJoined(m3.address)).to.equal(true);
    expect(await token.balanceOf(poolAddr)).to.equal(usdc(10));
  });

  it('gasless join rejects a wrong-value authorization', async function () {
    await newPool({ maxMembers: 3 });
    const now = (await ethers.provider.getBlock('latest')).timestamp;
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const { v, r, s } = await signReceiveAuth(token, m3, await pool.getAddress(), usdc(5), nonce, 0, now + 3600);
    await expect(
      pool.connect(outsider).joinWithAuthorization(m3.address, usdc(5), 0, now + 3600, nonce, v, r, s)
    ).to.be.revertedWithCustomError(pool, 'BadValue');
  });

  // ---- Relayer twins (spec 035 withSig) ----------------------------------

  it('approveWithSig: member signs, relayer submits; bound to proposalId; replay + expiry guarded', async function () {
    await closedPool();
    const entries = evenSplit();
    const pid = matrixHash(entries);
    await pool.connect(creator).proposeOutcome(entries);

    // creator approves via self-submit; m2 approves via a relayed signature
    await pool.connect(creator).approve(await pool.currentProposalId());
    const { sig, nonce, validAfter, validBefore } = await signApprove(pool, m2, pid);
    await expect(pool.connect(relayer).approveWithSig(pid, m2.address, nonce, validAfter, validBefore, sig))
      .to.emit(pool, 'OutcomeLocked')
      .withArgs(pid);
    expect(await pool.state()).to.equal(2n);
    // nonce replay is rejected
    await expect(
      pool.connect(relayer).approveWithSig(pid, m2.address, nonce, validAfter, validBefore, sig)
    ).to.be.revertedWithCustomError(pool, 'IntentReplayed');
  });

  it('approveWithSig rejects a wrong signer and an expired intent', async function () {
    await closedPool();
    const entries = evenSplit();
    const pid = matrixHash(entries);
    await pool.connect(creator).proposeOutcome(entries);

    // signature by outsider but claiming to be m2 -> InvalidIntentSignature
    const bad = await signApprove(pool, m2, pid);
    await expect(
      pool.connect(relayer).approveWithSig(pid, outsider.address, bad.nonce, bad.validAfter, bad.validBefore, bad.sig)
    ).to.be.revertedWithCustomError(pool, 'InvalidIntentSignature');

    // expired intent
    const now = (await ethers.provider.getBlock('latest')).timestamp;
    const exp = await signApprove(pool, m2, pid, { validBefore: now - 1 });
    await expect(
      pool.connect(relayer).approveWithSig(pid, m2.address, exp.nonce, exp.validAfter, exp.validBefore, exp.sig)
    ).to.be.revertedWithCustomError(pool, 'IntentExpired');
  });

  it('approveWithSig rejects if the current proposal changed (anti-retarget)', async function () {
    await closedPool();
    const entriesA = evenSplit();
    const entriesB = [
      { winner: creator.address, amount: usdc(20) },
      { winner: m2.address, amount: usdc(0) },
    ];
    const a = matrixHash(entriesA);
    await pool.connect(creator).proposeOutcome(entriesA);
    const signed = await signApprove(pool, m2, a); // m2 signed for proposal a
    await pool.connect(creator).proposeOutcome(entriesB); // creator revised to b
    await expect(
      pool.connect(relayer).approveWithSig(a, m2.address, signed.nonce, signed.validAfter, signed.validBefore, signed.sig)
    ).to.be.revertedWithCustomError(pool, 'OutcomeMismatch');
  });

  it('claimWithSig: winner signs a claim bound to (index, recipient); relayer submits', async function () {
    const entries = evenSplit();
    await resolvedPool(entries);
    const { sig, nonce, validAfter, validBefore } = await signClaim(pool, creator, 0, outsider.address);
    const before = await token.balanceOf(outsider.address);
    await expect(
      pool.connect(relayer).claimWithSig(entries, 0, outsider.address, creator.address, nonce, validAfter, validBefore, sig)
    )
      .to.emit(pool, 'Claimed')
      .withArgs(creator.address, outsider.address, usdc(15));
    expect(await token.balanceOf(outsider.address)).to.equal(before + usdc(15));
    // signer must own the row
    const bad = await signClaim(pool, m2, 0, m2.address);
    await expect(
      pool.connect(relayer).claimWithSig(entries, 0, m2.address, m2.address, bad.nonce, bad.validAfter, bad.validBefore, bad.sig)
    ).to.be.revertedWithCustomError(pool, 'NotWinner');
  });

  it('proposeOutcomeWithSig / closeJoiningWithSig / cancelWithSig: creator signs, relayer submits', async function () {
    // closeJoiningWithSig
    await newPool({ maxMembers: 5 });
    await join(creator);
    await join(m2);
    let s = await signClose(pool, creator);
    await expect(pool.connect(relayer).closeJoiningWithSig(creator.address, s.nonce, s.validAfter, s.validBefore, s.sig))
      .to.emit(pool, 'JoiningClosedEvent')
      .withArgs(2);
    // proposeOutcomeWithSig — the creator signs an intent bound to the matrix hash; anyone submits.
    const entries = evenSplit();
    const pid = matrixHash(entries);
    s = await signPropose(pool, creator, pid);
    await expect(pool.connect(relayer).proposeOutcomeWithSig(entries, creator.address, s.nonce, s.validAfter, s.validBefore, s.sig))
      .to.emit(pool, 'OutcomeProposed');
    expect(await pool.currentProposalId()).to.equal(pid);
    // a non-creator signer is rejected by the action's own check
    const bad = await signPropose(pool, m2, pid);
    await expect(
      pool.connect(relayer).proposeOutcomeWithSig(entries, m2.address, bad.nonce, bad.validAfter, bad.validBefore, bad.sig)
    ).to.be.revertedWithCustomError(pool, 'NotCreator');
  });

  it('cancelWithSig + refundWithSig: creator cancels via sig, member refunds via sig', async function () {
    await newPool({ maxMembers: 5 });
    await join(creator);
    await join(m2);
    let s = await signCancel(pool, creator);
    await expect(pool.connect(relayer).cancelWithSig(creator.address, s.nonce, s.validAfter, s.validBefore, s.sig)).to.emit(
      pool,
      'PoolCancelled'
    );
    const before = await token.balanceOf(m2.address);
    s = await signRefund(pool, m2);
    await expect(pool.connect(relayer).refundWithSig(m2.address, s.nonce, s.validAfter, s.validBefore, s.sig))
      .to.emit(pool, 'Refunded')
      .withArgs(m2.address, usdc(10));
    expect(await token.balanceOf(m2.address)).to.equal(before + usdc(10)); // funds go to the signer, not the relayer
  });

  it('invalidateNonce pre-empts a signed-but-unsubmitted intent', async function () {
    await closedPool();
    const entries = evenSplit();
    const pid = matrixHash(entries);
    await pool.connect(creator).proposeOutcome(entries);
    const s = await signApprove(pool, m2, pid);
    await pool.connect(m2).invalidateNonce(s.nonce);
    await expect(
      pool.connect(relayer).approveWithSig(pid, m2.address, s.nonce, s.validAfter, s.validBefore, s.sig)
    ).to.be.revertedWithCustomError(pool, 'IntentReplayed');
  });
});
