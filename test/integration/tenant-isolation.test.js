const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployMembershipManager } = require("../helpers/proxy");

/**
 * Two-tenant isolation suite (spec 072, US2 / SC-002, T022).
 *
 * Dedicated tenants are isolated by SEPARATE contract instances (research D8):
 * two MembershipManager proxies on one chain model tenant A's and tenant B's
 * estates. These probes codify the isolation promise at the contract layer —
 * cross-tenant membership recognition, admin authority, and fee accrual must
 * all be impossible by construction, not merely filtered off-chain.
 */

const Tier = { None: 0, Bronze: 1, Silver: 2, Gold: 3, Platinum: 4 };
const WAGER_PARTICIPANT_ROLE = ethers.keccak256(ethers.toUtf8Bytes("WAGER_PARTICIPANT_ROLE"));
const ROLE_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("ROLE_MANAGER_ROLE"));
const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

const usdc = (n) => ethers.parseUnits(String(n), 6);

describe("Tenant isolation (spec 072)", function () {
  async function twoTenantFixture() {
    const [adminA, adminB, member, treasuryA, treasuryB] = await ethers.getSigners();

    // One payment token on the chain — tenants may well share USDC; isolation
    // must come from the contract instances, not from the token.
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const token = await MockERC20.deploy("USD Coin", "USDC", 0);
    await token.waitForDeployment();

    const tenantA = await deployMembershipManager([adminA.address, await token.getAddress(), treasuryA.address]);
    const tenantB = await deployMembershipManager([adminB.address, await token.getAddress(), treasuryB.address]);

    const limits = { monthlyMarketCreation: 15, maxConcurrentMarkets: 5 };
    await tenantA.connect(adminA).setTier(WAGER_PARTICIPANT_ROLE, Tier.Bronze, usdc(50), 30, limits, true);
    await tenantB.connect(adminB).setTier(WAGER_PARTICIPANT_ROLE, Tier.Bronze, usdc(80), 30, limits, true);

    await token.mint(member.address, usdc(10_000));
    await token.connect(member).approve(await tenantA.getAddress(), ethers.MaxUint256);
    await token.connect(member).approve(await tenantB.getAddress(), ethers.MaxUint256);

    return { token, tenantA, tenantB, adminA, adminB, member, treasuryA, treasuryB };
  }

  it("separate proxies have distinct addresses and independent config", async () => {
    const { tenantA, tenantB } = await loadFixture(twoTenantFixture);
    expect(await tenantA.getAddress()).to.not.equal(await tenantB.getAddress());

    const cfgA = await tenantA.getTierConfig(WAGER_PARTICIPANT_ROLE, Tier.Bronze);
    const cfgB = await tenantB.getTierConfig(WAGER_PARTICIPANT_ROLE, Tier.Bronze);
    expect(cfgA.priceUSDC).to.equal(usdc(50));
    expect(cfgB.priceUSDC).to.equal(usdc(80));
  });

  it("US2.1: a membership purchased in tenant A grants nothing in tenant B", async () => {
    const { tenantA, tenantB, member } = await loadFixture(twoTenantFixture);

    await tenantA.connect(member).purchaseTier(WAGER_PARTICIPANT_ROLE, Tier.Bronze);

    expect(await tenantA.hasActiveRole(member.address, WAGER_PARTICIPANT_ROLE)).to.be.true;
    expect(await tenantB.hasActiveRole(member.address, WAGER_PARTICIPANT_ROLE)).to.be.false;
    expect(await tenantB.getActiveTier(member.address, WAGER_PARTICIPANT_ROLE)).to.equal(Tier.None);
  });

  it("US2.2: tenant A's admin holds no authority in tenant B's contracts", async () => {
    const { tenantA, tenantB, adminA, adminB } = await loadFixture(twoTenantFixture);

    expect(await tenantB.hasRole(DEFAULT_ADMIN_ROLE, adminA.address)).to.be.false;
    expect(await tenantA.hasRole(DEFAULT_ADMIN_ROLE, adminB.address)).to.be.false;

    const limits = { monthlyMarketCreation: 1, maxConcurrentMarkets: 1 };
    await expect(
      tenantB.connect(adminA).setTier(WAGER_PARTICIPANT_ROLE, Tier.Bronze, usdc(1), 30, limits, true)
    ).to.be.revertedWithCustomError(tenantB, "AccessControlUnauthorizedAccount").withArgs(adminA.address, DEFAULT_ADMIN_ROLE);
    await expect(tenantB.connect(adminA).setTreasury(adminA.address)).to.be.revertedWithCustomError(tenantB, "AccessControlUnauthorizedAccount").withArgs(adminA.address, DEFAULT_ADMIN_ROLE);
    await expect(tenantB.connect(adminA).withdrawFees(1, adminA.address)).to.be.revertedWithCustomError(tenantB, "AccessControlUnauthorizedAccount").withArgs(adminA.address, DEFAULT_ADMIN_ROLE);
    await expect(
      tenantB.connect(adminA).grantRole(ROLE_MANAGER_ROLE, adminA.address)
    ).to.be.revertedWithCustomError(tenantB, "AccessControlUnauthorizedAccount").withArgs(adminA.address, DEFAULT_ADMIN_ROLE);
  });

  it("US2.3: fees accrue only in the acting tenant's contract and treasury", async () => {
    const { token, tenantA, tenantB, adminA, member, treasuryA, treasuryB } =
      await loadFixture(twoTenantFixture);

    await tenantA.connect(member).purchaseTier(WAGER_PARTICIPANT_ROLE, Tier.Bronze);

    expect(await tenantA.accruedFees()).to.equal(usdc(50));
    expect(await tenantB.accruedFees()).to.equal(0);

    await tenantA.connect(adminA).withdrawFees(usdc(50), treasuryA.address);
    expect(await token.balanceOf(treasuryA.address)).to.equal(usdc(50));
    expect(await token.balanceOf(treasuryB.address)).to.equal(0);
    expect(await tenantB.accruedFees()).to.equal(0);
  });

  it("a member can hold independent memberships in both tenants (edge case)", async () => {
    const { tenantA, tenantB, member } = await loadFixture(twoTenantFixture);

    await tenantA.connect(member).purchaseTier(WAGER_PARTICIPANT_ROLE, Tier.Bronze);
    await tenantB.connect(member).purchaseTier(WAGER_PARTICIPANT_ROLE, Tier.Bronze);

    // Each instance sees only its own membership state.
    const inA = await tenantA.getMembership(member.address, WAGER_PARTICIPANT_ROLE);
    const inB = await tenantB.getMembership(member.address, WAGER_PARTICIPANT_ROLE);
    expect(inA.tier).to.equal(Tier.Bronze);
    expect(inB.tier).to.equal(Tier.Bronze);
    expect(await tenantA.accruedFees()).to.equal(usdc(50));
    expect(await tenantB.accruedFees()).to.equal(usdc(80));
  });
});
