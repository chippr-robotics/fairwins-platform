/**
 * Spec 041 T005 — vendored CoinbaseSmartWallet behavioral surface:
 * owner management (add/remove via owner, last-owner protection),
 * executeBatch atomicity, execute/executeBatch authorization.
 *
 * These tests pin the exact upstream behaviors the passkey feature relies on
 * (contracts/onchain-deployments.md "Behavioral surface relied upon").
 */

const { expect } = require('chai');
const { ethers } = require('hardhat');
const { AbiCoder } = require('ethers');
const { createPasskey } = require('./helpers/webauthn');

const abi = AbiCoder.defaultAbiCoder();
const addrOwnerBytes = (addr) => abi.encode(['address'], [addr]);

describe('CoinbaseSmartWallet (vendored) — owners & execution', function () {
  async function deployFixture() {
    const [deployer, eoaOwner, secondOwner, stranger] = await ethers.getSigners();
    const Wallet = await ethers.getContractFactory('CoinbaseSmartWallet');
    const impl = await Wallet.deploy();
    const Factory = await ethers.getContractFactory('CoinbaseSmartWalletFactory');
    const factory = await Factory.deploy(await impl.getAddress());
    const passkey = createPasskey();

    const owners = [addrOwnerBytes(eoaOwner.address), passkey.ownerBytes];
    const predicted = await factory['getAddress(bytes[],uint256)'](owners, 0);
    await factory.createAccount(owners, 0);
    const account = Wallet.attach(predicted);
    return { deployer, eoaOwner, secondOwner, stranger, factory, account, passkey, owners };
  }

  describe('owner management', function () {
    it('initializes with the given owners (EOA address + passkey public key)', async function () {
      const { account, eoaOwner, passkey } = await deployFixture();
      expect(await account.isOwnerAddress(eoaOwner.address)).to.equal(true);
      expect(await account.isOwnerPublicKey(passkey.x, passkey.y)).to.equal(true);
      expect(await account.ownerCount()).to.equal(2);
    });

    it('rejects double initialization', async function () {
      const { account, stranger } = await deployFixture();
      await expect(account.initialize([addrOwnerBytes(stranger.address)])).to.be.revertedWithCustomError(
        account,
        'Initialized'
      );
    });

    it('lets an existing owner add an EOA owner and a passkey owner', async function () {
      const { account, eoaOwner, secondOwner } = await deployFixture();
      const newPasskey = createPasskey();

      await expect(account.connect(eoaOwner).addOwnerAddress(secondOwner.address))
        .to.emit(account, 'AddOwner');
      expect(await account.isOwnerAddress(secondOwner.address)).to.equal(true);

      await account.connect(eoaOwner).addOwnerPublicKey(newPasskey.x, newPasskey.y);
      expect(await account.isOwnerPublicKey(newPasskey.x, newPasskey.y)).to.equal(true);
      expect(await account.ownerCount()).to.equal(4);
    });

    it('refuses owner mutations from a non-owner', async function () {
      const { account, stranger } = await deployFixture();
      await expect(account.connect(stranger).addOwnerAddress(stranger.address)).to.be.revertedWithCustomError(
        account,
        'Unauthorized'
      );
      await expect(
        account.connect(stranger).removeOwnerAtIndex(0, addrOwnerBytes(stranger.address))
      ).to.be.revertedWithCustomError(account, 'Unauthorized');
    });

    it('removes an owner on-chain: the removed owner can no longer act (FR-020 enforcement)', async function () {
      const { account, eoaOwner, secondOwner } = await deployFixture();
      await account.connect(eoaOwner).addOwnerAddress(secondOwner.address); // index 2

      await expect(account.connect(secondOwner).removeOwnerAtIndex(0, addrOwnerBytes(eoaOwner.address)))
        .to.emit(account, 'RemoveOwner');

      expect(await account.isOwnerAddress(eoaOwner.address)).to.equal(false);
      // Removed controller can sign nothing: an owner-gated call now reverts.
      await expect(account.connect(eoaOwner).addOwnerAddress(eoaOwner.address)).to.be.revertedWithCustomError(
        account,
        'Unauthorized'
      );
    });

    it('refuses to remove the last owner via removeOwnerAtIndex (FR-020)', async function () {
      const { account, eoaOwner, passkey } = await deployFixture();
      // Remove the passkey owner (index 1) so only the EOA owner remains.
      await account.connect(eoaOwner).removeOwnerAtIndex(1, passkey.ownerBytes);
      expect(await account.ownerCount()).to.equal(1);

      await expect(
        account.connect(eoaOwner).removeOwnerAtIndex(0, addrOwnerBytes(eoaOwner.address))
      ).to.be.revertedWithCustomError(account, 'LastOwner');
    });

    it('guards owner removal against index/owner mismatch', async function () {
      const { account, eoaOwner, passkey } = await deployFixture();
      await expect(
        account.connect(eoaOwner).removeOwnerAtIndex(1, addrOwnerBytes(eoaOwner.address))
      ).to.be.revertedWithCustomError(account, 'WrongOwnerAtIndex');
      expect(await account.isOwnerPublicKey(passkey.x, passkey.y)).to.equal(true);
    });
  });

  describe('execution', function () {
    it('executes a call from an owner', async function () {
      const { account, eoaOwner, stranger } = await deployFixture();
      await eoaOwner.sendTransaction({ to: await account.getAddress(), value: ethers.parseEther('1') });

      const before = await ethers.provider.getBalance(stranger.address);
      await account.connect(eoaOwner).execute(stranger.address, ethers.parseEther('0.25'), '0x');
      expect((await ethers.provider.getBalance(stranger.address)) - before).to.equal(ethers.parseEther('0.25'));
    });

    it('refuses execute/executeBatch from a non-owner, non-EntryPoint caller', async function () {
      const { account, stranger } = await deployFixture();
      await expect(account.connect(stranger).execute(stranger.address, 0, '0x')).to.be.revertedWithCustomError(
        account,
        'Unauthorized'
      );
      await expect(
        account.connect(stranger).executeBatch([{ target: stranger.address, value: 0, data: '0x' }])
      ).to.be.revertedWithCustomError(account, 'Unauthorized');
    });

    it('executeBatch runs multiple calls in one transaction (FR-016 single-ceremony basis)', async function () {
      const { account, eoaOwner, secondOwner, stranger } = await deployFixture();
      await eoaOwner.sendTransaction({ to: await account.getAddress(), value: ethers.parseEther('1') });

      const addOwnerData = account.interface.encodeFunctionData('addOwnerAddress', [secondOwner.address]);
      await account.connect(eoaOwner).executeBatch([
        { target: stranger.address, value: ethers.parseEther('0.1'), data: '0x' },
        { target: await account.getAddress(), value: 0, data: addOwnerData },
      ]);
      expect(await account.isOwnerAddress(secondOwner.address)).to.equal(true);
    });

    it('executeBatch is atomic: one failing call reverts the whole batch', async function () {
      const { account, eoaOwner, secondOwner, stranger } = await deployFixture();
      await eoaOwner.sendTransaction({ to: await account.getAddress(), value: ethers.parseEther('1') });

      const failingRemove = account.interface.encodeFunctionData('removeOwnerAtIndex', [
        7,
        addrOwnerBytes(stranger.address),
      ]);
      await expect(
        account.connect(eoaOwner).executeBatch([
          { target: stranger.address, value: ethers.parseEther('0.1'), data: '0x' },
          { target: await account.getAddress(), value: 0, data: failingRemove },
        ])
      ).to.be.revertedWithCustomError(account, 'NoOwnerAtIndex').withArgs(7);
      // First call's transfer must not have survived the revert.
      expect(await account.isOwnerAddress(secondOwner.address)).to.equal(false);
    });
  });
});
