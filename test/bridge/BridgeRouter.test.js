const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployFeeRouter } = require("../helpers/proxy");

// spec 067 — BridgeRouter: curated route registry + `bridge.transfer` fee-and-forward router.
// The fork suite (test/fork/bridgeRouter.fork.test.js) proves the same invariants against the real
// Across SpokePool; this file proves them against a recording mock, so a regression in the
// `depositor` argument, the residual-funds guard, or the consent ceiling fails fast and locally.
describe("BridgeRouter", function () {
  const BRIDGE_TRANSFER = ethers.keccak256(ethers.toUtf8Bytes("bridge.transfer"));
  const Kind = { Unregistered: 0, Wrapped: 1, ConfigOnly: 2 };
  const AMT = (n) => ethers.parseEther(n);

  // hardhat's own chain id (hardhat.config.js networks.hardhat.chainId) — the value a route may
  // never target, since a route's destination must be another chain.
  const LOCAL_CHAIN = 1337n;
  const DEST_CHAIN = 137n; // Polygon
  const BPS = 10_000n;

  let admin, liquidityAdmin, guardian, member, treasury, stranger, recipient;
  let feeRouter, router, spoke, usdc, usdcDest, wnative;
  let routerAddr, spokeAddr, usdcAddr, wnativeAddr;
  let routeId, nativeRouteId;

  /// Deploy BridgeRouter behind an ERC1967 UUPS proxy, mirroring
  /// test/helpers/proxy.js#deployStakingRouter. `initArgs` is
  /// `[admin, feeRouter, spokePool, sanctionsGuard]`. Manual proxy wiring keeps the suite fast; the
  /// plugin's storage-layout/safety validation runs via `npm run check:storage-layout`.
  async function deployBridgeRouter(initArgs) {
    const Impl = await ethers.getContractFactory("BridgeRouter");
    const impl = await Impl.deploy();
    await impl.waitForDeployment();

    const initData = Impl.interface.encodeFunctionData("initialize", initArgs);
    const Proxy = await ethers.getContractFactory("ERC1967Proxy");
    const proxy = await Proxy.deploy(await impl.getAddress(), initData);
    await proxy.waitForDeployment();

    return Impl.attach(await proxy.getAddress());
  }

  /// A valid ERC-20 route, with per-test overrides.
  function route(overrides = {}) {
    return {
      inputToken: usdcAddr,
      enabled: true,
      nativeInput: false,
      expectedFillSeconds: 1800,
      outputToken: usdcDest,
      destinationChainId: DEST_CHAIN,
      maxAmount: 0n, // uncapped
      ...overrides,
    };
  }

  /// A valid `bridgeWithFee` argument set (deadline in the future), with per-test overrides.
  async function args(overrides = {}) {
    const now = await time.latest();
    return {
      routeId,
      inputAmount: AMT("1000"),
      outputAmount: AMT("999"),
      recipient: recipient.address,
      quoteTimestamp: now,
      fillDeadline: now + 3600,
      exclusivityDeadline: 0,
      exclusiveRelayer: ethers.ZeroAddress,
      maxFeeBps: 250,
      ...overrides,
    };
  }

  function bridge(signer, a, value = 0n) {
    return router
      .connect(signer)
      .bridgeWithFee(
        a.routeId,
        a.inputAmount,
        a.outputAmount,
        a.recipient,
        a.quoteTimestamp,
        a.fillDeadline,
        a.exclusivityDeadline,
        a.exclusiveRelayer,
        a.maxFeeBps,
        { value }
      );
  }

  beforeEach(async function () {
    [admin, liquidityAdmin, guardian, member, treasury, stranger, recipient] = await ethers.getSigners();

    feeRouter = await deployFeeRouter([admin.address, treasury.address]);
    await feeRouter.connect(admin).registerService(BRIDGE_TRANSFER, 250, Kind.ConfigOnly);

    const ERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await ERC20.deploy("USD Coin", "USDC", 0);
    wnative = await ERC20.deploy("Wrapped Native", "WNATIVE", 0);
    usdcAddr = await usdc.getAddress();
    wnativeAddr = await wnative.getAddress();
    usdcDest = ethers.getAddress("0x00000000000000000000000000000000000d3517"); // destination-side asset

    const Spoke = await ethers.getContractFactory("MockAcrossSpokePool");
    spoke = await Spoke.deploy();
    spokeAddr = await spoke.getAddress();

    router = await deployBridgeRouter([
      admin.address,
      await feeRouter.getAddress(),
      spokeAddr,
      ethers.ZeroAddress, // screening disabled by default
    ]);
    routerAddr = await router.getAddress();
    await router.connect(admin).grantRole(await router.LIQUIDITY_ADMIN_ROLE(), liquidityAdmin.address);
    await router.connect(admin).grantRole(await router.GUARDIAN_ROLE(), guardian.address);

    await router.connect(liquidityAdmin).setRoute(route());
    routeId = await router.computeRouteId(usdcAddr, usdcDest, DEST_CHAIN);
    await router.connect(liquidityAdmin).setRoute(route({ inputToken: wnativeAddr, nativeInput: true }));
    nativeRouteId = await router.computeRouteId(wnativeAddr, usdcDest, DEST_CHAIN);

    await usdc.mint(member.address, AMT("1000000"));
    await usdc.connect(member).approve(routerAddr, ethers.MaxUint256);
  });

  describe("initialize", function () {
    it("grants the four roles to admin and stores the protocol references", async function () {
      expect(await router.hasRole(await router.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await router.hasRole(await router.UPGRADER_ROLE(), admin.address)).to.equal(true);
      expect(await router.hasRole(await router.LIQUIDITY_ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await router.hasRole(await router.GUARDIAN_ROLE(), admin.address)).to.equal(true);
      expect(await router.feeRouter()).to.equal(await feeRouter.getAddress());
      expect(await router.spokePool()).to.equal(spokeAddr);
      expect(await router.sanctionsGuard()).to.equal(ethers.ZeroAddress);
      expect(await router.bridgeTransferServiceId()).to.equal(BRIDGE_TRANSFER);
    });

    it("reverts on a zero admin, feeRouter, or spokePool", async function () {
      const fr = await feeRouter.getAddress();
      await expect(deployBridgeRouter([ethers.ZeroAddress, fr, spokeAddr, ethers.ZeroAddress])).to.be.reverted;
      await expect(deployBridgeRouter([admin.address, ethers.ZeroAddress, spokeAddr, ethers.ZeroAddress])).to.be
        .reverted;
      await expect(deployBridgeRouter([admin.address, fr, ethers.ZeroAddress, ethers.ZeroAddress])).to.be.reverted;
    });
  });

  // ---------------------------------------------------------------- T026
  describe("role gating on every setter (T026)", function () {
    it("rejects setRoute from a caller without LIQUIDITY_ADMIN_ROLE", async function () {
      await expect(router.connect(stranger).setRoute(route({ destinationChainId: 10n })))
        .to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
      // GUARDIAN alone is not enough — the two roles are deliberately disjoint.
      await expect(router.connect(guardian).setRoute(route({ destinationChainId: 10n })))
        .to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
    });

    it("rejects setRouteEnabled from a caller without LIQUIDITY_ADMIN_ROLE", async function () {
      await expect(router.connect(stranger).setRouteEnabled(routeId, false))
        .to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
      expect((await router.getRoute(routeId)).enabled).to.equal(true);
    });

    it("rejects setRouteLimit from a caller without LIQUIDITY_ADMIN_ROLE", async function () {
      await expect(router.connect(stranger).setRouteLimit(routeId, AMT("1")))
        .to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
      expect((await router.getRoute(routeId)).maxAmount).to.equal(0n);
    });

    it("rejects removeRoute from a caller without LIQUIDITY_ADMIN_ROLE", async function () {
      await expect(router.connect(stranger).removeRoute(routeId))
        .to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
      expect(await router.routeCount()).to.equal(2);
    });

    // The protocol-wiring setters are DEFAULT_ADMIN_ROLE, a role ABOVE curation. `spokePool` is
    // approved and handed the member's net amount and `feeRouter` names the treasury the fee is
    // transferred to, so whoever can write them can redirect where member funds go — that is not the
    // same authority as deciding which routes are offered. A LIQUIDITY_ADMIN holder is rejected here
    // on purpose; the assertions below are the privilege boundary, not incidental coverage.
    it("rejects the protocol-wiring setters from LIQUIDITY_ADMIN and from a stranger", async function () {
      for (const caller of [stranger, liquidityAdmin]) {
        await expect(router.connect(caller).setSpokePool(caller.address))
          .to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
        await expect(router.connect(caller).setFeeRouter(caller.address))
          .to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
        await expect(router.connect(caller).setSanctionsGuard(caller.address))
          .to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
      }
      expect(await router.spokePool()).to.equal(spokeAddr);
      expect(await router.feeRouter()).to.equal(await feeRouter.getAddress());
      expect(await router.sanctionsGuard()).to.equal(ethers.ZeroAddress);
    });

    it("lets DEFAULT_ADMIN_ROLE write the protocol wiring, each emitting its audit event", async function () {
      await expect(router.connect(admin).setSpokePool(stranger.address))
        .to.emit(router, "SpokePoolUpdated")
        .withArgs(spokeAddr, stranger.address, admin.address);
      expect(await router.spokePool()).to.equal(stranger.address);

      await expect(router.connect(admin).setFeeRouter(stranger.address))
        .to.emit(router, "FeeRouterUpdated")
        .withArgs(await feeRouter.getAddress(), stranger.address, admin.address);

      await expect(router.connect(admin).setSanctionsGuard(stranger.address))
        .to.emit(router, "SanctionsGuardUpdated")
        .withArgs(ethers.ZeroAddress, stranger.address, admin.address);
    });

    it("rejects pause and unpause from a caller without GUARDIAN_ROLE", async function () {
      await expect(router.connect(stranger).pause())
        .to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
      // LIQUIDITY_ADMIN curates config; it does not hold the emergency lever.
      await expect(router.connect(liquidityAdmin).pause())
        .to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
      expect(await router.paused()).to.equal(false);

      await router.connect(guardian).pause();
      await expect(router.connect(liquidityAdmin).unpause())
        .to.be.revertedWithCustomError(router, "AccessControlUnauthorizedAccount");
      expect(await router.paused()).to.equal(true);
    });

    it("lets a LIQUIDITY_ADMIN holder curate routes, each emitting its audit event", async function () {
      const newRoute = route({ destinationChainId: 10n, maxAmount: AMT("5") });
      const newId = await router.computeRouteId(usdcAddr, usdcDest, 10n);
      await expect(router.connect(liquidityAdmin).setRoute(newRoute))
        .to.emit(router, "RouteSet")
        // `enabled` is the 8th arg: RouteSet carries it so the FR-046 audit history can reconstruct
        // availability, since setRoute overwrites the struct and can flip it either way.
        .withArgs(newId, usdcAddr, 10n, usdcDest, AMT("5"), 1800, false, true, liquidityAdmin.address);

      await expect(router.connect(liquidityAdmin).setRouteEnabled(newId, false))
        .to.emit(router, "RouteEnabledChanged")
        .withArgs(newId, false, liquidityAdmin.address);

      await expect(router.connect(liquidityAdmin).setRouteLimit(newId, AMT("9")))
        .to.emit(router, "RouteLimitChanged")
        .withArgs(newId, AMT("5"), AMT("9"), liquidityAdmin.address);

      await expect(router.connect(liquidityAdmin).removeRoute(newId))
        .to.emit(router, "RouteRemoved")
        .withArgs(newId, liquidityAdmin.address);
      expect(await router.routeCount()).to.equal(2);

      await router.connect(guardian).pause();
      expect(await router.paused()).to.equal(true);
      await router.connect(guardian).unpause();
      expect(await router.paused()).to.equal(false);
    });

    // T150 — the FR-046 audit history must be able to reconstruct AVAILABILITY, not just metadata.
    // `setRoute` is idempotent and overwrites the whole struct, so it can flip `enabled` in either
    // direction while emitting only `RouteSet`. Without `enabled` on that event, a route disabled
    // during an incident and quietly re-enabled is indistinguishable from a metadata edit in the log.
    it("records `enabled` on RouteSet, so a log reader can tell availability from metadata", async function () {
      const disabled = route({ destinationChainId: 42161n, enabled: false });
      const id = await router.computeRouteId(usdcAddr, usdcDest, 42161n);
      await expect(router.connect(liquidityAdmin).setRoute(disabled))
        .to.emit(router, "RouteSet")
        .withArgs(id, usdcAddr, 42161n, usdcDest, 0n, 1800, false, false, liquidityAdmin.address);
      expect((await router.getRoute(id)).enabled).to.equal(false);

      // The same call flipping it back on, again emitting only RouteSet.
      await expect(router.connect(liquidityAdmin).setRoute(route({ destinationChainId: 42161n, enabled: true })))
        .to.emit(router, "RouteSet")
        .withArgs(id, usdcAddr, 42161n, usdcDest, 0n, 1800, false, true, liquidityAdmin.address);
      expect((await router.getRoute(id)).enabled).to.equal(true);
    });

    it("rejects the route setters for an unknown routeId and zero addresses", async function () {
      const unknown = ethers.id("no-such-route");
      await expect(router.connect(liquidityAdmin).setRouteEnabled(unknown, true))
        .to.be.revertedWithCustomError(router, "RouteUnknown");
      await expect(router.connect(liquidityAdmin).setRouteLimit(unknown, 1n))
        .to.be.revertedWithCustomError(router, "RouteUnknown");
      await expect(router.connect(liquidityAdmin).removeRoute(unknown))
        .to.be.revertedWithCustomError(router, "RouteUnknown");
      await expect(router.connect(admin).setSpokePool(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(router, "ZeroAddress");
      await expect(router.connect(admin).setFeeRouter(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(router, "ZeroAddress");
    });
  });

  // ---------------------------------------------------------------- T027
  describe("route validation (T027)", function () {
    it("rejects a destinationChainId equal to this chain", async function () {
      expect((await ethers.provider.getNetwork()).chainId).to.equal(LOCAL_CHAIN);
      await expect(router.connect(liquidityAdmin).setRoute(route({ destinationChainId: LOCAL_CHAIN })))
        .to.be.revertedWithCustomError(router, "InvalidDestinationChain");
    });

    it("rejects a zero destinationChainId (the Bitcoin/non-EVM shape)", async function () {
      await expect(router.connect(liquidityAdmin).setRoute(route({ destinationChainId: 0n })))
        .to.be.revertedWithCustomError(router, "InvalidDestinationChain");
    });

    it("rejects a zero inputToken or outputToken", async function () {
      await expect(router.connect(liquidityAdmin).setRoute(route({ inputToken: ethers.ZeroAddress })))
        .to.be.revertedWithCustomError(router, "ZeroAddress");
      await expect(router.connect(liquidityAdmin).setRoute(route({ outputToken: ethers.ZeroAddress })))
        .to.be.revertedWithCustomError(router, "ZeroAddress");
    });

    it("rejects an expectedFillSeconds outside [60, 86400] and accepts both bounds", async function () {
      await expect(router.connect(liquidityAdmin).setRoute(route({ expectedFillSeconds: 59 })))
        .to.be.revertedWithCustomError(router, "InvalidFillWindow");
      await expect(router.connect(liquidityAdmin).setRoute(route({ expectedFillSeconds: 0 })))
        .to.be.revertedWithCustomError(router, "InvalidFillWindow");
      await expect(router.connect(liquidityAdmin).setRoute(route({ expectedFillSeconds: 86_401 })))
        .to.be.revertedWithCustomError(router, "InvalidFillWindow");

      await router.connect(liquidityAdmin).setRoute(route({ expectedFillSeconds: 60 }));
      expect((await router.getRoute(routeId)).expectedFillSeconds).to.equal(60);
      await router.connect(liquidityAdmin).setRoute(route({ expectedFillSeconds: 86_400 }));
      expect((await router.getRoute(routeId)).expectedFillSeconds).to.equal(86_400);
    });

    it("validates before writing: a rejected route leaves the registry untouched", async function () {
      const before = await router.routeCount();
      await expect(router.connect(liquidityAdmin).setRoute(route({ destinationChainId: 42161n, expectedFillSeconds: 5 })))
        .to.be.revertedWithCustomError(router, "InvalidFillWindow");
      expect(await router.routeCount()).to.equal(before);
      expect((await router.getRoute(await router.computeRouteId(usdcAddr, usdcDest, 42161n))).inputToken)
        .to.equal(ethers.ZeroAddress);
    });

    it("keys routes on (inputToken, outputToken, this chain, destinationChainId) and updates in place", async function () {
      // outputToken is part of the identity so that changing the DELIVERED asset produces a
      // different route rather than silently overwriting the existing one in place.
      expect(routeId).to.equal(
        ethers.keccak256(
          ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "address", "uint256", "uint256"],
            [usdcAddr, usdcDest, LOCAL_CHAIN, DEST_CHAIN]
          )
        )
      );
      const before = await router.routeCount();
      await router.connect(liquidityAdmin).setRoute(route({ maxAmount: AMT("7") }));
      expect(await router.routeCount()).to.equal(before); // idempotent id set
      expect((await router.getRoute(routeId)).maxAmount).to.equal(AMT("7"));
      expect(await router.routeAt(0)).to.equal(routeId);
    });
  });

  // ---------------------------------------------------------------- T028
  describe("per-route limit and the fee consent ceiling (T028)", function () {
    it("reverts AmountAboveRouteLimit above the cap and allows exactly the cap", async function () {
      await router.connect(liquidityAdmin).setRouteLimit(routeId, AMT("1000"));

      await expect(bridge(member, await args({ inputAmount: AMT("1000") + 1n })))
        .to.be.revertedWithCustomError(router, "AmountAboveRouteLimit");

      await bridge(member, await args({ inputAmount: AMT("1000") }));
      expect(await spoke.lastInputAmount()).to.equal(AMT("1000"));
    });

    it("treats maxAmount == 0 as uncapped", async function () {
      expect((await router.getRoute(routeId)).maxAmount).to.equal(0n);
      await bridge(member, await args({ inputAmount: AMT("500000") }));
      expect(await spoke.lastInputAmount()).to.equal(AMT("500000"));
    });

    it("reverts FeeAboveQuoted when the live rate exceeds the rate the member was shown", async function () {
      await feeRouter.connect(admin).setFeeBps(BRIDGE_TRANSFER, 60);
      await expect(bridge(member, await args({ maxFeeBps: 50 })))
        .to.be.revertedWithCustomError(router, "FeeAboveQuoted");
      expect(await spoke.depositCount()).to.equal(0);
      expect(await usdc.balanceOf(treasury.address)).to.equal(0);

      // The member is never charged above what they consented to: at or below the ceiling it passes.
      await bridge(member, await args({ maxFeeBps: 60 }));
      expect(await usdc.balanceOf(treasury.address)).to.equal((AMT("1000") * 60n) / BPS);
    });

    it("does not block a zero-fee bridge on a stale configured rate (treasury unset)", async function () {
      // A treasury-unset network quotes fee 0, so the ceiling must not bite even at maxFeeBps 0.
      const fr = await deployFeeRouter([admin.address, ethers.ZeroAddress]);
      await fr.connect(admin).registerService(BRIDGE_TRANSFER, 250, Kind.ConfigOnly);
      await fr.connect(admin).setFeeBps(BRIDGE_TRANSFER, 250);
      await router.connect(admin).setFeeRouter(await fr.getAddress());

      await bridge(member, await args({ maxFeeBps: 0 }));
      expect(await spoke.lastInputAmount()).to.equal(AMT("1000")); // whole amount bridged, fee skipped
    });

    // ---- the ceiling binds the fee TAKEN, not the rate the fee router claims ----
    //
    // Adversarial review found that both ceiling checks read `feeBps()` — the FeeRouter's own account
    // of its rate — while the amount transferred to the treasury came from `quoteFee()`, unbounded. A
    // FeeRouter reporting 0 bps and quoting 99% therefore passed `liveBps > MAX_FEE_BPS` (0 > 250 is
    // false) AND `fee > 0 && liveBps > maxFeeBps` (0 > anything is false), and sent the member's
    // principal to its own treasury. These two tests are that scenario.
    it("refuses a FeeRouter that under-reports its rate and over-quotes the fee", async function () {
      const Lying = await ethers.getContractFactory("MockLyingFeeRouter");
      // Admits to 0 bps; actually takes 99%.
      const lying = await Lying.deploy(stranger.address, 0, 9_900);
      await router.connect(admin).setFeeRouter(await lying.getAddress());

      const before = await usdc.balanceOf(member.address);
      // maxFeeBps 0 — the member consented to no fee at all, and the router reports none.
      await expect(bridge(member, await args({ maxFeeBps: 0 })))
        .to.be.revertedWithCustomError(router, "FeeAboveCap");
      expect(await usdc.balanceOf(member.address)).to.equal(before);
      expect(await usdc.balanceOf(stranger.address)).to.equal(0n);

      // Exactly at the cap it is allowed through — the bound is on MAX_FEE_BPS, not on honesty.
      const atCap = await Lying.deploy(treasury.address, 0, 250);
      await router.connect(admin).setFeeRouter(await atCap.getAddress());
      await bridge(member, await args({ maxFeeBps: 0 }));
      expect(await usdc.balanceOf(treasury.address)).to.equal((AMT("1000") * 250n) / BPS);
    });

    it("refuses a FeeRouter whose fee and net do not add back to the gross", async function () {
      const Lying = await ethers.getContractFactory("MockLyingFeeRouter");
      const lying = await Lying.deploy(treasury.address, 100, 100);
      await lying.setSplitShort(true); // withholds a unit from `net`
      await router.connect(admin).setFeeRouter(await lying.getAddress());

      // `net` is what reaches Across, so an under-reported net would strand the difference in this
      // contract — caught before any funds move rather than by the residual-funds guard afterwards.
      await expect(bridge(member, await args())).to.be.revertedWithCustomError(router, "FeeSplitMismatch");
      expect(await usdc.balanceOf(routerAddr)).to.equal(0n);
    });

    it("charges the fee to the treasury and forwards only the net", async function () {
      await feeRouter.connect(admin).setFeeBps(BRIDGE_TRANSFER, 50); // 0.50%
      const gross = AMT("1000");
      const fee = (gross * 50n) / BPS;
      const net = gross - fee;

      await expect(bridge(member, await args({ inputAmount: gross })))
        .to.emit(router, "BridgeInitiated")
        .withArgs(routeId, member.address, recipient.address, DEST_CHAIN, gross, fee, net, member.address);

      expect(await usdc.balanceOf(treasury.address)).to.equal(fee);
      expect(await usdc.balanceOf(spokeAddr)).to.equal(net);
      expect(await spoke.lastInputAmount()).to.equal(net);
    });

    it("names the MEMBER as depositor so an unfilled deposit refunds to them (research R2)", async function () {
      const a = await args();
      await bridge(member, a);
      // The whole reason this mock records arguments: `depositor` must never be the router.
      expect(await spoke.lastDepositor()).to.equal(member.address);
      expect(await spoke.lastDepositor()).to.not.equal(routerAddr);
      expect(await spoke.lastRecipient()).to.equal(recipient.address);
      expect(await spoke.lastInputToken()).to.equal(usdcAddr);
      expect(await spoke.lastOutputToken()).to.equal(usdcDest);
      expect(await spoke.lastOutputAmount()).to.equal(a.outputAmount);
      expect(await spoke.lastDestinationChainId()).to.equal(DEST_CHAIN);
      expect(await spoke.lastFillDeadline()).to.equal(a.fillDeadline);
      expect(await spoke.lastMessage()).to.equal("0x"); // no cross-chain message in v1
    });
  });

  // ---------------------------------------------------------------- T029
  describe("zero fee rate (T029)", function () {
    it("performs no treasury transfer and leaves downstream behaviour identical", async function () {
      expect(await feeRouter.feeBps(BRIDGE_TRANSFER)).to.equal(0);
      const treasuryBefore = await usdc.balanceOf(treasury.address);
      const gross = AMT("1000");

      const a = await args({ inputAmount: gross });
      await expect(bridge(member, a))
        .to.emit(router, "BridgeInitiated")
        .withArgs(routeId, member.address, recipient.address, DEST_CHAIN, gross, 0n, gross, member.address);

      // No fee leg at all — the treasury balance is byte-identical to before.
      expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryBefore);

      // Downstream is unchanged: the full gross reaches the SpokePool with the same arguments a
      // fee-charging call would have produced (only the amount differs).
      const zeroFee = {
        depositor: await spoke.lastDepositor(),
        recipient: await spoke.lastRecipient(),
        inputToken: await spoke.lastInputToken(),
        outputToken: await spoke.lastOutputToken(),
        outputAmount: await spoke.lastOutputAmount(),
        destinationChainId: await spoke.lastDestinationChainId(),
        exclusiveRelayer: await spoke.lastExclusiveRelayer(),
        fillDeadline: await spoke.lastFillDeadline(),
        inputAmount: await spoke.lastInputAmount(),
      };
      expect(zeroFee.inputAmount).to.equal(gross);
      expect(await usdc.balanceOf(spokeAddr)).to.equal(gross);

      await feeRouter.connect(admin).setFeeBps(BRIDGE_TRANSFER, 50);
      const b = await args({ inputAmount: gross, fillDeadline: a.fillDeadline, quoteTimestamp: a.quoteTimestamp });
      await bridge(member, b);
      const withFee = {
        depositor: await spoke.lastDepositor(),
        recipient: await spoke.lastRecipient(),
        inputToken: await spoke.lastInputToken(),
        outputToken: await spoke.lastOutputToken(),
        outputAmount: await spoke.lastOutputAmount(),
        destinationChainId: await spoke.lastDestinationChainId(),
        exclusiveRelayer: await spoke.lastExclusiveRelayer(),
        fillDeadline: await spoke.lastFillDeadline(),
        inputAmount: await spoke.lastInputAmount(),
      };
      expect({ ...withFee, inputAmount: gross }).to.deep.equal(zeroFee);
      expect(withFee.inputAmount).to.equal(gross - (gross * 50n) / BPS);
    });

    it("performs no native treasury transfer at a zero rate", async function () {
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      const gross = AMT("3");

      await bridge(member, await args({ routeId: nativeRouteId, inputAmount: gross }), gross);

      expect(await ethers.provider.getBalance(treasury.address)).to.equal(treasuryBefore);
      expect(await ethers.provider.getBalance(spokeAddr)).to.equal(gross);
      expect(await ethers.provider.getBalance(routerAddr)).to.equal(0);
    });
  });

  // ---------------------------------------------------------------- T030
  describe("pause and reentrancy (T030)", function () {
    it("blocks bridgeWithFee while paused and restores it on unpause", async function () {
      await router.connect(guardian).pause();
      await expect(bridge(member, await args()))
        .to.be.revertedWithCustomError(router, "EnforcedPause");
      expect(await spoke.depositCount()).to.equal(0);

      await router.connect(guardian).unpause();
      await bridge(member, await args());
      expect(await spoke.depositCount()).to.equal(1);
    });

    it("blocks nothing else: every config setter and read still works while paused", async function () {
      await router.connect(guardian).pause();

      const otherId = await router.computeRouteId(usdcAddr, usdcDest, 8453n);
      await router.connect(liquidityAdmin).setRoute(route({ destinationChainId: 8453n }));
      await router.connect(liquidityAdmin).setRouteEnabled(otherId, false);
      await router.connect(liquidityAdmin).setRouteLimit(otherId, AMT("2"));
      await router.connect(admin).setSpokePool(stranger.address);
      await router.connect(admin).setFeeRouter(stranger.address);
      await router.connect(admin).setSanctionsGuard(stranger.address);
      await router.connect(liquidityAdmin).removeRoute(otherId);

      expect(await router.spokePool()).to.equal(stranger.address);
      expect(await router.feeRouter()).to.equal(stranger.address);
      expect(await router.sanctionsGuard()).to.equal(stranger.address);
      expect(await router.routeCount()).to.equal(2);
      expect((await router.getRoute(routeId)).inputToken).to.equal(usdcAddr);
      expect(await router.routeAt(0)).to.equal(routeId);
      expect(await router.computeRouteId(usdcAddr, usdcDest, DEST_CHAIN)).to.equal(routeId);
      expect(await router.paused()).to.equal(true);
    });

    it("remains pausable with every optional service unreachable (FR-044)", async function () {
      // A killswitch that needs the SpokePool, the FeeRouter, or the gateway to be healthy is not a
      // killswitch: point both references at code-less addresses and pause anyway.
      await router.connect(admin).setSpokePool(stranger.address);
      await router.connect(admin).setFeeRouter(stranger.address);

      await router.connect(guardian).pause();
      expect(await router.paused()).to.equal(true);
      await expect(bridge(member, await args()))
        .to.be.revertedWithCustomError(router, "EnforcedPause");
      await router.connect(guardian).unpause();
      expect(await router.paused()).to.equal(false);
    });

    it("rejects a SpokePool that re-enters bridgeWithFee mid-deposit", async function () {
      const Evil = await ethers.getContractFactory("MockReentrantSpokePool");
      const evil = await Evil.deploy();
      await router.connect(admin).setSpokePool(await evil.getAddress());

      const a = await args({ inputAmount: AMT("10") });
      const callback = router.interface.encodeFunctionData("bridgeWithFee", [
        a.routeId,
        a.inputAmount,
        a.outputAmount,
        a.recipient,
        a.quoteTimestamp,
        a.fillDeadline,
        a.exclusivityDeadline,
        a.exclusiveRelayer,
        a.maxFeeBps,
      ]);
      await evil.arm(routerAddr, callback);

      await expect(bridge(member, a))
        .to.be.revertedWithCustomError(router, "ReentrancyGuardReentrantCall");

      // Disarming the callback proves the revert came from the guard, not from the mock itself.
      await evil.arm(routerAddr, "0x");
      await bridge(member, await args({ inputAmount: AMT("10") }));
      expect(await usdc.balanceOf(await evil.getAddress())).to.equal(AMT("10"));
    });
  });

  // ---------------------------------------------------------------- T031
  describe("residual funds and allowances (T031)", function () {
    it("leaves zero token balance and zero SpokePool allowance after a fee-charging bridge", async function () {
      // A non-zero fee is what gives the allowance assertion teeth: approving the GROSS instead of
      // the NET would still satisfy the residual-balance check but leave `fee` standing as a live
      // allowance to the SpokePool.
      await feeRouter.connect(admin).setFeeBps(BRIDGE_TRANSFER, 50);
      await bridge(member, await args());

      expect(await usdc.balanceOf(routerAddr)).to.equal(0);
      expect(await usdc.allowance(routerAddr, spokeAddr)).to.equal(0);
      expect(await ethers.provider.getBalance(routerAddr)).to.equal(0);
    });

    it("leaves zero balance and zero allowance after a zero-fee bridge and after repeated bridges", async function () {
      for (let i = 0; i < 3; i += 1) {
        await bridge(member, await args({ inputAmount: AMT("100") }));
        expect(await usdc.balanceOf(routerAddr)).to.equal(0);
        expect(await usdc.allowance(routerAddr, spokeAddr)).to.equal(0);
      }
      expect(await usdc.balanceOf(spokeAddr)).to.equal(AMT("300"));
    });

    it("leaves zero native balance after a native bridge that charges a fee", async function () {
      await feeRouter.connect(admin).setFeeBps(BRIDGE_TRANSFER, 100); // 1%
      const gross = AMT("4");
      const fee = (gross * 100n) / BPS;
      const net = gross - fee;
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);

      await expect(bridge(member, await args({ routeId: nativeRouteId, inputAmount: gross }), gross))
        .to.emit(router, "BridgeInitiated")
        .withArgs(nativeRouteId, member.address, recipient.address, DEST_CHAIN, gross, fee, net, member.address);

      expect(await ethers.provider.getBalance(treasury.address)).to.equal(treasuryBefore + fee);
      expect(await ethers.provider.getBalance(spokeAddr)).to.equal(net);
      expect(await ethers.provider.getBalance(routerAddr)).to.equal(0);
      expect(await spoke.lastValue()).to.equal(net);
      expect(await spoke.lastDepositor()).to.equal(member.address);
    });

    it("reverts ResidualFunds when the SpokePool under-pulls the approved net", async function () {
      const Leaky = await ethers.getContractFactory("MockLeakySpokePool");
      const leaky = await Leaky.deploy();
      await router.connect(admin).setSpokePool(await leaky.getAddress());

      await expect(bridge(member, await args()))
        .to.be.revertedWithCustomError(router, "ResidualFunds");
    });
  });

  // ---------------------------------------------------------------- submission guards
  describe("submission guards", function () {
    it("reverts RouteUnknown for an unregistered or removed routeId", async function () {
      await expect(bridge(member, await args({ routeId: ethers.id("no-such-route") })))
        .to.be.revertedWithCustomError(router, "RouteUnknown");

      await router.connect(liquidityAdmin).removeRoute(routeId);
      await expect(bridge(member, await args()))
        .to.be.revertedWithCustomError(router, "RouteUnknown");
    });

    it("reverts RouteDisabled for a route the operator switched off", async function () {
      await router.connect(liquidityAdmin).setRouteEnabled(routeId, false);
      await expect(bridge(member, await args()))
        .to.be.revertedWithCustomError(router, "RouteDisabled");

      await router.connect(liquidityAdmin).setRouteEnabled(routeId, true);
      await bridge(member, await args());
      expect(await spoke.depositCount()).to.equal(1);
    });

    it("reverts DeadlineInPast for a fillDeadline at or before now", async function () {
      const now = await time.latest();
      await expect(bridge(member, await args({ fillDeadline: now })))
        .to.be.revertedWithCustomError(router, "DeadlineInPast");
      await expect(bridge(member, await args({ fillDeadline: now - 600 })))
        .to.be.revertedWithCustomError(router, "DeadlineInPast");
    });

    it("reverts ZeroAmount and ZeroAddress on an empty amount or recipient", async function () {
      await expect(bridge(member, await args({ inputAmount: 0n })))
        .to.be.revertedWithCustomError(router, "ZeroAmount");
      await expect(bridge(member, await args({ recipient: ethers.ZeroAddress })))
        .to.be.revertedWithCustomError(router, "ZeroAddress");
    });

    it("reverts NativeValueMismatch when a native route's msg.value differs from inputAmount", async function () {
      const gross = AMT("2");
      await expect(bridge(member, await args({ routeId: nativeRouteId, inputAmount: gross }), gross - 1n))
        .to.be.revertedWithCustomError(router, "NativeValueMismatch");
      await expect(bridge(member, await args({ routeId: nativeRouteId, inputAmount: gross }), gross + 1n))
        .to.be.revertedWithCustomError(router, "NativeValueMismatch");
      await expect(bridge(member, await args({ routeId: nativeRouteId, inputAmount: gross }), 0n))
        .to.be.revertedWithCustomError(router, "NativeValueMismatch");
    });

    it("reverts UnexpectedNativeValue when an ERC-20 route is sent value", async function () {
      // Native value on an ERC-20 route would be unrecoverable — the router has no receive().
      await expect(bridge(member, await args(), 1n))
        .to.be.revertedWithCustomError(router, "UnexpectedNativeValue");
      expect(await ethers.provider.getBalance(routerAddr)).to.equal(0);
    });
  });

  // ---------------------------------------------------------------- sanctions screening
  describe("sanctions screening", function () {
    let guard;

    beforeEach(async function () {
      const Oracle = await ethers.getContractFactory("MockSanctionsOracle");
      const oracle = await Oracle.deploy();
      const Guard = await ethers.getContractFactory("SanctionsGuard");
      guard = await Guard.deploy(admin.address, await oracle.getAddress());
      await router.connect(admin).setSanctionsGuard(await guard.getAddress());
    });

    it("refuses a deny-listed wallet BEFORE any transfer is attempted", async function () {
      // `stranger` holds no USDC and has granted no allowance. If screening ran after the pull, the
      // revert would be the token's — seeing SanctionedAddress proves the screen comes first.
      await guard.connect(admin).setDenied(stranger.address, true, "test deny-list");
      await expect(bridge(stranger, await args()))
        .to.be.revertedWithCustomError(guard, "SanctionedAddress")
        .withArgs(stranger.address);

      // Control: with the deny-list entry cleared the same call fails at the token layer instead.
      await guard.connect(admin).setDenied(stranger.address, false, "cleared");
      await expect(bridge(stranger, await args()))
        .to.be.revertedWithCustomError(usdc, "ERC20InsufficientAllowance");

      expect(await spoke.depositCount()).to.equal(0);
      expect(await usdc.balanceOf(treasury.address)).to.equal(0);
    });

    it("refuses a wallet the oracle reports sanctioned, and lets a clean wallet through", async function () {
      const oracle = await ethers.getContractAt("MockSanctionsOracle", await guard.sanctionsOracle());
      await oracle.setSanctioned(member.address, true);
      await expect(bridge(member, await args()))
        .to.be.revertedWithCustomError(guard, "SanctionedAddress")
        .withArgs(member.address);

      await oracle.setSanctioned(member.address, false);
      await bridge(member, await args());
      expect(await spoke.lastDepositor()).to.equal(member.address);
    });

    it("refuses a deny-listed RECIPIENT even when the sender is clean (#1667)", async function () {
      await guard.connect(admin).setDenied(recipient.address, true, "test deny-list");
      await expect(bridge(member, await args()))
        .to.be.revertedWithCustomError(guard, "SanctionedAddress")
        .withArgs(recipient.address);
      expect(await spoke.depositCount()).to.equal(0);

      await guard.connect(admin).setDenied(recipient.address, false, "cleared");
      await bridge(member, await args());
      expect(await spoke.lastRecipient()).to.equal(recipient.address);
    });

    it("skips screening entirely when the guard is unset", async function () {
      await router.connect(admin).setSanctionsGuard(ethers.ZeroAddress);
      await guard.connect(admin).setDenied(member.address, true, "ignored once the guard is cleared");
      await bridge(member, await args());
      expect(await spoke.depositCount()).to.equal(1);
    });
  });
});
