const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const path = require("path");
const { pathToFileURL } = require("url");

/**
 * Spec 068 — the ordered-policy scenarios, driven against the REAL guard.
 *
 * `matchPreview` (frontend/src/lib/custody/policyV2.js) is a client twin of on-chain matching, and
 * the two are meant to move in lockstep. Nothing enforced that: this suite and the Vitest suite
 * each carried their own hand-copied cases, so a divergence would show up as two green suites that
 * disagree about what a vault will actually do.
 *
 * The scenarios now live in ONE file (frontend/src/test/fixtures/policyScenarios.js). This test
 * asserts the CONTRACT obeys them; frontend/src/test/custody/policyV2.test.js asserts the preview
 * agrees with the same table; and the full-tier Cypress spec composes them in the UI. A scenario
 * added in one place is therefore checked in all three, and one that the contract does not honour
 * fails here rather than being quietly re-copied.
 *
 * Deliberately a SEPARATE file from SafePolicyGuardV2.test.js: that suite owns the guard's
 * behaviour in detail (bounds, typed errors, exemptions, approver verification), while this one
 * owns the shared-fixture contract between the three suites.
 */

const NATIVE = ethers.ZeroAddress;
const ANY = "0x0000000000000000000000000000000000000001";

function checkArgs({ to, value = 0n, data = "0x", operation = 0, gasPrice = 0n, sender = ethers.ZeroAddress }) {
  return [to, value, data, operation, 0, 0, gasPrice, ethers.ZeroAddress, ethers.ZeroAddress, "0x", sender];
}

describe("SafePolicyGuardV2 — shared policy scenarios", function () {
  let guard, vault, payee, stranger, scenarios;

  before(async () => {
    // The fixtures live in the frontend tree (ESM); a dynamic import is how the other cross-tree
    // gate in this repo reads a shared module from a CommonJS Hardhat test.
    const fixturePath = path.join(
      __dirname, "..", "..", "frontend", "src", "test", "fixtures", "policyScenarios.js",
    );
    ({ FIRST_MATCH_SCENARIOS: scenarios } = await import(pathToFileURL(fixturePath).href));
    expect(scenarios, "the shared scenarios file exports cases").to.be.an("array").that.is.not.empty;
  });

  beforeEach(async () => {
    [vault, payee, stranger] = await ethers.getSigners();
    guard = await (await ethers.getContractFactory("SafePolicyGuardV2")).deploy();
    await guard.waitForDeployment();
  });

  /** Resolve a scenario's symbolic names against this environment's signers. */
  const addressFor = (name) => (name === "payee" ? payee.address : stranger.address);

  /** Turn a scenario rule into the guard's tuple. */
  const toRuleTuple = (r) => ({
    asset: r.asset === "native" ? NATIVE : ANY,
    perTxLimit: ethers.parseEther(r.perTx ?? "0"),
    windowLimit: ethers.parseEther(r.window ?? "0"),
    approvalsRequired: r.approvalsRequired ?? 0,
    banded: r.banded ?? false,
    approvers: (r.approvers ?? []).map(addressFor),
    targets: (r.targets ?? []).map(addressFor),
  });

  it("the shared scenarios describe behaviour this guard actually has", async function () {
    for (const scenario of scenarios) {
      await guard.connect(vault).setRules(scenario.rules.map(toRuleTuple), scenario.cooldown ?? 0);

      for (const attempt of scenario.attempts) {
        const call = guard
          .connect(vault)
          .checkTransaction(...checkArgs({ to: addressFor(attempt.to), value: ethers.parseEther(attempt.amount) }));
        const label = `${scenario.id}: ${attempt.amount} to ${attempt.to}` +
          (attempt.why ? ` — ${attempt.why}` : "");

        if (attempt.allowed) {
          await expect(call, label).to.not.be.reverted;
        } else {
          // `ruleIndex` is the rule that DECIDED: null ⇒ nothing matched; otherwise that rule refused
          // (every refusal in the shared table is a per-tx limit).
          if (attempt.ruleIndex === null) {
            await expect(call, label).to.be.revertedWithCustomError(guard, "NoRuleMatches");
          } else {
            await expect(call, label)
              .to.be.revertedWithCustomError(guard, "RulePerTxExceeded")
              .withArgs(attempt.ruleIndex, NATIVE, ethers.parseEther(attempt.amount), anyValue);
          }
        }
      }
    }
  });
});
