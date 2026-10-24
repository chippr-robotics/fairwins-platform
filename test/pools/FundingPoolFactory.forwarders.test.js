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
  signCreatePool,
  signReceiveAuth,
} = require('../helpers/fundingpool');

// FundingPoolFactory relayer forwarders (spec 103, spec-035/036 pattern): each routes a clone's twin
// through the STABLE factory address, enforces pool provenance ON-CHAIN (poolAddressToId != 0), and is
// otherwise a pure pass-through — the clone verifies the signer's EIP-712 signature against its own
// per-clone domain. Also: createPoolWithSig is verified against the FACTORY's domain.

describe('FundingPoolFactory — relayer forwarders', function () {
  let admin, organizer, c1, c2, c3, relayer, factory, token, pool;

  beforeEach(async function () {
    [admin, organizer, c1, c2, c3, relayer] = await ethers.getSigners();
    ({ factory } = await deployFundingFactory({ admin: admin.address }));
    token = await deployToken([organizer, c1, c2, c3, relayer]);
    ({ pool } = await createPool(factory, organizer, await defaultParams(token)));
  });

  const splat = (a) => [a.nonce, a.validAfter, a.validBefore, a.sig];

  it('every forwarder refuses an address this factory did not create (UnknownPool)', async function () {
    const a = await signClose(pool, organizer);
    const notPool = relayer.address;
    await expect(factory.closeWithSigFor(notPool, organizer.address, ...splat(a))).to.be.revertedWithCustomError(factory, 'UnknownPool');
    await expect(factory.cancelWithSigFor(notPool, organizer.address, ...splat(a))).to.be.revertedWithCustomError(factory, 'UnknownPool');
    await expect(factory.voteRefundWithSigFor(notPool, c1.address, ...splat(a))).to.be.revertedWithCustomError(factory, 'UnknownPool');
    await expect(factory.claimRefundWithSigFor(notPool, c1.address, ...splat(a))).to.be.revertedWithCustomError(factory, 'UnknownPool');
    await expect(factory.pokeDeadlineFor(notPool)).to.be.revertedWithCustomError(factory, 'UnknownPool');
    await expect(factory.invalidateNonceWithSigFor(notPool, organizer.address, a.nonce, a.validBefore, a.sig)).to.be.revertedWithCustomError(factory, 'UnknownPool');
    const auth = await signReceiveAuth(token, c1, notPool, usdc(1));
    await expect(
      factory.contributeWithAuthorizationFor(notPool, c1.address, usdc(1), auth.validAfter, auth.validBefore, auth.nonce, auth.v, auth.r, auth.s)
    ).to.be.revertedWithCustomError(factory, 'UnknownPool');
  });

  it('contributeWithAuthorizationFor: the money moves from the signer into the CLONE, never the factory', async function () {
    const auth = await signReceiveAuth(token, c1, await pool.getAddress(), usdc(9));
    await factory.connect(relayer).contributeWithAuthorizationFor(
      await pool.getAddress(), c1.address, usdc(9), auth.validAfter, auth.validBefore, auth.nonce, auth.v, auth.r, auth.s
    );
    expect(await pool.contributed(c1.address)).to.equal(usdc(9));
    expect(await token.balanceOf(await pool.getAddress())).to.equal(usdc(9));
    expect(await token.balanceOf(await factory.getAddress())).to.equal(0n);
  });

  it('closeWithSigFor / cancelWithSigFor forward and attribute to the signer; clone guards bubble up', async function () {
    await contribute(pool, token, c1, usdc(10));
    const bad = await signClose(pool, c1);
    await expect(factory.connect(relayer).closeWithSigFor(await pool.getAddress(), c1.address, ...splat(bad)))
      .to.be.revertedWithCustomError(pool, 'NotOrganizer');
    const a = await signClose(pool, organizer);
    const before = await token.balanceOf(organizer.address);
    await factory.connect(relayer).closeWithSigFor(await pool.getAddress(), organizer.address, ...splat(a));
    expect(await token.balanceOf(organizer.address)).to.equal(before + usdc(10));
    expect(await pool.state()).to.equal(STATE.Closed);

    const { pool: p2 } = await createPool(factory, organizer, await defaultParams(token));
    const c = await signCancel(p2, organizer);
    await expect(factory.connect(relayer).cancelWithSigFor(await p2.getAddress(), organizer.address, ...splat(c)))
      .to.emit(p2, 'RefundingStarted').withArgs(REASON.Organizer);
  });

  it('voteRefundWithSigFor / claimRefundWithSigFor: majority via the forwarder, refunds to signers', async function () {
    await contribute(pool, token, c1, usdc(10));
    await contribute(pool, token, c2, usdc(20));
    await contribute(pool, token, c3, usdc(30));
    const v1 = await signVoteRefund(pool, c1);
    const v2 = await signVoteRefund(pool, c2);
    await factory.connect(relayer).voteRefundWithSigFor(await pool.getAddress(), c1.address, ...splat(v1));
    await factory.connect(relayer).voteRefundWithSigFor(await pool.getAddress(), c2.address, ...splat(v2));
    expect(await pool.state()).to.equal(STATE.Refunding);
    const b = await token.balanceOf(c2.address);
    const cl = await signClaimRefund(pool, c2);
    await factory.connect(relayer).claimRefundWithSigFor(await pool.getAddress(), c2.address, ...splat(cl));
    expect(await token.balanceOf(c2.address)).to.equal(b + usdc(20));
  });

  it('pokeDeadlineFor forwards the permissionless poke', async function () {
    await contribute(pool, token, c1, usdc(10));
    await expect(factory.pokeDeadlineFor(await pool.getAddress())).to.be.revertedWithCustomError(pool, 'DeadlineNotPassed');
    await time.increaseTo(await pool.settleDeadline());
    await factory.connect(relayer).pokeDeadlineFor(await pool.getAddress());
    expect(await pool.state()).to.equal(STATE.Refunding);
  });

  it('invalidateNonceWithSigFor revokes a signed-but-unsubmitted intent through the factory', async function () {
    const a = await signClose(pool, organizer);
    const { chainId } = await ethers.provider.getNetwork();
    const domain = { name: 'FairWins FundingPool', version: '1', chainId: Number(chainId), verifyingContract: await pool.getAddress() };
    const validBefore = (await time.latest()) + 3600;
    const sig = await organizer.signTypedData(
      domain,
      { InvalidateNonce: [{ name: 'signer', type: 'address' }, { name: 'nonce', type: 'bytes32' }, { name: 'validBefore', type: 'uint256' }] },
      { signer: organizer.address, nonce: a.nonce, validBefore }
    );
    await factory.connect(relayer).invalidateNonceWithSigFor(await pool.getAddress(), organizer.address, a.nonce, validBefore, sig);
    await expect(factory.connect(relayer).closeWithSigFor(await pool.getAddress(), organizer.address, ...splat(a)))
      .to.be.revertedWithCustomError(pool, 'IntentReplayed');
  });

  describe('createPoolWithSig (factory domain)', function () {
    it('creates for and attributes to the signer, burns the nonce', async function () {
      const params = await defaultParams(token, { purpose: 'Team offsite' });
      const a = await signCreatePool(factory, organizer, params);
      await expect(factory.connect(relayer).createPoolWithSig(params, organizer.address, ...splat(a)))
        .to.emit(factory, 'PoolCreated')
        .and.to.emit(factory, 'IntentNonceUsed').withArgs(organizer.address, a.nonce);
      const p = await ethers.getContractAt('FundingPool', await factory.poolById(2));
      expect(await p.organizer()).to.equal(organizer.address);
      expect(await p.purpose()).to.equal('Team offsite');
      await expect(factory.connect(relayer).createPoolWithSig(params, organizer.address, ...splat(a)))
        .to.be.revertedWithCustomError(factory, 'IntentReplayed');
    });

    it('binds the purpose: a changed purpose invalidates the signature', async function () {
      const params = await defaultParams(token, { purpose: 'Team offsite' });
      const a = await signCreatePool(factory, organizer, params);
      await expect(
        factory.connect(relayer).createPoolWithSig({ ...params, purpose: 'Team offsite!' }, organizer.address, ...splat(a))
      ).to.be.revertedWithCustomError(factory, 'InvalidIntentSignature');
    });

    it('rejects a wrong signer, an expired window, and a zero signer; a factory nonce is separate from clone nonces', async function () {
      const params = await defaultParams(token);
      const a = await signCreatePool(factory, c1, params);
      await expect(factory.connect(relayer).createPoolWithSig(params, organizer.address, ...splat(a)))
        .to.be.revertedWithCustomError(factory, 'InvalidIntentSignature');
      const expired = await signCreatePool(factory, organizer, params, { validBefore: (await time.latest()) - 1 });
      await expect(factory.connect(relayer).createPoolWithSig(params, organizer.address, ...splat(expired)))
        .to.be.revertedWithCustomError(factory, 'IntentExpired');
      const z = await signCreatePool(factory, organizer, params);
      await expect(factory.connect(relayer).createPoolWithSig(params, ethers.ZeroAddress, ...splat(z)))
        .to.be.revertedWithCustomError(factory, 'IntentSignerZero');
      // Same nonce on the factory and on the clone: independent namespaces.
      const nonce = randNonce();
      const f = await signCreatePool(factory, organizer, params, { nonce });
      await factory.connect(relayer).createPoolWithSig(params, organizer.address, ...splat(f));
      const c = await signClose(pool, organizer, { nonce });
      await factory.connect(relayer).closeWithSigFor(await pool.getAddress(), organizer.address, ...splat(c));
      expect(await pool.state()).to.equal(STATE.Closed);
    });
  });
});
