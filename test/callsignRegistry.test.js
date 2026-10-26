const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// Spec 054 — CallsignRegistry: register (US1), resolve (US2), lifecycle (US4), moderation (US5).
// Deploys the REAL MembershipManager proxy so the Gold-tier gate is exercised end-to-end.

const WAGER_PARTICIPANT_ROLE = ethers.id("WAGER_PARTICIPANT_ROLE");
const Tier = { None: 0, Bronze: 1, Silver: 2, Gold: 3, Platinum: 4 };
const Status = { NONE: 0, ACTIVE: 1, REPOINTING: 2, QUARANTINED: 3, SUSPENDED: 4, LAPSED_RECLAIMABLE: 5 };
const SALT = ethers.id("salt-1");
const DAY = 24 * 60 * 60;

async function deployProxy(name, initArgs) {
  const Impl = await ethers.getContractFactory(name);
  const impl = await Impl.deploy();
  await impl.waitForDeployment();
  const initData = Impl.interface.encodeFunctionData("initialize", initArgs);
  const Proxy = await ethers.getContractFactory("ERC1967Proxy");
  const proxy = await Proxy.deploy(await impl.getAddress(), initData);
  await proxy.waitForDeployment();
  return Impl.attach(await proxy.getAddress());
}

async function fixture() {
  const [admin, gold, gold2, silver, other, target] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MockERC20");
  const token = await Token.deploy("USD Coin", "USDC", 6);
  await token.waitForDeployment();

  const membership = await deployProxy("MembershipManager", [
    admin.address,
    await token.getAddress(),
    admin.address, // treasury
  ]);

  const reg = await deployProxy("CallsignRegistry", [
    admin.address,
    await membership.getAddress(),
    ethers.ZeroAddress, // sanctions disabled in unit tests
    WAGER_PARTICIPANT_ROLE,
  ]);

  // Grant tiers.
  await membership.connect(admin).grantMembership(gold.address, WAGER_PARTICIPANT_ROLE, Tier.Gold, 365);
  await membership.connect(admin).grantMembership(gold2.address, WAGER_PARTICIPANT_ROLE, Tier.Gold, 365);
  await membership.connect(admin).grantMembership(silver.address, WAGER_PARTICIPANT_ROLE, Tier.Silver, 365);

  return { admin, gold, gold2, silver, other, target, membership, reg };
}

async function claim(reg, signer, callsign, salt = SALT) {
  const commitment = await reg.makeCommitment(callsign, signer.address, salt);
  await reg.connect(signer).commit(commitment);
  await time.increase(120); // past minCommitmentAge (60s)
  return reg.connect(signer).register(callsign, salt);
}

