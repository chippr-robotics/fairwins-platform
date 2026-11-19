const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');
const { deployPoolFactory, deployToken, defaultParams, createPool } = require('../helpers/wagerpool');

// WagerPoolFactory is a UUPS proxy at a stable address. This proves an in-place upgrade preserves the
// pool registry + config and honors the append-only storage rule (no Semaphore slot to migrate).

describe('WagerPoolFactory (UUPS upgrade)', function () {
  let admin, creator;

  beforeEach(async function () {
    [admin, creator] = await ethers.getSigners();
  });

  it('upgrades in place, preserving the registry and admin', async function () {
    const { factory } = await deployPoolFactory({ admin: admin.address });
    const token = await deployToken();
    const { pool, poolId } = await createPool(factory, creator, await defaultParams(token));
    const proxyAddr = await factory.getAddress();

    const V2 = await ethers.getContractFactory('WagerPoolFactoryV2Mock');
    const upgraded = await upgrades.upgradeProxy(proxyAddr, V2, { unsafeAllow: ['missing-initializer'] });

    expect(await upgraded.getAddress()).to.equal(proxyAddr); // same address
    expect(await upgraded.version()).to.equal(2n); // new logic
    expect(await upgraded.poolById(poolId)).to.equal(await pool.getAddress()); // state preserved
    expect(await upgraded.poolCount()).to.equal(1n);
    expect(await upgraded.hasRole(await upgraded.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);

    // still functional after the upgrade
    const { pool: pool2 } = await createPool(upgraded, creator, await defaultParams(token));
    expect(await upgraded.poolCount()).to.equal(2n);
    expect(await pool2.creator()).to.equal(creator.address);
  });

  it('rejects an upgrade from a non-admin', async function () {
    const { factory } = await deployPoolFactory({ admin: admin.address });
    const V2 = await ethers.getContractFactory('WagerPoolFactoryV2Mock', creator);
    await expect(
      upgrades.upgradeProxy(await factory.getAddress(), V2, { unsafeAllow: ['missing-initializer'] })
    ).to.be.revertedWithCustomError(factory, 'AccessControlUnauthorizedAccount').withArgs(creator.address, await factory.UPGRADER_ROLE());
  });
});
