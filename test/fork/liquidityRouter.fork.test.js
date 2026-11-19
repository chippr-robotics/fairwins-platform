const { expect } = require("chai");
const { ethers, network, upgrades } = require("hardhat");

/**
 * LiquidityRouter fork tests (spec 067, tasks T040-T044).
 *
 * Runs against the REAL Uniswap V3 deployment on a forked chain.
 *
 * The custody property is the one that matters here: after `mintFullRangeWithFee` the position NFT
 * must be owned by the MEMBER, and the member must be able to exit WITHOUT the router — including
 * while the router is paused and the pool retired. A router-owned NFT would make this custodial and
 * leave the member unable to `decreaseLiquidity`/`collect` (FR-021/FR-023).
 *
 * T041 deliberately parameterises over networks rather than hardcoding one: Base's Uniswap addresses
 * differ from the set the other chains share (research R4b), so a copied address would revert here
 * and nowhere else. Supply BASE_RPC_URL to exercise it.
 *
 * REQUIREMENTS TO RUN — archive-capable RPC per chain (public endpoints reject the state methods
 * hardhat's fork uses). Set POLYGON_RPC_URL / BASE_RPC_URL / ARBITRUM_RPC_URL / MAINNET_RPC_URL.
 * Unset ⇒ that network's block SKIPS, and a skip is not a pass.
 */

const FEE_CAP_BPS = 250;
const LIQUIDITY_SERVICE = ethers.id("liquidity.deposit");

/**
 * Reset onto a fork and immediately mine one block.
 *
 * The mine is required, not cosmetic. Hardhat only consults its hardfork-activation history for
 * blocks at or below the fork block; anything above uses the configured hardfork. An `eth_call` made
 * AT the fork block therefore throws "No known hardfork for execution on historical block N" unless
 * a full activation history is configured for that chain. Mining once moves the head past the fork
 * block so every subsequent read and call is in the safe range.
 *
 * (`hardhat.config.js` also declares a `chains` history for these networks, but it is not applied on
 * a runtime `hardhat_reset` — only at provider construction. This is the reliable fix.)
 */
async function resetFork(rpcUrl) {
  await network.provider.request({
    method: "hardhat_reset",
    params: [{ forking: { jsonRpcUrl: rpcUrl } }],
  });
  await network.provider.send("evm_mine", []);
}


const CHAINS = {
  polygon: {
    chainId: 137,
    rpcEnv: "POLYGON_RPC_URL",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    positionManager: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
    tokenA: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 }, // WETH
    tokenB: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 }, // native USDC
  },
  base: {
    chainId: 8453,
    rpcEnv: "BASE_RPC_URL",
    // ⚠️ NOT the canonical addresses — Base has its own deployment (research R4b).
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    positionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
    tokenA: { address: "0x4200000000000000000000000000000000000006", decimals: 18 }, // WETH
    tokenB: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }, // USDC
  },
};

const FEE_TIERS = [500, 3000, 10000];

const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const POOL_ABI = ["function tickSpacing() view returns (int24)", "function liquidity() view returns (uint128)"];
const NFPM_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
  "function decreaseLiquidity((uint256,uint128,uint256,uint256,uint256)) payable returns (uint256,uint256)",
  "function collect((uint256,address,uint128,uint128)) payable returns (uint256,uint256)",
];

/** See the twin helper in bridgeRouter.fork.test.js — probes are snapshot-isolated so a wrong guess
 *  cannot corrupt a proxy's implementation slot and silently poison later assertions. */
async function dealErc20(token, account, amount) {
  const erc20 = await ethers.getContractAt(
    "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20",
    token
  );
  let found = null;
  for (const slot of [9, 0, 1, 2, 3, 4, 5, 51]) {
    const snapshot = await network.provider.send("evm_snapshot", []);
    try {
      const key = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [account, slot])
      );
      await network.provider.send("hardhat_setStorageAt", [token, key, ethers.toBeHex(amount, 32)]);
      if ((await erc20.balanceOf(account)) === amount) found = slot;
    } catch {
      /* wrong slot */
    }
    await network.provider.send("evm_revert", [snapshot]);
    if (found !== null) break;
  }
  if (found === null) throw new Error(`dealErc20: could not locate the balance slot for ${token}`);
  const key = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [account, found])
  );
  await network.provider.send("hardhat_setStorageAt", [token, key, ethers.toBeHex(amount, 32)]);
}

