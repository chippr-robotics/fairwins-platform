const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployMembershipManager } = require("../helpers/proxy");
const { expectMissingRole } = require("./helpers/roles");

// Spec 112 FR-004 / Story 2 — MembershipManager is a live UUPS proxy that holds member fees.
// Every admin setter is exercised on its FAILING side with the SPECIFIC error:
//   * a caller without the role ⇒ AccessControlUnauthorizedAccount(caller, role),
//   * a zero address where one is refused ⇒ ZeroAddress,
// plus the (re)initialisation guards, and the fund-path reverts no test asserted before
// (`InsufficientFees`, `PriceZero`). Each guard test also proves the SAME call succeeds once the guard's
// condition is lifted, so neutralising the guard turns the test red rather than leaving it green on a
// different revert.

const Tier = { None: 0, Bronze: 1, Silver: 2, Gold: 3 };
const ROLE = ethers.keccak256(ethers.toUtf8Bytes("WAGER_PARTICIPANT_ROLE"));
const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
const ROLE_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ROLE_MANAGER_ROLE"));
const UPGRADER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("UPGRADER_ROLE"));
const usdc = (n) => ethers.parseUnits(String(n), 6);
const LIMITS = { monthlyMarketCreation: 10, maxConcurrentMarkets: 5 };

