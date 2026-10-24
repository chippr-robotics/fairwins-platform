const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deployPoolFactory, deployToken, defaultParams, createPool, matrixHash, usdc } = require('../../helpers/wagerpool');

// End-to-end lifecycle with compliance ENABLED (screeningRequired + sanctions + membership guards),
// proving the pool -> factory screen/requireMembership callbacks gate JOIN on the real wallet (FR-021),
// then a full create -> join -> close -> propose -> approve -> claim cycle succeeds for allowed members.

describe('WagerPool lifecycle (compliance enabled)', function () {
  let admin, creator, m2, sanctioned, recipient, guard, membership, factory, token, pool;

  beforeEach(async function () {
    [admin, creator, m2, sanctioned, recipient] = await ethers.getSigners();

    const Sanctions = await ethers.getContractFactory('MockPoolSanctions');
    guard = await Sanctions.deploy();
    const Membership = await ethers.getContractFactory('MockPoolMembership');
    membership = await Membership.deploy();

    ({ factory } = await deployPoolFactory({
      admin: admin.address,
      screeningRequired: true,
      sanctionsGuard: await guard.getAddress(),
      membershipManager: await membership.getAddress(),
    }));
    token = await deployToken([creator, m2, sanctioned]);
    await factory.connect(admin).setAllowedToken(await token.getAddress(), true); // FR-024 allowlist (screening on)

    ({ pool } = await createPool(factory, creator, await defaultParams(token, { maxMembers: 2, thresholdBips: 10000 })));
  });

  async function join(signer) {
    await token.connect(signer).approve(await pool.getAddress(), await pool.buyIn());
    return pool.connect(signer).join();
  }

  it('blocks a sanctioned member at join (screen callback)', async function () {
    await guard.setDenied(sanctioned.address, true);
    await expect(join(sanctioned)).to.be.revertedWithCustomError(guard, 'SanctionedAddress');
  });

  it('blocks a non-member at join (requireMembership callback)', async function () {
    await membership.setAllowed(false);
    await expect(join(m2)).to.be.revertedWithCustomError(factory, 'MembershipDenied');
  });

  it('runs the full lifecycle for allowed members and pays winners by address', async function () {
    await join(creator);
    await join(m2); // auto-closes, escrow 20
    expect(await pool.state()).to.equal(1n);

    const entries = [
      { winner: creator.address, amount: usdc(12) },
      { winner: m2.address, amount: usdc(8) },
    ];
    await pool.connect(creator).proposeOutcome(entries);
    await pool.connect(creator).approve(await pool.currentProposalId());
    await pool.connect(m2).approve(await pool.currentProposalId()); // locks
    expect(await pool.state()).to.equal(2n);

    await pool.connect(creator).claim(entries, 0, recipient.address);
    await pool.connect(m2).claim(entries, 1, m2.address);
    expect(await token.balanceOf(recipient.address)).to.equal(usdc(12));
    expect(await token.balanceOf(await pool.getAddress())).to.equal(0);
  });
});