describe("CallsignRegistry — registration (US1)", () => {
  it("Gold member commits then registers; resolves ACTIVE both ways", async () => {
    const { reg, gold } = await fixture();
    await claim(reg, gold, "chipprbots");
    const info = await reg.resolve("chipprbots");
    expect(info.owner).to.equal(gold.address);
    expect(info.status).to.equal(Status.ACTIVE);
    expect(await reg.callsignOf(gold.address)).to.equal("chipprbots");
  });

  it("Platinum member (Gold and above) can register", async () => {
    const { reg, membership, admin, other } = await fixture();
    await membership.connect(admin).grantMembership(other.address, WAGER_PARTICIPANT_ROLE, Tier.Platinum, 365);
    await claim(reg, other, "platinumco");
    expect((await reg.resolve("platinumco")).status).to.equal(Status.ACTIVE);
  });

  it("rejects duplicate registration (case-insensitive uniqueness)", async () => {
    const { reg, gold, gold2 } = await fixture();
    await claim(reg, gold, "acme");
    // gold2 commits + tries same callsign
    const commitment = await reg.makeCommitment("acme", gold2.address, SALT);
    await reg.connect(gold2).commit(commitment);
    await time.increase(120);
    await expect(reg.connect(gold2).register("acme", SALT)).to.be.revertedWithCustomError(reg, "CallsignUnavailable");
  });

  it("rejects below-Gold tiers on-chain (Silver / None)", async () => {
    const { reg, silver, other } = await fixture();
    // Silver
    let c = await reg.makeCommitment("silvertag", silver.address, SALT);
    await reg.connect(silver).commit(c);
    await time.increase(120);
    await expect(reg.connect(silver).register("silvertag", SALT)).to.be.revertedWithCustomError(reg, "InsufficientMembershipTier");
    // No membership
    c = await reg.makeCommitment("nomember", other.address, SALT);
    await reg.connect(other).commit(c);
    await time.increase(120);
    await expect(reg.connect(other).register("nomember", SALT)).to.be.revertedWithCustomError(reg, "InsufficientMembershipTier");
  });

  it("rejects reserved terms", async () => {
    const { reg, admin, gold } = await fixture();
    await reg.connect(admin).grantRole(await reg.REGISTRY_CURATOR_ROLE(), admin.address);
    await reg.connect(admin).setReserved([ethers.keccak256(ethers.toUtf8Bytes("admin"))], true);
    const c = await reg.makeCommitment("admin", gold.address, SALT);
    await reg.connect(gold).commit(c);
    await time.increase(120);
    await expect(reg.connect(gold).register("admin", SALT)).to.be.revertedWithCustomError(reg, "CallsignIsReserved");
  });

  it("rejects invalid formats (length, charset, hyphen placement, uppercase)", async () => {
    const { reg, gold } = await fixture();
    for (const bad of ["ab", "a".repeat(21), "-lead", "trail-", "dou--ble", "Upper", "bad_underscore", "emoji😀x"]) {
      await expect(reg.makeCommitment(bad, gold.address, SALT)).to.be.revertedWithCustomError(reg, "InvalidCallsignFormat");
    }
    // Valid edge cases succeed at validation (pure call returns a 32-byte commitment hash).
    expect(ethers.isHexString(await reg.makeCommitment("a-b", gold.address, SALT), 32)).to.equal(true);
    expect(ethers.isHexString(await reg.makeCommitment("abc", gold.address, SALT), 32)).to.equal(true);
  });

  it("prevents claim-sniping: reveal without a matching aged commitment reverts", async () => {
    const { reg, gold, gold2 } = await fixture();
    // gold commits, does NOT yet register
    const c = await reg.makeCommitment("snipeme", gold.address, SALT);
    await reg.connect(gold).commit(c);
    await time.increase(120);
    // gold2 observes the callsign and front-runs register with no commitment of their own
    await expect(reg.connect(gold2).register("snipeme", SALT)).to.be.revertedWithCustomError(reg, "NoCommitment");
    // original claimant still completes
    await expect(reg.connect(gold).register("snipeme", SALT)).to.not.be.reverted;
  });

  it("enforces commit-age window (too-new and expired)", async () => {
    const { reg, gold, gold2 } = await fixture();
    // too new
    const c = await reg.makeCommitment("freshtag", gold.address, SALT);
    await reg.connect(gold).commit(c);
    await expect(reg.connect(gold).register("freshtag", SALT)).to.be.revertedWithCustomError(reg, "CommitmentTooNew");
    // expired (> maxCommitmentAge = 1 day)
    const c2 = await reg.makeCommitment("expiredtag", gold2.address, SALT);
    await reg.connect(gold2).commit(c2);
    await time.increase(DAY + 60);
    await expect(reg.connect(gold2).register("expiredtag", SALT)).to.be.revertedWithCustomError(reg, "CommitmentExpired");
  });

  it("one callsign per account", async () => {
    const { reg, gold } = await fixture();
    await claim(reg, gold, "firsttag");
    const c = await reg.makeCommitment("secondtag", gold.address, SALT);
    await reg.connect(gold).commit(c);
    await time.increase(120);
    await expect(reg.connect(gold).register("secondtag", SALT)).to.be.revertedWithCustomError(reg, "AlreadyHasCallsign");
  });
});

describe("CallsignRegistry — resolution (US2)", () => {
  it("unknown callsign resolves to NONE with no near-match; optionality holds for tagless accounts", async () => {
    const { reg, other } = await fixture();
    const info = await reg.resolve("ghosttag");
    expect(info.status).to.equal(Status.NONE);
    expect(info.owner).to.equal(ethers.ZeroAddress);
    // A tagless account is a first-class case: no callsign, nothing blocked at the registry boundary.
    expect(await reg.callsignOf(other.address)).to.equal("");
  });

  it("isAvailable reflects registration + reserved", async () => {
    const { reg, gold } = await fixture();
    expect(await reg.isAvailable("openname")).to.equal(true);
    await claim(reg, gold, "openname");
    expect(await reg.isAvailable("openname")).to.equal(false);
  });

  it("reverse resolution only reports a callsign whose forward resolution is ACTIVE (FR-008)", async () => {
    const { reg, gold } = await fixture();
    await claim(reg, gold, "roundtrip");
    expect(await reg.callsignOf(gold.address)).to.equal("roundtrip");
    const fwd = await reg.resolve("roundtrip");
    expect(fwd.owner).to.equal(gold.address);
  });
});