describe("MembershipManager — negative paths (spec 112 FR-004)", function () {
  async function fixture() {
    const [admin, member, treasury, stranger, other] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockUSDCPermit");
    const token = await Token.deploy();
    const mgr = await deployMembershipManager([admin.address, await token.getAddress(), treasury.address]);
    await mgr.connect(admin).setTier(ROLE, Tier.Bronze, usdc(50), 30, LIMITS, true);
    await token.mint(member.address, usdc(1000));
    await token.connect(member).approve(await mgr.getAddress(), ethers.MaxUint256);
    return { mgr, token, admin, member, treasury, stranger, other };
  }

  // -------------------------------------------------------------------------- role gates
  //
  // [tag, role, call(mgr as caller, fx)] — every onlyRole(...) function on the contract.
  const GATED = [
    ["setTier", DEFAULT_ADMIN_ROLE, (m) => m.setTier(ROLE, Tier.Silver, usdc(1), 30, LIMITS, true)],
    ["setTreasury", DEFAULT_ADMIN_ROLE, (m, fx) => m.setTreasury(fx.other.address)],
    ["setPaymentToken", DEFAULT_ADMIN_ROLE, (m, fx) => m.setPaymentToken(fx.other.address)],
    ["setAuthorizedCaller", DEFAULT_ADMIN_ROLE, (m, fx) => m.setAuthorizedCaller(fx.other.address, true)],
    ["setSanctionsGuard", DEFAULT_ADMIN_ROLE, (m, fx) => m.setSanctionsGuard(fx.other.address)],
    ["setVoucher", DEFAULT_ADMIN_ROLE, (m, fx) => m.setVoucher(fx.other.address)],
    ["setFeeNetting", DEFAULT_ADMIN_ROLE, (m, fx) => m.setFeeNetting(true, fx.other.address, 1)],
    ["withdrawFees", DEFAULT_ADMIN_ROLE, (m, fx) => m.withdrawFees(0, fx.other.address)],
    ["grantMembership", ROLE_MANAGER_ROLE, (m, fx) => m.grantMembership(fx.other.address, ROLE, Tier.Bronze, 30)],
    ["revokeMembership", ROLE_MANAGER_ROLE, (m, fx) => m.revokeMembership(fx.other.address, ROLE)],
  ];

  describe("role gates", function () {
    for (const [name, role, call] of GATED) {
      it(`[G:MM.${name}.role] ${name} reverts AccessControlUnauthorizedAccount for a caller without the role, and succeeds for the holder`, async function () {
        const fx = await loadFixture(fixture);
        await expectMissingRole(fx.mgr, call(fx.mgr.connect(fx.stranger), fx), fx.stranger.address, role);
        await expect(call(fx.mgr.connect(fx.admin), fx)).to.not.be.reverted;
      });
    }

    it("[G:MM.upgrade.role] upgradeToAndCall reverts AccessControlUnauthorizedAccount(caller, UPGRADER_ROLE)", async function () {
      const fx = await loadFixture(fixture);
      const Impl = await ethers.getContractFactory("MembershipManager");
      const next = await Impl.deploy();
      await expectMissingRole(fx.mgr, fx.mgr.connect(fx.stranger).upgradeToAndCall(await next.getAddress(), "0x"), fx.stranger.address, UPGRADER_ROLE);
    });

    it("[G:MM.onlyAuthorized] recordCreate/recordClose revert NotAuthorized for a non-authorized caller", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.mgr.connect(fx.stranger).recordCreate(fx.member.address, ROLE)).to.be.revertedWithCustomError(fx.mgr, "NotAuthorized");
      await expect(fx.mgr.connect(fx.stranger).recordClose(fx.member.address, ROLE)).to.be.revertedWithCustomError(fx.mgr, "NotAuthorized");
    });
  });

  // -------------------------------------------------------------------------- zero-address checks

  const ZERO_CHECKED = [
    ["setTreasury", (m) => m.setTreasury(ethers.ZeroAddress), (m, fx) => m.setTreasury(fx.other.address)],
    ["setPaymentToken", (m) => m.setPaymentToken(ethers.ZeroAddress), (m, fx) => m.setPaymentToken(fx.other.address)],
    ["setAuthorizedCaller", (m) => m.setAuthorizedCaller(ethers.ZeroAddress, true), (m, fx) => m.setAuthorizedCaller(fx.other.address, true)],
    ["setVoucher", (m) => m.setVoucher(ethers.ZeroAddress), (m, fx) => m.setVoucher(fx.other.address)],
    ["setFeeNetting", (m) => m.setFeeNetting(true, ethers.ZeroAddress, 1), (m, fx) => m.setFeeNetting(true, fx.other.address, 1)],
    ["grantMembership", (m) => m.grantMembership(ethers.ZeroAddress, ROLE, Tier.Bronze, 30), (m, fx) => m.grantMembership(fx.other.address, ROLE, Tier.Bronze, 30)],
    ["revokeMembership", (m) => m.revokeMembership(ethers.ZeroAddress, ROLE), (m, fx) => m.revokeMembership(fx.other.address, ROLE)],
    ["withdrawFees", (m) => m.withdrawFees(0, ethers.ZeroAddress), (m, fx) => m.withdrawFees(0, fx.other.address)],
  ];

  describe("zero-address checks", function () {
    for (const [name, bad, good] of ZERO_CHECKED) {
      it(`[G:MM.${name}.zero] ${name} reverts ZeroAddress for address(0); a real address succeeds`, async function () {
        const fx = await loadFixture(fixture);
        await expect(bad(fx.mgr.connect(fx.admin))).to.be.revertedWithCustomError(fx.mgr, "ZeroAddress");
        await expect(good(fx.mgr.connect(fx.admin), fx)).to.not.be.reverted;
      });
    }

    it("[G:MM.setFeeNetting.disableZero] setFeeNetting(false, address(0)) is allowed (disabling needs no sink)", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.mgr.connect(fx.admin).setFeeNetting(false, ethers.ZeroAddress, 0))
        .to.emit(fx.mgr, "FeeNettingUpdated").withArgs(false, ethers.ZeroAddress, 0);
    });

    it("[G:MM.tierNone] setTier and grantMembership revert TierNone for Tier.None", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.mgr.connect(fx.admin).setTier(ROLE, Tier.None, usdc(1), 30, LIMITS, true)).to.be.revertedWithCustomError(fx.mgr, "TierNone");
      await expect(fx.mgr.connect(fx.admin).grantMembership(fx.other.address, ROLE, Tier.None, 30)).to.be.revertedWithCustomError(fx.mgr, "TierNone");
    });
  });

  // -------------------------------------------------------------------------- (re)initialisation

  describe("initialisation guards", function () {
    async function deployRaw(args) {
      const Impl = await ethers.getContractFactory("MembershipManager");
      const impl = await Impl.deploy();
      const Proxy = await ethers.getContractFactory("ERC1967Proxy");
      return { impl, tx: Proxy.deploy(await impl.getAddress(), Impl.interface.encodeFunctionData("initialize", args)) };
    }

    it("[G:MM.init.zero] initialize reverts ZeroAddress for a zero admin, payment token or treasury", async function () {
      const [admin, , treasury] = await ethers.getSigners();
      const tokenAddr = admin.address; // any non-zero address; initialize does not call it
      for (const args of [
        [ethers.ZeroAddress, tokenAddr, treasury.address],
        [admin.address, ethers.ZeroAddress, treasury.address],
        [admin.address, tokenAddr, ethers.ZeroAddress],
      ]) {
        const { impl, tx } = await deployRaw(args);
        await expect(tx).to.be.revertedWithCustomError(impl, "ZeroAddress");
      }
    });

    it("[G:MM.reinit] initialize cannot run twice on the proxy, nor at all on the bare implementation", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.mgr.initialize(fx.admin.address, await fx.token.getAddress(), fx.treasury.address))
        .to.be.revertedWithCustomError(fx.mgr, "InvalidInitialization");
      const Impl = await ethers.getContractFactory("MembershipManager");
      const bare = await Impl.deploy();
      await expect(bare.initialize(fx.admin.address, await fx.token.getAddress(), fx.treasury.address))
        .to.be.revertedWithCustomError(bare, "InvalidInitialization");
    });

    it("[G:MM.initializeIntents.reinit] initializeIntents (reinitializer(2)) runs at most once", async function () {
      const fx = await loadFixture(fixture);
      await fx.mgr.initializeIntents();
      await expect(fx.mgr.initializeIntents()).to.be.revertedWithCustomError(fx.mgr, "InvalidInitialization");
    });
  });

  // -------------------------------------------------------------------------- fund-path named reverts

  describe("fund paths", function () {
    it("[G:MM.insufficientFees] withdrawFees reverts InsufficientFees above accruedFees; exactly accruedFees succeeds", async function () {
      const fx = await loadFixture(fixture);
      await fx.mgr.connect(fx.member).purchaseTier(ROLE, Tier.Bronze);
      const accrued = await fx.mgr.accruedFees();
      expect(accrued).to.equal(usdc(50));
      await expect(fx.mgr.connect(fx.admin).withdrawFees(accrued + 1n, fx.treasury.address)).to.be.revertedWithCustomError(fx.mgr, "InsufficientFees");
      await expect(fx.mgr.connect(fx.admin).withdrawFees(accrued, fx.treasury.address))
        .to.emit(fx.mgr, "FeesWithdrawn").withArgs(fx.treasury.address, accrued);
      await expect(fx.mgr.connect(fx.admin).withdrawFees(1, fx.treasury.address)).to.be.revertedWithCustomError(fx.mgr, "InsufficientFees");
    });

    it("[G:MM.purchase.priceZero] purchaseTier reverts PriceZero for an active tier priced at zero (a free tier is never sold)", async function () {
      const fx = await loadFixture(fixture);
      await fx.mgr.connect(fx.admin).setTier(ROLE, Tier.Silver, 0, 30, LIMITS, true);
      await expect(fx.mgr.connect(fx.member).purchaseTier(ROLE, Tier.Silver)).to.be.revertedWithCustomError(fx.mgr, "PriceZero");
      await expect(fx.mgr.connect(fx.member).purchaseTierWithTerms(ROLE, Tier.Silver, ethers.id("terms"))).to.be.revertedWithCustomError(fx.mgr, "PriceZero");
    });

    it("[G:MM.extend.priceZero] extendMembership reverts PriceZero when the held tier is re-priced to zero", async function () {
      const fx = await loadFixture(fixture);
      await fx.mgr.connect(fx.member).purchaseTier(ROLE, Tier.Bronze);
      await fx.mgr.connect(fx.admin).setTier(ROLE, Tier.Bronze, 0, 30, LIMITS, true);
      await expect(fx.mgr.connect(fx.member).extendMembership(ROLE)).to.be.revertedWithCustomError(fx.mgr, "PriceZero");
    });
  });

  // -------------------------------------------------------------------------- membership-state validation
  // Branches the baseline coverage run showed as never taken (lcov BRDA L308, L311, L330, L332, L479, L486).

  describe("membership-state validation", function () {
    it("upgradeTier reverts NoActiveMembership with no membership and after expiry", async function () {
      const fx = await loadFixture(fixture);
      await fx.mgr.connect(fx.admin).setTier(ROLE, Tier.Silver, usdc(120), 30, LIMITS, true);
      await expect(fx.mgr.connect(fx.member).upgradeTier(ROLE, Tier.Silver)).to.be.revertedWithCustomError(fx.mgr, "NoActiveMembership");
      await fx.mgr.connect(fx.member).purchaseTier(ROLE, Tier.Bronze);
      await time.increase(31 * 24 * 3600);
      await expect(fx.mgr.connect(fx.member).upgradeTier(ROLE, Tier.Silver)).to.be.revertedWithCustomError(fx.mgr, "NoActiveMembership");
    });

    it("upgradeTier reverts TierInactive for an inactive target tier", async function () {
      const fx = await loadFixture(fixture);
      await fx.mgr.connect(fx.admin).setTier(ROLE, Tier.Silver, usdc(120), 30, LIMITS, false);
      await fx.mgr.connect(fx.member).purchaseTier(ROLE, Tier.Bronze);
      await expect(fx.mgr.connect(fx.member).upgradeTier(ROLE, Tier.Silver)).to.be.revertedWithCustomError(fx.mgr, "TierInactive");
    });

    it("extendMembership reverts NoActiveMembership with no membership, and TierInactive once the held tier is deactivated", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.mgr.connect(fx.member).extendMembership(ROLE)).to.be.revertedWithCustomError(fx.mgr, "NoActiveMembership");
      await fx.mgr.connect(fx.member).purchaseTier(ROLE, Tier.Bronze);
      await fx.mgr.connect(fx.admin).setTier(ROLE, Tier.Bronze, usdc(50), 30, LIMITS, false);
      await expect(fx.mgr.connect(fx.member).extendMembership(ROLE)).to.be.revertedWithCustomError(fx.mgr, "TierInactive");
    });

    it("recordCreate (authorized caller) reverts NoActiveMembership for no membership and for an expired one", async function () {
      const fx = await loadFixture(fixture);
      await fx.mgr.connect(fx.admin).setAuthorizedCaller(fx.admin.address, true);
      await expect(fx.mgr.connect(fx.admin).recordCreate(fx.member.address, ROLE)).to.be.revertedWithCustomError(fx.mgr, "NoActiveMembership");
      await fx.mgr.connect(fx.member).purchaseTier(ROLE, Tier.Bronze);
      await time.increase(31 * 24 * 3600);
      await expect(fx.mgr.connect(fx.admin).recordCreate(fx.member.address, ROLE)).to.be.revertedWithCustomError(fx.mgr, "NoActiveMembership");
    });

    it("checkCanCreate answers false once the monthly creation limit is reached, and true again after the rolling window", async function () {
      const fx = await loadFixture(fixture);
      await fx.mgr.connect(fx.admin).setTier(ROLE, Tier.Bronze, usdc(50), 90, { monthlyMarketCreation: 1, maxConcurrentMarkets: 5 }, true);
      await fx.mgr.connect(fx.admin).setAuthorizedCaller(fx.admin.address, true);
      await fx.mgr.connect(fx.member).purchaseTier(ROLE, Tier.Bronze);
      expect(await fx.mgr.checkCanCreate(fx.member.address, ROLE)).to.equal(true);
      await fx.mgr.connect(fx.admin).recordCreate(fx.member.address, ROLE);
      expect(await fx.mgr.checkCanCreate(fx.member.address, ROLE)).to.equal(false);
      await expect(fx.mgr.connect(fx.admin).recordCreate(fx.member.address, ROLE)).to.be.revertedWithCustomError(fx.mgr, "MonthlyLimitReached");
      await time.increase(31 * 24 * 3600);
      expect(await fx.mgr.checkCanCreate(fx.member.address, ROLE)).to.equal(true);
    });
  });
});
