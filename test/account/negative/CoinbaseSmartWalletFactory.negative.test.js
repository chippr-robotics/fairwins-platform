/**
 * Spec 112 FR-004 — CoinbaseSmartWalletFactory: constructor + createAccount guards
 * driven down their failing side with the specific error asserted.
 */

const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const { addrOwnerBytes, deployAccountFixture } = require('./fixtures');

describe('CoinbaseSmartWalletFactory — negative paths (spec 112 FR-004)', function () {
  describe('constructor', function () {
    it('refuses an EOA as the implementation: ImplementationUndeployed', async function () {
      const [, , stranger] = await ethers.getSigners();
      const Factory = await ethers.getContractFactory('CoinbaseSmartWalletFactory');
      await expect(Factory.deploy(stranger.address)).to.be.revertedWithCustomError(Factory, 'ImplementationUndeployed');
    });

    it('refuses the zero address as the implementation: ImplementationUndeployed', async function () {
      const Factory = await ethers.getContractFactory('CoinbaseSmartWalletFactory');
      await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(Factory, 'ImplementationUndeployed');
    });

    it('control: accepts a deployed implementation', async function () {
      const fx = await loadFixture(deployAccountFixture);
      expect(await fx.factory.implementation()).to.equal(await fx.impl.getAddress());
    });
  });

  describe('createAccount', function () {
    it('refuses an empty owner list: OwnerRequired (no account deployed)', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const predicted = await fx.factory['getAddress(bytes[],uint256)']([], 7);
      await expect(fx.factory.createAccount([], 7)).to.be.revertedWithCustomError(fx.factory, 'OwnerRequired');
      expect(await ethers.provider.getCode(predicted)).to.equal('0x');
    });

    it('an invalid owner rolls back the clone deployment too (no half-initialized account left behind)', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const bad = ['0x' + '33'.repeat(20)];
      const predicted = await fx.factory['getAddress(bytes[],uint256)'](bad, 3);
      await expect(fx.factory.createAccount(bad, 3)).to.be.revertedWithCustomError(fx.impl, 'InvalidOwnerBytesLength');
      expect(await ethers.provider.getCode(predicted)).to.equal('0x');
    });

    it('a repeat createAccount neither re-emits AccountCreated nor re-initializes (owners unchanged)', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await expect(fx.factory.createAccount(fx.owners, 0)).to.not.emit(fx.factory, 'AccountCreated');
      expect(await fx.account.ownerCount()).to.equal(2n);
      expect(await fx.account.nextOwnerIndex()).to.equal(2n);
      expect(await fx.account.isOwnerAddress(fx.stranger.address)).to.equal(false);
    });

    it('control: a new nonce for the same owners deploys a distinct account', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const predicted = await fx.factory['getAddress(bytes[],uint256)'](fx.owners, 1);
      expect(predicted).to.not.equal(fx.accountAddr);
      await expect(fx.factory.createAccount(fx.owners, 1))
        .to.emit(fx.factory, 'AccountCreated');
      expect(await ethers.provider.getCode(predicted)).to.not.equal('0x');
      const second = fx.Wallet.attach(predicted);
      expect(await second.isOwnerBytes(addrOwnerBytes(fx.driver.address))).to.equal(true);
    });
  });
});
