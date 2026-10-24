const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');
const { deployFundingFactory, deployToken, defaultParams, createPool } = require('../helpers/fundingpool');

// FundingPoolFactory is a UUPS proxy at a stable address. This proves an in-place upgrade preserves the
// pool registry + config and honors the append-only storage rule.

describe('FundingPoolFactory (UUPS upgrade)', function () {
  let admin, organizer;

  beforeEach(async function () {
    [admin, organizer] = await ethers.getSigners();
  });

  it('upgrades in place, preserving the registry, phrases and admin', async function () {
    const { factory } = await deployFundingFactory({ admin: admin.address });
    const token = await deployToken();
    const { pool, poolId } = await createPool(factory, organizer, await defaultParams(token));
    const proxyAddr = await factory.getAddress();
    const phrase = [...(await factory.phraseOfPool(await pool.getAddress()))].map(Number);

    const V2 = await ethers.getContractFactory('FundingPoolFactoryV2Mock');
    const upgraded = await upgrades.upgradeProxy(proxyAddr, V2, { unsafeAllow: ['missing-initializer'] });

    expect(await upgraded.getAddress()).to.equal(proxyAddr);
    expect(await upgraded.version()).to.equal(2n);
    expect(await upgraded.poolById(poolId)).to.equal(await pool.getAddress());
    expect(await upgraded.poolCount()).to.equal(1n);
    expect(await upgraded.poolByPhrase(phrase)).to.equal(await pool.getAddress());
    expect(await upgraded.hasRole(await upgraded.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);

    const { pool: pool2 } = await createPool(upgraded, organizer, await defaultParams(token));
    expect(await upgraded.poolCount()).to.equal(2n);
    expect(await pool2.organizer()).to.equal(organizer.address);
  });

  it('rejects an upgrade from a non-admin', async function () {
    const { factory } = await deployFundingFactory({ admin: admin.address });
    const V2 = await ethers.getContractFactory('FundingPoolFactoryV2Mock', organizer);
    await expect(
      upgrades.upgradeProxy(await factory.getAddress(), V2, { unsafeAllow: ['missing-initializer'] })
    ).to.be.reverted;
  });
});
