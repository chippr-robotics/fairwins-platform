/**
 * Spec 112 (FR-004 / FR-006, #1673) — ERC1271InputGenerator, the vendored "deployless" helper.
 *
 * Its constructor returns `replaySafeHash(hash)` for an account that may not exist yet: if the
 * account has no code it calls `accountFactory` with `factoryCalldata` inside the CREATE, then
 * insists the factory reported the very account it was asked about. Both refusals are reachable
 * with the real CoinbaseSmartWalletFactory — no mock needed:
 *
 *   AccountDeploymentFailed                       — the factory call reverts (empty owner list)
 *   ReturnedAddressDoesNotMatchAccount(acct, ret) — the factory deploys a DIFFERENT account
 *                                                   (same owners, other nonce)
 *
 * The control cases run the same constructor as an eth_call (how it is used off-chain) and check
 * the returned word against the deployed account's own replaySafeHash, for both the counterfactual
 * and the already-deployed branch.
 */

const { expect } = require('chai');
const { ethers } = require('hardhat');
const { AbiCoder } = require('ethers');

const abi = AbiCoder.defaultAbiCoder();
const HASH = ethers.id('spec 112 erc1271 input');

describe('ERC1271InputGenerator — negative paths (spec 112 FR-004)', function () {
  async function fixture() {
    const [, owner] = await ethers.getSigners();
    const impl = await (await ethers.getContractFactory('CoinbaseSmartWallet')).deploy();
    const factory = await (await ethers.getContractFactory('CoinbaseSmartWalletFactory')).deploy(await impl.getAddress());
    const Gen = await ethers.getContractFactory('ERC1271InputGenerator');
    const owners = [abi.encode(['address'], [owner.address])];
    const account0 = await factory['getAddress(bytes[],uint256)'](owners, 0);
    const account1 = await factory['getAddress(bytes[],uint256)'](owners, 1);
    const createData = (o, n) => factory.interface.encodeFunctionData('createAccount', [o, n]);
    return { factory, Gen, owners, account0, account1, createData, factoryAddr: await factory.getAddress() };
  }

  it('AccountDeploymentFailed: the factory call reverts (empty owner list) and nothing is deployed', async function () {
    const fx = await fixture();
    const emptyOwners = await fx.factory['getAddress(bytes[],uint256)']([], 0);
    await expect(fx.Gen.deploy(emptyOwners, HASH, fx.factoryAddr, fx.createData([], 0))).to.be.revertedWithCustomError(fx.Gen, 'AccountDeploymentFailed');
    expect(await ethers.provider.getCode(emptyOwners)).to.equal('0x');
  });

  it('AccountDeploymentFailed: calldata the factory does not implement', async function () {
    const fx = await fixture();
    await expect(fx.Gen.deploy(fx.account0, HASH, fx.factoryAddr, '0xdeadbeef')).to.be.revertedWithCustomError(fx.Gen, 'AccountDeploymentFailed');
  });

  it('ReturnedAddressDoesNotMatchAccount(account, returned): factory deploys a different account', async function () {
    const fx = await fixture();
    // Asked about the nonce-0 account, handed calldata that creates the nonce-1 account.
    await expect(fx.Gen.deploy(fx.account0, HASH, fx.factoryAddr, fx.createData(fx.owners, 1))).to.be.revertedWithCustomError(fx.Gen, 'ReturnedAddressDoesNotMatchAccount').withArgs(fx.account0, fx.account1);
    // The whole CREATE reverted, so the side-deployment did not stick either.
    expect(await ethers.provider.getCode(fx.account1)).to.equal('0x');
  });

  it("control: counterfactual eth_call returns the account's own replaySafeHash", async function () {
    const fx = await fixture();
    const tx = await fx.Gen.getDeployTransaction(fx.account0, HASH, fx.factoryAddr, fx.createData(fx.owners, 0));
    const out = await ethers.provider.call({ data: tx.data });
    expect(await ethers.provider.getCode(fx.account0)).to.equal('0x'); // eth_call: nothing persisted

    await fx.factory.createAccount(fx.owners, 0);
    const wallet = await ethers.getContractAt('CoinbaseSmartWallet', fx.account0);
    expect(out).to.equal(await wallet.replaySafeHash(HASH));
  });

  it('control: an already-deployed account skips the factory entirely (bad calldata is never called)', async function () {
    const fx = await fixture();
    await fx.factory.createAccount(fx.owners, 0);
    const wallet = await ethers.getContractAt('CoinbaseSmartWallet', fx.account0);
    const tx = await fx.Gen.getDeployTransaction(fx.account0, HASH, fx.factoryAddr, '0xdeadbeef');
    expect(await ethers.provider.call({ data: tx.data })).to.equal(await wallet.replaySafeHash(HASH));
  });
});
