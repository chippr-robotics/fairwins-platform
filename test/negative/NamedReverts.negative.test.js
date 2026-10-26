const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployMembershipManager, deployFeeRouter } = require("../helpers/proxy");
const { deployPoolFactory, deployToken, defaultParams, createPool } = require("../helpers/wagerpool");
const { setPackedVar } = require("./helpers/storage");

// Spec 112 FR-006 — named reverts that production contracts can raise but no test asserted by name.
// One `describe` per contract; each asserts the specific error next to the positive path it guards.
//
//   MembershipVoucher.PriceZero, VoucherBatchMinter.PriceZero — a zero-priced tier is never minted
//   BridgeRouter.TreasuryTransferFailed — a treasury that refuses ETH fails loudly, NOT as ResidualFunds
//   PolicyGuardSetup.NotAGuard — the ERC-165 acceptance check Safe.setGuard performs (GS300)
//   RestrictedERC20V2.WrongInitializer — the inherited initializer cannot set up a compliance-less token
//   WagerPool.PoolFull — defence in depth; see the note on that test
//
// (MembershipManager.PriceZero/InsufficientFees, LiquidityRouter.InvalidPoolListing/PoolListingMismatch,
//  CallsignRegistry's repoint errors and SignerIntentBase.FeeRecipientUnset live in their own files.)

const ROLE = ethers.keccak256(ethers.toUtf8Bytes("WAGER_PARTICIPANT_ROLE"));
const Tier = { None: 0, Bronze: 1, Silver: 2 };
const LIMITS = { monthlyMarketCreation: 10, maxConcurrentMarkets: 5 };
const usdc = (n) => ethers.parseUnits(String(n), 6);

