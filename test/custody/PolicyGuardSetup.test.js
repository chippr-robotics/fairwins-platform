const { expect } = require("chai");
const { ethers } = require("hardhat");

// Spec 049 — PolicyGuardSetup unit suite. Exercised under a REAL delegatecall via
// MockSafe.setupDelegate (mirroring Safe.setup's optional delegatecall): verifies the guard
// storage slot write, the ChangedGuard log, that the configure call reaches the guard with the
// vault as msg.sender, that reverts bubble (no half-configured vault), and that the ERC-165
// acceptance check rejects non-guards.

const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
const NATIVE = ethers.ZeroAddress;

describe("PolicyGuardSetup", function () {
  let guard, setup, mockSafe, deployer, recipient;
  let guardAddr, setupAddr, mockSafeAddr;

  beforeEach(async () => {
    [deployer, recipient] = await ethers.getSigners();
    guard = await (await ethers.getContractFactory("SafePolicyGuard")).deploy();
    setup = await (await ethers.getContractFactory("PolicyGuardSetup")).deploy();
    mockSafe = await (await ethers.getContractFactory("MockSafe")).deploy();
    await Promise.all([guard.waitForDeployment(), setup.waitForDeployment(), mockSafe.waitForDeployment()]);
    [guardAddr, setupAddr, mockSafeAddr] = await Promise.all([
      guard.getAddress(), setup.getAddress(), mockSafe.getAddress(),
    ]);
  });

  function enablePolicyData(configureCalldata = "0x") {
    return setup.interface.encodeFunctionData("enablePolicy", [guardAddr, configureCalldata]);
  }

  function configureData() {
    return guard.interface.encodeFunctionData("configureRules", [
      [{ asset: NATIVE, perTxLimit: 100n, windowLimit: 500n }], 3600, true, [recipient.address], [],
    ]);
  }

  it("writes the Safe guard storage slot in the caller's (vault's) context", async () => {
    await mockSafe.setupDelegate(setupAddr, enablePolicyData());
    const slot = await ethers.provider.getStorage(mockSafeAddr, GUARD_SLOT);
    expect(ethers.getAddress(ethers.dataSlice(slot, 12))).to.equal(guardAddr);
    // The helper's own storage/slot is untouched.
    expect(await ethers.provider.getStorage(setupAddr, GUARD_SLOT)).to.equal(ethers.ZeroHash);
  });

  it("emits the Safe ChangedGuard event signature from the vault's address", async () => {
    const tx = await mockSafe.setupDelegate(setupAddr, enablePolicyData());
    const receipt = await tx.wait();
    const topic = ethers.id("ChangedGuard(address)");
    const log = receipt.logs.find((l) => l.address === mockSafeAddr && l.topics[0] === topic);
    expect(log, "ChangedGuard log emitted by the vault").to.not.equal(undefined);
    expect(ethers.getAddress(ethers.dataSlice(log.topics[1], 12))).to.equal(guardAddr);
  });

  it("applies the initial policy with the new vault as msg.sender (authority model holds)", async () => {
    await mockSafe.setupDelegate(setupAddr, enablePolicyData(configureData()));
    const p = await guard.getPolicy(mockSafeAddr);
    expect(p.hasRules).to.equal(true);
    expect(p.allowlistEnabled).to.equal(true);
    expect(p.cooldown).to.equal(3600n);
    const r = await guard.getAssetRule(mockSafeAddr, NATIVE);
    expect(r.perTxLimit).to.equal(100n);
    expect(r.windowLimit).to.equal(500n);
  });

  it("attaches with no initial rules when configure calldata is empty", async () => {
    await mockSafe.setupDelegate(setupAddr, enablePolicyData("0x"));
    expect((await guard.getPolicy(mockSafeAddr)).hasRules).to.equal(false);
    const slot = await ethers.provider.getStorage(mockSafeAddr, GUARD_SLOT);
    expect(ethers.getAddress(ethers.dataSlice(slot, 12))).to.equal(guardAddr);
  });

  it("bubbles guard config reverts, aborting the whole setup (no half-configured vault)", async () => {
    // Allowlist enabled with zero entries → guard reverts EmptyAllowlist → creation aborts.
    const bad = guard.interface.encodeFunctionData("configureRules", [[], 0, true, [], []]);
    await expect(mockSafe.setupDelegate(setupAddr, enablePolicyData(bad)))
      .to.be.revertedWithCustomError(guard, "EmptyAllowlist");
    expect(await ethers.provider.getStorage(mockSafeAddr, GUARD_SLOT)).to.equal(ethers.ZeroHash);
  });

  it("rejects the zero guard address", async () => {
    const data = setup.interface.encodeFunctionData("enablePolicy", [ethers.ZeroAddress, "0x"]);
    await expect(mockSafe.setupDelegate(setupAddr, data)).to.be.revertedWithCustomError(setup, "ZeroGuard");
  });

  it("rejects a target that does not self-report the Safe guard interface (GS300 parity)", async () => {
    // The proposal hub is a contract but not a guard.
    const notGuard = await (await ethers.getContractFactory("SafeProposalHub")).deploy();
    await notGuard.waitForDeployment();
    const data = setup.interface.encodeFunctionData("enablePolicy", [await notGuard.getAddress(), "0x"]);
    // The hub has no supportsInterface and no fallback, so the ERC-165 probe itself reverts with empty
    // data before NotAGuard can be reached; MockSafe surfaces an empty delegatecall failure as DelegateSetupFailed.
    await expect(mockSafe.setupDelegate(setupAddr, data)).to.be.revertedWithCustomError(mockSafe, "DelegateSetupFailed");
    expect(await ethers.provider.getStorage(mockSafeAddr, GUARD_SLOT)).to.equal(ethers.ZeroHash);
  });

  it("direct (non-delegatecall) invocation cannot touch any vault's slot", async () => {
    await expect(setup.connect(deployer).enablePolicy(guardAddr, "0x")).to.not.be.reverted;
    expect(await ethers.provider.getStorage(mockSafeAddr, GUARD_SLOT)).to.equal(ethers.ZeroHash);
  });
});
