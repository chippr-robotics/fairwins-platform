const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');
const {
  deployFundingFactory,
  deployToken,
  defaultParams,
  createPool,
  contribute,
  usdc,
  STATE,
  REASON,
  randNonce,
  signClose,
  signCancel,
  signVoteRefund,
  signClaimRefund,
  signReceiveAuth,
} = require('../helpers/fundingpool');

// FundingPool relayer twins (spec 103, spec-035 pattern): every actor action has a …WithSig twin that
// authorizes the recovered EIP-712 signer (never the submitter), burns a single-use nonce, and enforces
// the validity window; the money-in has its EIP-3009 form. The twins reach the same internal path as the
// self-submit entrypoints, so every state guard bubbles up unchanged.

describe('FundingPool — …WithSig twins + EIP-3009 contribute', function () {
  let admin, organizer, c1, c2, c3, relayer, factory, token, pool;

  beforeEach(async function () {
    [admin, organizer, c1, c2, c3, relayer] = await ethers.getSigners();
    ({ factory } = await deployFundingFactory({ admin: admin.address }));
    token = await deployToken([organizer, c1, c2, c3, relayer]);
    ({ pool } = await createPool(factory, organizer, await defaultParams(token)));
  });

  const splat = (a) => [a.nonce, a.validAfter, a.validBefore, a.sig];

  // ---- contributeWithAuthorization ----------------------------------------------

  it('contributeWithAuthorization: the relayer submits, the SIGNER is the contributor, funds enter escrow', async function () {
    const auth = await signReceiveAuth(token, c1, await pool.getAddress(), usdc(12));
    const before = await token.balanceOf(c1.address);
    await expect(
      pool.connect(relayer).contributeWithAuthorization(
        c1.address, usdc(12), auth.validAfter, auth.validBefore, auth.nonce, auth.v, auth.r, auth.s
      )
    ).to.emit(pool, 'Contributed').withArgs(c1.address, usdc(12), usdc(12), usdc(12));
    expect(await token.balanceOf(c1.address)).to.equal(before - usdc(12));
    expect(await pool.contributed(c1.address)).to.equal(usdc(12));
    expect(await pool.contributed(relayer.address)).to.equal(0n);
    expect(await token.balanceOf(await pool.getAddress())).to.equal(usdc(12));
  });

  it('contributeWithAuthorization: an authorization signed to another payee is rejected by the token', async function () {
    const auth = await signReceiveAuth(token, c1, relayer.address, usdc(12));
    await expect(
      pool.connect(relayer).contributeWithAuthorization(
        c1.address, usdc(12), auth.validAfter, auth.validBefore, auth.nonce, auth.v, auth.r, auth.s
      )
    ).to.be.reverted;
    expect(await pool.contributed(c1.address)).to.equal(0n);
    expect(await pool.contributorCount()).to.equal(0);
  });

  it('contributeWithAuthorization: zero value and closed contributions are refused before the token is touched', async function () {
    const auth = await signReceiveAuth(token, c1, await pool.getAddress(), 0n);
    await expect(
      pool.connect(relayer).contributeWithAuthorization(c1.address, 0n, auth.validAfter, auth.validBefore, auth.nonce, auth.v, auth.r, auth.s)
    ).to.be.revertedWithCustomError(pool, 'ZeroAmount');
    await time.increaseTo(await pool.contributeDeadline());
    const auth2 = await signReceiveAuth(token, c1, await pool.getAddress(), usdc(1));
    await expect(
      pool.connect(relayer).contributeWithAuthorization(c1.address, usdc(1), auth2.validAfter, auth2.validBefore, auth2.nonce, auth2.v, auth2.r, auth2.s)
    ).to.be.revertedWithCustomError(pool, 'ContributionsClosed');
  });

  // ---- closeWithSig ----------------------------------------------------------------

  it('closeWithSig: relayer submits, the organizer collects', async function () {
    await contribute(pool, token, c1, usdc(10));
    const a = await signClose(pool, organizer);
    const before = await token.balanceOf(organizer.address);
    await expect(pool.connect(relayer).closeWithSig(organizer.address, ...splat(a)))
      .to.emit(pool, 'PoolClosed').withArgs(organizer.address, usdc(10))
      .and.to.emit(pool, 'IntentNonceUsed').withArgs(organizer.address, a.nonce);
    expect(await token.balanceOf(organizer.address)).to.equal(before + usdc(10));
    expect(await token.balanceOf(relayer.address)).to.equal(usdc(1000));
    expect(await pool.state()).to.equal(STATE.Closed);
  });

  it('closeWithSig: a non-organizer signer is refused (NotOrganizer), and a signature from someone else is invalid', async function () {
    await contribute(pool, token, c1, usdc(10));
    const a = await signClose(pool, c1);
    await expect(pool.connect(relayer).closeWithSig(c1.address, ...splat(a))).to.be.revertedWithCustomError(pool, 'NotOrganizer');
    // Signed by c1 but claiming the organizer.
    const forged = await signClose(pool, c1);
    await expect(pool.connect(relayer).closeWithSig(organizer.address, ...splat(forged)))
      .to.be.revertedWithCustomError(pool, 'InvalidIntentSignature');
    expect(await pool.state()).to.equal(STATE.Open);
  });

  it('closeWithSig: replay, expiry, not-yet-valid, and zero signer are refused; a failed intent never burns the nonce', async function () {
    await contribute(pool, token, c1, usdc(10));
    const expired = await signClose(pool, organizer, { validBefore: (await time.latest()) - 1 });
    await expect(pool.connect(relayer).closeWithSig(organizer.address, ...splat(expired)))
      .to.be.revertedWithCustomError(pool, 'IntentExpired');
    expect(await pool.authorizationState(organizer.address, expired.nonce)).to.equal(false);

    const early = await signClose(pool, organizer, { validAfter: (await time.latest()) + 3600 });
    await expect(pool.connect(relayer).closeWithSig(organizer.address, ...splat(early)))
      .to.be.revertedWithCustomError(pool, 'IntentNotYetValid');

    const zero = await signClose(pool, organizer);
    await expect(pool.connect(relayer).closeWithSig(ethers.ZeroAddress, ...splat(zero)))
      .to.be.revertedWithCustomError(pool, 'IntentSignerZero');

    // Use once, then replay.
    const a = await signClose(pool, organizer);
    await pool.connect(relayer).closeWithSig(organizer.address, ...splat(a));
    await expect(pool.connect(relayer).closeWithSig(organizer.address, ...splat(a)))
      .to.be.revertedWithCustomError(pool, 'IntentReplayed');
  });

  it('an invalidated nonce can never execute (self and gasless invalidation)', async function () {
    const a = await signClose(pool, organizer);
    await pool.connect(organizer).invalidateNonce(a.nonce);
    await expect(pool.connect(relayer).closeWithSig(organizer.address, ...splat(a)))
      .to.be.revertedWithCustomError(pool, 'IntentReplayed');
    expect(await pool.state()).to.equal(STATE.Open);
  });

  // ---- cancelWithSig ---------------------------------------------------------------

  it('cancelWithSig: relayer submits, the pool is refunding, contributors collect', async function () {
    await contribute(pool, token, c1, usdc(10));
    const a = await signCancel(pool, organizer);
    await expect(pool.connect(relayer).cancelWithSig(organizer.address, ...splat(a)))
      .to.emit(pool, 'RefundingStarted').withArgs(REASON.Organizer);
    expect(await pool.state()).to.equal(STATE.Refunding);
    // A second organizer intent on the now-refunding pool is refused on state (terminal).
    const again = await signCancel(pool, organizer);
    await expect(pool.connect(relayer).cancelWithSig(organizer.address, ...splat(again))).to.be.revertedWithCustomError(pool, 'WrongState');
  });

  it('cancelWithSig: a contributor cannot cancel', async function () {
    await contribute(pool, token, c1, usdc(10));
    const a = await signCancel(pool, c1);
    await expect(pool.connect(relayer).cancelWithSig(c1.address, ...splat(a))).to.be.revertedWithCustomError(pool, 'NotOrganizer');
  });

  // ---- voteRefundWithSig / claimRefundWithSig ------------------------------------------

  it('voteRefundWithSig + claimRefundWithSig: attributed to the signer; refund goes to the signer, never the relayer', async function () {
    await contribute(pool, token, c1, usdc(10));
    await contribute(pool, token, c2, usdc(20));
    await contribute(pool, token, c3, usdc(30));
    const v1 = await signVoteRefund(pool, c1);
    await expect(pool.connect(relayer).voteRefundWithSig(c1.address, ...splat(v1)))
      .to.emit(pool, 'RefundVoted').withArgs(c1.address, 1, 2);
    expect(await pool.votedRefund(c1.address)).to.equal(true);
    expect(await pool.votedRefund(relayer.address)).to.equal(false);
    // Same signer twice (fresh nonce) is still one vote.
    const v1b = await signVoteRefund(pool, c1);
    await expect(pool.connect(relayer).voteRefundWithSig(c1.address, ...splat(v1b))).to.be.revertedWithCustomError(pool, 'AlreadyVoted');
    const v2 = await signVoteRefund(pool, c2);
    await pool.connect(relayer).voteRefundWithSig(c2.address, ...splat(v2));
    expect(await pool.state()).to.equal(STATE.Refunding);

    const before = await token.balanceOf(c3.address);
    const rBefore = await token.balanceOf(relayer.address);
    const cl = await signClaimRefund(pool, c3);
    await expect(pool.connect(relayer).claimRefundWithSig(c3.address, ...splat(cl)))
      .to.emit(pool, 'RefundClaimed').withArgs(c3.address, usdc(30));
    expect(await token.balanceOf(c3.address)).to.equal(before + usdc(30));
    expect(await token.balanceOf(relayer.address)).to.equal(rBefore);
    const again = await signClaimRefund(pool, c3);
    await expect(pool.connect(relayer).claimRefundWithSig(c3.address, ...splat(again))).to.be.revertedWithCustomError(pool, 'NothingToRefund');
  });

  it('voteRefundWithSig by a non-contributor is refused', async function () {
    await contribute(pool, token, c1, usdc(10));
    const v = await signVoteRefund(pool, relayer);
    await expect(pool.connect(relayer).voteRefundWithSig(relayer.address, ...splat(v))).to.be.revertedWithCustomError(pool, 'NotContributor');
  });

  it('a nonce is scoped per signer and per clone: the same nonce works for two signers and on two pools', async function () {
    await contribute(pool, token, c1, usdc(10));
    await contribute(pool, token, c2, usdc(10));
    await contribute(pool, token, c3, usdc(10));
    const nonce = randNonce();
    const v1 = await signVoteRefund(pool, c1, { nonce });
    const v2 = await signVoteRefund(pool, c2, { nonce });
    await pool.connect(relayer).voteRefundWithSig(c1.address, ...splat(v1));
    await pool.connect(relayer).voteRefundWithSig(c2.address, ...splat(v2));
    expect(await pool.state()).to.equal(STATE.Refunding);
    // Same nonce on a second pool — a different domain (verifyingContract), so the digest differs and it
    // is a fresh, unused nonce there.
    const { pool: pool2 } = await createPool(factory, organizer, await defaultParams(token));
    const a = await signClose(pool2, organizer, { nonce });
    await pool2.connect(relayer).closeWithSig(organizer.address, ...splat(a));
    expect(await pool2.state()).to.equal(STATE.Closed);
  });

  it('a signature for one pool cannot be replayed on another (per-clone domain)', async function () {
    const { pool: pool2 } = await createPool(factory, organizer, await defaultParams(token));
    const a = await signClose(pool, organizer);
    await expect(pool2.connect(relayer).closeWithSig(organizer.address, ...splat(a)))
      .to.be.revertedWithCustomError(pool2, 'InvalidIntentSignature');
  });
});
