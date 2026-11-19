/**
 * Spec 041 T010 — a smart account as `msg.sender` across the core platform:
 * membership purchase, wager create/accept/declare/claim, and sanctions-guard
 * blocking all behave EXACTLY as for an EOA, with ZERO interface changes to
 * MembershipManager / WagerRegistry / SanctionsGuard.
 *
 * The account is a vendored CoinbaseSmartWallet driven by an EOA owner via
 * `execute`/`executeBatch` (msg.sender of every inner call = the ACCOUNT).
 * The approve+act pairs run as ONE executeBatch — the on-chain basis for the
 * spec's single-ceremony requirement (FR-016).
 *
 * Registry deploys via test/helpers/proxy.js#deployWagerRegistry (both
 * facets, merged ABI) per the spec-035 house rule.
 */

const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers');
const { AbiCoder } = require('ethers');
const { deployWagerRegistry, deployMembershipManager } = require('../helpers/proxy');
const { createPasskey } = require('../account/helpers/webauthn');

const abi = AbiCoder.defaultAbiCoder();
const usdc = (n) => BigInt(n) * 10n ** 6n;
const WAGER_PARTICIPANT_ROLE = ethers.keccak256(ethers.toUtf8Bytes('WAGER_PARTICIPANT_ROLE'));
const Tier = { None: 0, Bronze: 1, Silver: 2, Gold: 3 };
const Resolution = { Either: 0, Creator: 1, Opponent: 2, ThirdParty: 3 };

