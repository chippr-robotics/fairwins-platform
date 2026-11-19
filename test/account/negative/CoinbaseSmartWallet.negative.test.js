/**
 * Spec 112 FR-004 — CoinbaseSmartWallet: every guard driven down its FAILING side,
 * each asserting the specific error (never a bare `.reverted`).
 *
 * Covers: onlyEntryPoint / onlyEntryPointOrOwner, the replayable-nonce-key rules in
 * validateUserOp (both directions), InvalidImplementation for a codeless upgrade
 * target inside a replayable batch, SelectorNotAllowed in
 * executeWithoutChainIdValidation, payPrefund, _authorizeUpgrade, and the
 * owner-bytes checks inside _isValidSignature. Each negative is paired with a
 * control showing the same call succeeds when only the guarded condition changes,
 * so a red test means the guard, not the fixture.
 *
 * The EntryPoint is the hardcoded v0.6 address, impersonated (see ./fixtures.js).
 */

const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers');
const {
  ENTRY_POINT_V06,
  REPLAYABLE_NONCE_KEY,
  addrOwnerBytes,
  nonceWithKey,
  wrapSignature,
  signDigest,
  baseUserOp,
  deployAccountFixture,
  ownerDataSlot,
} = require('./fixtures');

const SOME_HASH = ethers.keccak256(ethers.toUtf8Bytes('fairwins/spec-112/userOpHash'));
const ERC1271_MAGIC = '0x1626ba7e';
const ERC1271_FAIL = '0xffffffff';

