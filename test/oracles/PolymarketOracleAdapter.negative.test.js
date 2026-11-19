const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const solc = require("solc");

// Spec 112 (FR-004 / FR-006), issue #1677 — negative paths for PolymarketOracleAdapter.
//
// "Final" for this adapter = the CTF reports the condition resolved AND returns a 2-slot payout
// array (and a denominator). Each test drives one guard that keeps an unreachable/broken CTF, an
// unresolved condition or a malformed (non-binary) payout from producing a cached resolution,
// and asserts the NAMED error / require message.
//
// A CTF that answers `isResolved` but then fails a later read cannot be built from the shared
// MockPolymarketCTF (it gates every read on the same `resolved` flag). Rather than add a
// contract under contracts/ (spec 112 scope: tests only), a tiny fault-injecting CTF is compiled
// here with the repo's pinned solc and deployed directly. It is test-only and never deployed.
const FLAKY_CTF_SOURCE = `
// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.24;
contract FlakyCTF {
    // 0 = isResolved reverts, 1 = getPayoutNumerators reverts,
    // 2 = getPayoutDenominator reverts, 3 = every read answers (control),
    // 4 = resolved but getPayoutNumerators returns a 1-slot (malformed) array
    uint8 public mode;
    function setMode(uint8 m) external { mode = m; }
    function isResolved(bytes32) external view returns (bool) { require(mode != 0, "down"); return true; }
    function getPayoutNumerators(bytes32) external view returns (uint256[] memory p) {
        require(mode != 1, "down");
        p = new uint256[](mode == 4 ? 1 : 2);
        p[0] = 1;
    }
    function getPayoutDenominator(bytes32) external view returns (uint256) { require(mode != 2, "down"); return 1; }
    function getCondition(bytes32) external pure returns (address, bytes32, uint256, bool) {
        return (address(1), bytes32(0), 2, true);
    }
}`;

let flakyArtifact;
function compileFlaky() {
  if (flakyArtifact) return flakyArtifact;
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { "FlakyCTF.sol": { content: FLAKY_CTF_SOURCE } },
    settings: { outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  })));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts["FlakyCTF.sol"].FlakyCTF;
  flakyArtifact = { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
  return flakyArtifact;
}