describe('Integration: passkey smart account as msg.sender (spec 041)', function () {
  async function deployFixture() {
    const [admin, treasury, driver, bob] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory('MockERC20');
    const usdcToken = await MockERC20.deploy('USD Coin', 'USDC', 0);

    const mgr = await deployMembershipManager([admin.address, await usdcToken.getAddress(), treasury.address]);
    const limits = { monthlyMarketCreation: 100, maxConcurrentMarkets: 10 };
    await mgr.connect(admin).setTier(WAGER_PARTICIPANT_ROLE, Tier.Bronze, usdc(50), 30, limits, true);

    const MockOracle = await ethers.getContractFactory('MockSanctionsOracle');
    const oracle = await MockOracle.deploy();
    const Guard = await ethers.getContractFactory('SanctionsGuard');
    const guard = await Guard.deploy(admin.address, await oracle.getAddress());

    const reg = await deployWagerRegistry([
      admin.address,
      await mgr.getAddress(),
      ethers.ZeroAddress,
      [await usdcToken.getAddress()],
    ]);
    await mgr.connect(admin).setAuthorizedCaller(await reg.getAddress(), true);
    await reg.connect(admin).setSanctionsGuard(await guard.getAddress());
    await mgr.connect(admin).setSanctionsGuard(await guard.getAddress());

    // The passkey smart account: passkey owner (identity) + EOA driver owner
    // (test transport standing in for the EntryPoint/bundler leg).
    const Wallet = await ethers.getContractFactory('CoinbaseSmartWallet');
    const impl = await Wallet.deploy();
    const Factory = await ethers.getContractFactory('CoinbaseSmartWalletFactory');
    const factory = await Factory.deploy(await impl.getAddress());
    const passkey = createPasskey();
    const owners = [passkey.ownerBytes, abi.encode(['address'], [driver.address])];
    await factory.createAccount(owners, 0);
    const account = Wallet.attach(await factory['getAddress(bytes[],uint256)'](owners, 0));
    const accountAddr = await account.getAddress();

    // Fund: the account holds ONLY stablecoin (spec journey), bob is a classic EOA user.
    await usdcToken.mint(accountAddr, usdc(10_000));
    await usdcToken.mint(bob.address, usdc(10_000));
    await usdcToken.connect(bob).approve(await mgr.getAddress(), ethers.MaxUint256);
    await usdcToken.connect(bob).approve(await reg.getAddress(), ethers.MaxUint256);
    await mgr.connect(bob).purchaseTier(WAGER_PARTICIPANT_ROLE, Tier.Bronze);

    return { admin, driver, bob, usdcToken, mgr, reg, oracle, guard, account, accountAddr };
  }

  /** Run [approve, act] as ONE executeBatch from the account (FR-016 shape). */
  async function batchAs(fx, calls) {
    return fx.account.connect(fx.driver).executeBatch(
      calls.map((c) => ({ target: c.target, value: 0, data: c.data }))
    );
  }

  async function purchaseMembershipAsAccount(fx) {
    const price = usdc(50);
    return batchAs(fx, [
      {
        target: await fx.usdcToken.getAddress(),
        data: fx.usdcToken.interface.encodeFunctionData('approve', [await fx.mgr.getAddress(), price]),
      },
      {
        target: await fx.mgr.getAddress(),
        data: fx.mgr.interface.encodeFunctionData('purchaseTier', [WAGER_PARTICIPANT_ROLE, Tier.Bronze]),
      },
    ]);
  }

  async function createParams(fx, opponent) {
    const now = await time.latest();
    return [
      opponent,
      ethers.ZeroAddress,
      await fx.usdcToken.getAddress(),
      usdc(10),
      usdc(10),
      BigInt(now) + 86400n,
      BigInt(now) + 864000n,
      Resolution.Either,
      ethers.ZeroHash,
      false,
      ethers.ZeroHash,
      'ipfs://meta',
    ];
  }

  it('purchases membership via one approve+purchase batch; the role binds to the ACCOUNT address', async function () {
    const fx = await loadFixture(deployFixture);
    await purchaseMembershipAsAccount(fx);

    expect(await fx.mgr.getActiveTier(fx.accountAddr, WAGER_PARTICIPANT_ROLE)).to.equal(Tier.Bronze);
    // And NOT to the driver EOA that carried the transaction.
    expect(await fx.mgr.getActiveTier(fx.driver.address, WAGER_PARTICIPANT_ROLE)).to.equal(Tier.None);
  });

  it('refuses a members-only action for an account without the role (same gating as EOAs)', async function () {
    const fx = await loadFixture(deployFixture);
    const params = await createParams(fx, fx.bob.address);
    const data = fx.reg.interface.encodeFunctionData('createWager', params);
    await expect(
      batchAs(fx, [
        {
          target: await fx.usdcToken.getAddress(),
          data: fx.usdcToken.interface.encodeFunctionData('approve', [await fx.reg.getAddress(), usdc(10)]),
        },
        { target: await fx.reg.getAddress(), data },
      ])
    ).to.be.revertedWithCustomError(fx.reg, 'MembershipDenied');
  });

  it('runs the full wager round-trip with the account as creator: create -> accept -> declare -> claim', async function () {
    const fx = await loadFixture(deployFixture);
    await purchaseMembershipAsAccount(fx);

    const params = await createParams(fx, fx.bob.address);
    await batchAs(fx, [
      {
        target: await fx.usdcToken.getAddress(),
        data: fx.usdcToken.interface.encodeFunctionData('approve', [await fx.reg.getAddress(), usdc(10)]),
      },
      { target: await fx.reg.getAddress(), data: fx.reg.interface.encodeFunctionData('createWager', params) },
    ]);

    const wagerId = 1n;
    const wager = await fx.reg.getWager(wagerId);
    expect(wager.creator).to.equal(fx.accountAddr); // creator = the smart account, not the driver

    await fx.reg.connect(fx.bob).acceptWager(wagerId);

    // Opponent declares the account the winner (Resolution.Either).
    await fx.reg.connect(fx.bob).declareWinner(wagerId, fx.accountAddr);

    const before = await fx.usdcToken.balanceOf(fx.accountAddr);
    await fx.account
      .connect(fx.driver)
      .execute(await fx.reg.getAddress(), 0, fx.reg.interface.encodeFunctionData('claimPayout', [wagerId]));
    const after = await fx.usdcToken.balanceOf(fx.accountAddr);

    // Winnings land in the ACCOUNT (creator+opponent stakes, minus any platform fee).
    expect(after - before).to.be.greaterThan(usdc(10));
  });

  it('blocks a sanctioned ACCOUNT address exactly like a sanctioned EOA (FR-011/US6)', async function () {
    const fx = await loadFixture(deployFixture);
    await purchaseMembershipAsAccount(fx);

    await fx.oracle.setSanctioned(fx.accountAddr, true);

    const params = await createParams(fx, fx.bob.address);
    await expect(
      batchAs(fx, [
        {
          target: await fx.usdcToken.getAddress(),
          data: fx.usdcToken.interface.encodeFunctionData('approve', [await fx.reg.getAddress(), usdc(10)]),
        },
        { target: await fx.reg.getAddress(), data: fx.reg.interface.encodeFunctionData('createWager', params) },
      ])
    ).to.be.revertedWithCustomError(fx.guard, 'SanctionedAddress').withArgs(fx.accountAddr);
  });

  it('accepts a wager as the ACCOUNT (opponent side) with stake pulled from the account balance', async function () {
    const fx = await loadFixture(deployFixture);
    await purchaseMembershipAsAccount(fx);

    // bob creates against the account as opponent.
    const now = await time.latest();
    await fx.reg
      .connect(fx.bob)
      .createWager(
        fx.accountAddr,
        ethers.ZeroAddress,
        await fx.usdcToken.getAddress(),
        usdc(10),
        usdc(10),
        BigInt(now) + 86400n,
        BigInt(now) + 864000n,
        Resolution.Either,
        ethers.ZeroHash,
        false,
        ethers.ZeroHash,
        'ipfs://meta'
      );

    const before = await fx.usdcToken.balanceOf(fx.accountAddr);
    await batchAs(fx, [
      {
        target: await fx.usdcToken.getAddress(),
        data: fx.usdcToken.interface.encodeFunctionData('approve', [await fx.reg.getAddress(), usdc(10)]),
      },
      { target: await fx.reg.getAddress(), data: fx.reg.interface.encodeFunctionData('acceptWager', [1n]) },
    ]);
    expect(before - (await fx.usdcToken.balanceOf(fx.accountAddr))).to.equal(usdc(10));
    expect((await fx.reg.getWager(1n)).opponent).to.equal(fx.accountAddr);
  });
});