describe("CallsignRegistry — lifecycle & takeover protection (US4)", () => {
  it("release quarantines the callsign; others cannot register until quarantine elapses", async () => {
    const { reg, gold, gold2 } = await fixture();
    await claim(reg, gold, "temporary");
    await reg.connect(gold).release();
    expect((await reg.resolve("temporary")).status).to.equal(Status.QUARANTINED);
    // gold2 cannot take it during quarantine
    const c = await reg.makeCommitment("temporary", gold2.address, SALT);
    await reg.connect(gold2).commit(c);
    await time.increase(120);
    await expect(reg.connect(gold2).register("temporary", SALT)).to.be.revertedWithCustomError(reg, "CallsignUnavailable");
    // after quarantine (90d) it becomes available
    await time.increase(90 * DAY);
    expect((await reg.resolve("temporary")).status).to.equal(Status.NONE);
    const c2 = await reg.makeCommitment("temporary", gold2.address, SALT);
    await reg.connect(gold2).commit(c2);
    await time.increase(120);
    await expect(reg.connect(gold2).register("temporary", SALT)).to.not.be.reverted;
  });

  it("changeCallsign is rate-limited by the cooldown", async () => {
    const { reg, gold } = await fixture();
    await claim(reg, gold, "changer");
    // commit new callsign then change
    const c = await reg.makeCommitment("changed1", gold.address, SALT);
    await reg.connect(gold).commit(c);
    await time.increase(120);
    await reg.connect(gold).changeCallsign("changed1", SALT);
    expect(await reg.callsignOf(gold.address)).to.equal("changed1");
    // immediate second change blocked by cooldown
    const c2 = await reg.makeCommitment("changed2", gold.address, SALT);
    await reg.connect(gold).commit(c2);
    await time.increase(120);
    await expect(reg.connect(gold).changeCallsign("changed2", SALT)).to.be.revertedWithCustomError(reg, "ChangeCooldownActive");
  });

  it("repoint: REPOINTING during delay, cancellable, finalizable by anyone once target is Gold; reverse index moves and verified is cleared", async () => {
    const { reg, membership, admin, gold, target, other } = await fixture();
    await claim(reg, gold, "movable");
    const h = ethers.keccak256(ethers.toUtf8Bytes("movable"));
    // Verify the callsign first so we can prove verification does NOT ride along to the new owner.
    await reg.connect(admin).grantRole(await reg.VERIFIER_ROLE(), admin.address);
    await reg.connect(admin).setVerified(h, true);

    await reg.connect(gold).requestRepoint(target.address);
    expect((await reg.resolve("movable")).status).to.equal(Status.REPOINTING);
    // cancel
    await reg.connect(gold).cancelRepoint();
    expect((await reg.resolve("movable")).status).to.equal(Status.ACTIVE);
    // request again
    await reg.connect(gold).requestRepoint(target.address);
    await time.increase(48 * 60 * 60 + 60);

    // Anti-hoarding: finalize cannot complete until the INCOMING owner is Gold-eligible (FR-021).
    await expect(reg.connect(other).finalizeRepoint(h)).to.be.revertedWithCustomError(reg, "InsufficientMembershipTier");

    // Target becomes Gold → finalize succeeds, permissionlessly.
    await membership.connect(admin).grantMembership(target.address, WAGER_PARTICIPANT_ROLE, Tier.Gold, 365);
    await reg.connect(other).finalizeRepoint(h);
    expect(await reg.callsignOf(target.address)).to.equal("movable");
    expect(await reg.callsignOf(gold.address)).to.equal("");
    const info = await reg.resolve("movable");
    expect(info.owner).to.equal(target.address);
    expect(info.verified).to.equal(false); // verification does not transfer with the callsign
  });

  it("commit cannot be griefed: replaying an unexpired commitment reverts (reveal-DoS defense)", async () => {
    const { reg, gold, other } = await fixture();
    // Victim (gold) commits their callsign.
    const commitment = await reg.makeCommitment("victimco", gold.address, SALT);
    await reg.connect(gold).commit(commitment);
    // Attacker replays the SAME public commitment bytes to try to reset its age → must revert.
    await expect(reg.connect(other).commit(commitment)).to.be.revertedWithCustomError(reg, "CommitmentPending");
    // Victim can still reveal normally after the age window (grief failed).
    await time.increase(120);
    await reg.connect(gold).register("victimco", SALT);
    expect(await reg.callsignOf(gold.address)).to.equal("victimco");
  });

  it("reclaimLapsed only after Gold coverage ends past grace; honored through the grace window", async () => {
    const { reg, membership, admin, gold, other } = await fixture();
    await claim(reg, gold, "lapser");
    const h = ethers.keccak256(ethers.toUtf8Bytes("lapser"));
    // Not lapsed while Gold active.
    await expect(reg.connect(other).reclaimLapsed(h)).to.be.revertedWithCustomError(reg, "NotLapsed");
    // Drop below Gold. Within the grace window (measured from ownership anchor) the callsign is still ACTIVE.
    await membership.connect(admin).revokeMembership(gold.address, WAGER_PARTICIPANT_ROLE);
    expect((await reg.resolve("lapser")).status).to.equal(Status.ACTIVE);
    await expect(reg.connect(other).reclaimLapsed(h)).to.be.revertedWithCustomError(reg, "NotLapsed");
    // Past the grace window it becomes reclaimable, then anyone can quarantine it.
    await time.increase(365 * DAY + 60);
    expect((await reg.resolve("lapser")).status).to.equal(Status.LAPSED_RECLAIMABLE);
    await reg.connect(other).reclaimLapsed(h);
    expect((await reg.resolve("lapser")).status).to.equal(Status.QUARANTINED);
  });
});

