const { expect } = require('chai');
const { ethers } = require('hardhat');
const { deployPoolFactory, deployToken, defaultParams, createPool, ZERO } = require('../helpers/wagerpool');

// WagerPoolFactory (spec 034, address-based) — create + creator screening, sanctions-guard-required
// revert, phrase uniqueness/collision, clone+registry, PoolCreated, param + deadline validation
// (deadlines mirror WagerRegistry: acceptDeadline + resolveDeadline, bounded 30d/180d).

describe('WagerPoolFactory', function () {
  let admin, creator, other;

  beforeEach(async function () {
    [admin, creator, other] = await ethers.getSigners();
  });

  it('initializes and exposes an empty, network-scoped registry', async function () {
    const { factory } = await deployPoolFactory({ admin: admin.address });
    expect(await factory.hasRole(await factory.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
    expect(await factory.poolCount()).to.equal(0);
    expect(await factory.poolImpl()).to.not.equal(ZERO);
  });

  it('rejects re-initialization', async function () {
    const { factory, poolImpl } = await deployPoolFactory({ admin: admin.address });
    await expect(
      factory.initialize(admin.address, await poolImpl.getAddress(), ZERO, ZERO, false)
    ).to.be.revertedWithCustomError(factory, 'InvalidInitialization');
  });

  it('reverts deployment when screening is required but guards are unset (FR-021a)', async function () {
    await expect(deployPoolFactory({ admin: admin.address, screeningRequired: true })).to.be.revertedWithCustomError(await ethers.getContractFactory('WagerPoolFactory'), 'InvalidParams');
  });

  it('creates a pool: emits PoolCreated, clones a pool, records it, resolves by phrase', async function () {
    const { factory } = await deployPoolFactory({ admin: admin.address });
    const token = await deployToken();
    const params = await defaultParams(token);

    await expect(factory.connect(creator).createPool(params)).to.emit(factory, 'PoolCreated');

    const params2 = await defaultParams(token);
    const { pool, poolId, wordIndices } = await createPool(factory, creator, params2);
    expect(poolId).to.equal(2n); // first create above was id 1
    expect(await factory.poolById(poolId)).to.equal(await pool.getAddress());
    expect(await factory.poolAddressToId(await pool.getAddress())).to.equal(poolId);

    const wi = wordIndices.map((x) => Number(x));
    expect(await factory.poolByPhrase(wi)).to.equal(await pool.getAddress());
    const phrase = await factory.phraseOfPool(await pool.getAddress());
    expect(phrase.map(Number)).to.deep.equal(wi);

    expect(await pool.creator()).to.equal(creator.address);
    expect(await pool.thresholdBips()).to.equal(params2.thresholdBips);
    expect(await pool.maxMembers()).to.equal(params2.maxMembers);
    expect(await pool.acceptDeadline()).to.equal(params2.acceptDeadline);
    expect(await pool.resolveDeadline()).to.equal(params2.resolveDeadline);
    expect(await pool.factory()).to.equal(await factory.getAddress());
  });

  it('assigns unique 4-word phrases across pools (FR-003)', async function () {
    const { factory } = await deployPoolFactory({ admin: admin.address });
    const token = await deployToken();
    const a = await createPool(factory, creator, await defaultParams(token));
    const b = await createPool(factory, creator, await defaultParams(token));
    expect(a.wordIndices.map(Number)).to.not.deep.equal(b.wordIndices.map(Number));
    a.wordIndices.forEach((i) => expect(Number(i)).to.be.lessThan(2048));
  });

  it('validates non-deadline params (cap, threshold, buyIn, token)', async function () {
    const { factory } = await deployPoolFactory({ admin: admin.address });
    const token = await deployToken();

    await expect(factory.connect(creator).createPool(await defaultParams(token, { maxMembers: 1001 })))
      .to.be.revertedWithCustomError(factory, 'InvalidParams');
    await expect(factory.connect(creator).createPool(await defaultParams(token, { maxMembers: 1 })))
      .to.be.revertedWithCustomError(factory, 'InvalidParams');
    await expect(factory.connect(creator).createPool(await defaultParams(token, { thresholdBips: 0 })))
      .to.be.revertedWithCustomError(factory, 'InvalidParams');
    await expect(factory.connect(creator).createPool(await defaultParams(token, { thresholdBips: 10001 })))
      .to.be.revertedWithCustomError(factory, 'InvalidParams');
    await expect(factory.connect(creator).createPool(await defaultParams(token, { buyIn: 0 })))
      .to.be.revertedWithCustomError(factory, 'InvalidParams');
    await expect(factory.connect(creator).createPool(await defaultParams(token, { token: ZERO })))
      .to.be.revertedWithCustomError(factory, 'InvalidParams');
  });

  it('validates deadlines like WagerRegistry (BadDeadlines: order + 30d/180d bounds)', async function () {
    const { factory } = await deployPoolFactory({ admin: admin.address });
    const token = await deployToken();
    const now = (await ethers.provider.getBlock('latest')).timestamp;
    const DAY = 24 * 3600;

    // accept in the past
    await expect(factory.connect(creator).createPool(await defaultParams(token, { acceptDeadline: now - 1 })))
      .to.be.revertedWithCustomError(factory, 'BadDeadlines');
    // resolve <= accept
    await expect(
      factory
        .connect(creator)
        .createPool(await defaultParams(token, { acceptDeadline: now + 5 * DAY, resolveDeadline: now + 5 * DAY }))
    ).to.be.revertedWithCustomError(factory, 'BadDeadlines');
    // accept beyond 30-day horizon
    await expect(
      factory
        .connect(creator)
        .createPool(await defaultParams(token, { acceptDeadline: now + 31 * DAY, resolveDeadline: now + 60 * DAY }))
    ).to.be.revertedWithCustomError(factory, 'BadDeadlines');
    // resolve beyond 180-day horizon
    await expect(
      factory
        .connect(creator)
        .createPool(await defaultParams(token, { acceptDeadline: now + 5 * DAY, resolveDeadline: now + 181 * DAY }))
    ).to.be.revertedWithCustomError(factory, 'BadDeadlines');
    // a valid boundary set succeeds
    await expect(
      factory
        .connect(creator)
        .createPool(await defaultParams(token, { acceptDeadline: now + 30 * DAY, resolveDeadline: now + 180 * DAY }))
    ).to.emit(factory, 'PoolCreated');
  });

  it('screens the creator: sanctioned and non-member creators are rejected (FR-021)', async function () {
    const Sanctions = await ethers.getContractFactory('MockPoolSanctions');
    const guard = await Sanctions.deploy();
    const Membership = await ethers.getContractFactory('MockPoolMembership');
    const membership = await Membership.deploy();
    const { factory } = await deployPoolFactory({
      admin: admin.address,
      screeningRequired: true,
      sanctionsGuard: await guard.getAddress(),
      membershipManager: await membership.getAddress(),
    });
    const token = await deployToken();

    await guard.setDenied(creator.address, true);
    await expect(factory.connect(creator).createPool(await defaultParams(token)))
      .to.be.revertedWithCustomError(guard, 'SanctionedAddress');

    await guard.setDenied(creator.address, false);
    await membership.setAllowed(false);
    await expect(factory.connect(creator).createPool(await defaultParams(token)))
      .to.be.revertedWithCustomError(factory, 'MembershipDenied');

    await membership.setAllowed(true);
    await factory.connect(admin).setAllowedToken(await token.getAddress(), true); // FR-024 token allowlist
    await expect(factory.connect(creator).createPool(await defaultParams(token))).to.emit(factory, 'PoolCreated');
  });

  it('enforces the buy-in token allowlist on value-bearing networks (FR-024)', async function () {
    const Sanctions = await ethers.getContractFactory('MockPoolSanctions');
    const guard = await Sanctions.deploy();
    const Membership = await ethers.getContractFactory('MockPoolMembership');
    const membership = await Membership.deploy();
    const { factory } = await deployPoolFactory({
      admin: admin.address,
      screeningRequired: true,
      sanctionsGuard: await guard.getAddress(),
      membershipManager: await membership.getAddress(),
    });
    const token = await deployToken();

    // Not allowlisted -> rejected, even though the creator passes sanctions + membership.
    await expect(factory.connect(creator).createPool(await defaultParams(token)))
      .to.be.revertedWithCustomError(factory, 'TokenNotAllowed');

    // Admin curates the token; only admin may.
    await expect(factory.connect(creator).setAllowedToken(await token.getAddress(), true))
      .to.be.revertedWithCustomError(factory, 'AccessControlUnauthorizedAccount');
    await expect(factory.connect(admin).setAllowedToken(await token.getAddress(), true))
      .to.emit(factory, 'TokenAllowed')
      .withArgs(await token.getAddress(), true);

    await expect(factory.connect(creator).createPool(await defaultParams(token))).to.emit(factory, 'PoolCreated');

    // De-listing takes effect immediately for new pools.
    await factory.connect(admin).setAllowedToken(await token.getAddress(), false);
    await expect(factory.connect(creator).createPool(await defaultParams(token)))
      .to.be.revertedWithCustomError(factory, 'TokenNotAllowed');
  });

  it('gates admin setters', async function () {
    const { factory } = await deployPoolFactory({ admin: admin.address });
    await expect(factory.connect(other).setTemplate(other.address))
      .to.be.revertedWithCustomError(factory, 'AccessControlUnauthorizedAccount');
    await expect(factory.connect(other).setSanctionsGuard(other.address))
      .to.be.revertedWithCustomError(factory, 'AccessControlUnauthorizedAccount');
    // admin can swap the template
    await expect(factory.connect(admin).setTemplate(other.address)).to.emit(factory, 'TemplateUpdated');
    expect(await factory.poolImpl()).to.equal(other.address);
  });
});
