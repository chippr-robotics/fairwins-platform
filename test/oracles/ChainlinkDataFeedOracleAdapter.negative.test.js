const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

// Spec 112 (FR-004 / FR-006), issue #1677 — negative paths for ChainlinkDataFeedOracleAdapter.
//
// "Final" for this adapter = block.timestamp >= deadline AND the feed's latest round has a
// non-zero `updatedAt` that is at/after the deadline. Each test drives one guard that keeps a
// stale/unanswered feed, a malformed registration or an unauthorised caller from producing a
// cached outcome, and asserts the NAMED error.
describe("ChainlinkDataFeedOracleAdapter — negative paths (spec 112)", function () {
  const GT = 0;

  async function fix() {
    const [admin, stranger] = await ethers.getSigners();
    const now = await time.latest();
    const feed = await (await ethers.getContractFactory("MockChainlinkAggregator")).deploy(100n, 8, now);
    const adapter = await (await ethers.getContractFactory("ChainlinkDataFeedOracleAdapter")).deploy(admin.address);
    await adapter.setFeedAllowed(await feed.getAddress(), true);
    return { adapter, feed, admin, stranger };
  }

  async function register(adapter, feed, deadlineOffset = 3600) {
    const id = ethers.id("df-" + Math.random());
    const deadline = (await time.latest()) + deadlineOffset;
    await adapter.registerCondition(id, await feed.getAddress(), 50n, GT, deadline);
    return { id, deadline };
  }

  describe("admin authorisation (Ownable)", () => {
    it("setFeedAllowed / registerCondition / linkMarket from a non-owner revert OwnableUnauthorizedAccount", async () => {
      const { adapter, feed, stranger } = await loadFixture(fix);
      const feedAddr = await feed.getAddress();
      await expect(adapter.connect(stranger).setFeedAllowed(feedAddr, true))
        .to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount").withArgs(stranger.address);
      const deadline = (await time.latest()) + 3600;
      await expect(adapter.connect(stranger).registerCondition(ethers.id("x"), feedAddr, 1n, GT, deadline))
        .to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount").withArgs(stranger.address);
      const { id } = await register(adapter, feed);
      await expect(adapter.connect(stranger).linkMarket(1, id))
        .to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount").withArgs(stranger.address);
    });

    it("setFeedAllowed rejects the zero feed with InvalidAddress", async () => {
      const { adapter } = await loadFixture(fix);
      await expect(adapter.setFeedAllowed(ethers.ZeroAddress, true))
        .to.be.revertedWithCustomError(adapter, "InvalidAddress");
    });
  });

  describe("registration validation", () => {
    it("rejects the zero condition id with ConditionNotRegistered", async () => {
      const { adapter, feed } = await loadFixture(fix);
      const deadline = (await time.latest()) + 3600;
      await expect(adapter.registerCondition(ethers.ZeroHash, await feed.getAddress(), 1n, GT, deadline))
        .to.be.revertedWithCustomError(adapter, "ConditionNotRegistered");
    });

    it("rejects a deadline in the past with InvalidDeadline", async () => {
      const { adapter, feed } = await loadFixture(fix);
      const past = (await time.latest()) - 1;
      await expect(adapter.registerCondition(ethers.id("p"), await feed.getAddress(), 1n, GT, past))
        .to.be.revertedWithCustomError(adapter, "InvalidDeadline");
    });

    it("rejects a deadline equal to the registration block's timestamp with InvalidDeadline (<= boundary)", async () => {
      const { adapter, feed } = await loadFixture(fix);
      const next = (await time.latest()) + 5;
      await time.setNextBlockTimestamp(next);
      await expect(adapter.registerCondition(ethers.id("eq"), await feed.getAddress(), 1n, GT, next))
        .to.be.revertedWithCustomError(adapter, "InvalidDeadline");
    });

    it("a feed that was de-allowlisted cannot be registered (FeedNotAllowed)", async () => {
      const { adapter, feed } = await loadFixture(fix);
      await adapter.setFeedAllowed(await feed.getAddress(), false);
      const deadline = (await time.latest()) + 3600;
      await expect(adapter.registerCondition(ethers.id("d"), await feed.getAddress(), 1n, GT, deadline))
        .to.be.revertedWithCustomError(adapter, "FeedNotAllowed");
    });

    it("an out-of-range comparison op never reaches the adapter (ABI enum decoding rejects it first)", async () => {
      // InvalidComparisonOp is unreachable through the ABI: Solidity's decoder validates the
      // `Comparison` enum (max 4) and reverts with EMPTY data before the function body runs.
      // We prove that here so the unreachability claim in the spec-112 allowlist is tested,
      // asserting the raw-call failure has no revert data (i.e. it is NOT InvalidComparisonOp
      // nor any other named error).
      const { adapter, feed, admin } = await loadFixture(fix);
      const deadline = (await time.latest()) + 3600;
      const frag = adapter.interface.getFunction("registerCondition");
      const data = frag.selector + ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "address", "int256", "uint8", "uint64"],
        [ethers.id("op"), await feed.getAddress(), 1n, 5, deadline]
      ).slice(2);
      let revertData = null;
      try {
        await admin.call({ to: await adapter.getAddress(), data });
      } catch (e) {
        revertData = e.data ?? "0x";
      }
      expect(revertData).to.equal("0x");
    });
  });

  describe("linking", () => {
    it("linkMarket to an unregistered condition reverts ConditionNotRegistered", async () => {
      const { adapter } = await loadFixture(fix);
      await expect(adapter.linkMarket(1, ethers.id("nope")))
        .to.be.revertedWithCustomError(adapter, "ConditionNotRegistered");
    });

    it("linkMarket twice reverts MarketAlreadyLinked and keeps the original binding", async () => {
      const { adapter, feed } = await loadFixture(fix);
      const a = await register(adapter, feed);
      const b = await register(adapter, feed);
      await adapter.linkMarket(1, a.id);
      await expect(adapter.linkMarket(1, b.id)).to.be.revertedWithCustomError(adapter, "MarketAlreadyLinked");
      expect(await adapter.marketToCondition(1)).to.equal(a.id);
    });
  });

  describe("evaluation finality", () => {
    it("evaluate on an unregistered condition reverts ConditionNotRegistered", async () => {
      const { adapter } = await loadFixture(fix);
      await expect(adapter.evaluate(ethers.id("nope")))
        .to.be.revertedWithCustomError(adapter, "ConditionNotRegistered");
    });

    it("a feed that has never answered (updatedAt == 0) is StaleFeedData, not a resolution", async () => {
      const { adapter, feed } = await loadFixture(fix);
      const { id, deadline } = await register(adapter, feed);
      await feed.setAnswer(1_000n, 0); // answer would satisfy GT 50 — must still not resolve
      await time.increaseTo(deadline + 10);
      await expect(adapter.evaluate(id)).to.be.revertedWithCustomError(adapter, "StaleFeedData");
      expect(await adapter.isConditionResolved(id)).to.equal(false);
    });

    it("a round updated one second before the deadline is StaleFeedData (boundary)", async () => {
      const { adapter, feed } = await loadFixture(fix);
      const { id, deadline } = await register(adapter, feed);
      await feed.setAnswer(1_000n, deadline - 1);
      await time.increaseTo(deadline + 10);
      await expect(adapter.evaluate(id)).to.be.revertedWithCustomError(adapter, "StaleFeedData");
    });

    it("evaluate exactly one second before the deadline reverts DeadlineNotReached", async () => {
      const { adapter, feed } = await loadFixture(fix);
      const { id, deadline } = await register(adapter, feed);
      await time.setNextBlockTimestamp(deadline - 1);
      await expect(adapter.evaluate(id)).to.be.revertedWithCustomError(adapter, "DeadlineNotReached");
    });
  });
});
