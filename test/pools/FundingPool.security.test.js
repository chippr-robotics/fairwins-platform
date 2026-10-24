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
} = require('../helpers/fundingpool');

// Security properties of FundingPool (spec 103, constitution I / SC-003 / SC-004):
//   I1 escrow == totalRaised while Open; == totalRaised − refunded while Refunding; == 0 once Closed
//   I2 value leaves ONLY via close (→ organizer) or claimRefund (→ the claimant's own contribution)
//   I3 Closed / Refunding are terminal
//   I4 an Open pool at settleDeadline can always be moved to Refunding by anyone
//   I5 refundVotes <= contributorCount; refundedCount <= contributorCount
// plus reentrancy probes on every value-moving path with a malicious token.

describe('FundingPool — security properties', function () {
  let admin, organizer, signers, factory, token;

  beforeEach(async function () {
    [admin, organizer, ...signers] = await ethers.getSigners();
    ({ factory } = await deployFundingFactory({ admin: admin.address }));
    token = await deployToken([organizer, ...signers.slice(0, 8)], 10000);
  });

  // Deterministic PRNG so a failure is reproducible from the seed printed in the assertion.
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  async function checkInvariants(pool, label) {
    const [state, totalRaised, contributorCount, refundVotes, refundedCount] = await Promise.all([
      pool.state(), pool.totalRaised(), pool.contributorCount(), pool.refundVotes(), pool.refundedCount(),
    ]);
    const bal = await token.balanceOf(await pool.getAddress());
    expect(refundVotes, `${label}: I5 votes`).to.be.at.most(contributorCount);
    expect(refundedCount, `${label}: I5 refunded`).to.be.at.most(contributorCount);
    if (state === STATE.Open) expect(bal, `${label}: I1 open`).to.equal(totalRaised);
    if (state === STATE.Closed) expect(bal, `${label}: I1 closed`).to.equal(0n);
    return { state, totalRaised, bal };
  }

  for (const seed of [1, 7, 42, 1337, 2024]) {
    it(`random contribute / vote / close / cancel / poke / claim sequence keeps every invariant (seed ${seed})`, async function () {
      const rand = rng(seed);
      const actors = signers.slice(0, 6);
      const { pool, params } = await (async () => {
        const p = await defaultParams(token, { goal: usdc(50) });
        return { ...(await createPool(factory, organizer, p)), params: p };
      })();
      const poolAddr = await pool.getAddress();
      const ledger = new Map(); // address → contributed
      const refunded = new Set();
      let paidOut = 0n;
      const startOrganizer = await token.balanceOf(organizer.address);
      const start = new Map();
      for (const a of actors) start.set(a.address, await token.balanceOf(a.address));

      for (let step = 0; step < 40; step += 1) {
        const r = rand();
        const actor = actors[Math.floor(rand() * actors.length)];
        const state = await pool.state();
        try {
          if (r < 0.45) {
            const amt = usdc(Math.floor(rand() * 20) + 1);
            await contribute(pool, token, actor, amt);
            ledger.set(actor.address, (ledger.get(actor.address) ?? 0n) + amt);
          } else if (r < 0.6) {
            await pool.connect(actor).voteRefund();
          } else if (r < 0.68) {
            await pool.connect(organizer).close();
            paidOut = await pool.totalRaised();
          } else if (r < 0.73) {
            await pool.connect(organizer).cancel();
          } else if (r < 0.78) {
            if (rand() < 0.3) await time.increaseTo(params.settleDeadline);
            await pool.connect(actor).pokeDeadline();
          } else if (r < 0.95) {
            await pool.connect(actor).claimRefund();
            refunded.add(actor.address);
          } else {
            // An outsider (never a contributor) trying every exit must always fail.
            const outsider = signers[7];
            await expect(pool.connect(outsider).close()).to.be.reverted;
            await expect(pool.connect(outsider).claimRefund()).to.be.reverted;
            await expect(pool.connect(outsider).voteRefund()).to.be.reverted;
          }
        } catch (e) {
          // Reverts are expected for illegal moves; the invariants below are what must hold.
          if (!/revert|custom error|reverted/i.test(String(e?.message))) throw e;
        }
        const { state: after } = await checkInvariants(pool, `seed ${seed} step ${step}`);
        // I3: terminal states never go back.
        if (state !== STATE.Open) expect(after, `seed ${seed} step ${step}: I3`).to.equal(state);
      }

      // Drain: if refunding, everyone collects; if open, poke past the deadline then collect.
      let state = await pool.state();
      if (state === STATE.Open) {
        await time.increaseTo(params.settleDeadline);
        await pool.connect(signers[7]).pokeDeadline();
        state = await pool.state();
      }
      if (state === STATE.Refunding) {
        for (const a of actors) {
          if ((ledger.get(a.address) ?? 0n) > 0n && !refunded.has(a.address)) await pool.connect(a).claimRefund();
        }
        expect(await token.balanceOf(poolAddr), 'all refunds drained').to.equal(0n);
        // I2: every contributor is exactly whole; the organizer got nothing.
        for (const a of actors) expect(await token.balanceOf(a.address), `refund ${a.address}`).to.equal(start.get(a.address));
        expect(await token.balanceOf(organizer.address)).to.equal(startOrganizer);
      } else {
        // Closed: the organizer holds exactly the pot; contributors are down by exactly what they gave.
        expect(await token.balanceOf(organizer.address)).to.equal(startOrganizer + paidOut);
        let sum = 0n;
        for (const a of actors) {
          const gave = ledger.get(a.address) ?? 0n;
          sum += gave;
          expect(await token.balanceOf(a.address)).to.equal(start.get(a.address) - gave);
        }
        expect(sum).to.equal(paidOut);
      }
      await checkInvariants(pool, `seed ${seed} final`);
    });
  }

  it('I4: however many contributors, an open pool past settleDeadline is always refundable by anyone', async function () {
    const p = await defaultParams(token);
    const { pool } = await createPool(factory, organizer, p);
    for (const a of signers.slice(0, 6)) await contribute(pool, token, a, usdc(3));
    await time.increaseTo(p.settleDeadline);
    await pool.connect(signers[7]).pokeDeadline();
    for (const a of signers.slice(0, 6)) await pool.connect(a).claimRefund();
    expect(await token.balanceOf(await pool.getAddress())).to.equal(0n);
  });

  describe('reentrancy (malicious token)', function () {
    let evil, pool;

    beforeEach(async function () {
      const Evil = await ethers.getContractFactory('ReentrantToken');
      evil = await Evil.deploy();
      await evil.waitForDeployment();
      for (const a of [organizer, signers[0]]) await evil.mint(a.address, usdc(1000));
      ({ pool } = await createPool(factory, organizer, await defaultParams(evil)));
    });

    it('contribute → re-entering contribute is blocked by the guard', async function () {
      const c = signers[0];
      await evil.connect(c).approve(await pool.getAddress(), usdc(100));
      await evil.arm(await pool.getAddress(), pool.interface.encodeFunctionData('contribute', [usdc(1)]));
      await expect(pool.connect(c).contribute(usdc(10))).to.be.revertedWithCustomError(pool, 'ReentrancyGuardReentrantCall');
      expect(await pool.totalRaised()).to.equal(0n);
      expect(await pool.contributorCount()).to.equal(0);
    });

    it('close → re-entering close / claimRefund is blocked by the guard', async function () {
      const c = signers[0];
      await evil.connect(c).approve(await pool.getAddress(), usdc(10));
      await pool.connect(c).contribute(usdc(10));
      await evil.arm(await pool.getAddress(), pool.interface.encodeFunctionData('close'));
      await expect(pool.connect(organizer).close()).to.be.revertedWithCustomError(pool, 'ReentrancyGuardReentrantCall');
      expect(await pool.state()).to.equal(STATE.Open);
      await evil.arm(await pool.getAddress(), pool.interface.encodeFunctionData('claimRefund'));
      await expect(pool.connect(organizer).close()).to.be.revertedWithCustomError(pool, 'ReentrancyGuardReentrantCall');
      expect(await pool.state()).to.equal(STATE.Open);
      expect(await evil.balanceOf(await pool.getAddress())).to.equal(usdc(10));
    });

    it('claimRefund → re-entering claimRefund is blocked; a plain claim then succeeds once', async function () {
      const c = signers[0];
      await evil.connect(c).approve(await pool.getAddress(), usdc(10));
      await pool.connect(c).contribute(usdc(10));
      await pool.connect(organizer).cancel();
      await evil.arm(await pool.getAddress(), pool.interface.encodeFunctionData('claimRefund'));
      await expect(pool.connect(c).claimRefund()).to.be.revertedWithCustomError(pool, 'ReentrancyGuardReentrantCall');
      expect(await pool.refunded(c.address)).to.equal(false);
      // The failed tx rolled the token's one-shot disarm back too — point it at a harmless EOA call.
      await evil.arm(c.address, '0x');
      await pool.connect(c).claimRefund();
      expect(await pool.refunded(c.address)).to.equal(true);
      await expect(pool.connect(c).claimRefund()).to.be.revertedWithCustomError(pool, 'NothingToRefund');
    });
  });

  it('no function moves value to an arbitrary address: the ABI exposes no recipient/sweep surface', async function () {
    const names = (await ethers.getContractFactory('FundingPool')).interface.fragments
      .filter((f) => f.type === 'function')
      .map((f) => f.name);
    for (const banned of ['sweep', 'rescue', 'withdraw', 'transferTo', 'setOrganizer', 'setGoal', 'setPurpose']) {
      expect(names, `unexpected ${banned}`).to.not.include(banned);
    }
    const iface = (await ethers.getContractFactory('FundingPool')).interface;
    expect(iface.getFunction('close').inputs.length, 'close takes no recipient').to.equal(0);
    expect(iface.getFunction('claimRefund').inputs.length, 'claimRefund takes no recipient').to.equal(0);
  });
});