describe("PolymarketOracleAdapter — negative paths (spec 112)", function () {
  this.timeout(120_000);

  async function fix() {
    const [admin, stranger] = await ethers.getSigners();
    const ctf = await (await ethers.getContractFactory("MockPolymarketCTF")).deploy();
    const adapter = await (await ethers.getContractFactory("PolymarketOracleAdapter"))
      .deploy(admin.address, await ctf.getAddress());
    const { abi, bytecode } = compileFlaky();
    const flaky = await new ethers.ContractFactory(abi, bytecode, admin).deploy();
    await adapter.addCTFContract(await flaky.getAddress());
    return { adapter, ctf, flaky, admin, stranger };
  }

  async function prepared(ctf, admin, slots, payouts) {
    const q = ethers.id("q-" + Math.random());
    const id = await ctf.getConditionId(admin.address, q, slots);
    await ctf.prepareCondition(admin.address, q, slots);
    if (payouts) await ctf.resolveCondition(id, payouts);
    return id;
  }

  describe("admin authorisation (Ownable)", () => {
    it("every admin setter rejects a non-owner with OwnableUnauthorizedAccount", async () => {
      const { adapter, ctf, admin, stranger } = await loadFixture(fix);
      const id = await prepared(ctf, admin, 2);
      const ctfAddr = await ctf.getAddress();
      const calls = [
        () => adapter.connect(stranger).addCTFContract(stranger.address),
        () => adapter.connect(stranger).removeCTFContract(ctfAddr),
        () => adapter.connect(stranger).updatePrimaryCTF(stranger.address),
        () => adapter.connect(stranger).linkMarketToPolymarket(1, id),
        () => adapter.connect(stranger).linkMarketToPolymarketWithCTF(1, id, ctfAddr),
        () => adapter.connect(stranger).unlinkMarket(1),
      ];
      for (const call of calls) {
        await expect(call()).to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount")
          .withArgs(stranger.address);
      }
    });

    it("updatePrimaryCTF rejects the zero address with InvalidAddress", async () => {
      const { adapter } = await loadFixture(fix);
      await expect(adapter.updatePrimaryCTF(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(adapter, "InvalidAddress");
    });
  });

  describe("linking against a broken CTF", () => {
    it("a CTF whose getCondition reverts is InvalidConditionId (try/catch), not a link", async () => {
      // MockERC20 has no getCondition and no fallback, so the call reverts inside the try.
      const { adapter, admin } = await loadFixture(fix);
      const notCtf = await (await ethers.getContractFactory("MockERC20")).deploy("X", "X", 0);
      await adapter.addCTFContract(await notCtf.getAddress());
      await expect(adapter.connect(admin).linkMarketToPolymarketWithCTF(1, ethers.id("c"), await notCtf.getAddress()))
        .to.be.revertedWithCustomError(adapter, "InvalidConditionId");
      expect(await adapter.isMarketLinked(1)).to.equal(false);
    });
  });

  describe("fetchResolution finality", () => {
    it("isResolved reverting is FetchFailed", async () => {
      const { adapter, flaky } = await loadFixture(fix);
      await flaky.setMode(0);
      await expect(adapter.fetchResolutionFromCTF(ethers.id("c"), await flaky.getAddress()))
        .to.be.revertedWithCustomError(adapter, "FetchFailed");
    });

    it("getPayoutNumerators reverting after isResolved=true is FetchFailed (nothing cached)", async () => {
      const { adapter, flaky } = await loadFixture(fix);
      await flaky.setMode(1);
      const id = ethers.id("c1");
      await expect(adapter.fetchResolutionFromCTF(id, await flaky.getAddress()))
        .to.be.revertedWithCustomError(adapter, "FetchFailed");
      expect((await adapter.getCachedResolution(id)).resolved).to.equal(false);
    });

    it("getPayoutDenominator reverting after isResolved=true is FetchFailed (nothing cached)", async () => {
      const { adapter, flaky } = await loadFixture(fix);
      await flaky.setMode(2);
      const id = ethers.id("c2");
      await expect(adapter.fetchResolutionFromCTF(id, await flaky.getAddress()))
        .to.be.revertedWithCustomError(adapter, "FetchFailed");
      expect((await adapter.getCachedResolution(id)).resolved).to.equal(false);
    });

    it("control: the same fault-injecting CTF with every read answering does cache", async () => {
      // Proves the three FetchFailed tests above fail for the injected fault, not the harness.
      const { adapter, flaky } = await loadFixture(fix);
      await flaky.setMode(3);
      const id = ethers.id("c3");
      await expect(adapter.fetchResolutionFromCTF(id, await flaky.getAddress()))
        .to.emit(adapter, "ResolutionCached").withArgs(id, 1n, 0n, 1n);
    });

    it("a resolved NON-binary payout array is rejected with 'Invalid payout array'", async () => {
      // A 3-outcome condition resolved [1,0,0]: final on the CTF, but not a YES/NO answer.
      const { adapter, ctf, admin } = await loadFixture(fix);
      const id = await prepared(ctf, admin, 3, [1, 0, 0]);
      await expect(adapter.fetchResolution(id)).to.be.revertedWith("Invalid payout array");
      expect((await adapter.getCachedResolution(id)).resolved).to.equal(false);
    });

    it("a de-listed CTF can no longer feed resolutions (CTFNotSupported)", async () => {
      const { adapter, ctf, admin } = await loadFixture(fix);
      const id = await prepared(ctf, admin, 2, [1, 0]);
      await adapter.removeCTFContract(await ctf.getAddress());
      await expect(adapter.fetchResolution(id)).to.be.revertedWithCustomError(adapter, "CTFNotSupported");
    });

    it("getResolutionForMarket swallows a FetchFailed into (0,0,0,false) — unresolved, never a guess", async () => {
      const { adapter, flaky, admin } = await loadFixture(fix);
      await flaky.setMode(3); // getCondition answers a binary condition so linking succeeds
      const id = ethers.id("linked");
      await adapter.connect(admin).linkMarketToPolymarketWithCTF(9, id, await flaky.getAddress());
      await flaky.setMode(1);
      const r = await adapter.getResolutionForMarket.staticCall(9);
      expect([r[0], r[1], r[2], r[3]]).to.deep.equal([0n, 0n, 0n, false]);
    });
  });

  describe("view paths against a broken primary CTF", () => {
    it("isConditionResolved / isConditionSupported / isAvailable / getOutcome fail closed when the CTF reverts", async () => {
      const { adapter, flaky } = await loadFixture(fix);
      await adapter.updatePrimaryCTF(await flaky.getAddress());
      await flaky.setMode(0); // isResolved reverts
      const id = ethers.id("v");
      expect(await adapter.isConditionResolved(id)).to.equal(false);
      expect(await adapter.isAvailable()).to.equal(false);
      const [o, c, t] = await adapter.getOutcome(id);
      expect([o, c, t]).to.deep.equal([false, 0n, 0n]);
      // getCondition on a contract without it reverts -> unsupported
      const notCtf = await (await ethers.getContractFactory("MockERC20")).deploy("X", "X", 0);
      await adapter.updatePrimaryCTF(await notCtf.getAddress());
      expect(await adapter.isConditionSupported(id)).to.equal(false);
    });

    it("getOutcome on a resolved condition whose numerators read reverts produces NO outcome (bubbles the CTF revert)", async () => {
      // Only `isResolved` sits inside getOutcome's try; the getPayoutNumerators call is in the
      // success block, so its revert propagates rather than falling through to the sentinel.
      // Still fail-safe for the registry (autoResolve reverts => deadline refund path), and
      // pinned here so a refactor that turns this into a fabricated answer goes red.
      const { adapter, flaky } = await loadFixture(fix);
      await adapter.updatePrimaryCTF(await flaky.getAddress());
      await flaky.setMode(1); // isResolved=true, numerators revert
      await expect(adapter.getOutcome(ethers.id("v2"))).to.be.revertedWith("down");
    });

    it("getOutcome on a resolved condition with a malformed (<2 slot) payout array returns the unresolved sentinel", async () => {
      const { adapter, flaky } = await loadFixture(fix);
      await adapter.updatePrimaryCTF(await flaky.getAddress());
      await flaky.setMode(4);
      const [o, c, t] = await adapter.getOutcome(ethers.id("short"));
      expect([o, c, t]).to.deep.equal([false, 0n, 0n]);
    });

    it("once cached, views answer from the cache even if the CTF later breaks (no re-read of a final answer)", async () => {
      const { adapter, ctf, flaky, admin } = await loadFixture(fix);
      const id = await prepared(ctf, admin, 2, [0, 1]);
      await adapter.connect(admin).linkMarketToPolymarket(3, id);
      await adapter.fetchResolution(id);
      // Point the primary at a CTF that reverts every read and de-list the CTF that answered:
      // the cached paths must not need either of them.
      await adapter.updatePrimaryCTF(await flaky.getAddress());
      await adapter.removeCTFContract(await ctf.getAddress());
      await flaky.setMode(0);
      expect(await adapter.isConditionResolved(id)).to.equal(true);
      expect(await adapter.isConditionSupported(id)).to.equal(true);
      const r = await adapter.getResolutionForMarket.staticCall(3);
      expect([r[0], r[1], r[2], r[3]]).to.deep.equal([0n, 1n, 1n, true]);
      const [o, c] = await adapter.getOutcome(id);
      expect(o).to.equal(false);
      expect(c).to.equal(10000n);
    });

    it("isAvailable is false for a primary CTF address with no code", async () => {
      const { adapter, stranger } = await loadFixture(fix);
      await adapter.updatePrimaryCTF(stranger.address);
      expect(await adapter.isAvailable()).to.equal(false);
    });
  });
});
