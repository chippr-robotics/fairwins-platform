const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployMembershipManager } = require("../helpers/proxy");

// redeemVoucher (spec 026 US2/US3/US4): burn a voucher → soulbound membership of its (role, tier); fail-closed
// redeemer screening; Terms recorded; failure preserves the voucher; private redeem-to-fresh-wallet.

const Tier = { None: 0, Bronze: 1, Silver: 2, Gold: 3, Platinum: 4 };
const WAGER_PARTICIPANT_ROLE = ethers.keccak256(ethers.toUtf8Bytes("WAGER_PARTICIPANT_ROLE"));
const TERMS = ethers.id("terms-v1");
const usdc = (n) => ethers.parseUnits(String(n), 6);

async function setup() {
  const [admin, alice, bob, fresh, treasury] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const usdcToken = await MockERC20.deploy("USD Coin", "USDC", 0);
  await usdcToken.waitForDeployment();

  const mgr = await deployMembershipManager([admin.address, await usdcToken.getAddress(), treasury.address]);
  await mgr.waitForDeployment();
  await mgr.connect(admin).setTier(
    WAGER_PARTICIPANT_ROLE, Tier.Bronze, usdc(50), 30, { monthlyMarketCreation: 5, maxConcurrentMarkets: 2 }, true
  );

  const Voucher = await ethers.getContractFactory("MembershipVoucher");
  const voucher = await Voucher.deploy(admin.address, await mgr.getAddress());
  await voucher.waitForDeployment();
  await mgr.connect(admin).setVoucher(await voucher.getAddress());

  for (const u of [alice, bob, fresh]) {
    await usdcToken.mint(u.address, usdc(10_000));
    await usdcToken.connect(u).approve(await voucher.getAddress(), ethers.MaxUint256);
  }

  const mintTo = async (signer, tier = Tier.Bronze) => {
    const tx = await voucher.connect(signer).mint(WAGER_PARTICIPANT_ROLE, tier);
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return voucher.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "VoucherMinted");
    return Number(ev.args.id);
  };

  return { admin, alice, bob, fresh, treasury, usdcToken, mgr, voucher, mintTo };
}