describe('CoinbaseSmartWallet — negative paths (spec 112 FR-004)', function () {
  /** A normal (chain-bound) op from the key owner at index 0, signed over `hash`. */
  function signedNormalOp(fx, { key = 0n, hash = SOME_HASH, ownerIndex = 0, callData } = {}) {
    return baseUserOp(fx.accountAddr, {
      nonce: nonceWithKey(key),
      callData: callData ?? fx.account.interface.encodeFunctionData('execute', [fx.stranger.address, 0, '0x']),
      signature: wrapSignature(ownerIndex, signDigest(fx.keyOwner, hash)),
    });
  }

  function replayableCallData(fx, calls) {
    return fx.account.interface.encodeFunctionData('executeWithoutChainIdValidation', [calls]);
  }

  /** A replayable op, signed over the chain-agnostic hash the account itself recomputes. */
  async function signedReplayableOp(fx, calls, { key = REPLAYABLE_NONCE_KEY } = {}) {
    const op = baseUserOp(fx.accountAddr, { nonce: nonceWithKey(key), callData: replayableCallData(fx, calls) });
    const hash = await fx.account.getUserOpHashWithoutChainId(op);
    return { ...op, signature: wrapSignature(0, signDigest(fx.keyOwner, hash)) };
  }

  describe('onlyEntryPoint (validateUserOp, executeWithoutChainIdValidation)', function () {
    it('refuses validateUserOp from an OWNER that is not the EntryPoint', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await expect(
        fx.account.connect(fx.driver).validateUserOp(signedNormalOp(fx), SOME_HASH, 0)
      ).to.be.revertedWithCustomError(fx.account, 'Unauthorized');
    });

    it('refuses validateUserOp from a stranger', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await expect(
        fx.account.connect(fx.stranger).validateUserOp(signedNormalOp(fx), SOME_HASH, 0)
      ).to.be.revertedWithCustomError(fx.account, 'Unauthorized');
    });

    it('control: the EntryPoint validates the same op (returns 0 for a valid owner signature)', async function () {
      const fx = await loadFixture(deployAccountFixture);
      expect(await fx.account.connect(fx.entryPoint).validateUserOp.staticCall(signedNormalOp(fx), SOME_HASH, 0)).to.equal(0n);
    });

    it('refuses executeWithoutChainIdValidation from an owner (EntryPoint ONLY, not owner)', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const calls = [fx.account.interface.encodeFunctionData('addOwnerAddress', [fx.other.address])];
      await expect(
        fx.account.connect(fx.driver).executeWithoutChainIdValidation(calls)
      ).to.be.revertedWithCustomError(fx.account, 'Unauthorized');
      await expect(
        fx.account.connect(fx.stranger).executeWithoutChainIdValidation(calls)
      ).to.be.revertedWithCustomError(fx.account, 'Unauthorized');
      expect(await fx.account.isOwnerAddress(fx.other.address)).to.equal(false);
    });

    it('control: the EntryPoint can run an allowed replayable call', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const calls = [fx.account.interface.encodeFunctionData('addOwnerAddress', [fx.other.address])];
      await fx.account.connect(fx.entryPoint).executeWithoutChainIdValidation(calls);
      expect(await fx.account.isOwnerAddress(fx.other.address)).to.equal(true);
    });
  });

  describe('onlyEntryPointOrOwner (execute, executeBatch)', function () {
    it('refuses execute and executeBatch from a non-owner, non-EntryPoint caller', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await expect(
        fx.account.connect(fx.stranger).execute(fx.stranger.address, 0, '0x')
      ).to.be.revertedWithCustomError(fx.account, 'Unauthorized');
      await expect(
        fx.account.connect(fx.stranger).executeBatch([{ target: fx.stranger.address, value: 0, data: '0x' }])
      ).to.be.revertedWithCustomError(fx.account, 'Unauthorized');
    });

    it('refuses an owner that has been REMOVED', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await fx.account.connect(fx.driver).removeOwnerAtIndex(1, addrOwnerBytes(fx.driver.address));
      await expect(
        fx.account.connect(fx.driver).execute(fx.stranger.address, 0, '0x')
      ).to.be.revertedWithCustomError(fx.account, 'Unauthorized');
    });

    it('control: the EntryPoint (not an owner) may execute and executeBatch', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await fx.driver.sendTransaction({ to: fx.accountAddr, value: ethers.parseEther('1') });
      await expect(
        fx.account.connect(fx.entryPoint).execute(fx.stranger.address, 7n, '0x')
      ).to.changeEtherBalance(fx.stranger, 7n);
      await expect(
        fx.account.connect(fx.entryPoint).executeBatch([{ target: fx.stranger.address, value: 5n, data: '0x' }])
      ).to.changeEtherBalance(fx.stranger, 5n);
    });

    it('control: the account itself counts as an owner (self-call via execute)', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const inner = fx.account.interface.encodeFunctionData('addOwnerAddress', [fx.other.address]);
      await fx.account.connect(fx.driver).execute(fx.accountAddr, 0, inner);
      expect(await fx.account.isOwnerAddress(fx.other.address)).to.equal(true);
    });
  });

  describe('validateUserOp — replayable nonce key', function () {
    it('refuses an executeWithoutChainIdValidation op whose nonce key is not REPLAYABLE_NONCE_KEY (key 0)', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const calls = [fx.account.interface.encodeFunctionData('addOwnerAddress', [fx.other.address])];
      const op = await signedReplayableOp(fx, calls, { key: 0n });
      await expect(fx.account.connect(fx.entryPoint).validateUserOp(op, SOME_HASH, 0))
        .to.be.revertedWithCustomError(fx.account, 'InvalidNonceKey')
        .withArgs(0n);
    });

    it('refuses an executeWithoutChainIdValidation op one key off REPLAYABLE_NONCE_KEY', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const calls = [fx.account.interface.encodeFunctionData('addOwnerAddress', [fx.other.address])];
      const op = await signedReplayableOp(fx, calls, { key: REPLAYABLE_NONCE_KEY + 1n });
      await expect(fx.account.connect(fx.entryPoint).validateUserOp(op, SOME_HASH, 0))
        .to.be.revertedWithCustomError(fx.account, 'InvalidNonceKey')
        .withArgs(REPLAYABLE_NONCE_KEY + 1n);
    });

    it('refuses a NORMAL op that uses REPLAYABLE_NONCE_KEY', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const op = signedNormalOp(fx, { key: REPLAYABLE_NONCE_KEY });
      await expect(fx.account.connect(fx.entryPoint).validateUserOp(op, SOME_HASH, 0))
        .to.be.revertedWithCustomError(fx.account, 'InvalidNonceKey')
        .withArgs(REPLAYABLE_NONCE_KEY);
    });

    it('control: a replayable op on REPLAYABLE_NONCE_KEY validates against the chain-agnostic hash', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const calls = [fx.account.interface.encodeFunctionData('addOwnerAddress', [fx.other.address])];
      const op = await signedReplayableOp(fx, calls);
      // The EntryPoint-supplied (chain-bound) hash is ignored on this path.
      expect(await fx.account.connect(fx.entryPoint).validateUserOp.staticCall(op, SOME_HASH, 0)).to.equal(0n);
    });

    it('a replayable op signed over the CHAIN-BOUND hash does not validate (returns 1, not 0)', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const calls = [fx.account.interface.encodeFunctionData('addOwnerAddress', [fx.other.address])];
      const op = {
        ...baseUserOp(fx.accountAddr, { nonce: nonceWithKey(REPLAYABLE_NONCE_KEY), callData: replayableCallData(fx, calls) }),
        signature: wrapSignature(0, signDigest(fx.keyOwner, SOME_HASH)),
      };
      expect(await fx.account.connect(fx.entryPoint).validateUserOp.staticCall(op, SOME_HASH, 0)).to.equal(1n);
    });

    it('a normal op signed by a non-owner key returns 1 (signature failure is reported, not reverted)', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const op = {
        ...signedNormalOp(fx),
        signature: wrapSignature(0, signDigest(ethers.Wallet.createRandom(), SOME_HASH)),
      };
      expect(await fx.account.connect(fx.entryPoint).validateUserOp.staticCall(op, SOME_HASH, 0)).to.equal(1n);
    });
  });

  describe('validateUserOp — upgrade inside a replayable batch', function () {
    it('refuses upgradeToAndCall to a codeless implementation with InvalidImplementation', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const codeless = fx.stranger.address; // an EOA: no code
      const calls = [fx.account.interface.encodeFunctionData('upgradeToAndCall', [codeless, '0x'])];
      const op = await signedReplayableOp(fx, calls);
      await expect(fx.account.connect(fx.entryPoint).validateUserOp(op, SOME_HASH, 0))
        .to.be.revertedWithCustomError(fx.account, 'InvalidImplementation')
        .withArgs(codeless);
    });

    it('scans the WHOLE batch: a codeless upgrade after an allowed call is still refused', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const codeless = ethers.Wallet.createRandom().address;
      const calls = [
        fx.account.interface.encodeFunctionData('addOwnerAddress', [fx.other.address]),
        fx.account.interface.encodeFunctionData('upgradeToAndCall', [codeless, '0x']),
      ];
      const op = await signedReplayableOp(fx, calls);
      await expect(fx.account.connect(fx.entryPoint).validateUserOp(op, SOME_HASH, 0))
        .to.be.revertedWithCustomError(fx.account, 'InvalidImplementation')
        .withArgs(codeless);
    });

    it('control: upgradeToAndCall to a deployed implementation passes validation', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const calls = [fx.account.interface.encodeFunctionData('upgradeToAndCall', [await fx.impl.getAddress(), '0x'])];
      const op = await signedReplayableOp(fx, calls);
      expect(await fx.account.connect(fx.entryPoint).validateUserOp.staticCall(op, SOME_HASH, 0)).to.equal(0n);
    });
  });

  describe('executeWithoutChainIdValidation — SelectorNotAllowed', function () {
    it('refuses execute() smuggled into a replayable batch', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await fx.driver.sendTransaction({ to: fx.accountAddr, value: ethers.parseEther('1') });
      const smuggled = fx.account.interface.encodeFunctionData('execute', [fx.stranger.address, ethers.parseEther('1'), '0x']);
      const selector = smuggled.slice(0, 10);
      await expect(fx.account.connect(fx.entryPoint).executeWithoutChainIdValidation([smuggled]))
        .to.be.revertedWithCustomError(fx.account, 'SelectorNotAllowed')
        .withArgs(selector);
    });

    it('refuses a disallowed selector AFTER an allowed one, atomically (the allowed call is rolled back)', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const allowed = fx.account.interface.encodeFunctionData('addOwnerAddress', [fx.other.address]);
      const disallowed = fx.account.interface.encodeFunctionData('executeBatch', [[]]);
      await expect(fx.account.connect(fx.entryPoint).executeWithoutChainIdValidation([allowed, disallowed]))
        .to.be.revertedWithCustomError(fx.account, 'SelectorNotAllowed')
        .withArgs(disallowed.slice(0, 10));
      expect(await fx.account.isOwnerAddress(fx.other.address)).to.equal(false);
    });

    it('canSkipChainIdValidation allows exactly the five owner/upgrade selectors', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const iface = fx.account.interface;
      for (const fn of ['addOwnerPublicKey', 'addOwnerAddress', 'removeOwnerAtIndex', 'removeLastOwner', 'upgradeToAndCall']) {
        expect(await fx.account.canSkipChainIdValidation(iface.getFunction(fn).selector), fn).to.equal(true);
      }
      for (const fn of ['execute', 'executeBatch', 'executeWithoutChainIdValidation', 'initialize']) {
        expect(await fx.account.canSkipChainIdValidation(iface.getFunction(fn).selector), fn).to.equal(false);
      }
    });
  });

  describe('payPrefund (missingAccountFunds)', function () {
    it('pays the EntryPoint exactly missingAccountFunds', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await fx.driver.sendTransaction({ to: fx.accountAddr, value: ethers.parseEther('1') });
      const missing = ethers.parseEther('0.01');
      await expect(
        fx.account.connect(fx.entryPoint).validateUserOp(signedNormalOp(fx), SOME_HASH, missing)
      ).to.changeEtherBalances([fx.account, ENTRY_POINT_V06], [-missing, missing]);
    });

    it('pays nothing when missingAccountFunds is zero (paymaster / pre-funded deposit)', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await fx.driver.sendTransaction({ to: fx.accountAddr, value: ethers.parseEther('1') });
      await expect(
        fx.account.connect(fx.entryPoint).validateUserOp(signedNormalOp(fx), SOME_HASH, 0)
      ).to.changeEtherBalances([fx.account, ENTRY_POINT_V06], [0n, 0n]);
    });

    it('an unaffordable prefund does not revert validation (EntryPoint verifies its deposit)', async function () {
      const fx = await loadFixture(deployAccountFixture);
      // account holds 0 ETH; the prefund call fails and is ignored, validation still answers.
      expect(
        await fx.account.connect(fx.entryPoint).validateUserOp.staticCall(signedNormalOp(fx), SOME_HASH, ethers.parseEther('1'))
      ).to.equal(0n);
    });
  });

  describe('_authorizeUpgrade / upgradeToAndCall', function () {
    it('refuses a direct upgrade from a non-owner', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await expect(
        fx.account.connect(fx.stranger).upgradeToAndCall(await fx.impl.getAddress(), '0x')
      ).to.be.revertedWithCustomError(fx.account, 'Unauthorized');
    });

    it('control: an owner may upgrade to a deployed implementation', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const Wallet = await ethers.getContractFactory('CoinbaseSmartWallet');
      const impl2 = await Wallet.deploy();
      await fx.account.connect(fx.driver).upgradeToAndCall(await impl2.getAddress(), '0x');
      expect(await fx.account.implementation()).to.equal(await impl2.getAddress());
    });
  });

  describe('_isValidSignature — owner bytes checks', function () {
    it('refuses (reverts, not "invalid") an ERC-1271 check naming an index with no owner: InvalidOwnerBytesLength', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await expect(fx.account.isValidSignature(SOME_HASH, wrapSignature(99, '0x')))
        .to.be.revertedWithCustomError(fx.account, 'InvalidOwnerBytesLength')
        .withArgs('0x');
    });

    it('refuses a signature naming a REMOVED owner index: InvalidOwnerBytesLength', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await fx.account.connect(fx.driver).removeOwnerAtIndex(0, addrOwnerBytes(fx.keyOwner.address));
      const op = signedNormalOp(fx, { ownerIndex: 0 });
      await expect(fx.account.connect(fx.entryPoint).validateUserOp(op, SOME_HASH, 0))
        .to.be.revertedWithCustomError(fx.account, 'InvalidOwnerBytesLength')
        .withArgs('0x');
    });

    it('refuses an owner slot holding a 32-byte value above uint160: InvalidEthereumAddressOwner', async function () {
      // Defence in depth: addOwnerAddress / _initializeOwners cannot store such a value, so the
      // slot is written directly — the "future change" the contract comment anticipates.
      const fx = await loadFixture(deployAccountFixture);
      const corrupt = '0x' + 'ff'.repeat(32);
      await network.provider.request({
        method: 'hardhat_setStorageAt',
        params: [fx.accountAddr, ownerDataSlot(0n), corrupt],
      });
      expect(await fx.account.ownerAtIndex(0)).to.equal(corrupt);
      await expect(fx.account.isValidSignature(SOME_HASH, wrapSignature(0, signDigest(fx.keyOwner, SOME_HASH))))
        .to.be.revertedWithCustomError(fx.account, 'InvalidEthereumAddressOwner')
        .withArgs(corrupt);
    });

    it('ERC-1271: wrong signer answers 0xffffffff; the owner over replaySafeHash answers the magic value', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const safe = await fx.account.replaySafeHash(SOME_HASH);
      expect(
        await fx.account.isValidSignature(SOME_HASH, wrapSignature(0, signDigest(ethers.Wallet.createRandom(), safe)))
      ).to.equal(ERC1271_FAIL);
      // Signing the RAW hash (not the replay-safe one) must also fail.
      expect(await fx.account.isValidSignature(SOME_HASH, wrapSignature(0, signDigest(fx.keyOwner, SOME_HASH)))).to.equal(
        ERC1271_FAIL
      );
      expect(await fx.account.isValidSignature(SOME_HASH, wrapSignature(0, signDigest(fx.keyOwner, safe)))).to.equal(
        ERC1271_MAGIC
      );
    });

    it('ERC-5267 eip712Domain reports the domain replaySafeHash is bound to (this account, this chain)', async function () {
      const fx = await loadFixture(deployAccountFixture);
      const d = await fx.account.eip712Domain();
      const { chainId } = await ethers.provider.getNetwork();
      expect(d.fields).to.equal('0x0f');
      expect(d.name).to.equal('Coinbase Smart Wallet');
      expect(d.version).to.equal('1');
      expect(d.chainId).to.equal(chainId);
      expect(d.verifyingContract).to.equal(fx.accountAddr);
      expect(d.salt).to.equal(ethers.ZeroHash);
      expect(d.extensions).to.deep.equal([]);
      const separator = ethers.TypedDataEncoder.hashDomain({
        name: d.name,
        version: d.version,
        chainId: d.chainId,
        verifyingContract: d.verifyingContract,
      });
      expect(await fx.account.domainSeparator()).to.equal(separator);
    });
  });

  describe('initialize', function () {
    it('the implementation itself cannot be initialized (constructor seeds an owner): Initialized', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await expect(fx.impl.initialize([addrOwnerBytes(fx.stranger.address)])).to.be.revertedWithCustomError(
        fx.impl,
        'Initialized'
      );
    });

    it('a deployed account cannot be re-initialized by anyone, including an owner', async function () {
      const fx = await loadFixture(deployAccountFixture);
      await expect(
        fx.account.connect(fx.driver).initialize([addrOwnerBytes(fx.stranger.address)])
      ).to.be.revertedWithCustomError(fx.account, 'Initialized');
      expect(await fx.account.isOwnerAddress(fx.stranger.address)).to.equal(false);
    });
  });
});
