const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Spec 112 (FR-004 / FR-006), issue #1677 — negative paths for UMAOptimisticOracleV3Adapter.
//
// "Final" for this adapter = OOv3 calls assertionResolvedCallback (liveness elapsed undisputed,
// or the DVM settled a dispute). A dispute is NOT final. Each test drives one guard that keeps a
// forged/unknown callback, a disputed assertion or a malformed registration from producing a
// cached outcome, and asserts the NAMED error.
describe("UMAOptimisticOracleV3Adapter — negative paths (spec 112)", function () {
  const BOND = ethers.parseUnits("100", 6);
  const LIVENESS = 7200;

  async function fix() {
    const [admin, asserter, stranger] = await ethers.getSigners();
    const usdc = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 0);
    const oo = await (await ethers.getContractFactory("MockOptimisticOracleV3")).deploy();
    const Adapter = await ethers.getContractFactory("UMAOptimisticOracleV3Adapter");
    const adapter = await Adapter.deploy(admin.address, await oo.getAddress());
    await usdc.mint(asserter.address, BOND * 10n);
    await usdc.connect(asserter).approve(await adapter.getAddress(), ethers.MaxUint256);
    return { adapter, oo, usdc, admin, asserter, stranger, Adapter };
  }

  async function register(adapter, usdc, id = ethers.id("uma-" + Math.random())) {
    await adapter.registerCondition(id, ethers.toUtf8Bytes("claim"), await usdc.getAddress(), BOND, LIVENESS);
    return id;
  }

  async function assertOne(adapter, asserter, id) {
    const rcpt = await (await adapter.connect(asserter).assertResolution(id, asserter.address)).wait();
    const ev = rcpt.logs
      .map((l) => { try { return adapter.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "AssertionMade");
    return ev.args.assertionId;
  }

  async function asOO(oo) {
    const addr = await oo.getAddress();
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
    await network.provider.request({ method: "hardhat_setBalance", params: [addr, "0x56BC75E2D63100000"] });
    return ethers.getSigner(addr);
  }

  describe("constructor", () => {
    it("rejects a zero OO address with InvalidAddress", async () => {
      const { Adapter, admin } = await loadFixture(fix);
      await expect(Adapter.deploy(admin.address, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(Adapter, "InvalidAddress");
    });
  });

  describe("admin authorisation (Ownable)", () => {
    it("registerCondition / linkMarket from a non-owner revert OwnableUnauthorizedAccount", async () => {
      const { adapter, usdc, stranger } = await loadFixture(fix);
      await expect(adapter.connect(stranger).registerCondition(
        ethers.id("x"), "0x01", await usdc.getAddress(), BOND, LIVENESS
      )).to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount").withArgs(stranger.address);
      const id = await register(adapter, usdc);
      await expect(adapter.connect(stranger).linkMarket(1, id))
        .to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount").withArgs(stranger.address);
    });
  });

  describe("registration + binding", () => {
    it("registerCondition rejects the zero condition id with ConditionNotRegistered", async () => {
      const { adapter, usdc } = await loadFixture(fix);
      await expect(adapter.registerCondition(ethers.ZeroHash, "0x01", await usdc.getAddress(), BOND, LIVENESS))
        .to.be.revertedWithCustomError(adapter, "ConditionNotRegistered");
    });

    it("registerCondition twice reverts ConditionAlreadyRegistered (terms cannot be rewritten)", async () => {
      const { adapter, usdc } = await loadFixture(fix);
      const id = await register(adapter, usdc);
      await expect(adapter.registerCondition(id, "0x02", await usdc.getAddress(), 1n, LIVENESS))
        .to.be.revertedWithCustomError(adapter, "ConditionAlreadyRegistered");
    });

    it("liveness of exactly MIN_LIVENESS - 1 reverts LivenessTooShort (boundary)", async () => {
      const { adapter, usdc } = await loadFixture(fix);
      const min = await adapter.MIN_LIVENESS();
      await expect(adapter.registerCondition(ethers.id("l"), "0x01", await usdc.getAddress(), BOND, min - 1n))
        .to.be.revertedWithCustomError(adapter, "LivenessTooShort");
    });

    it("linkMarket to an unregistered condition reverts ConditionNotRegistered", async () => {
      const { adapter } = await loadFixture(fix);
      await expect(adapter.linkMarket(1, ethers.id("nope")))
        .to.be.revertedWithCustomError(adapter, "ConditionNotRegistered");
    });

    it("linkMarket twice reverts MarketAlreadyLinked and keeps the original binding", async () => {
      const { adapter, usdc } = await loadFixture(fix);
      const a = await register(adapter, usdc);
      const b = await register(adapter, usdc);
      await adapter.linkMarket(1, a);
      await expect(adapter.linkMarket(1, b)).to.be.revertedWithCustomError(adapter, "MarketAlreadyLinked");
      expect(await adapter.marketToCondition(1)).to.equal(a);
    });
  });

  describe("assertion", () => {
    it("assertResolution on an unregistered condition reverts ConditionNotRegistered", async () => {
      const { adapter, asserter } = await loadFixture(fix);
      await expect(adapter.connect(asserter).assertResolution(ethers.id("nope"), asserter.address))
        .to.be.revertedWithCustomError(adapter, "ConditionNotRegistered");
    });

    it("assertResolution with a zero asserter reverts InvalidAddress (bond refund would be burned)", async () => {
      const { adapter, usdc, asserter } = await loadFixture(fix);
      const id = await register(adapter, usdc);
      await expect(adapter.connect(asserter).assertResolution(id, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(adapter, "InvalidAddress");
    });

    it("a bond token re-entering assertResolution during the bond pull reverts ReentrancyGuardReentrantCall", async () => {
      // A hostile bond currency (owner-registered, so this is defence in depth) tries to open a
      // second concurrent assertion while the first is mid-flight.
      const { adapter, asserter } = await loadFixture(fix);
      const rt = await (await ethers.getContractFactory("ReentrantToken")).deploy();
      await rt.mint(asserter.address, BOND * 10n);
      await rt.connect(asserter).approve(await adapter.getAddress(), ethers.MaxUint256);
      const a = ethers.id("re-a");
      const b = ethers.id("re-b");
      for (const id of [a, b]) {
        await adapter.registerCondition(id, "0x01", await rt.getAddress(), BOND, LIVENESS);
      }
      await rt.arm(await adapter.getAddress(),
        adapter.interface.encodeFunctionData("assertResolution", [b, asserter.address]));
      await expect(adapter.connect(asserter).assertResolution(a, asserter.address))
        .to.be.revertedWithCustomError(adapter, "ReentrancyGuardReentrantCall");
      expect(await adapter.conditionToAssertion(a)).to.equal(ethers.ZeroHash);
      expect(await adapter.conditionToAssertion(b)).to.equal(ethers.ZeroHash);
    });

    it("assertResolution after the condition is final reverts AlreadyResolved", async () => {
      const { adapter, oo, usdc, asserter } = await loadFixture(fix);
      const id = await register(adapter, usdc);
      const aid = await assertOne(adapter, asserter, id);
      await oo.mockResolve(aid, true);
      await expect(adapter.connect(asserter).assertResolution(id, asserter.address))
        .to.be.revertedWithCustomError(adapter, "AlreadyResolved");
    });
  });

  describe("callbacks", () => {
    it("assertionDisputedCallback from a non-OO caller reverts UnauthorizedCallback", async () => {
      const { adapter, usdc, asserter, stranger } = await loadFixture(fix);
      const id = await register(adapter, usdc);
      const aid = await assertOne(adapter, asserter, id);
      await expect(adapter.connect(stranger).assertionDisputedCallback(aid))
        .to.be.revertedWithCustomError(adapter, "UnauthorizedCallback");
    });

    it("a forged resolved-callback (non-OO) cannot settle a pending assertion", async () => {
      const { adapter, usdc, asserter, stranger } = await loadFixture(fix);
      const id = await register(adapter, usdc);
      const aid = await assertOne(adapter, asserter, id);
      await expect(adapter.connect(stranger).assertionResolvedCallback(aid, true))
        .to.be.revertedWithCustomError(adapter, "UnauthorizedCallback");
      expect(await adapter.isConditionResolved(id)).to.equal(false);
    });

    it("an OO resolved-callback for an assertion this adapter never made reverts UnknownAssertion", async () => {
      const { adapter, oo } = await loadFixture(fix);
      const signer = await asOO(oo);
      await expect(adapter.connect(signer).assertionResolvedCallback(ethers.id("not-ours"), true))
        .to.be.revertedWithCustomError(adapter, "UnknownAssertion");
    });

    it("an OO disputed-callback for an assertion this adapter never made reverts UnknownAssertion", async () => {
      const { adapter, oo } = await loadFixture(fix);
      const signer = await asOO(oo);
      await expect(adapter.connect(signer).assertionDisputedCallback(ethers.id("not-ours")))
        .to.be.revertedWithCustomError(adapter, "UnknownAssertion");
    });

    it("a dispute is NOT final: no cached outcome, and a second assertion stays blocked", async () => {
      const { adapter, oo, usdc, asserter } = await loadFixture(fix);
      const id = await register(adapter, usdc);
      const aid = await assertOne(adapter, asserter, id);
      await oo.mockDispute(aid);
      expect(await adapter.isConditionResolved(id)).to.equal(false);
      const [outcome, confidence, resolvedAt] = await adapter.getOutcome(id);
      expect([outcome, confidence, resolvedAt]).to.deep.equal([false, 0n, 0n]);
      await expect(adapter.connect(asserter).assertResolution(id, asserter.address))
        .to.be.revertedWithCustomError(adapter, "AssertionAlreadyPending");
    });
  });
});
