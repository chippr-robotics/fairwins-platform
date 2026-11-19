/**
 * Spec 112 FR-004 — FairWinsVerifyingPaymaster: onlyEntryPoint on BOTH EntryPoint
 * entry points (validatePaymasterUserOp, postOp), onlyOwner on every fund/stake
 * function, the zero-signer and zero-owner constructor checks, and the
 * paymasterAndData length boundary.
 *
 * The posture under test (spec 050): a compromised verifyingSigner can spend the
 * deposit on gas but can NEVER withdraw or move stake — so the signer itself is
 * among the refused callers below.
 */

const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');

const POST_OP_MODE = { opSucceeded: 0, opReverted: 1, postOpReverted: 2 };

function baseUserOp(sender, paymasterAndData = '0x') {
  return {
    sender,
    nonce: 0n,
    initCode: '0x',
    callData: '0x1234',
    callGasLimit: 100000n,
    verificationGasLimit: 200000n,
    preVerificationGas: 50000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    paymasterAndData,
    signature: '0x',
  };
}

describe('FairWinsVerifyingPaymaster — negative paths (spec 112 FR-004)', function () {
  async function deployFixture() {
    const [owner, kmsSigner, stranger, epEOA, sender, newOwner] = await ethers.getSigners();
    const Mock = await ethers.getContractFactory('MockEntryPointStake');
    const mockEP = await Mock.deploy();
    const PM = await ethers.getContractFactory('FairWinsVerifyingPaymaster');
    // EntryPoint = an EOA so the tests can call as the EntryPoint (validation/postOp legs).
    const pm = await PM.deploy(epEOA.address, kmsSigner.address, owner.address);
    // EntryPoint = the mock so deposit/stake legs actually move value.
    const pmDep = await PM.deploy(await mockEP.getAddress(), kmsSigner.address, owner.address);
    return { PM, pm, pmDep, mockEP, owner, kmsSigner, stranger, epEOA, sender, newOwner };
  }

  describe('onlyEntryPoint', function () {
    it('refuses postOp from a stranger: NotFromEntryPoint', async function () {
      const { pm, stranger } = await loadFixture(deployFixture);
      await expect(pm.connect(stranger).postOp(POST_OP_MODE.opSucceeded, '0x', 0)).to.be.revertedWithCustomError(
        pm,
        'NotFromEntryPoint'
      );
    });

    it('refuses postOp from the OWNER and from the verifying signer: NotFromEntryPoint', async function () {
      const { pm, owner, kmsSigner } = await loadFixture(deployFixture);
      await expect(pm.connect(owner).postOp(POST_OP_MODE.opReverted, '0x', 1)).to.be.revertedWithCustomError(
        pm,
        'NotFromEntryPoint'
      );
      await expect(pm.connect(kmsSigner).postOp(POST_OP_MODE.postOpReverted, '0x', 1)).to.be.revertedWithCustomError(
        pm,
        'NotFromEntryPoint'
      );
    });

    it('control: the EntryPoint may call postOp', async function () {
      const { pm, epEOA } = await loadFixture(deployFixture);
      // postOp is `view`: a resolved eth_call is the success signal.
      // A NotFromEntryPoint revert would reject this promise and fail the test.
      await pm.connect(epEOA).postOp(POST_OP_MODE.opSucceeded, '0x', 0);
    });

    it('refuses validatePaymasterUserOp from the owner: NotFromEntryPoint', async function () {
      const { pm, owner, sender } = await loadFixture(deployFixture);
      const op = baseUserOp(sender.address, '0x' + '00'.repeat(32));
      await expect(pm.connect(owner).validatePaymasterUserOp(op, ethers.ZeroHash, 0)).to.be.revertedWithCustomError(
        pm,
        'NotFromEntryPoint'
      );
    });
  });

  describe('paymasterAndData length', function () {
    it('refuses 31 bytes (one short of address‖validUntil‖validAfter): InvalidPaymasterDataLength', async function () {
      const { pm, epEOA, sender } = await loadFixture(deployFixture);
      const op = baseUserOp(sender.address, '0x' + '00'.repeat(31));
      await expect(pm.connect(epEOA).validatePaymasterUserOp(op, ethers.ZeroHash, 0)).to.be.revertedWithCustomError(
        pm,
        'InvalidPaymasterDataLength'
      );
    });

    it('refuses an empty paymasterAndData: InvalidPaymasterDataLength', async function () {
      const { pm, epEOA, sender } = await loadFixture(deployFixture);
      await expect(
        pm.connect(epEOA).validatePaymasterUserOp(baseUserOp(sender.address, '0x'), ethers.ZeroHash, 0)
      ).to.be.revertedWithCustomError(pm, 'InvalidPaymasterDataLength');
    });

    it('control: exactly 32 bytes parses, and the missing signature is a sigFailed=1, never a sponsorship', async function () {
      const { pm, epEOA, sender } = await loadFixture(deployFixture);
      const op = baseUserOp(sender.address, '0x' + '00'.repeat(32));
      const [, validationData] = await pm.connect(epEOA).validatePaymasterUserOp(op, ethers.ZeroHash, 0);
      expect(validationData & 1n).to.equal(1n);
    });
  });

  describe('onlyOwner — deposit and stake custody', function () {
    for (const who of ['stranger', 'kmsSigner', 'epEOA']) {
      it(`refuses withdrawTo/addStake/unlockStake/withdrawStake/setVerifyingSigner from ${who}: OwnableUnauthorizedAccount`, async function () {
        const fx = await loadFixture(deployFixture);
        const caller = fx[who];
        const pmDep = fx.pmDep.connect(caller);
        await fx.pmDep.deposit({ value: ethers.parseEther('1') });

        await expect(pmDep.withdrawTo(caller.address, 1n))
          .to.be.revertedWithCustomError(fx.pmDep, 'OwnableUnauthorizedAccount')
          .withArgs(caller.address);
        await expect(pmDep.addStake(86400, { value: 1n }))
          .to.be.revertedWithCustomError(fx.pmDep, 'OwnableUnauthorizedAccount')
          .withArgs(caller.address);
        await expect(pmDep.unlockStake())
          .to.be.revertedWithCustomError(fx.pmDep, 'OwnableUnauthorizedAccount')
          .withArgs(caller.address);
        await expect(pmDep.withdrawStake(caller.address))
          .to.be.revertedWithCustomError(fx.pmDep, 'OwnableUnauthorizedAccount')
          .withArgs(caller.address);
        await expect(pmDep.setVerifyingSigner(caller.address))
          .to.be.revertedWithCustomError(fx.pmDep, 'OwnableUnauthorizedAccount')
          .withArgs(caller.address);

        expect(await fx.pmDep.getDeposit()).to.equal(ethers.parseEther('1'));
        expect(await fx.pmDep.verifyingSigner()).to.equal(fx.kmsSigner.address);
      });
    }

    it('control: the owner can add, unlock and withdraw stake', async function () {
      const { pmDep, mockEP, owner, stranger } = await loadFixture(deployFixture);
      const amount = ethers.parseEther('0.5');
      await pmDep.connect(owner).addStake(86400, { value: amount });
      expect(await mockEP.stakeOf(await pmDep.getAddress())).to.equal(amount);
      await pmDep.connect(owner).unlockStake();
      await expect(pmDep.connect(owner).withdrawStake(stranger.address)).to.changeEtherBalance(stranger, amount);
      expect(await mockEP.stakeOf(await pmDep.getAddress())).to.equal(0n);
    });

    it('a former owner loses custody after transferOwnership', async function () {
      const { pmDep, owner, newOwner } = await loadFixture(deployFixture);
      await pmDep.deposit({ value: ethers.parseEther('1') });
      await pmDep.connect(owner).transferOwnership(newOwner.address);
      await expect(pmDep.connect(owner).withdrawTo(owner.address, 1n))
        .to.be.revertedWithCustomError(pmDep, 'OwnableUnauthorizedAccount')
        .withArgs(owner.address);
      await expect(pmDep.connect(owner).withdrawStake(owner.address))
        .to.be.revertedWithCustomError(pmDep, 'OwnableUnauthorizedAccount')
        .withArgs(owner.address);
      await expect(pmDep.connect(newOwner).withdrawTo(newOwner.address, 1n)).to.changeEtherBalance(newOwner, 1n);
    });

    it('receive() routes plain ETH into the EntryPoint deposit (nothing is held by the paymaster)', async function () {
      const { pmDep, stranger } = await loadFixture(deployFixture);
      const addr = await pmDep.getAddress();
      await stranger.sendTransaction({ to: addr, value: 1234n });
      expect(await pmDep.getDeposit()).to.equal(1234n);
      expect(await ethers.provider.getBalance(addr)).to.equal(0n);
    });
  });

  describe('constructor', function () {
    it('refuses a zero owner: OwnableInvalidOwner', async function () {
      const { PM, epEOA, kmsSigner } = await loadFixture(deployFixture);
      await expect(PM.deploy(epEOA.address, kmsSigner.address, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(PM, 'OwnableInvalidOwner')
        .withArgs(ethers.ZeroAddress);
    });

    it('refuses a zero verifying signer: ZeroSigner', async function () {
      const { PM, epEOA, owner } = await loadFixture(deployFixture);
      await expect(PM.deploy(epEOA.address, ethers.ZeroAddress, owner.address)).to.be.revertedWithCustomError(
        PM,
        'ZeroSigner'
      );
    });

    it('setVerifyingSigner refuses zero even from the owner: ZeroSigner (signer unchanged)', async function () {
      const { pm, owner, kmsSigner } = await loadFixture(deployFixture);
      await expect(pm.connect(owner).setVerifyingSigner(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        pm,
        'ZeroSigner'
      );
      expect(await pm.verifyingSigner()).to.equal(kmsSigner.address);
    });
  });
});
