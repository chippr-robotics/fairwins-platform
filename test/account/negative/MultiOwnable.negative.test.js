/**
 * Spec 112 FR-004 — MultiOwnable (as inherited by CoinbaseSmartWallet): every owner-set
 * guard driven down its failing side with the specific error asserted.
 *
 * Errors asserted by name here: AlreadyOwner, InvalidEthereumAddressOwner,
 * InvalidOwnerBytesLength, NoOwnerAtIndex, NotLastOwner, LastOwner,
 * WrongOwnerAtIndex, Unauthorized. Initialization-time checks are driven through
 * the factory (the only production path into `_initializeOwners` for an account).
 */

const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { createPasskey } = require('../helpers/webauthn');
const { abi, addrOwnerBytes, deployAccountFixture } = require('./fixtures');

const UINT160_MAX = (1n << 160n) - 1n;

describe('MultiOwnable — negative paths (spec 112 FR-004)', function () {
  describe('initialization (_initializeOwners via the factory)', function () {
    it('refuses a 20-byte (packed address) owner: InvalidOwnerBytesLength', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const packed = fx.stranger.address.toLowerCase(); // 20 bytes, not abi-encoded
      await expect(fx.factory.createAccount([packed], 1))
        .to.be.revertedWithCustomError(fx.impl, 'InvalidOwnerBytesLength')
        .withArgs(packed);
    });

    it('refuses a 33-byte and an empty owner: InvalidOwnerBytesLength', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const thirtyThree = '0x' + '11'.repeat(33);
      await expect(fx.factory.createAccount([thirtyThree], 1))
        .to.be.revertedWithCustomError(fx.impl, 'InvalidOwnerBytesLength')
        .withArgs(thirtyThree);
      await expect(fx.factory.createAccount(['0x'], 1))
        .to.be.revertedWithCustomError(fx.impl, 'InvalidOwnerBytesLength')
        .withArgs('0x');
    });

    it('refuses a later invalid owner even when the first is valid (whole list validated)', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const bad = '0x' + '22'.repeat(31);
      await expect(fx.factory.createAccount([addrOwnerBytes(fx.stranger.address), bad], 1))
        .to.be.revertedWithCustomError(fx.impl, 'InvalidOwnerBytesLength')
        .withArgs(bad);
    });

    it('refuses a 32-byte owner whose value exceeds uint160: InvalidEthereumAddressOwner', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const tooWide = abi.encode(['uint256'], [UINT160_MAX + 1n]);
      await expect(fx.factory.createAccount([tooWide], 1))
        .to.be.revertedWithCustomError(fx.impl, 'InvalidEthereumAddressOwner')
        .withArgs(tooWide);
    });

    it('control: a 32-byte owner at exactly uint160 max is accepted (boundary)', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const edge = abi.encode(['uint256'], [UINT160_MAX]);
      await expect(fx.factory.createAccount([edge], 1)).to.emit(fx.factory, 'AccountCreated');
    });

    it('refuses a duplicated initial owner: AlreadyOwner', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const dup = addrOwnerBytes(fx.stranger.address);
      await expect(fx.factory.createAccount([dup, dup], 1))
        .to.be.revertedWithCustomError(fx.impl, 'AlreadyOwner')
        .withArgs(dup);
    });
  });

  describe('addOwnerAddress / addOwnerPublicKey', function () {
    it('refuses re-adding an existing address owner: AlreadyOwner', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await expect(fx.account.connect(fx.driver).addOwnerAddress(fx.driver.address))
        .to.be.revertedWithCustomError(fx.account, 'AlreadyOwner')
        .withArgs(addrOwnerBytes(fx.driver.address));
      expect(await fx.account.nextOwnerIndex()).to.equal(2n);
    });

    it('refuses re-adding an existing passkey owner: AlreadyOwner', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const pk = createPasskey();
      await fx.account.connect(fx.driver).addOwnerPublicKey(pk.x, pk.y);
      await expect(fx.account.connect(fx.driver).addOwnerPublicKey(pk.x, pk.y))
        .to.be.revertedWithCustomError(fx.account, 'AlreadyOwner')
        .withArgs(pk.ownerBytes);
    });

    it('refuses addOwnerPublicKey from a non-owner: Unauthorized', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const pk = createPasskey();
      await expect(fx.account.connect(fx.stranger).addOwnerPublicKey(pk.x, pk.y)).to.be.revertedWithCustomError(
        fx.account,
        'Unauthorized'
      );
      expect(await fx.account.isOwnerPublicKey(pk.x, pk.y)).to.equal(false);
    });
  });

  describe('removeOwnerAtIndex', function () {
    it('refuses an index that never held an owner: NoOwnerAtIndex', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await expect(fx.account.connect(fx.driver).removeOwnerAtIndex(99, addrOwnerBytes(fx.stranger.address)))
        .to.be.revertedWithCustomError(fx.account, 'NoOwnerAtIndex')
        .withArgs(99n);
    });

    it('refuses an index already removed: NoOwnerAtIndex (no double-count of removedOwnersCount)', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const keyOwnerBytes = addrOwnerBytes(fx.keyOwner.address);
      await fx.account.connect(fx.driver).addOwnerAddress(fx.other.address);
      await fx.account.connect(fx.driver).removeOwnerAtIndex(0, keyOwnerBytes);
      await expect(fx.account.connect(fx.driver).removeOwnerAtIndex(0, keyOwnerBytes))
        .to.be.revertedWithCustomError(fx.account, 'NoOwnerAtIndex')
        .withArgs(0n);
      expect(await fx.account.removedOwnersCount()).to.equal(1n);
      expect(await fx.account.ownerCount()).to.equal(2n);
    });

    it('refuses a mismatched owner for the index: WrongOwnerAtIndex', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const claimed = addrOwnerBytes(fx.driver.address);
      const actual = addrOwnerBytes(fx.keyOwner.address);
      await expect(fx.account.connect(fx.driver).removeOwnerAtIndex(0, claimed))
        .to.be.revertedWithCustomError(fx.account, 'WrongOwnerAtIndex')
        .withArgs(0n, claimed, actual);
    });

    it('refuses removing the last owner: LastOwner', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await fx.account.connect(fx.driver).removeOwnerAtIndex(0, addrOwnerBytes(fx.keyOwner.address));
      await expect(
        fx.account.connect(fx.driver).removeOwnerAtIndex(1, addrOwnerBytes(fx.driver.address))
      ).to.be.revertedWithCustomError(fx.account, 'LastOwner');
    });

    it('refuses removal from a non-owner: Unauthorized', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await expect(
        fx.account.connect(fx.stranger).removeOwnerAtIndex(0, addrOwnerBytes(fx.keyOwner.address))
      ).to.be.revertedWithCustomError(fx.account, 'Unauthorized');
    });
  });

  describe('removeLastOwner', function () {
    it('refuses while more than one owner remains: NotLastOwner(ownersRemaining)', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await expect(fx.account.connect(fx.driver).removeLastOwner(1, addrOwnerBytes(fx.driver.address)))
        .to.be.revertedWithCustomError(fx.account, 'NotLastOwner')
        .withArgs(2n);
      expect(await fx.account.isOwnerAddress(fx.driver.address)).to.equal(true);
    });

    it('refuses from a non-owner: Unauthorized', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await fx.account.connect(fx.driver).removeOwnerAtIndex(0, addrOwnerBytes(fx.keyOwner.address));
      await expect(
        fx.account.connect(fx.stranger).removeLastOwner(1, addrOwnerBytes(fx.driver.address))
      ).to.be.revertedWithCustomError(fx.account, 'Unauthorized');
    });

    it('refuses a wrong index for the last owner: NoOwnerAtIndex / WrongOwnerAtIndex', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await fx.account.connect(fx.driver).removeOwnerAtIndex(0, addrOwnerBytes(fx.keyOwner.address));
      const last = addrOwnerBytes(fx.driver.address);
      await expect(fx.account.connect(fx.driver).removeLastOwner(0, last))
        .to.be.revertedWithCustomError(fx.account, 'NoOwnerAtIndex')
        .withArgs(0n);
      await expect(fx.account.connect(fx.driver).removeLastOwner(1, addrOwnerBytes(fx.stranger.address)))
        .to.be.revertedWithCustomError(fx.account, 'WrongOwnerAtIndex')
        .withArgs(1n, addrOwnerBytes(fx.stranger.address), last);
    });

    it('control: removes the sole remaining owner (account is then ownerless and refuses its old owner)', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await fx.account.connect(fx.driver).removeOwnerAtIndex(0, addrOwnerBytes(fx.keyOwner.address));
      await expect(fx.account.connect(fx.driver).removeLastOwner(1, addrOwnerBytes(fx.driver.address))).to.emit(
        fx.account,
        'RemoveOwner'
      );
      expect(await fx.account.ownerCount()).to.equal(0n);
      await expect(fx.account.connect(fx.driver).execute(fx.stranger.address, 0, '0x')).to.be.revertedWithCustomError(
        fx.account,
        'Unauthorized'
      );
    });
  });
});
