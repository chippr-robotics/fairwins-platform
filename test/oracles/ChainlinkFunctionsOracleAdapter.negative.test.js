const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const solc = require("solc");

// A router that re-enters the client from inside sendRequest. Compiled here with the repo's
// pinned solc (spec 112 scope: tests only, nothing under contracts/). Test-only, never deployed.
const REENTRANT_ROUTER_SOURCE = `
// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;
contract ReentrantFunctionsRouter {
    bytes public reenterData;
    uint256 private _n;
    function arm(bytes calldata data) external { reenterData = data; }
    function sendRequest(uint64, bytes calldata, uint16, uint32, bytes32) external returns (bytes32) {
        bytes memory d = reenterData;
        if (d.length > 0) {
            delete reenterData; // one-shot
            (bool ok, bytes memory ret) = msg.sender.call(d);
            if (!ok) assembly { revert(add(ret, 0x20), mload(ret)) }
        }
        _n += 1;
        return keccak256(abi.encode(msg.sender, _n));
    }
}`;

let routerArtifact;
function compileReentrantRouter() {
  if (routerArtifact) return routerArtifact;
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { "R.sol": { content: REENTRANT_ROUTER_SOURCE } },
    settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["R.sol"].ReentrantFunctionsRouter;
  routerArtifact = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
  return routerArtifact;
}

