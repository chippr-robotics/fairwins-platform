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
} = require('../helpers/fundingpool');

// FundingPool (spec 103): contribute any amount → organizer closes (collects) at any time, or the
// organizer / a strict majority of contributors / the settle deadline flip the pool to refunding and
// each contributor pulls back exactly what they put in. Timing mirrors WagerPool (two absolute deadlines).

describe('FundingPool', function () {
  let admin, organizer, c1, c2, c3, outsider, factory, token, pool;

  beforeEach(async function () {
    [admin, organizer, c1, c2, c3, outsider] = await ethers.getSigners();
    ({ factory } = await deployFundingFactory({ admin: admin.address }));
    token = await deployToken([organizer, c1, c2, c3, outsider]);
  });

  async function newPool(overrides = {}) {
    const params = await defaultParams(token, overrides);
    ({ pool } = await createPool(factory, organizer, params));
    return { pool, params };
  }

  // ---- Init ----------------------------------------------------------------

  it('is a clone template: factory clones + initializes it (open state, config, createdBlock)', async function () {
    const { params } = await newPool();
    expect(await pool.state()).to.equal(STATE.Open);
    expect(await pool.organizer()).to.equal(organizer.address);
    expect(await pool.goal()).to.equal(params.goal);
    expect(await pool.purpose()).to.equal(params.purpose);
    expect(await pool.token()).to.equal(await token.getAddress());
    expect(await pool.factory()).to.equal(await factory.getAddress());
    expect(await pool.contributeDeadline()).to.equal(params.contributeDeadline);
    expect(await pool.settleDeadline()).to.equal(params.settleDeadline);
    expect(await pool.createdBlock()).to.be.greaterThan(0n);
    expect(await pool.totalRaised()).to.equal(0n);
    expect(await pool.contributorCount()).to.equal(0);
    expect(await pool.refundVotesNeeded()).to.equal(0);
    expect(await pool.contributionOpen()).to.equal(true);
  });

  it('cannot be re-initialized (clone or template)', async function () {
    const { params } = await newPool();
    await expect(
      pool.initialize(params.token, organizer.address, params.goal, params.purpose, params.contributeDeadline, params.settleDeadline)
    ).to.be.revertedWithCustomError(pool, 'InvalidInitialization');
    const impl = await ethers.getContractAt('FundingPool', await factory.poolImpl());
    await expect(
      impl.initialize(params.token, organizer.address, params.goal, params.purpose, params.contributeDeadline, params.settleDeadline)
    ).to.be.revertedWithCustomError(impl, 'InvalidInitialization');
  });

  // ---- Contribute ------------------------------------------------------------

  it('accepts any amount > 0, any number of times; accumulates per contributor; counts distinct contributors', async function () {
    await newPool();
    await expect(contribute(pool, token, c1, usdc(10)))
      .to.emit(pool, 'Contributed').withArgs(c1.address, usdc(10), usdc(10), usdc(10));
    await expect(contribute(pool, token, c1, usdc(5)))
      .to.emit(pool, 'Contributed').withArgs(c1.address, usdc(5), usdc(15), usdc(15));
    await contribute(pool, token, c2, usdc(2.5));
    expect(await pool.contributed(c1.address)).to.equal(usdc(15));
    expect(await pool.contributed(c2.address)).to.equal(usdc(2.5));
    expect(await pool.totalRaised()).to.equal(usdc(17.5));
    expect(await pool.contributorCount()).to.equal(2);
    expect(await token.balanceOf(await pool.getAddress())).to.equal(usdc(17.5));
  });

  it('accepts contributions past the goal (the goal is informational, never a cap)', async function () {
    await newPool({ goal: usdc(10) });
    await contribute(pool, token, c1, usdc(50));
    expect(await pool.totalRaised()).to.equal(usdc(50));
    expect(await pool.state()).to.equal(STATE.Open);
  });

  it('the organizer may contribute like anyone else', async function () {
    await newPool();
    await contribute(pool, token, organizer, usdc(1));
    expect(await pool.contributorCount()).to.equal(1);
    expect(await pool.contributed(organizer.address)).to.equal(usdc(1));
  });

  it('rejects a zero contribution', async function () {
    await newPool();
    await expect(pool.connect(c1).contribute(0)).to.be.revertedWithCustomError(pool, 'ZeroAmount');
  });

  it('rejects contributions once the contribute deadline has passed', async function () {
    const { params } = await newPool();
    await time.increaseTo(params.contributeDeadline);
    expect(await pool.contributionOpen()).to.equal(false);
    await expect(contribute(pool, token, c1, usdc(1))).to.be.revertedWithCustomError(pool, 'ContributionsClosed');
  });

  it('rejects contributions to a closed or refunding pool', async function () {
    await newPool();
    await contribute(pool, token, c1, usdc(1));
    await pool.connect(organizer).close();
    await expect(contribute(pool, token, c2, usdc(1))).to.be.revertedWithCustomError(pool, 'WrongState');

    await newPool();
    await pool.connect(organizer).cancel();
    await expect(contribute(pool, token, c2, usdc(1))).to.be.revertedWithCustomError(pool, 'WrongState');
  });

  it('a contribute without allowance fails and records nothing', async function () {
    await newPool();
    await expect(pool.connect(c1).contribute(usdc(1))).to.be.reverted;
    expect(await pool.totalRaised()).to.equal(0n);
    expect(await pool.contributorCount()).to.equal(0);
  });

  // ---- Close (organizer collects) ----------------------------------------------

  it('the organizer closes at any time and collects the whole pot, goal met or not', async function () {
    await newPool({ goal: usdc(1000) });
    await contribute(pool, token, c1, usdc(10));
    await contribute(pool, token, c2, usdc(20));
    const before = await token.balanceOf(organizer.address);
    await expect(pool.connect(organizer).close()).to.emit(pool, 'PoolClosed').withArgs(organizer.address, usdc(30));
    expect(await token.balanceOf(organizer.address)).to.equal(before + usdc(30));
    expect(await token.balanceOf(await pool.getAddress())).to.equal(0n);
    expect(await pool.state()).to.equal(STATE.Closed);
    expect(await pool.closedAt()).to.be.greaterThan(0n);
  });

  it('closing with nothing raised is a no-transfer close', async function () {
    await newPool();
    const before = await token.balanceOf(organizer.address);
    await expect(pool.connect(organizer).close()).to.emit(pool, 'PoolClosed').withArgs(organizer.address, 0n);
    expect(await token.balanceOf(organizer.address)).to.equal(before);
    expect(await pool.state()).to.equal(STATE.Closed);
  });

  it('the organizer may still close after contributions closed, up to the settle deadline', async function () {
    const { params } = await newPool();
    await contribute(pool, token, c1, usdc(10));
    await time.increaseTo(params.contributeDeadline + 1);
    await pool.connect(organizer).close();
    expect(await pool.state()).to.equal(STATE.Closed);
  });

  it('only the organizer can close; closing is terminal', async function () {
    await newPool();
    await contribute(pool, token, c1, usdc(10));
    await expect(pool.connect(c1).close()).to.be.revertedWithCustomError(pool, 'NotOrganizer');
    await expect(pool.connect(outsider).close()).to.be.revertedWithCustomError(pool, 'NotOrganizer');
    await pool.connect(organizer).close();
    await expect(pool.connect(organizer).close()).to.be.revertedWithCustomError(pool, 'WrongState');
    await expect(pool.connect(organizer).cancel()).to.be.revertedWithCustomError(pool, 'WrongState');
    await expect(pool.connect(c1).voteRefund()).to.be.revertedWithCustomError(pool, 'WrongState');
    await expect(pool.connect(c1).claimRefund()).to.be.revertedWithCustomError(pool, 'WrongState');
    await expect(pool.pokeDeadline()).to.be.revertedWithCustomError(pool, 'WrongState');
  });

  // ---- Cancel (organizer refund) ----------------------------------------------

  it('the organizer can flip an open pool to refunding; contributors collect exactly their own amounts, once', async function () {
    await newPool();
    await contribute(pool, token, c1, usdc(10));
    await contribute(pool, token, c2, usdc(30));
    await contribute(pool, token, c1, usdc(5));
    await expect(pool.connect(organizer).cancel()).to.emit(pool, 'RefundingStarted').withArgs(REASON.Organizer);
    expect(await pool.state()).to.equal(STATE.Refunding);
    expect(await pool.refundReason()).to.equal(REASON.Organizer);

    const b1 = await token.balanceOf(c1.address);
    await expect(pool.connect(c1).claimRefund()).to.emit(pool, 'RefundClaimed').withArgs(c1.address, usdc(15));
    expect(await token.balanceOf(c1.address)).to.equal(b1 + usdc(15));
    await expect(pool.connect(c1).claimRefund()).to.be.revertedWithCustomError(pool, 'NothingToRefund');
    expect(await pool.refundedCount()).to.equal(1);

    await pool.connect(c2).claimRefund();
    expect(await pool.refundedCount()).to.equal(2);
    expect(await token.balanceOf(await pool.getAddress())).to.equal(0n);
    // A non-contributor has nothing to collect.
    await expect(pool.connect(outsider).claimRefund()).to.be.revertedWithCustomError(pool, 'NothingToRefund');
    // Terminal.
    await expect(pool.connect(organizer).close()).to.be.revertedWithCustomError(pool, 'WrongState');
  });

  it('only the organizer can cancel', async function () {
    await newPool();
    await expect(pool.connect(c1).cancel()).to.be.revertedWithCustomError(pool, 'NotOrganizer');
  });

  it('refunds cannot be claimed while the pool is open', async function () {
    await newPool();
    await contribute(pool, token, c1, usdc(10));
    await expect(pool.connect(c1).claimRefund()).to.be.revertedWithCustomError(pool, 'WrongState');
  });

  // ---- Majority refund vote ------------------------------------------------------

  it('a strict majority of contributors (⌊N/2⌋+1) flips the pool to refunding', async function () {
    await newPool();
    await contribute(pool, token, c1, usdc(1));
    await contribute(pool, token, c2, usdc(1));
    await contribute(pool, token, c3, usdc(1));
    expect(await pool.refundVotesNeeded()).to.equal(2);

    await expect(pool.connect(c1).voteRefund()).to.emit(pool, 'RefundVoted').withArgs(c1.address, 1, 2);
    expect(await pool.state()).to.equal(STATE.Open);
    await expect(pool.connect(c2).voteRefund())
      .to.emit(pool, 'RefundVoted').withArgs(c2.address, 2, 2)
      .and.to.emit(pool, 'RefundingStarted').withArgs(REASON.Majority);
    expect(await pool.state()).to.equal(STATE.Refunding);
    expect(await pool.refundReason()).to.equal(REASON.Majority);
    // Late vote on a refunding pool is refused (state), and everyone collects.
    await expect(pool.connect(c3).voteRefund()).to.be.revertedWithCustomError(pool, 'WrongState');
    for (const c of [c1, c2, c3]) await pool.connect(c).claimRefund();
    expect(await token.balanceOf(await pool.getAddress())).to.equal(0n);
  });

  it('needed votes: 1 of 1, 2 of 2, 2 of 3, 3 of 4, 3 of 5', async function () {
    const cases = [
      [1, 1],
      [2, 2],
      [3, 2],
      [4, 3],
      [5, 3],
    ];
    const signers = await ethers.getSigners();
    for (const [n, needed] of cases) {
      await newPool();
      for (let i = 0; i < n; i += 1) {
        const s = signers[6 + i];
        await token.mint(s.address, usdc(1));
        await contribute(pool, token, s, usdc(1));
      }
      expect(await pool.refundVotesNeeded(), `N=${n}`).to.equal(needed);
    }
  });

  it('the majority is evaluated against the CURRENT contributor count; a later contributor raises the bar', async function () {
    await newPool();
    await contribute(pool, token, c1, usdc(1));
    await contribute(pool, token, c2, usdc(1));
    await pool.connect(c1).voteRefund(); // 1 of 2 needed — not yet
    expect(await pool.state()).to.equal(STATE.Open);
    await contribute(pool, token, c3, usdc(1)); // now 3 contributors, needed 2
    expect(await pool.refundVotesNeeded()).to.equal(2);
    await pool.connect(c3).voteRefund();
    expect(await pool.state()).to.equal(STATE.Refunding);
  });

  it('one vote per contributor; non-contributors cannot vote', async function () {
    await newPool();
    await contribute(pool, token, c1, usdc(1));
    await contribute(pool, token, c2, usdc(1));
    await contribute(pool, token, c3, usdc(1));
    await pool.connect(c1).voteRefund();
    await expect(pool.connect(c1).voteRefund()).to.be.revertedWithCustomError(pool, 'AlreadyVoted');
    await expect(pool.connect(outsider).voteRefund()).to.be.revertedWithCustomError(pool, 'NotContributor');
    expect(await pool.refundVotes()).to.equal(1);
  });

  it('the organizer can still close while a vote is short of the majority (the close stands)', async function () {
    await newPool();
    await contribute(pool, token, c1, usdc(1));
    await contribute(pool, token, c2, usdc(1));
    await contribute(pool, token, c3, usdc(1));
    await pool.connect(c1).voteRefund();
    await pool.connect(organizer).close();
    expect(await pool.state()).to.equal(STATE.Closed);
    await expect(pool.connect(c2).voteRefund()).to.be.revertedWithCustomError(pool, 'WrongState');
  });

  // ---- Settle deadline (never stranded) ------------------------------------------

  it('after the settle deadline anyone can move an open pool to refunding', async function () {
    const { params } = await newPool();
    await contribute(pool, token, c1, usdc(10));
    await expect(pool.connect(outsider).pokeDeadline()).to.be.revertedWithCustomError(pool, 'DeadlineNotPassed');
    await time.increaseTo(params.settleDeadline);
    await expect(pool.connect(outsider).pokeDeadline()).to.emit(pool, 'RefundingStarted').withArgs(REASON.Deadline);
    expect(await pool.state()).to.equal(STATE.Refunding);
    const b = await token.balanceOf(c1.address);
    await pool.connect(c1).claimRefund();
    expect(await token.balanceOf(c1.address)).to.equal(b + usdc(10));
    // The organizer can no longer close.
    await expect(pool.connect(organizer).close()).to.be.revertedWithCustomError(pool, 'WrongState');
  });

  it('a pool closed before the settle deadline cannot be poked afterwards', async function () {
    const { params } = await newPool();
    await pool.connect(organizer).close();
    await time.increaseTo(params.settleDeadline);
    await expect(pool.pokeDeadline()).to.be.revertedWithCustomError(pool, 'WrongState');
  });
});
