const { expect } = require("chai");
const { ethers } = require("hardhat");

// Spec 049 — integration suite against the REAL Safe v1.4.1 (devDependency, compiled via
// contracts/mocks/vendor/SafeVendorImports.sol). Proves the guard's whole contract surface —
// the Safe's execTransaction calling convention, setGuard's ERC-165 "GS300" acceptance, and
// Safe.setup's delegatecall hook — against the actual bytecode the custody vaults run:
//   • factory-create a vault with the PolicyGuardSetup initializer → rules live pre-first-tx (US1)
//   • approved-but-violating execTransaction reverts with the guard's typed error (FR-003)
//   • compliant execTransaction moves funds
//   • threshold-approved configureRules self-transaction changes the policy (US3 / FR-007)
//   • setGuard attaches the guard to a pre-existing vault (ERC-165 accepted)
//   • a policy-less vault (plain initializer) behaves exactly as stock Safe (FR-010 / SC-007)

const SAFE_QN = "@safe-global/safe-contracts/contracts/SafeL2.sol:SafeL2";
const FACTORY_QN = "@safe-global/safe-contracts/contracts/proxies/SafeProxyFactory.sol:SafeProxyFactory";
const HANDLER_QN = "@safe-global/safe-contracts/contracts/handler/CompatibilityFallbackHandler.sol:CompatibilityFallbackHandler";

const GUARD_SLOT = "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8";
const NATIVE = ethers.ZeroAddress;
const AddressZero = ethers.ZeroAddress;

