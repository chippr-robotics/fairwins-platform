const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployWagerRegistry, deployMembershipManager } = require("../helpers/proxy");

// Spec 112 FR-004 — the `nonReentrant` guard on every value-moving registry entrypoint, on BOTH facets.
//
// The baseline coverage run showed the failing side of `nonReentrant` untaken on every wager
// entrypoint: no test ever re-entered the registry. `ReentrantToken` (test-only mock) re-enters an
// armed target from inside its own transfer/transferFrom and bubbles the inner revert. Each case arms
// the token with a call into ONE guarded function, then triggers a token movement from inside a guarded
// self-submit call (createWager's stake pull). The re-entered function must refuse with OpenZeppelin's
// ReentrancyGuardReentrantCall — and because the lock lives in the proxy's (namespaced) storage, this
// also proves the Intents facet, reached through the fallback's delegatecall, shares the main facet's
// lock rather than holding its own.

const R = { Either: 0 };
const ROLE = ethers.keccak256(ethers.toUtf8Bytes("WAGER_PARTICIPANT_ROLE"));
const usdc = (n) => ethers.parseUnits(String(n), 6);
const Z = ethers.ZeroAddress;
const H = ethers.ZeroHash;
const AUTH = [0, 0, 0, H, 0, H, H];

describe("WagerRegistry — nonReentrant on both facets (spec 112 FR-004)", function () {
  async function fixture() {
    const [admin, alice, bob] = await ethers.getSigners();
    const rt = await (await ethers.getContractFactory("ReentrantToken")).deploy();
    const pay = await (await ethers.getContractFactory("MockUSDCPermit")).deploy();
    const mgr = await deployMembershipManager([admin.address, await pay.getAddress(), admin.address]);
    const limits = { monthlyMarketCreation: 100, maxConcurrentMarkets: 20 };
    await mgr.connect(admin).setTier(ROLE, 2, usdc(1), 30, limits, true);
    const reg = await deployWagerRegistry([admin.address, await mgr.getAddress(), Z, [await rt.getAddress()]]);
    await mgr.connect(admin).setAuthorizedCaller(await reg.getAddress(), true);
    for (const u of [alice, bob]) {
      await mgr.connect(admin).grantMembership(u.address, ROLE, 2, 365);
      await rt.mint(u.address, usdc(1000));
      await rt.connect(u).approve(await reg.getAddress(), ethers.MaxUint256);
    }
    return { reg, rt, alice, bob };
  }

  // [label, function name, args] — args only need to ABI-encode: the guard fires before any of them is read.
  const TARGETS = [
    // main facet (self-submit)
    ["createWager", [Z, Z, Z, 1, 1, 0, 0, 0, H, false, H, ""]],
    ["createWagerWithTerms", [Z, Z, Z, 1, 1, 0, 0, 0, H, false, H, "", H]],
    ["createOpenWager", [Z, Z, Z, 1, 0, 0, 0, H, false, H, ""]],
    ["acceptWager", [1]],
    ["acceptOpenWager", [1, "0x"]],
    ["cancelOpen", [1]],
    ["declineWager", [1]],
    ["declareWinner", [1, Z]],
    ["declareDraw", [1]],
    ["revokeDraw", [1]],
    ["claimPayout", [1]],
    ["claimRefund", [1]],
    // Intents facet (via the fallback)
    ["createWagerWithAuthorization", [[Z, Z, Z, 1, 1, 0, 0, 0, H, false, H, "", H, H], Z, H, 0, 0, "0x", AUTH, AUTH]],
    ["acceptWagerWithAuthorization", [1, Z, H, 0, 0, "0x", AUTH, AUTH]],
    ["acceptOpenWagerWithAuthorization", [1, Z, "0x", H, 0, 0, "0x", AUTH, AUTH]],
    ["claimPayoutWithSig", [1, Z, H, 0, 0, "0x"]],
    ["claimRefundWithSig", [1, Z, H, 0, 0, "0x"]],
    ["declareDrawWithSig", [1, Z, H, 0, 0, "0x"]],
    ["revokeDrawWithSig", [1, Z, H, 0, 0, "0x"]],
    ["cancelOpenWithSig", [1, Z, H, 0, 0, "0x"]],
    ["declineWagerWithSig", [1, Z, H, 0, 0, "0x"]],
    ["declareWinnerWithSig", [1, Z, Z, H, 0, 0, "0x"]],
    ["batchExpireOpen", [[1]]],
  ];

  for (const [fn, args] of TARGETS) {
    it(`${fn} refuses re-entry with ReentrancyGuardReentrantCall`, async function () {
      const { reg, rt, alice, bob } = await loadFixture(fixture);
      await rt.arm(await reg.getAddress(), reg.interface.encodeFunctionData(fn, args));
      const now = await time.latest();
      await expect(
        reg.connect(alice).createWager(bob.address, Z, await rt.getAddress(), usdc(10), usdc(10), now + 3600, now + 86400, R.Either, H, false, ethers.id("re"), "")
      ).to.be.revertedWithCustomError(reg, "ReentrancyGuardReentrantCall");
    });
  }

  it("control: with the token disarmed the same createWager succeeds (the revert above is the guard, not the setup)", async function () {
    const { reg, rt, alice, bob } = await loadFixture(fixture);
    const now = await time.latest();
    await expect(
      reg.connect(alice).createWager(bob.address, Z, await rt.getAddress(), usdc(10), usdc(10), now + 3600, now + 86400, R.Either, H, false, ethers.id("re"), "")
    ).to.emit(reg, "WagerCreated");
  });
});