// Spec 112 (FR-004 / FR-006), issue #1677 — negative paths for ChainlinkFunctionsOracleAdapter.
//
// "Final" for this adapter = the Functions router delivered a fulfilment with an empty `err`
// and a non-empty `response`. Every test here drives one guard that keeps a non-final or
// malformed delivery from becoming a cached resolution, or keeps an unauthorised caller out,
// and asserts the guard's NAMED error — never a bare `.reverted`.
describe("ChainlinkFunctionsOracleAdapter — negative paths (spec 112)", function () {
  const SOURCE = "return Functions.encodeUint256(1);";
  const DON_ID = "0x" + Buffer.from("fun-polygon-amoy-1").toString("hex").padEnd(64, "0");
  const ENCODED = ethers.toUtf8Bytes(SOURCE);
  const SOURCE_HASH = ethers.keccak256(ENCODED);

  async function fix() {
    const [admin, stranger] = await ethers.getSigners();
    const router = await (await ethers.getContractFactory("MockFunctionsRouter")).deploy();
    const Adapter = await ethers.getContractFactory("ChainlinkFunctionsOracleAdapter");
    const adapter = await Adapter.deploy(admin.address, await router.getAddress());
    return { adapter, router, admin, stranger, Adapter };
  }

  async function register(adapter, id = ethers.id("cf-" + Math.random())) {
    await adapter.registerCondition(id, ENCODED, SOURCE_HASH, 42, 300_000, DON_ID);
    return id;
  }

  async function request(adapter, conditionId) {
    const rcpt = await (await adapter.requestResolution(conditionId)).wait();
    const ev = rcpt.logs
      .map((l) => { try { return adapter.interface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "ResolutionRequested");
    return ev.args.requestId;
  }

  // Act AS the router (the only address FunctionsClient lets fulfil) without going through the
  // mock's `fulfill`, which refuses request ids it did not mint itself.
  async function asRouter(router) {
    const addr = await router.getAddress();
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
    await network.provider.request({ method: "hardhat_setBalance", params: [addr, "0x56BC75E2D63100000"] });
    return ethers.getSigner(addr);
  }

  describe("constructor", () => {
    it("rejects a zero router with RouterHasNoCode", async () => {
      const { Adapter, admin } = await loadFixture(fix);
      await expect(Adapter.deploy(admin.address, ethers.ZeroAddress))
        .to.be.revertedWithCustomError(Adapter, "RouterHasNoCode");
    });
  });

  describe("admin authorisation (ConfirmedOwner)", () => {
    it("registerCondition from a non-owner reverts 'Only callable by owner'", async () => {
      const { adapter, stranger } = await loadFixture(fix);
      await expect(
        adapter.connect(stranger).registerCondition(ethers.id("x"), ENCODED, SOURCE_HASH, 42, 300_000, DON_ID)
      ).to.be.revertedWith("Only callable by owner");
    });

    it("linkMarket from a non-owner reverts 'Only callable by owner'", async () => {
      const { adapter, stranger } = await loadFixture(fix);
      const id = await register(adapter);
      await expect(adapter.connect(stranger).linkMarket(1, id)).to.be.revertedWith("Only callable by owner");
    });
  });

  describe("condition binding", () => {
    it("registerCondition rejects the zero condition id with ConditionNotRegistered", async () => {
      const { adapter } = await loadFixture(fix);
      await expect(
        adapter.registerCondition(ethers.ZeroHash, ENCODED, SOURCE_HASH, 42, 300_000, DON_ID)
      ).to.be.revertedWithCustomError(adapter, "ConditionNotRegistered");
    });

    it("linkMarket to an unregistered condition reverts ConditionNotRegistered", async () => {
      const { adapter } = await loadFixture(fix);
      await expect(adapter.linkMarket(7, ethers.id("never-registered")))
        .to.be.revertedWithCustomError(adapter, "ConditionNotRegistered");
    });

    it("linkMarket twice for the same market reverts MarketAlreadyLinked (no re-pointing a market)", async () => {
      const { adapter } = await loadFixture(fix);
      const a = await register(adapter);
      const b = await register(adapter);
      await adapter.linkMarket(7, a);
      await expect(adapter.linkMarket(7, b)).to.be.revertedWithCustomError(adapter, "MarketAlreadyLinked");
      expect(await adapter.marketToCondition(7)).to.equal(a);
    });

    it("requestResolution for an unregistered condition reverts ConditionNotRegistered", async () => {
      const { adapter } = await loadFixture(fix);
      await expect(adapter.requestResolution(ethers.id("never-registered")))
        .to.be.revertedWithCustomError(adapter, "ConditionNotRegistered");
    });

    it("requestResolution after the condition is final reverts AlreadyResolved", async () => {
      const { adapter, router } = await loadFixture(fix);
      const id = await register(adapter);
      const req = await request(adapter, id);
      await router.fulfill(req, "0x01", "0x");
      expect(await adapter.isConditionResolved(id)).to.equal(true);
      await expect(adapter.requestResolution(id)).to.be.revertedWithCustomError(adapter, "AlreadyResolved");
    });
  });

  describe("re-entrancy", () => {
    it("a router re-entering requestResolution from sendRequest reverts ReentrancyGuardReentrantCall", async function () {
      this.timeout(120_000);
      const { admin, Adapter } = await loadFixture(fix);
      const { abi, bytecode } = compileReentrantRouter();
      const router = await new ethers.ContractFactory(abi, bytecode, admin).deploy();
      const adapter = await Adapter.deploy(admin.address, await router.getAddress());
      const id = await register(adapter);
      await router.arm(adapter.interface.encodeFunctionData("requestResolution", [id]));
      await expect(adapter.requestResolution(id))
        .to.be.revertedWithCustomError(adapter, "ReentrancyGuardReentrantCall");
      expect(await adapter.conditionToPendingRequest(id)).to.equal(ethers.ZeroHash);
      // Control: un-armed (the one-shot delete was rolled back with the revert, so disarm
      // explicitly), the same router accepts the request — the guard, not the harness, fired.
      await router.arm("0x");
      await expect(adapter.requestResolution(id)).to.emit(adapter, "ResolutionRequested");
    });
  });

  describe("fulfilment", () => {
    it("a fulfilment from anyone but the router reverts OnlyRouterCanFulfill", async () => {
      const { adapter, stranger } = await loadFixture(fix);
      const id = await register(adapter);
      const req = await request(adapter, id);
      await expect(adapter.connect(stranger).handleOracleFulfillment(req, "0x01", "0x"))
        .to.be.revertedWithCustomError(adapter, "OnlyRouterCanFulfill");
      expect(await adapter.isConditionResolved(id)).to.equal(false);
    });

    it("a router fulfilment for a request id the adapter never sent reverts UnknownRequestId", async () => {
      const { adapter, router } = await loadFixture(fix);
      await register(adapter);
      const r = await asRouter(router);
      await expect(adapter.connect(r).handleOracleFulfillment(ethers.id("forged-request"), "0x01", "0x"))
        .to.be.revertedWithCustomError(adapter, "UnknownRequestId");
    });

    it("an empty response with no error reverts InvalidResponseLength and caches nothing", async () => {
      const { adapter, router } = await loadFixture(fix);
      const id = await register(adapter);
      const req = await request(adapter, id);
      await expect(router.fulfill(req, "0x", "0x"))
        .to.be.revertedWithCustomError(adapter, "InvalidResponseLength");
      expect(await adapter.isConditionResolved(id)).to.equal(false);
      const [outcome, confidence, resolvedAt] = await adapter.getOutcome(id);
      expect([outcome, confidence, resolvedAt]).to.deep.equal([false, 0n, 0n]);
      // The revert rolled back the pending-slot delete, so the request is still the pending one.
      expect(await adapter.conditionToPendingRequest(id)).to.equal(req);
    });

    it("a DON error is NOT a resolution: nothing cached, pending slot freed for a retry", async () => {
      const { adapter, router } = await loadFixture(fix);
      const id = await register(adapter);
      const req = await request(adapter, id);
      await expect(router.fulfill(req, "0x01", "0x" + Buffer.from("boom").toString("hex")))
        .to.emit(adapter, "RequestFailed");
      expect(await adapter.isConditionResolved(id)).to.equal(false);
      const [, confidence, resolvedAt] = await adapter.getOutcome(id);
      expect(confidence).to.equal(0n);
      expect(resolvedAt).to.equal(0n);
      expect(await adapter.conditionToPendingRequest(id)).to.equal(ethers.ZeroHash);
      // A retry is allowed (RequestAlreadyPending would fire if the slot had not been freed).
      await expect(adapter.requestResolution(id)).to.emit(adapter, "ResolutionRequested");
    });
  });
});