describe("MembershipManager.redeemVoucher", function () {
  it("burns the voucher and writes the (role, tier) soulbound membership + records Terms (US2)", async function () {
    const { mgr, voucher, alice, mintTo } = await setup();
    const id = await mintTo(alice);
    await expect(mgr.connect(alice).redeemVoucher(id, TERMS)).to.emit(mgr, "MembershipRedeemed");

    await expect(voucher.ownerOf(id)).to.be.revertedWithCustomError(voucher, "ERC721NonexistentToken");
    expect(await mgr.hasActiveRole(alice.address, WAGER_PARTICIPANT_ROLE)).to.equal(true);
    expect(await mgr.getActiveTier(alice.address, WAGER_PARTICIPANT_ROLE)).to.equal(Tier.Bronze);
    const m = await mgr.getMembership(alice.address, WAGER_PARTICIPANT_ROLE);
    expect(m.expiresAt).to.be.greaterThan(await time.latest());
    expect(await mgr.memberTermsHash(alice.address, WAGER_PARTICIPANT_ROLE)).to.equal(TERMS);
  });

  it("grants the tier it was minted for even after tier config changes (FR-009)", async function () {
    const { mgr, admin, alice, mintTo } = await setup();
    const id = await mintTo(alice);
    // Deactivate Bronze after mint; redemption must still grant it.
    await mgr.connect(admin).setTier(
      WAGER_PARTICIPANT_ROLE, Tier.Bronze, usdc(50), 30, { monthlyMarketCreation: 5, maxConcurrentMarkets: 2 }, false
    );
    await mgr.connect(alice).redeemVoucher(id, TERMS);
    expect(await mgr.getActiveTier(alice.address, WAGER_PARTICIPANT_ROLE)).to.equal(Tier.Bronze);
  });

  it("is single-use: a burned voucher cannot be redeemed again (FR-010)", async function () {
    const { mgr, voucher, alice, mintTo } = await setup();
    const id = await mintTo(alice);
    await mgr.connect(alice).redeemVoucher(id, TERMS);
    await expect(mgr.connect(alice).redeemVoucher(id, TERMS))
      .to.be.revertedWithCustomError(voucher, "ERC721NonexistentToken");
  });

  it("rejects redemption when the redeemer already has an active membership; voucher intact (FR-011)", async function () {
    const { mgr, voucher, alice, mintTo } = await setup();
    const id1 = await mintTo(alice);
    await mgr.connect(alice).redeemVoucher(id1, TERMS); // alice now active
    const id2 = await mintTo(alice);
    await expect(mgr.connect(alice).redeemVoucher(id2, TERMS)).to.be.revertedWithCustomError(mgr, "AlreadyActive");
    expect(await voucher.ownerOf(id2)).to.equal(alice.address); // not burned
  });

  it("setVoucher is admin-gated", async function () {
    const { mgr, alice, voucher } = await setup();
    await expect(mgr.connect(alice).setVoucher(await voucher.getAddress()))
      .to.be.revertedWithCustomError(mgr, "AccessControlUnauthorizedAccount");
  });

  // ---- US3: private redeem-to-fresh-wallet ----
  it("succeeds for any owner regardless of who minted (fresh-wallet redeem) (US3 / FR-017)", async function () {
    const { mgr, voucher, alice, fresh, mintTo } = await setup();
    const id = await mintTo(alice);
    await voucher.connect(alice).transferFrom(alice.address, fresh.address, id); // gift to an unlinked wallet
    await mgr.connect(fresh).redeemVoucher(id, TERMS);
    expect(await mgr.hasActiveRole(fresh.address, WAGER_PARTICIPANT_ROLE)).to.equal(true);
    expect(await mgr.hasActiveRole(alice.address, WAGER_PARTICIPANT_ROLE)).to.equal(false);
  });

  it("rejects a redeemer who does not own the voucher (NotVoucherOwner)", async function () {
    const { mgr, bob, alice, mintTo } = await setup();
    const id = await mintTo(alice);
    await expect(mgr.connect(bob).redeemVoucher(id, TERMS)).to.be.revertedWithCustomError(mgr, "NotVoucherOwner");
  });

  // ---- US4: compliance & failure resilience ----
  it("fails closed for a blocked redeemer and preserves the voucher (FR-012/FR-015)", async function () {
    const { mgr, voucher, admin, alice, mintTo } = await setup();
    const MockOracle = await ethers.getContractFactory("MockSanctionsOracle");
    const oracle = await MockOracle.deploy();
    await oracle.waitForDeployment();
    const Guard = await ethers.getContractFactory("SanctionsGuard");
    const guard = await Guard.deploy(admin.address, await oracle.getAddress());
    await guard.waitForDeployment();
    await mgr.connect(admin).setSanctionsGuard(await guard.getAddress());

    const id = await mintTo(alice);
    await oracle.setSanctioned(alice.address, true);
    await expect(mgr.connect(alice).redeemVoucher(id, TERMS)).to.be.revertedWithCustomError(guard, "SanctionedAddress").withArgs(alice.address); // fail-closed
    expect(await voucher.ownerOf(id)).to.equal(alice.address); // NOT burned — re-tradable
    expect(await mgr.hasActiveRole(alice.address, WAGER_PARTICIPANT_ROLE)).to.equal(false);

    // A later eligible buyer redeems the same voucher successfully (SC-006).
    await oracle.setSanctioned(alice.address, false);
    const [, , bob] = await ethers.getSigners();
    await voucher.connect(alice).transferFrom(alice.address, bob.address, id);
    await mgr.connect(bob).redeemVoucher(id, TERMS);
    expect(await mgr.hasActiveRole(bob.address, WAGER_PARTICIPANT_ROLE)).to.equal(true);
  });

  it("reverts redeem when no voucher is configured (VoucherNotSet)", async function () {
    const [admin, , , , treasury] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("USD Coin", "USDC", 0);
    await token.waitForDeployment();
    const mgr = await deployMembershipManager([admin.address, await token.getAddress(), treasury.address]);
    await mgr.waitForDeployment();
    await expect(mgr.redeemVoucher(1, TERMS)).to.be.revertedWithCustomError(mgr, "VoucherNotSet");
  });
});