describe("CallsignRegistry — moderation & verification (US5)", () => {
  it("suspend stops resolution without reassigning ownership or moving the record", async () => {
    const { reg, admin, gold } = await fixture();
    await claim(reg, gold, "brandco");
    const h = ethers.keccak256(ethers.toUtf8Bytes("brandco"));
    await reg.connect(admin).grantRole(await reg.MODERATOR_ROLE(), admin.address);
    await reg.connect(admin).setSuspended(h, true);
    const info = await reg.resolve("brandco");
    expect(info.status).to.equal(Status.SUSPENDED);
    expect(info.owner).to.equal(gold.address); // ownership untouched
    expect(await reg.callsignOf(gold.address)).to.equal(""); // not shown while suspended
  });

  it("verification flag round-trips and is visible", async () => {
    const { reg, admin, gold } = await fixture();
    await claim(reg, gold, "verifiedco");
    const h = ethers.keccak256(ethers.toUtf8Bytes("verifiedco"));
    await reg.connect(admin).grantRole(await reg.VERIFIER_ROLE(), admin.address);
    await reg.connect(admin).setVerified(h, true);
    expect((await reg.resolve("verifiedco")).verified).to.equal(true);
    await reg.connect(admin).setVerified(h, false);
    expect((await reg.resolve("verifiedco")).verified).to.equal(false);
  });

  it("role-gated: non-role callers cannot moderate", async () => {
    const { reg, gold } = await fixture();
    await claim(reg, gold, "guarded");
    const h = ethers.keccak256(ethers.toUtf8Bytes("guarded"));
    await expect(reg.connect(gold).setSuspended(h, true)).to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount").withArgs(gold.address, await reg.MODERATOR_ROLE());
    await expect(reg.connect(gold).setVerified(h, true)).to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount").withArgs(gold.address, await reg.VERIFIER_ROLE());
    await expect(reg.connect(gold).setReserved([h], true)).to.be.revertedWithCustomError(reg, "AccessControlUnauthorizedAccount").withArgs(gold.address, await reg.REGISTRY_CURATOR_ROLE());
  });
});

describe("CallsignRegistry — admin gate bounds", () => {
  it("setMembershipGate cannot drop below Gold", async () => {
    const { reg, admin } = await fixture();
    await expect(reg.connect(admin).setMembershipGate(WAGER_PARTICIPANT_ROLE, Tier.Silver)).to.be.revertedWithCustomError(reg, "TierBelowFloor");
    await expect(reg.connect(admin).setMembershipGate(WAGER_PARTICIPANT_ROLE, Tier.Platinum)).to.not.be.reverted;
  });

  it("setPolicyParams rejects out-of-bounds values", async () => {
    const { reg, admin } = await fixture();
    // quarantine below 30d floor
    await expect(
      reg.connect(admin).setPolicyParams(60, DAY, 10 * DAY, 30 * DAY, 48 * 3600, 365 * DAY)
    ).to.be.revertedWithCustomError(reg, "ParamOutOfBounds");
    // valid
    await expect(
      reg.connect(admin).setPolicyParams(60, DAY, 90 * DAY, 30 * DAY, 48 * 3600, 365 * DAY)
    ).to.not.be.reverted;
  });
});
