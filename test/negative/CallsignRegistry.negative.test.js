const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Spec 112 FR-006 — CallsignRegistry (spec 054) named reverts that no test asserted, centred on the
// delayed REPOINT flow (FR-022): request → wait `repointDelay` → permissionless finalize, or cancel.
// Every refusal along that path is asserted by name, each next to the positive step it guards:
//   BadRepointTarget, NoCallsign, TargetHasCallsign (at request AND at finalize), NoPendingRepoint
//   (cancel AND finalize), RepointNotReady.

const WAGER_PARTICIPANT_ROLE = ethers.id("WAGER_PARTICIPANT_ROLE");
const Tier = { None: 0, Bronze: 1, Silver: 2, Gold: 3 };
const SALT = ethers.id("neg-salt");
const REPOINT_DELAY = 48 * 60 * 60;

async function deployProxy(name, initArgs) {
  const Impl = await ethers.getContractFactory(name);
  const impl = await Impl.deploy();
  const Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await Proxy.deploy(await impl.getAddress(), Impl.interface.encodeFunctionData("initialize", initArgs));
  return Impl.attach(await proxy.getAddress());
}

describe("CallsignRegistry — repoint flow negative paths (spec 112 FR-006)", function () {
  async function fixture() {
    const [admin, owner, target, third, stranger] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockERC20")).deploy("USD Coin", "USDC", 6);
    const membership = await deployProxy("MembershipManager", [admin.address, await token.getAddress(), admin.address]);
    const reg = await deployProxy("CallsignRegistry", [admin.address, await membership.getAddress(), ethers.ZeroAddress, WAGER_PARTICIPANT_ROLE]);
    for (const u of [owner, target, third]) {
      await membership.connect(admin).grantMembership(u.address, WAGER_PARTICIPANT_ROLE, Tier.Gold, 365);
    }
    await claim(reg, owner, "neguser");
    const hash = await reg.callsignHashOf(owner.address);
    return { reg, membership, admin, owner, target, third, stranger, hash };
  }

  async function claim(reg, signer, callsign) {
    await reg.connect(signer).commit(await reg.makeCommitment(callsign, signer.address, SALT));
    await time.increase(120);
    await reg.connect(signer).register(callsign, SALT);
  }

  describe("requestRepoint", function () {
    it("reverts BadRepointTarget for the zero address and for the owner themself", async function () {
      const { reg, owner } = await loadFixture(fixture);
      await expect(reg.connect(owner).requestRepoint(ethers.ZeroAddress)).to.be.revertedWithCustomError(reg, "BadRepointTarget");
      await expect(reg.connect(owner).requestRepoint(owner.address)).to.be.revertedWithCustomError(reg, "BadRepointTarget");
    });

    it("reverts NoCallsign when the caller holds no callsign", async function () {
      const { reg, stranger, target } = await loadFixture(fixture);
      await expect(reg.connect(stranger).requestRepoint(target.address)).to.be.revertedWithCustomError(reg, "NoCallsign");
    });

    it("reverts TargetHasCallsign when the destination already holds one", async function () {
      const { reg, owner, third } = await loadFixture(fixture);
      await claim(reg, third, "thirdtag");
      await expect(reg.connect(owner).requestRepoint(third.address)).to.be.revertedWithCustomError(reg, "TargetHasCallsign");
    });
  });

  describe("cancelRepoint", function () {
    it("reverts NoCallsign when the caller holds no callsign", async function () {
      const { reg, stranger } = await loadFixture(fixture);
      await expect(reg.connect(stranger).cancelRepoint()).to.be.revertedWithCustomError(reg, "NoCallsign");
    });

    it("reverts NoPendingRepoint with nothing pending; cancels a pending one; then reverts NoPendingRepoint again", async function () {
      const { reg, owner, target, hash } = await loadFixture(fixture);
      await expect(reg.connect(owner).cancelRepoint()).to.be.revertedWithCustomError(reg, "NoPendingRepoint");
      await reg.connect(owner).requestRepoint(target.address);
      await expect(reg.connect(owner).cancelRepoint()).to.emit(reg, "CallsignRepointCancelled").withArgs(hash);
      await expect(reg.connect(owner).cancelRepoint()).to.be.revertedWithCustomError(reg, "NoPendingRepoint");
    });
  });

  describe("finalizeRepoint", function () {
    it("reverts NoPendingRepoint for a callsign with no pending repoint (and for an unknown hash)", async function () {
      const { reg, stranger, hash } = await loadFixture(fixture);
      await expect(reg.connect(stranger).finalizeRepoint(hash)).to.be.revertedWithCustomError(reg, "NoPendingRepoint");
      await expect(reg.connect(stranger).finalizeRepoint(ethers.id("nobody"))).to.be.revertedWithCustomError(reg, "NoPendingRepoint");
    });

    it("reverts RepointNotReady before the delay elapses, then finalizes permissionlessly at the effective time", async function () {
      const { reg, owner, target, stranger, hash } = await loadFixture(fixture);
      await reg.connect(owner).requestRepoint(target.address);
      await expect(reg.connect(stranger).finalizeRepoint(hash)).to.be.revertedWithCustomError(reg, "RepointNotReady");
      await time.increase(REPOINT_DELAY - 10);
      await expect(reg.connect(stranger).finalizeRepoint(hash)).to.be.revertedWithCustomError(reg, "RepointNotReady");
      await time.increase(10);
      await expect(reg.connect(stranger).finalizeRepoint(hash))
        .to.emit(reg, "CallsignRepointFinalized").withArgs(hash, owner.address, target.address);
      expect(await reg.callsignHashOf(target.address)).to.equal(hash);
      expect(await reg.callsignHashOf(owner.address)).to.equal(ethers.ZeroHash);
      // Consumed: a second finalize has nothing pending.
      await expect(reg.connect(stranger).finalizeRepoint(hash)).to.be.revertedWithCustomError(reg, "NoPendingRepoint");
    });

    it("reverts TargetHasCallsign when the destination registered its own callsign during the delay", async function () {
      const { reg, owner, target, stranger, hash } = await loadFixture(fixture);
      await reg.connect(owner).requestRepoint(target.address);
      await claim(reg, target, "targettag"); // legal: the pending repoint does not reserve the target
      await time.increase(REPOINT_DELAY);
      await expect(reg.connect(stranger).finalizeRepoint(hash)).to.be.revertedWithCustomError(reg, "TargetHasCallsign");
    });
  });

  describe("other NoCallsign sites", function () {
    it("release, changeCallsign and reclaimLapsed revert NoCallsign without a callsign", async function () {
      const { reg, stranger } = await loadFixture(fixture);
      await expect(reg.connect(stranger).release()).to.be.revertedWithCustomError(reg, "NoCallsign");
      await expect(reg.connect(stranger).changeCallsign("other", SALT)).to.be.revertedWithCustomError(reg, "NoCallsign");
      await expect(reg.connect(stranger).reclaimLapsed(ethers.id("nobody"))).to.be.revertedWithCustomError(reg, "NoCallsign");
    });
  });

  describe("initialisation", function () {
    it("initialize cannot run twice", async function () {
      const { reg, admin, membership } = await loadFixture(fixture);
      await expect(reg.initialize(admin.address, await membership.getAddress(), ethers.ZeroAddress, WAGER_PARTICIPANT_ROLE))
        .to.be.revertedWithCustomError(reg, "InvalidInitialization");
    });

    it("initialize reverts ZeroAddress for a zero admin, zero membership manager, or zero membership role", async function () {
      const [admin, other] = await ethers.getSigners();
      const Impl = await ethers.getContractFactory("CallsignRegistry");
      const Proxy = await ethers.getContractFactory("ERC1967Proxy");
      for (const args of [
        [ethers.ZeroAddress, other.address, ethers.ZeroAddress, WAGER_PARTICIPANT_ROLE],
        [admin.address, ethers.ZeroAddress, ethers.ZeroAddress, WAGER_PARTICIPANT_ROLE],
        [admin.address, other.address, ethers.ZeroAddress, ethers.ZeroHash],
      ]) {
        const impl = await Impl.deploy();
        await expect(Proxy.deploy(await impl.getAddress(), Impl.interface.encodeFunctionData("initialize", args)))
          .to.be.revertedWithCustomError(impl, "ZeroAddress");
      }
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Authorization + validation branches the baseline coverage run showed as never taken.
  // ---------------------------------------------------------------------------------------------

  describe("role gates", function () {
    const role = (n) => ethers.keccak256(ethers.toUtf8Bytes(n));
    const CASES = [
      ["setReserved", role("REGISTRY_CURATOR_ROLE"), (r) => r.setReserved([ethers.id("x")], true)],
      ["setSuspended", role("MODERATOR_ROLE"), (r) => r.setSuspended(ethers.id("x"), true)],
      ["setVerified", role("VERIFIER_ROLE"), (r) => r.setVerified(ethers.id("x"), true)],
      ["setPolicyParams", ethers.ZeroHash, (r) => r.setPolicyParams(60, 86400, 90 * 86400, 30 * 86400, REPOINT_DELAY, 365 * 86400)],
      ["setMembershipGate", ethers.ZeroHash, (r) => r.setMembershipGate(WAGER_PARTICIPANT_ROLE, Tier.Gold)],
      ["setMembershipManager", ethers.ZeroHash, (r, fx) => r.setMembershipManager(fx.stranger.address)],
      ["setSanctionsGuard", ethers.ZeroHash, (r) => r.setSanctionsGuard(ethers.ZeroAddress)],
    ];
    for (const [name, r, call] of CASES) {
      it(`${name} reverts AccessControlUnauthorizedAccount for a caller without its role; the holder succeeds`, async function () {
        const fx = await loadFixture(fixture);
        await expect(call(fx.reg.connect(fx.stranger), fx))
          .to.be.revertedWithCustomError(fx.reg, "AccessControlUnauthorizedAccount").withArgs(fx.stranger.address, r);
        if (r !== ethers.ZeroHash) await fx.reg.connect(fx.admin).grantRole(r, fx.third.address);
        const holder = r === ethers.ZeroHash ? fx.admin : fx.third;
        await expect(call(fx.reg.connect(holder), fx)).to.not.be.reverted;
      });
    }
  });

  describe("admin parameter bounds", function () {
    const D = 86400;
    const OK = [60, D, 90 * D, 30 * D, 2 * D, 365 * D];
    // [index, too-low, too-high] for each bounded parameter; maxCommitmentAge's low bound is "> min".
    const BOUNDS = [
      [0, 59, D + 1],
      [1, 60, 7 * D + 1],
      [2, 30 * D - 1, 365 * D + 1],
      [3, D - 1, 365 * D + 1],
      [4, D - 1, 14 * D + 1],
      [5, 30 * D - 1, 3650 * D + 1],
    ];
    it("setPolicyParams reverts ParamOutOfBounds on each side of every bound; in-range values apply", async function () {
      const fx = await loadFixture(fixture);
      for (const [i, lo, hi] of BOUNDS) {
        for (const v of [lo, hi]) {
          const args = [...OK];
          args[i] = v;
          await expect(fx.reg.connect(fx.admin).setPolicyParams(...args), `param ${i} = ${v}`).to.be.revertedWithCustomError(fx.reg, "ParamOutOfBounds");
        }
      }
      await expect(fx.reg.connect(fx.admin).setPolicyParams(...OK)).to.emit(fx.reg, "PolicyParamsSet");
    });

    it("setMembershipGate reverts TierBelowFloor below Gold; setMembershipManager reverts ZeroAddress", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.reg.connect(fx.admin).setMembershipGate(WAGER_PARTICIPANT_ROLE, Tier.Silver)).to.be.revertedWithCustomError(fx.reg, "TierBelowFloor");
      await expect(fx.reg.connect(fx.admin).setMembershipManager(ethers.ZeroAddress)).to.be.revertedWithCustomError(fx.reg, "ZeroAddress");
    });
  });

  describe("registration + change validation", function () {
    it("register reverts InvalidCallsignFormat for a malformed callsign; resolve/isAvailable answer empty/false for it", async function () {
      const fx = await loadFixture(fixture);
      await expect(fx.reg.connect(fx.target).register("Bad_Name", SALT)).to.be.revertedWithCustomError(fx.reg, "InvalidCallsignFormat");
      expect((await fx.reg.resolve("Bad_Name")).owner).to.equal(ethers.ZeroAddress);
      expect(await fx.reg.isAvailable("Bad_Name")).to.equal(false);
    });

    it("changeCallsign reverts InvalidCallsignFormat, CallsignUnavailable (same / taken), CallsignIsReserved", async function () {
      const fx = await loadFixture(fixture);
      await claim(fx.reg, fx.third, "takenname");
      await fx.reg.connect(fx.admin).grantRole(ethers.keccak256(ethers.toUtf8Bytes("REGISTRY_CURATOR_ROLE")), fx.admin.address);
      await fx.reg.connect(fx.admin).setReserved([ethers.keccak256(ethers.toUtf8Bytes("reserved"))], true);
      await expect(fx.reg.connect(fx.owner).changeCallsign("-bad", SALT)).to.be.revertedWithCustomError(fx.reg, "InvalidCallsignFormat");
      await expect(fx.reg.connect(fx.owner).changeCallsign("neguser", SALT)).to.be.revertedWithCustomError(fx.reg, "CallsignUnavailable");
      await expect(fx.reg.connect(fx.owner).changeCallsign("takenname", SALT)).to.be.revertedWithCustomError(fx.reg, "CallsignUnavailable");
      await expect(fx.reg.connect(fx.owner).changeCallsign("reserved", SALT)).to.be.revertedWithCustomError(fx.reg, "CallsignIsReserved");
    });

    it("register reverts SanctionedAccount when the guard disallows the caller", async function () {
      const fx = await loadFixture(fixture);
      const oracle = await (await ethers.getContractFactory("MockSanctionsOracle")).deploy();
      const guard = await (await ethers.getContractFactory("SanctionsGuard")).deploy(fx.admin.address, await oracle.getAddress());
      await fx.reg.connect(fx.admin).setSanctionsGuard(await guard.getAddress());
      await oracle.setSanctioned(fx.target.address, true);
      await fx.reg.connect(fx.target).commit(await fx.reg.makeCommitment("sanctioned", fx.target.address, SALT));
      await time.increase(120);
      await expect(fx.reg.connect(fx.target).register("sanctioned", SALT)).to.be.revertedWithCustomError(fx.reg, "SanctionedAccount");
    });
  });

  describe("…WithSig twins pin the exact callsign (NoCallsign)", function () {
    const tail = [{ name: "nonce", type: "bytes32" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }];
    async function sign(fx, primary, fields, msg) {
      const { chainId } = await ethers.provider.getNetwork();
      const domain = { name: "FairWins CallsignRegistry", version: "1", chainId, verifyingContract: await fx.reg.getAddress() };
      const intent = { nonce: ethers.hexlify(ethers.randomBytes(32)), validAfter: 0, validBefore: (await time.latest()) + 3600 };
      const sig = await fx.owner.signTypedData(domain, { [primary]: [...fields, ...tail] }, { ...msg, ...intent });
      return { ...intent, sig };
    }

    it("releaseWithSig / requestRepointWithSig / cancelRepointWithSig revert NoCallsign when the signed hash is not the signer's callsign", async function () {
      const fx = await loadFixture(fixture);
      const wrong = ethers.id("not-mine");
      const owner = fx.owner.address;

      let i = await sign(fx, "ReleaseCallsignIntent", [{ name: "owner", type: "address" }, { name: "callsignHash", type: "bytes32" }], { owner, callsignHash: wrong });
      await expect(fx.reg.connect(fx.stranger).releaseWithSig(owner, wrong, i.nonce, i.validAfter, i.validBefore, i.sig)).to.be.revertedWithCustomError(fx.reg, "NoCallsign");

      i = await sign(fx, "RequestRepointIntent", [{ name: "owner", type: "address" }, { name: "callsignHash", type: "bytes32" }, { name: "newOwner", type: "address" }], { owner, callsignHash: wrong, newOwner: fx.target.address });
      await expect(fx.reg.connect(fx.stranger).requestRepointWithSig(owner, wrong, fx.target.address, i.nonce, i.validAfter, i.validBefore, i.sig)).to.be.revertedWithCustomError(fx.reg, "NoCallsign");

      i = await sign(fx, "CancelRepointIntent", [{ name: "owner", type: "address" }, { name: "callsignHash", type: "bytes32" }], { owner, callsignHash: wrong });
      await expect(fx.reg.connect(fx.stranger).cancelRepointWithSig(owner, wrong, i.nonce, i.validAfter, i.validBefore, i.sig)).to.be.revertedWithCustomError(fx.reg, "NoCallsign");

      // The right hash goes through (positive control for the pin).
      i = await sign(fx, "RequestRepointIntent", [{ name: "owner", type: "address" }, { name: "callsignHash", type: "bytes32" }, { name: "newOwner", type: "address" }], { owner, callsignHash: fx.hash, newOwner: fx.target.address });
      await expect(fx.reg.connect(fx.stranger).requestRepointWithSig(owner, fx.hash, fx.target.address, i.nonce, i.validAfter, i.validBefore, i.sig)).to.emit(fx.reg, "CallsignRepointRequested");
    });
  });
});