describe("SafePolicyGuard × real Safe v1.4.1 (integration)", function () {
  let owner1, owner2, owner3, outsider;
  let singleton, factory, handler, guard, setup;
  let saltNonce = 1000n;

  before(async () => {
    [owner1, owner2, owner3, outsider] = await ethers.getSigners();
    singleton = await (await ethers.getContractFactory(SAFE_QN)).deploy();
    factory = await (await ethers.getContractFactory(FACTORY_QN)).deploy();
    handler = await (await ethers.getContractFactory(HANDLER_QN)).deploy();
    guard = await (await ethers.getContractFactory("SafePolicyGuard")).deploy();
    setup = await (await ethers.getContractFactory("PolicyGuardSetup")).deploy();
    await Promise.all([singleton, factory, handler, guard, setup].map((c) => c.waitForDeployment()));
  });

  /** Deploy a 2-of-3 Safe; optional setupTo/setupData wires PolicyGuardSetup at creation. */
  async function createVault({ setupTo = AddressZero, setupData = "0x" } = {}) {
    const owners = [owner1.address, owner2.address, owner3.address];
    const initializer = singleton.interface.encodeFunctionData("setup", [
      owners, 2n, setupTo, setupData, await handler.getAddress(), AddressZero, 0n, AddressZero,
    ]);
    const tx = await factory.createProxyWithNonce(await singleton.getAddress(), initializer, saltNonce++);
    const receipt = await tx.wait();
    const log = receipt.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
      .find((p) => p?.name === "ProxyCreation");
    const vault = await ethers.getContractAt(SAFE_QN, log.args.proxy);
    await owner1.sendTransaction({ to: log.args.proxy, value: ethers.parseEther("10") });
    return vault;
  }

  function enablePolicyCalldata(configure) {
    return setup.interface.encodeFunctionData("enablePolicy", [guard.target, configure]);
  }

  function configureCalldata({ limits = [], cooldown = 0, allowlistEnabled = false, add = [], remove = [] } = {}) {
    return guard.interface.encodeFunctionData("configureRules", [limits, cooldown, allowlistEnabled, add, remove]);
  }

  /** Threshold-approve (approveHash by each owner) then execute a Safe transaction. */
  async function execAsOwners(vault, { to, value = 0n, data = "0x", operation = 0 }, signers = [owner1, owner2]) {
    const nonce = await vault.nonce();
    const txHash = await vault.getTransactionHash(to, value, data, operation, 0, 0, 0, AddressZero, AddressZero, nonce);
    for (const s of signers) await vault.connect(s).approveHash(txHash);
    const sorted = [...signers].sort((a, b) => (BigInt(a.address) < BigInt(b.address) ? -1 : 1));
    // Pre-validated signature encoding: r = owner, s = 0, v = 1.
    const signatures = ethers.concat(
      sorted.map((s) => ethers.concat([ethers.zeroPadValue(s.address, 32), ethers.ZeroHash, "0x01"])),
    );
    return vault.connect(signers[0]).execTransaction(to, value, data, operation, 0, 0, 0, AddressZero, AddressZero, signatures);
  }

  it("US1: a vault created with PolicyGuardSetup has its rules live before its first transaction", async () => {
    const vault = await createVault({
      setupTo: setup.target,
      setupData: enablePolicyCalldata(
        configureCalldata({ limits: [{ asset: NATIVE, perTxLimit: ethers.parseEther("1"), windowLimit: 0n }] }),
      ),
    });
    const slot = await ethers.provider.getStorage(vault.target, GUARD_SLOT);
    expect(ethers.getAddress(ethers.dataSlice(slot, 12))).to.equal(guard.target);
    const p = await guard.getPolicy(vault.target);
    expect(p.hasRules).to.equal(true);

    // Approved-but-violating execution reverts with the guard's typed error (FR-003)...
    await expect(execAsOwners(vault, { to: outsider.address, value: ethers.parseEther("2") }))
      .to.be.revertedWithCustomError(guard, "PerTxLimitExceeded")
      .withArgs(NATIVE, ethers.parseEther("2"), ethers.parseEther("1"));

    // ...and a compliant one moves funds.
    const before = await ethers.provider.getBalance(outsider.address);
    await execAsOwners(vault, { to: outsider.address, value: ethers.parseEther("1") });
    expect(await ethers.provider.getBalance(outsider.address)).to.equal(before + ethers.parseEther("1"));
  });

  it("US3/FR-007: a threshold-approved self-transaction to the guard changes the policy", async () => {
    const vault = await createVault({
      setupTo: setup.target,
      setupData: enablePolicyCalldata(
        configureCalldata({ limits: [{ asset: NATIVE, perTxLimit: ethers.parseEther("1"), windowLimit: 0n }] }),
      ),
    });
    // Raise the limit to 3 ETH via the vault's own approval flow (guard target = exempt path).
    await execAsOwners(vault, {
      to: guard.target,
      data: configureCalldata({ limits: [{ asset: NATIVE, perTxLimit: ethers.parseEther("3"), windowLimit: 0n }] }),
    });
    const rule = await guard.getAssetRule(vault.target, NATIVE);
    expect(rule.perTxLimit).to.equal(ethers.parseEther("3"));
    // The very next transaction is governed by the new rules.
    await expect(execAsOwners(vault, { to: outsider.address, value: ethers.parseEther("2") })).to.not.be.reverted;
  });

  it("lockout-proofing on the real Safe: a max-strict policy still admits the loosening change", async () => {
    const vault = await createVault({
      setupTo: setup.target,
      setupData: enablePolicyCalldata(
        configureCalldata({
          limits: [{ asset: NATIVE, perTxLimit: 1n, windowLimit: 1n }],
          cooldown: 365 * 24 * 3600,
          allowlistEnabled: true,
          add: [owner3.address],
        }),
      ),
    });
    // Nothing moves...
    await expect(execAsOwners(vault, { to: outsider.address, value: ethers.parseEther("1") }))
      .to.be.revertedWithCustomError(guard, "RecipientNotAllowed");
    // ...but the loosening executes despite every rule (FR-008/SC-003).
    await execAsOwners(vault, {
      to: guard.target,
      data: configureCalldata({ limits: [{ asset: NATIVE, perTxLimit: 0n, windowLimit: 0n }], cooldown: 0, allowlistEnabled: false }),
    });
    await expect(execAsOwners(vault, { to: outsider.address, value: ethers.parseEther("1") })).to.not.be.reverted;
  });

  it("attach-to-existing: Safe.setGuard accepts the guard via ERC-165 (GS300) on a plain vault", async () => {
    const vault = await createVault(); // no policy at creation
    // Order matters (frontend contract): configure rules first (inert), then setGuard (activates).
    await execAsOwners(vault, {
      to: guard.target,
      data: configureCalldata({ limits: [{ asset: NATIVE, perTxLimit: ethers.parseEther("1"), windowLimit: 0n }] }),
    });
    await execAsOwners(vault, { to: vault.target, data: vault.interface.encodeFunctionData("setGuard", [guard.target]) });
    const slot = await ethers.provider.getStorage(vault.target, GUARD_SLOT);
    expect(ethers.getAddress(ethers.dataSlice(slot, 12))).to.equal(guard.target);
    await expect(execAsOwners(vault, { to: outsider.address, value: ethers.parseEther("2") }))
      .to.be.revertedWithCustomError(guard, "PerTxLimitExceeded");
  });

  it("FR-010/SC-007: a vault created WITHOUT the policy initializer behaves as stock Safe", async () => {
    const vault = await createVault();
    expect(await ethers.provider.getStorage(vault.target, GUARD_SLOT)).to.equal(ethers.ZeroHash);
    expect((await guard.getPolicy(vault.target)).hasRules).to.equal(false);
    // Arbitrary large transfer executes with plain threshold approval — no policy interference.
    await expect(execAsOwners(vault, { to: outsider.address, value: ethers.parseEther("5") })).to.not.be.reverted;
  });

  it("a half-configured vault cannot deploy: invalid initial policy aborts creation", async () => {
    // Allowlist enabled with zero entries → guard reverts → setup delegatecall reverts → GS000.
    // ANY-REVERT: SafeProxyFactory v1.4.1 discards the initializer's revert data (`revert(0, 0)`), so
    // neither the guard's EmptyAllowlist nor Safe's GS000 is observable from here.
    await expect(
      createVault({
        setupTo: setup.target,
        setupData: enablePolicyCalldata(configureCalldata({ allowlistEnabled: true })),
      }),
    ).to.be.revertedWithoutReason();
  });
});
