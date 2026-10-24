const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');
const { anyValue } = require('@nomicfoundation/hardhat-chai-matchers/withArgs');
const {
  deployFundingFactory,
  deployToken,
  defaultParams,
  createPool,
  usdc,
  ZERO,
} = require('../helpers/fundingpool');

// FundingPoolFactory (spec 103): screens the organizer, validates params + deadlines, clones an immutable
// FundingPool, assigns a unique 4-word tuple in its own namespace, and records the pool. Admin surface
// is DEFAULT_ADMIN_ROLE-gated. Mirrors test/pools/WagerPoolFactory.test.js.

describe('FundingPoolFactory', function () {
  let admin, organizer, other, factory, poolImpl, token;

  beforeEach(async function () {
    [admin, organizer, other] = await ethers.getSigners();
    ({ factory, poolImpl } = await deployFundingFactory({ admin: admin.address }));
    token = await deployToken([organizer, other]);
  });

  it('initializes with the template, guards off, and the admin roles', async function () {
    expect(await factory.poolImpl()).to.equal(await poolImpl.getAddress());
    expect(await factory.screeningRequired()).to.equal(false);
    expect(await factory.sanctionsGuard()).to.equal(ZERO);
    expect(await factory.membershipManager()).to.equal(ZERO);
    expect(await factory.hasRole(await factory.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
    expect(await factory.hasRole(await factory.UPGRADER_ROLE(), admin.address)).to.equal(true);
    expect(await factory.poolCount()).to.equal(0n);
    expect(await factory.MAX_PURPOSE_BYTES()).to.equal(200n);
    expect(await factory.MAX_CONTRIBUTE_WINDOW()).to.equal(30n * 86400n);
    expect(await factory.MAX_SETTLE_WINDOW()).to.equal(180n * 86400n);
  });

  it('refuses to initialize with a zero template, or screeningRequired without both guards', async function () {
    const Factory = await ethers.getContractFactory('FundingPoolFactory');
    await expect(upgrades.deployProxy(Factory, [admin.address, ZERO, ZERO, ZERO, false], { kind: 'uups' })).to.be.reverted;
    await expect(
      upgrades.deployProxy(Factory, [admin.address, await poolImpl.getAddress(), ZERO, ZERO, true], { kind: 'uups' })
    ).to.be.reverted;
  });

  it('createPool: clones, registers, assigns a phrase, emits PoolCreated with the purpose', async function () {
    const params = await defaultParams(token);
    await expect(factory.connect(organizer).createPool(params))
      .to.emit(factory, 'PoolCreated')
      .withArgs(1n, anyValue, organizer.address, anyValue, params.token, params.goal, params.purpose, params.contributeDeadline, params.settleDeadline);
    const addr = await factory.poolById(1);
    expect(await factory.poolCount()).to.equal(1n);
    expect(await factory.poolAddressToId(addr)).to.equal(1n);
    const idx = [...(await factory.phraseOfPool(addr))].map(Number);
    expect(idx.length).to.equal(4);
    for (const i of idx) expect(Number(i)).to.be.within(0, 2047);
    expect(await factory.poolByPhrase(idx)).to.equal(addr);
    const pool = await ethers.getContractAt('FundingPool', addr);
    expect(await pool.organizer()).to.equal(organizer.address);
    expect(await pool.purpose()).to.equal(params.purpose);
  });

  it('assigns distinct phrases to distinct pools; an unknown phrase resolves to zero', async function () {
    const { address: a } = await createPool(factory, organizer, await defaultParams(token));
    const { address: b } = await createPool(factory, organizer, await defaultParams(token));
    const pa = await factory.phraseOfPool(a);
    const pb = await factory.phraseOfPool(b);
    expect(pa.map(Number)).to.not.deep.equal(pb.map(Number));
    expect(await factory.poolByPhrase([0, 0, 0, 1])).to.equal(ZERO);
    expect(await factory.poolAddressToId(other.address)).to.equal(0n);
  });

  it('validates params: zero token, zero goal, empty / over-long purpose', async function () {
    const base = await defaultParams(token);
    await expect(factory.connect(organizer).createPool({ ...base, token: ZERO })).to.be.revertedWithCustomError(factory, 'InvalidParams');
    await expect(factory.connect(organizer).createPool({ ...base, goal: 0n })).to.be.revertedWithCustomError(factory, 'InvalidParams');
    await expect(factory.connect(organizer).createPool({ ...base, purpose: '' })).to.be.revertedWithCustomError(factory, 'PurposeLength');
    await expect(factory.connect(organizer).createPool({ ...base, purpose: 'x'.repeat(201) })).to.be.revertedWithCustomError(factory, 'PurposeLength');
    // Exactly 200 bytes is fine; multi-byte characters count as bytes.
    await factory.connect(organizer).createPool({ ...base, purpose: 'x'.repeat(200) });
    await expect(factory.connect(organizer).createPool({ ...base, purpose: 'é'.repeat(101) })).to.be.revertedWithCustomError(factory, 'PurposeLength');
  });

  it('validates deadlines: future, ordered, and within the 30/180-day bounds', async function () {
    const now = (await ethers.provider.getBlock('latest')).timestamp;
    const base = await defaultParams(token);
    const bad = (o) => expect(factory.connect(organizer).createPool({ ...base, ...o })).to.be.revertedWithCustomError(factory, 'BadDeadlines');
    await bad({ contributeDeadline: now - 1 });
    await bad({ contributeDeadline: now + 100, settleDeadline: now + 100 });
    await bad({ contributeDeadline: now + 100, settleDeadline: now + 50 });
    await bad({ contributeDeadline: now + 31 * 86400, settleDeadline: now + 40 * 86400 });
    await bad({ contributeDeadline: now + 86400, settleDeadline: now + 181 * 86400 });
    await factory.connect(organizer).createPool({ ...base, contributeDeadline: now + 29 * 86400, settleDeadline: now + 179 * 86400 });
  });

  it('screening: a sanctioned organizer cannot create; a sanctioned wallet cannot contribute', async function () {
    const Guard = await ethers.getContractFactory('MockPoolSanctions');
    const guard = await Guard.deploy();
    await guard.waitForDeployment();
    await expect(factory.connect(admin).setSanctionsGuard(await guard.getAddress()))
      .to.emit(factory, 'SanctionsGuardUpdated').withArgs(await guard.getAddress());

    await guard.setDenied(other.address, true);
    await expect(factory.connect(other).createPool(await defaultParams(token)))
      .to.be.revertedWithCustomError(guard, 'SanctionedAddress');
    const { pool } = await createPool(factory, organizer, await defaultParams(token));
    await token.connect(other).approve(await pool.getAddress(), usdc(1));
    await expect(pool.connect(other).contribute(usdc(1))).to.be.revertedWithCustomError(guard, 'SanctionedAddress');
    // The clean organizer can still contribute.
    await token.connect(organizer).approve(await pool.getAddress(), usdc(1));
    await pool.connect(organizer).contribute(usdc(1));
    // Non-admins cannot repoint the guard.
    await expect(factory.connect(other).setSanctionsGuard(ZERO)).to.be.reverted;
  });

  it('screeningRequired: the token must be allow-listed, and neither guard can be unset', async function () {
    const Guard = await ethers.getContractFactory('MockPoolSanctions');
    const guard = await Guard.deploy();
    const Membership = await ethers.getContractFactory('MockPoolMembership');
    const membership = await Membership.deploy();
    const { factory: strict } = await deployFundingFactory({
      admin: admin.address,
      screeningRequired: true,
      sanctionsGuard: await guard.getAddress(),
      membershipManager: await membership.getAddress(),
    });
    await expect(strict.connect(organizer).createPool(await defaultParams(token))).to.be.revertedWithCustomError(strict, 'TokenNotAllowed');
    await strict.connect(admin).setAllowedToken(await token.getAddress(), true);
    await strict.connect(organizer).createPool(await defaultParams(token));
    await expect(strict.connect(admin).setSanctionsGuard(ZERO)).to.be.revertedWithCustomError(strict, 'ScreeningNotConfigured');
    await expect(strict.connect(admin).setMembershipManager(ZERO)).to.be.revertedWithCustomError(strict, 'MembershipNotConfigured');
    // Denied token again → refused again.
    await strict.connect(admin).setAllowedToken(await token.getAddress(), false);
    await expect(strict.connect(organizer).createPool(await defaultParams(token))).to.be.revertedWithCustomError(strict, 'TokenNotAllowed');
  });

  it('membership: requireMembership gates organizer and contributors on POOL_PARTICIPANT_ROLE', async function () {
    const Membership = await ethers.getContractFactory('MockPoolMembership');
    const membership = await Membership.deploy();
    await membership.waitForDeployment();
    await factory.connect(admin).setMembershipManager(await membership.getAddress());
    const { pool } = await createPool(factory, organizer, await defaultParams(token));
    await membership.setAllowed(false);
    await expect(factory.connect(other).createPool(await defaultParams(token))).to.be.revertedWithCustomError(factory, 'MembershipDenied');
    await token.connect(other).approve(await pool.getAddress(), usdc(1));
    await expect(pool.connect(other).contribute(usdc(1))).to.be.revertedWithCustomError(factory, 'MembershipDenied');
    await membership.setAllowed(true);
    await pool.connect(other).contribute(usdc(1));
    expect(await factory.POOL_PARTICIPANT_ROLE()).to.equal(ethers.keccak256(ethers.toUtf8Bytes('POOL_PARTICIPANT_ROLE')));
  });

  it('admin: setTemplate swaps the clone template for FUTURE pools only; non-admins are refused', async function () {
    const Pool = await ethers.getContractFactory('FundingPool');
    const impl2 = await Pool.deploy();
    await expect(factory.connect(other).setTemplate(await impl2.getAddress())).to.be.reverted;
    await expect(factory.connect(admin).setTemplate(ZERO)).to.be.revertedWithCustomError(factory, 'InvalidParams');
    await expect(factory.connect(admin).setTemplate(await impl2.getAddress())).to.emit(factory, 'TemplateUpdated').withArgs(await impl2.getAddress());
    expect(await factory.poolImpl()).to.equal(await impl2.getAddress());
    await expect(factory.connect(other).setAllowedToken(await token.getAddress(), true)).to.be.reverted;
    await expect(factory.connect(admin).setAllowedToken(await token.getAddress(), true)).to.emit(factory, 'TokenAllowed');
  });

  it('the factory never holds funds: contributions sit in the clone', async function () {
    const { pool } = await createPool(factory, organizer, await defaultParams(token));
    await token.connect(other).approve(await pool.getAddress(), usdc(7));
    await pool.connect(other).contribute(usdc(7));
    expect(await token.balanceOf(await factory.getAddress())).to.equal(0n);
    expect(await token.balanceOf(await pool.getAddress())).to.equal(usdc(7));
  });
});