for (const [name, cfg] of Object.entries(CHAINS)) {
  const rpc = process.env[cfg.rpcEnv];
  const describeFork = rpc ? describe : describe.skip;

  describeFork(`LiquidityRouter fork — ${name} (${cfg.chainId})`, function () {
    this.timeout(600_000);

    let admin, member, router, feeRouter, nfpm, poolAddress, feeTier, token0, token1, amt0, amt1;

    before(async function () {
      await resetFork(rpc);
      [admin, member] = await ethers.getSigners();

      // Resolve the pool from the REAL factory rather than hardcoding an address — that is also how
      // a wrong per-chain factory address would surface (research R4b).
      const factory = new ethers.Contract(cfg.factory, FACTORY_ABI, ethers.provider);
      const [a, b] = [cfg.tokenA, cfg.tokenB];
      const sorted =
        a.address.toLowerCase() < b.address.toLowerCase() ? [a, b] : [b, a];
      token0 = sorted[0];
      token1 = sorted[1];

      for (const tier of FEE_TIERS) {
        const p = await factory.getPool(token0.address, token1.address, tier);
        if (p !== ethers.ZeroAddress) {
          const liq = await new ethers.Contract(p, POOL_ABI, ethers.provider).liquidity();
          if (liq > 0n) {
            poolAddress = p;
            feeTier = tier;
            break;
          }
        }
      }
      expect(poolAddress, `no liquid ${name} pool found for the configured pair`).to.not.be.undefined;

      amt0 = ethers.parseUnits("1", token0.decimals);
      amt1 = ethers.parseUnits("1", token1.decimals);

      const FeeRouter = await ethers.getContractFactory("FeeRouter");
      feeRouter = await upgrades.deployProxy(FeeRouter, [admin.address, admin.address], { kind: "uups" });
      await feeRouter.waitForDeployment();
      await feeRouter.registerService(LIQUIDITY_SERVICE, FEE_CAP_BPS, 2 /* ConfigOnly — see deploy-bridge-liquidity.js */);

      const LiquidityRouter = await ethers.getContractFactory("LiquidityRouter");
      router = await upgrades.deployProxy(
        LiquidityRouter,
        [admin.address, await feeRouter.getAddress(), cfg.positionManager, ethers.ZeroAddress],
        { kind: "uups" }
      );
      await router.waitForDeployment();

      await router.listPool({
        kind: 2, // TradingLp
        enabled: true,
        feeTier,
        token0: token0.address,
        token1: token1.address,
        poolAddress,
        maxDeposit0PerTx: 0,
        maxDeposit1PerTx: 0,
      });

      nfpm = new ethers.Contract(cfg.positionManager, NFPM_ABI, ethers.provider);
    });

    after(async function () {
      await network.provider.request({ method: "hardhat_reset", params: [] });
    });

    async function poolId() {
      return router.computePoolId(2, poolAddress, token0.address, token1.address);
    }

    async function supply({ maxFeeBps = FEE_CAP_BPS } = {}) {
      await dealErc20(token0.address, member.address, amt0 * 2n);
      await dealErc20(token1.address, member.address, amt1 * 2n);
      const t0 = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", token0.address);
      const t1 = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", token1.address);
      await t0.connect(member).approve(await router.getAddress(), amt0);
      await t1.connect(member).approve(await router.getAddress(), amt1);
      const block = await ethers.provider.getBlock("latest");
      return router
        .connect(member)
        .mintFullRangeWithFee(await poolId(), amt0, amt1, 0, 0, block.timestamp + 600, maxFeeBps);
    }

    // ---------------------------------------------------------------- T040 / T041
    it("mints a full-range position OWNED BY THE MEMBER, with fees to treasury and no residue", async () => {
      await feeRouter.setFeeBps(LIQUIDITY_SERVICE, 50); // 0.5%
      const t0 = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", token0.address);
      const t1 = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", token1.address);

      const treas0Before = await t0.balanceOf(admin.address);
      const treas1Before = await t1.balanceOf(admin.address);

      const tx = await supply();
      const receipt = await tx.wait();

      const routerAddr = (await router.getAddress()).toLowerCase();
      const supplied = receipt.logs
        .filter((l) => l.address.toLowerCase() === routerAddr)
        .map((l) => {
          try {
            return router.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p) => p && p.name === "LiquiditySupplied");
      expect(supplied, "no LiquiditySupplied event").to.not.be.undefined;

      // THE custody assertion.
      expect(await nfpm.ownerOf(supplied.args.tokenId)).to.equal(member.address);
      expect(supplied.args.owner).to.equal(member.address);

      // Fee reached the treasury on both legs — charged on the capital Uniswap ACTUALLY consumed,
      // not on what was offered. Against a live pool the two legs are consumed in the pool's current
      // price ratio, so one leg is typically consumed almost entirely and the other barely at all;
      // asserting a fee on the gross would be asserting the overcharge this router was fixed to
      // avoid. The event reports both the consumed amounts and the fees, so the invariant is checked
      // against reality rather than against a guess.
      expect(await t0.balanceOf(admin.address)).to.equal(treas0Before + supplied.args.fee0);
      expect(await t1.balanceOf(admin.address)).to.equal(treas1Before + supplied.args.fee1);
      // And each fee really is the disclosed rate on the deployed amount (50 bps here).
      expect(supplied.args.fee0).to.equal((supplied.args.amount0 * 50n) / 10_000n);
      expect(supplied.args.fee1).to.equal((supplied.args.amount1 * 50n) / 10_000n);
      // The member is never billed for capital that did not become a position.
      expect(supplied.args.fee0).to.be.lessThanOrEqual(amt0 / 200n);
      expect(supplied.args.fee1).to.be.lessThanOrEqual(amt1 / 200n);

      // Router keeps nothing, and leaves no standing approval.
      expect(await t0.balanceOf(await router.getAddress())).to.equal(0n);
      expect(await t1.balanceOf(await router.getAddress())).to.equal(0n);
      expect(await t0.allowance(await router.getAddress(), cfg.positionManager)).to.equal(0n);
      expect(await t1.allowance(await router.getAddress(), cfg.positionManager)).to.equal(0n);
    });

    // ---------------------------------------------------------------- T042
    it("uses full-range ticks aligned to the pool's own tick spacing", async () => {
      const pool = new ethers.Contract(poolAddress, POOL_ABI, ethers.provider);
      const spacing = await pool.tickSpacing();
      const [lower, upper] = await router.fullRangeTicks(poolAddress);

      expect(lower % spacing).to.equal(0n);
      expect(upper % spacing).to.equal(0n);
      // Widest usable range for this spacing: one more step out would exceed Uniswap's bounds.
      expect(lower).to.be.lessThan(-887272n + spacing);
      expect(upper).to.be.greaterThan(887272n - spacing);
    });

    it("returns every unspent token to the member (Uniswap rarely consumes both legs exactly)", async () => {
      await feeRouter.setFeeBps(LIQUIDITY_SERVICE, 0);
      const t0 = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", token0.address);
      const t1 = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", token1.address);

      const before0 = await t0.balanceOf(member.address);
      const before1 = await t1.balanceOf(member.address);
      const tx = await supply();
      const receipt = await tx.wait();
      const routerAddr = (await router.getAddress()).toLowerCase();
      const ev = receipt.logs
        .filter((l) => l.address.toLowerCase() === routerAddr)
        .map((l) => {
          try {
            return router.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p) => p && p.name === "LiquiditySupplied");

      // dealErc20 reset the balances to amt*2 before the supply, so the member should now hold
      // exactly what the position did not consume.
      expect(await t0.balanceOf(member.address)).to.equal(amt0 * 2n - ev.args.amount0);
      expect(await t1.balanceOf(member.address)).to.equal(amt1 * 2n - ev.args.amount1);
      expect(before0).to.be.a("bigint");
      expect(before1).to.be.a("bigint");
    });

    // ---------------------------------------------------------------- T043
    it("lets the member exit WITHOUT the router — while it is paused AND the pool retired", async () => {
      await feeRouter.setFeeBps(LIQUIDITY_SERVICE, 0);
      const tx = await supply();
      const receipt = await tx.wait();
      const routerAddr = (await router.getAddress()).toLowerCase();
      const tokenId = receipt.logs
        .filter((l) => l.address.toLowerCase() === routerAddr)
        .map((l) => {
          try {
            return router.interface.parseLog(l);
          } catch {
            return null;
          }
        })
        .find((p) => p && p.name === "LiquiditySupplied").args.tokenId;

      // Slam every door the operator has.
      await router.pause();
      await router.setPoolEnabled(await poolId(), false);

      // New supplies are refused...
      await expect(supply()).to.be.revertedWithCustomError(router, "EnforcedPause");

      // ...but the exit is untouched, because it never goes through the router.
      const pos = await nfpm.positions(tokenId);
      const liquidity = pos[7];
      expect(liquidity).to.be.greaterThan(0n);

      const deadline = (await ethers.provider.getBlock("latest")).timestamp + 600;
      await expect(
        nfpm.connect(member).decreaseLiquidity([tokenId, liquidity, 0, 0, deadline])
      ).to.not.be.reverted;
      await expect(
        nfpm.connect(member).collect([tokenId, member.address, 2n ** 128n - 1n, 2n ** 128n - 1n])
      ).to.not.be.reverted;

      expect((await nfpm.positions(tokenId))[7]).to.equal(0n);

      await router.unpause();
      await router.setPoolEnabled(await poolId(), true);
    });
  });
}

/**
 * T044 — Across HubPool round trip, Ethereum only (the HubPool is an L1 contract).
 *
 * Asserts the member can supply and withdraw bridge liquidity entirely on their own, and that
 * LiquidityRouter is never an intermediary. This is the executable form of research R3: because
 * `addLiquidity` has no recipient parameter, routing it would make the router the LP-token owner.
 */
const mainnetRpc = process.env.MAINNET_RPC_URL;
(mainnetRpc ? describe : describe.skip)("Across HubPool liquidity — direct member path (T044)", function () {
  this.timeout(600_000);

  const HUB_POOL = "0xc186fA914353c44b2E33eBE05f21846F1048bEda";
  const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

  const HUB_ABI = [
    "function addLiquidity(address l1Token, uint256 l1TokenAmount) payable",
    "function removeLiquidity(address l1Token, uint256 lpTokenAmount, bool sendEth)",
    "function pooledTokens(address) view returns (address lpToken, bool isEnabled, uint32 lastLpFeeUpdate, int256 utilizedReserves, uint256 liquidReserves, uint256 undistributedLpFees)",
  ];

  it("supplies and withdraws with the MEMBER as msg.sender; the router is never involved", async () => {
    await resetFork(mainnetRpc);
    const [, member] = await ethers.getSigners();
    const hub = new ethers.Contract(HUB_POOL, HUB_ABI, ethers.provider);

    const { lpToken, isEnabled } = await hub.pooledTokens(WETH);
    expect(isEnabled, "WETH pool not enabled on the HubPool").to.be.true;

    const amount = ethers.parseEther("1");
    await dealErc20(WETH, member.address, amount * 2n);
    const weth = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", WETH);
    await weth.connect(member).approve(HUB_POOL, amount);

    await hub.connect(member).addLiquidity(WETH, amount);

    // LP tokens minted to msg.sender — the member. There is no recipient argument to redirect them,
    // which is exactly why this path stays fee-free and out of LiquidityRouter (research R3).
    const lp = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", lpToken);
    const lpBalance = await lp.balanceOf(member.address);
    expect(lpBalance).to.be.greaterThan(0n);

    await expect(hub.connect(member).removeLiquidity(WETH, lpBalance, false)).to.not.be.reverted;
    expect(await lp.balanceOf(member.address)).to.equal(0n);

    await network.provider.request({ method: "hardhat_reset", params: [] });
  });
});
