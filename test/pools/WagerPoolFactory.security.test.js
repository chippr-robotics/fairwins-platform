const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time } = require('@nomicfoundation/hardhat-network-helpers');
const { deployPoolFactory, deployToken, defaultParams, createPool, usdc, ZERO } = require('../helpers/wagerpool');

// Adversarial coverage for WagerPoolFactory (spec 034) beyond the happy-path suite: the full admin
// access-control matrix (incl. UUPS upgrade authorization), the token allowlist across allow/deny/re-allow
// and screening on/off, phrase uniqueness + resolution both directions, the screening callbacks, and the
// full createPool parameter + deadline BOUNDARY matrices. Re-initialization is blocked.

describe('WagerPoolFactory — security & access control', function () {
  let admin, creator, other;

  beforeEach(async function () {
    [admin, creator, other] = await ethers.getSigners();
  });

  async function deployScreened() {
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
    return { factory, guard, membership };
  }

  // =========================================================================
  // Admin access-control matrix
  // =========================================================================

  describe('access-control matrix (every admin setter + upgrade)', function () {
    it('setTemplate: rejects non-admin, rejects zero, accepts admin', async function () {
      const { factory } = await deployPoolFactory({ admin: admin.address });
      await expect(factory.connect(other).setTemplate(other.address)).to.be.revertedWithCustomError(
        factory,
        'AccessControlUnauthorizedAccount'
      );
      await expect(factory.connect(admin).setTemplate(ZERO)).to.be.revertedWithCustomError(factory, 'InvalidParams');
      await expect(factory.connect(admin).setTemplate(other.address)).to.emit(factory, 'TemplateUpdated');
      expect(await factory.poolImpl()).to.equal(other.address);
    });

    it('setSanctionsGuard: rejects non-admin, accepts admin', async function () {
      const { factory } = await deployPoolFactory({ admin: admin.address });
      await expect(factory.connect(other).setSanctionsGuard(other.address)).to.be.revertedWithCustomError(
        factory,
        'AccessControlUnauthorizedAccount'
      );
      await expect(factory.connect(admin).setSanctionsGuard(other.address)).to.emit(factory, 'SanctionsGuardUpdated');
      expect(await factory.sanctionsGuard()).to.equal(other.address);
    });

    it('setMembershipManager: rejects non-admin, accepts admin', async function () {
      const { factory } = await deployPoolFactory({ admin: admin.address });
      await expect(factory.connect(other).setMembershipManager(other.address)).to.be.revertedWithCustomError(
        factory,
        'AccessControlUnauthorizedAccount'
      );
      await factory.connect(admin).setMembershipManager(other.address);
      expect(await factory.membershipManager()).to.equal(other.address);
    });

    it('setAllowedToken: rejects non-admin, accepts admin', async function () {
      const { factory } = await deployPoolFactory({ admin: admin.address });
      await expect(factory.connect(other).setAllowedToken(other.address, true)).to.be.revertedWithCustomError(
        factory,
        'AccessControlUnauthorizedAccount'
      );
      await expect(factory.connect(admin).setAllowedToken(other.address, true))
        .to.emit(factory, 'TokenAllowed')
        .withArgs(other.address, true);
      expect(await factory.allowedToken(other.address)).to.equal(true);
    });

    it('upgrade: rejects a non-upgrader, accepts the admin (UPGRADER_ROLE)', async function () {
      const { factory } = await deployPoolFactory({ admin: admin.address });
      const V2 = await ethers.getContractFactory('WagerPoolFactoryV2Mock');
      const newImpl = await V2.deploy();
      await newImpl.waitForDeployment();

      await expect(
        factory.connect(other).upgradeToAndCall(await newImpl.getAddress(), '0x')
      ).to.be.revertedWithCustomError(factory, 'AccessControlUnauthorizedAccount');

      await factory.connect(admin).upgradeToAndCall(await newImpl.getAddress(), '0x');
      const upgraded = await ethers.getContractAt('WagerPoolFactoryV2Mock', await factory.getAddress());
      expect(await upgraded.version()).to.equal(2n);
    });
  });

  // =========================================================================
  // Token allowlist matrix
  // =========================================================================

  describe('token allowlist', function () {
    it('allow / deny / re-allow, enforced only when screeningRequired', async function () {
      const { factory } = await deployScreened();
      const token = await deployToken();
      const addr = await token.getAddress();

      // not allowed -> rejected
      await expect(factory.connect(creator).createPool(await defaultParams(token))).to.be.revertedWithCustomError(
        factory,
        'TokenNotAllowed'
      );
      // allow -> ok
      await factory.connect(admin).setAllowedToken(addr, true);
      await expect(factory.connect(creator).createPool(await defaultParams(token))).to.emit(factory, 'PoolCreated');
      // deny -> rejected again (takes effect immediately)
      await factory.connect(admin).setAllowedToken(addr, false);
      await expect(factory.connect(creator).createPool(await defaultParams(token))).to.be.revertedWithCustomError(
        factory,
        'TokenNotAllowed'
      );
      // re-allow -> ok
      await factory.connect(admin).setAllowedToken(addr, true);
      await expect(factory.connect(creator).createPool(await defaultParams(token))).to.emit(factory, 'PoolCreated');
    });

    it('any token is accepted when screening is off (allowlist not consulted)', async function () {
      const { factory } = await deployPoolFactory({ admin: admin.address });
      const token = await deployToken();
      expect(await factory.allowedToken(await token.getAddress())).to.equal(false); // never allowlisted
      await expect(factory.connect(creator).createPool(await defaultParams(token))).to.emit(factory, 'PoolCreated');
      // ...even after an explicit deny, screening-off pools ignore the list
      await factory.connect(admin).setAllowedToken(await token.getAddress(), false);
      await expect(factory.connect(creator).createPool(await defaultParams(token))).to.emit(factory, 'PoolCreated');
    });
  });

  // =========================================================================
  // Phrase uniqueness + resolution
  // =========================================================================

  describe('4-word phrase allocation', function () {
    it('assigns unique tuples across many pools, resolvable in both directions', async function () {
      const { factory } = await deployPoolFactory({ admin: admin.address });
      const token = await deployToken();
      const seen = new Set();
      const N = 25;
      for (let i = 0; i < N; i++) {
        const { pool, wordIndices } = await createPool(factory, creator, await defaultParams(token));
        const wi = wordIndices.map(Number);
        wi.forEach((x) => expect(x).to.be.within(0, 2047));
        const key = wi.join('-');
        expect(seen.has(key)).to.equal(false); // uniqueness (FR-003)
        seen.add(key);
        expect(await factory.poolByPhrase(wi)).to.equal(await pool.getAddress()); // phrase -> pool
        const back = await factory.phraseOfPool(await pool.getAddress());
        expect(back.map(Number)).to.deep.equal(wi); // pool -> phrase
      }
      expect(seen.size).to.equal(N);
    });

    it('resolution of an unknown phrase / pool returns the zero identity', async function () {
      const { factory } = await deployPoolFactory({ admin: admin.address });
      expect(await factory.poolByPhrase([2047, 2047, 2047, 2047])).to.equal(ZERO);
      const p = await factory.phraseOfPool(other.address);
      expect(p.map(Number)).to.deep.equal([0, 0, 0, 0]);
    });
  });

  // =========================================================================
  // Screening callbacks
  // =========================================================================

  describe('screening callbacks (screen / requireMembership)', function () {
    it('no-op when guards are unset and screening is off', async function () {
      const { factory } = await deployPoolFactory({ admin: admin.address });
      await factory.screen(creator.address); // does not revert
      await factory.requireMembership(creator.address); // does not revert
    });

    it('enforced when guards are set: sanctioned -> revert, non-member -> MembershipDenied', async function () {
      const { factory, guard, membership } = await deployScreened();
      await guard.setDenied(creator.address, true);
      await expect(factory.screen(creator.address)).to.be.revertedWithCustomError(guard, 'SanctionedAddress');
      await guard.setDenied(creator.address, false);
      await factory.screen(creator.address); // ok
      await membership.setAllowed(false);
      await expect(factory.requireMembership(creator.address)).to.be.revertedWithCustomError(
        factory,
        'MembershipDenied'
      );
    });

    it('the required-but-unset states are unreachable: nulling a guard under screeningRequired is blocked', async function () {
      // The `screen`/`requireMembership` internal branches that raise ScreeningNotConfigured /
      // MembershipNotConfigured require screeningRequired && guard==0, which the setters refuse to create.
      const { factory } = await deployScreened();
      await expect(factory.connect(admin).setSanctionsGuard(ZERO)).to.be.revertedWithCustomError(
        factory,
        'ScreeningNotConfigured'
      );
      await expect(factory.connect(admin).setMembershipManager(ZERO)).to.be.revertedWithCustomError(
        factory,
        'MembershipNotConfigured'
      );
    });

    it('cannot deploy with screeningRequired but unset guards (init InvalidParams)', async function () {
      await expect(deployPoolFactory({ admin: admin.address, screeningRequired: true })).to.be.revertedWithCustomError(await ethers.getContractFactory('WagerPoolFactory'), 'InvalidParams');
    });
  });

  // =========================================================================
  // createPool parameter boundaries
  // =========================================================================

  describe('createPool parameter boundaries', function () {
    let factory, token;
    beforeEach(async function () {
      ({ factory } = await deployPoolFactory({ admin: admin.address }));
      token = await deployToken();
    });

    it('token == 0 -> InvalidParams', async function () {
      await expect(factory.connect(creator).createPool(await defaultParams(token, { token: ZERO })))
        .to.be.revertedWithCustomError(factory, 'InvalidParams');
    });

    it('buyIn == 0 -> InvalidParams', async function () {
      await expect(factory.connect(creator).createPool(await defaultParams(token, { buyIn: 0 })))
        .to.be.revertedWithCustomError(factory, 'InvalidParams');
    });

    it('maxMembers: 1 rejected, 2 ok, 1000 ok, 1001 rejected', async function () {
      await expect(factory.connect(creator).createPool(await defaultParams(token, { maxMembers: 1 })))
        .to.be.revertedWithCustomError(factory, 'InvalidParams');
      await expect(factory.connect(creator).createPool(await defaultParams(token, { maxMembers: 2 }))).to.emit(
        factory,
        'PoolCreated'
      );
      await expect(factory.connect(creator).createPool(await defaultParams(token, { maxMembers: 1000 }))).to.emit(
        factory,
        'PoolCreated'
      );
      await expect(factory.connect(creator).createPool(await defaultParams(token, { maxMembers: 1001 })))
        .to.be.revertedWithCustomError(factory, 'InvalidParams');
    });

    it('thresholdBips: 0 rejected, 1 ok, 10000 ok, 10001 rejected', async function () {
      await expect(factory.connect(creator).createPool(await defaultParams(token, { thresholdBips: 0 })))
        .to.be.revertedWithCustomError(factory, 'InvalidParams');
      await expect(factory.connect(creator).createPool(await defaultParams(token, { thresholdBips: 1 }))).to.emit(
        factory,
        'PoolCreated'
      );
      await expect(factory.connect(creator).createPool(await defaultParams(token, { thresholdBips: 10000 }))).to.emit(
        factory,
        'PoolCreated'
      );
      await expect(factory.connect(creator).createPool(await defaultParams(token, { thresholdBips: 10001 })))
        .to.be.revertedWithCustomError(factory, 'InvalidParams');
    });
  });

  // =========================================================================
  // Deadline bounds + ordering (exact boundaries)
  // =========================================================================

  describe('deadline bounds & ordering', function () {
    const DAY = 24 * 3600;
    let factory, token;
    beforeEach(async function () {
      ({ factory } = await deployPoolFactory({ admin: admin.address }));
      token = await deployToken();
    });

    // Executes createPool at a controlled block.timestamp `t`, with deadlines expressed as offsets from t.
    async function createWithOffsets(acceptOff, resolveOff) {
      const t = (await time.latest()) + 100;
      await time.setNextBlockTimestamp(t);
      return factory.connect(creator).createPool({
        token: await token.getAddress(),
        buyIn: usdc(10),
        maxMembers: 5,
        thresholdBips: 6000,
        acceptDeadline: t + acceptOff,
        resolveDeadline: t + resolveOff,
      });
    }

    it('accept <= now -> BadDeadlines (== now and < now)', async function () {
      await expect(createWithOffsets(0, DAY)).to.be.revertedWithCustomError(factory, 'BadDeadlines');
      await expect(createWithOffsets(-1, DAY)).to.be.revertedWithCustomError(factory, 'BadDeadlines');
    });

    it('resolve <= accept -> BadDeadlines (== and <)', async function () {
      await expect(createWithOffsets(DAY, DAY)).to.be.revertedWithCustomError(factory, 'BadDeadlines');
      await expect(createWithOffsets(2 * DAY, DAY)).to.be.revertedWithCustomError(factory, 'BadDeadlines');
    });

    it('accept beyond the 30-day horizon -> BadDeadlines; exactly 30 days is accepted', async function () {
      await expect(createWithOffsets(30 * DAY + 1, 60 * DAY)).to.be.revertedWithCustomError(factory, 'BadDeadlines');
      await expect(createWithOffsets(30 * DAY, 60 * DAY)).to.emit(factory, 'PoolCreated');
    });

    it('resolve beyond the 180-day horizon -> BadDeadlines; exactly 180 days is accepted', async function () {
      await expect(createWithOffsets(DAY, 180 * DAY + 1)).to.be.revertedWithCustomError(factory, 'BadDeadlines');
      await expect(createWithOffsets(DAY, 180 * DAY)).to.emit(factory, 'PoolCreated');
    });

    it('the minimal valid window (accept now+1, resolve now+2) is accepted', async function () {
      await expect(createWithOffsets(1, 2)).to.emit(factory, 'PoolCreated');
    });
  });

  // =========================================================================
  // Re-initialization
  // =========================================================================

  it('rejects re-initialization', async function () {
    const { factory, poolImpl } = await deployPoolFactory({ admin: admin.address });
    await expect(
      factory.initialize(admin.address, await poolImpl.getAddress(), ZERO, ZERO, false)
    ).to.be.revertedWithCustomError(factory, 'InvalidInitialization');
  });
});