describe("Named reverts with no prior assertion (spec 112 FR-006)", function () {
  describe("MembershipVoucher / VoucherBatchMinter — PriceZero", function () {
    async function fixture() {
      const [admin, buyer, treasury] = await ethers.getSigners();
      const token = await (await ethers.getContractFactory("MockUSDCPermit")).deploy();
      const mgr = await deployMembershipManager([admin.address, await token.getAddress(), treasury.address]);
      await mgr.connect(admin).setTier(ROLE, Tier.Bronze, usdc(50), 30, LIMITS, true);
      await mgr.connect(admin).setTier(ROLE, Tier.Silver, 0, 30, LIMITS, true); // active but FREE
      const voucher = await (await ethers.getContractFactory("MembershipVoucher")).deploy(admin.address, await mgr.getAddress());
      const minter = await (await ethers.getContractFactory("VoucherBatchMinter")).deploy(await voucher.getAddress());
      await token.mint(buyer.address, usdc(1000));
      await token.connect(buyer).approve(await voucher.getAddress(), ethers.MaxUint256);
      await token.connect(buyer).approve(await minter.getAddress(), ethers.MaxUint256);
      return { voucher, minter, buyer };
    }

    it("MembershipVoucher.mint reverts PriceZero for an active zero-priced tier; a priced tier mints", async function () {
      const { voucher, buyer } = await fixture();
      await expect(voucher.connect(buyer).mint(ROLE, Tier.Silver)).to.be.revertedWithCustomError(voucher, "PriceZero");
      await expect(voucher.connect(buyer).mint(ROLE, Tier.Bronze)).to.emit(voucher, "VoucherMinted");
    });

    it("VoucherBatchMinter.mintBatch reverts PriceZero for an active zero-priced tier; a priced tier mints", async function () {
      const { minter, buyer } = await fixture();
      await expect(minter.connect(buyer).mintBatch(ROLE, Tier.Silver, 2, buyer.address)).to.be.revertedWithCustomError(minter, "PriceZero");
      await expect(minter.connect(buyer).mintBatch(ROLE, Tier.Bronze, 2, buyer.address)).to.emit(minter, "BatchMinted");
    });
  });

  describe("MembershipVoucher / VoucherBatchMinter — constructor + admin validation", function () {
    it("MembershipVoucher's constructor reverts ZeroAddress for a zero admin or manager; setRoyaltyBps is admin-only and capped (RoyaltyTooHigh)", async function () {
      const [admin, stranger, mgr] = await ethers.getSigners();
      const V = await ethers.getContractFactory("MembershipVoucher");
      await expect(V.deploy(ethers.ZeroAddress, mgr.address)).to.be.revertedWithCustomError(V, "ZeroAddress");
      await expect(V.deploy(admin.address, ethers.ZeroAddress)).to.be.revertedWithCustomError(V, "ZeroAddress");
      const v = await V.deploy(admin.address, mgr.address);
      await expect(v.connect(stranger).setRoyaltyBps(1))
        .to.be.revertedWithCustomError(v, "AccessControlUnauthorizedAccount").withArgs(stranger.address, ethers.ZeroHash);
      const max = await v.MAX_ROYALTY_BPS();
      await expect(v.connect(admin).setRoyaltyBps(max + 1n)).to.be.revertedWithCustomError(v, "RoyaltyTooHigh");
      await expect(v.connect(admin).setRoyaltyBps(max)).to.emit(v, "RoyaltyUpdated").withArgs(max);
    });

    it("VoucherBatchMinter's constructor reverts ZeroAddress for a zero voucher, and for a voucher reporting no membership manager", async function () {
      const M = await ethers.getContractFactory("VoucherBatchMinter");
      await expect(M.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(M, "ZeroAddress");
      // Any contract whose `membershipManager()` reads address(0) — a WagerPoolFactory with no manager wired.
      const { factory } = await deployPoolFactory();
      expect(await factory.membershipManager()).to.equal(ethers.ZeroAddress);
      await expect(M.deploy(await factory.getAddress())).to.be.revertedWithCustomError(M, "ZeroAddress");
    });
  });

  describe("RestrictedERC20V2 — BatchTooLarge", function () {
    it("initializeRestricted and setEligibleBatch revert BatchTooLarge above MAX_BATCH; setEligibleBatch is COMPLIANCE_ROLE-only", async function () {
      const [owner, stranger] = await ethers.getSigners();
      const Impl = await ethers.getContractFactory("RestrictedERC20V2");
      const Proxy = await ethers.getContractFactory("ERC1967Proxy");
      const impl = await Impl.deploy();
      const max = Number(await impl.MAX_BATCH());
      const many = Array.from({ length: max + 1 }, (_, i) => ethers.getAddress(ethers.zeroPadValue(ethers.toBeHex(i + 1), 20)));
      await expect(Proxy.deploy(await impl.getAddress(), Impl.interface.encodeFunctionData("initializeRestricted", ["R", "R", 18, 0, 0, owner.address, ethers.ZeroAddress, many])))
        .to.be.revertedWithCustomError(impl, "BatchTooLarge").withArgs(max + 1, max);

      const proxy = await Proxy.deploy(await impl.getAddress(), Impl.interface.encodeFunctionData("initializeRestricted", ["R", "R", 18, 0, 0, owner.address, ethers.ZeroAddress, []]));
      const t = Impl.attach(await proxy.getAddress());
      await expect(t.connect(stranger).setEligibleBatch([stranger.address], true))
        .to.be.revertedWithCustomError(t, "AccessControlUnauthorizedAccount").withArgs(stranger.address, ethers.keccak256(ethers.toUtf8Bytes("COMPLIANCE_ROLE")));
      await expect(t.connect(owner).setEligibleBatch(many, true)).to.be.revertedWithCustomError(t, "BatchTooLarge").withArgs(max + 1, max);
      await expect(t.connect(owner).setEligibleBatch(many.slice(0, max), true)).to.not.be.reverted;
    });

    it("initializeRestricted cannot run twice (InvalidInitialization)", async function () {
      const [owner] = await ethers.getSigners();
      const Impl = await ethers.getContractFactory("RestrictedERC20V2");
      const impl = await Impl.deploy();
      const args = ["R", "R", 18, 0, 0, owner.address, ethers.ZeroAddress, []];
      const proxy = await (await ethers.getContractFactory("ERC1967Proxy")).deploy(await impl.getAddress(), Impl.interface.encodeFunctionData("initializeRestricted", args));
      const t = Impl.attach(await proxy.getAddress());
      await expect(t.initializeRestricted(...args)).to.be.revertedWithCustomError(t, "InvalidInitialization");
    });
  });

  describe("BridgeRouter — initialisation guard", function () {
    it("initialize cannot run twice on the proxy, nor at all on the bare implementation (InvalidInitialization)", async function () {
      const [admin, a1] = await ethers.getSigners();
      const Impl = await ethers.getContractFactory("BridgeRouter");
      const impl = await Impl.deploy();
      const args = [admin.address, a1.address, a1.address, ethers.ZeroAddress];
      const proxy = await (await ethers.getContractFactory("ERC1967Proxy")).deploy(await impl.getAddress(), Impl.interface.encodeFunctionData("initialize", args));
      const router = Impl.attach(await proxy.getAddress());
      await expect(router.initialize(...args)).to.be.revertedWithCustomError(router, "InvalidInitialization");
      await expect(impl.initialize(...args)).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });
  });

  describe("BridgeRouter — FeeAboveCap on the reported rate (L286)", function () {
    it("bridgeWithFee reverts FeeAboveCap when the FeeRouter REPORTS a rate above MAX_FEE_BPS, even with maxFeeBps at 100%", async function () {
      const [admin, member, recipient, treasury] = await ethers.getSigners();
      const lying = await (await ethers.getContractFactory("MockLyingFeeRouter")).deploy(treasury.address, 251, 0);
      const usdcT = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 0);
      const spoke = await (await ethers.getContractFactory("MockAcrossSpokePool")).deploy();
      const Impl = await ethers.getContractFactory("BridgeRouter");
      const impl = await Impl.deploy();
      const proxy = await (await ethers.getContractFactory("ERC1967Proxy")).deploy(
        await impl.getAddress(),
        Impl.interface.encodeFunctionData("initialize", [admin.address, await lying.getAddress(), await spoke.getAddress(), ethers.ZeroAddress])
      );
      const router = Impl.attach(await proxy.getAddress());
      const out = ethers.getAddress("0x00000000000000000000000000000000000d3517");
      await router.connect(admin).setRoute({ inputToken: await usdcT.getAddress(), enabled: true, nativeInput: false, expectedFillSeconds: 1800, outputToken: out, destinationChainId: 137n, maxAmount: 0n });
      const routeId = await router.computeRouteId(await usdcT.getAddress(), out, 137n);
      const now = await time.latest();
      await expect(router.connect(member).bridgeWithFee(routeId, 1000, 990, recipient.address, now, now + 3600, 0, ethers.ZeroAddress, 10_000))
        .to.be.revertedWithCustomError(router, "FeeAboveCap");
    });
  });

  describe("BridgeRouter — TreasuryTransferFailed", function () {
    const BRIDGE_TRANSFER = ethers.keccak256(ethers.toUtf8Bytes("bridge.transfer"));
    const DEST_CHAIN = 137n;

    it("a native bridge that charges a fee reverts TreasuryTransferFailed when the treasury refuses ETH; succeeds once the treasury can receive", async function () {
      const [admin, member, recipient, treasury] = await ethers.getSigners();
      const feeRouter = await deployFeeRouter([admin.address, treasury.address]);
      await feeRouter.connect(admin).registerService(BRIDGE_TRANSFER, 250, 2 /* ConfigOnly */);
      await feeRouter.connect(admin).setFeeBps(BRIDGE_TRANSFER, 100);

      // A treasury with code and no receive()/fallback: any ETH send to it fails.
      const ethRefuser = await (await ethers.getContractFactory("MockERC20")).deploy("No ETH", "NOETH", 0);
      await feeRouter.connect(admin).setTreasury(await ethRefuser.getAddress());

      const wnative = await (await ethers.getContractFactory("MockERC20")).deploy("Wrapped", "WN", 0);
      const spoke = await (await ethers.getContractFactory("MockAcrossSpokePool")).deploy();
      const Impl = await ethers.getContractFactory("BridgeRouter");
      const impl = await Impl.deploy();
      const proxy = await (await ethers.getContractFactory("ERC1967Proxy")).deploy(
        await impl.getAddress(),
        Impl.interface.encodeFunctionData("initialize", [admin.address, await feeRouter.getAddress(), await spoke.getAddress(), ethers.ZeroAddress])
      );
      const router = Impl.attach(await proxy.getAddress());
      const outToken = ethers.getAddress("0x00000000000000000000000000000000000d3517");
      await router.connect(admin).setRoute({
        inputToken: await wnative.getAddress(), enabled: true, nativeInput: true, expectedFillSeconds: 1800,
        outputToken: outToken, destinationChainId: DEST_CHAIN, maxAmount: 0n,
      });
      const routeId = await router.computeRouteId(await wnative.getAddress(), outToken, DEST_CHAIN);
      const gross = ethers.parseEther("1");
      const send = async () => {
        const now = await time.latest();
        return router.connect(member).bridgeWithFee(routeId, gross, gross - gross / 50n, recipient.address, now, now + 3600, 0, ethers.ZeroAddress, 250, { value: gross });
      };

      await expect(send()).to.be.revertedWithCustomError(router, "TreasuryTransferFailed");
      expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(0);

      await feeRouter.connect(admin).setTreasury(treasury.address);
      await expect(send()).to.emit(router, "BridgeInitiated");
    });
  });

  describe("PolicyGuardSetup — NotAGuard", function () {
    it("enablePolicy reverts NotAGuard for an ERC-165 contract that does not implement the Safe guard interface; a real guard is accepted", async function () {
      const setup = await (await ethers.getContractFactory("PolicyGuardSetup")).deploy();
      const mockSafe = await (await ethers.getContractFactory("MockSafe")).deploy();
      // FeeRouter's bare implementation answers supportsInterface (AccessControl/ERC-165) — but `false`
      // for the guard interface, which is precisely the case the check exists for.
      const notAGuard = await (await ethers.getContractFactory("FeeRouter")).deploy();
      const realGuard = await (await ethers.getContractFactory("SafePolicyGuard")).deploy();

      const call = (g) => setup.interface.encodeFunctionData("enablePolicy", [g, "0x"]);
      await expect(mockSafe.setupDelegate(await setup.getAddress(), call(await notAGuard.getAddress())))
        .to.be.revertedWithCustomError(setup, "NotAGuard");
      await expect(setup.enablePolicy(await notAGuard.getAddress(), "0x")).to.be.revertedWithCustomError(setup, "NotAGuard");
      await expect(mockSafe.setupDelegate(await setup.getAddress(), call(await realGuard.getAddress())))
        .to.not.be.reverted;
    });
  });

  describe("RestrictedERC20V2 — WrongInitializer", function () {
    it("the inherited OpenERC20V2.initialize is disabled: through a proxy and directly it reverts WrongInitializer", async function () {
      const [owner] = await ethers.getSigners();
      const Impl = await ethers.getContractFactory("RestrictedERC20V2");
      const impl = await Impl.deploy();
      const args = ["X", "X", 18, 0, 0, owner.address, ethers.ZeroAddress];
      const Proxy = await ethers.getContractFactory("ERC1967Proxy");
      await expect(Proxy.deploy(await impl.getAddress(), Impl.interface.encodeFunctionData("initialize", args)))
        .to.be.revertedWithCustomError(impl, "WrongInitializer");
      await expect(impl.initialize(...args)).to.be.revertedWithCustomError(impl, "WrongInitializer");
    });
  });

  describe("WagerPool — PoolFull", function () {
    // `PoolFull` is DEFENCE IN DEPTH and is unreachable through the public surface today: every
    // `memberCount += 1` is followed, inside the same nonReentrant frame, by `_maybeAutoClose()`, which
    // flips `state` to JoiningClosed the moment the pool fills — so `JoinClosed` (checked first) always
    // fires before `PoolFull` can. The test therefore (1) pins that ordering on a genuinely full pool,
    // and (2) re-opens `state` directly in storage — the shape of a future change that stops auto-closing
    // — and asserts the capacity check still refuses the next member.
    it("a full pool rejects a join with JoinClosed; with state forced back to JoiningOpen the cap still holds with PoolFull", async function () {
      const [creator, m1, m2, m3] = await ethers.getSigners();
      const { factory } = await deployPoolFactory();
      const token = await deployToken([m1, m2, m3]);
      const { pool, address } = await createPool(factory, creator, await defaultParams(token, { maxMembers: 2 }));
      for (const m of [m1, m2, m3]) await token.connect(m).approve(address, ethers.MaxUint256);

      await pool.connect(m1).join();
      await pool.connect(m2).join();
      expect(await pool.memberCount()).to.equal(2);
      expect(await pool.state()).to.equal(1); // JoiningClosed — auto-closed on fill
      await expect(pool.connect(m3).join()).to.be.revertedWithCustomError(pool, "JoinClosed");

      await setPackedVar(address, "contracts/pools/WagerPool.sol:WagerPool", "state", 0n); // JoiningOpen
      expect(await pool.state()).to.equal(0);
      await expect(pool.connect(m3).join()).to.be.revertedWithCustomError(pool, "PoolFull");
    });
  });
});
