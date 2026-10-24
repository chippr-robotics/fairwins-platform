// Spec 104 — the tenant `assistant-byok` feature and `settings.assistant`
// block, with must-fail fixtures.
//
// Same convention as native-block.test.js: a rule is proven by a fixture the
// validator must REJECT, because a gate that enforces nothing and a gate that
// enforces everything look identical from outside.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { validateManifest } = require("../validate-tenant-manifest.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function loadCatalog() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "tenants", "features.json"), "utf8"));
}

function loadFeatures() {
  return new Set(loadCatalog().features);
}

function fairwinsManifest() {
  return JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "tenants", "fairwins", "manifest.json"), "utf8")
  );
}

test("the catalog declares assistant-byok and fairwins enables it", () => {
  const catalog = loadCatalog();
  assert.ok(catalog.features.includes("assistant-byok"));
  assert.ok(catalog.features.includes("assistant"));
  assert.ok(fairwinsManifest().settings.features.includes("assistant-byok"));
  assert.deepEqual(validateManifest("fairwins", fairwinsManifest(), loadFeatures()), []);
});

test("a manifest WITHOUT settings.assistant stays valid — absence means the plain signup link", () => {
  const manifest = fairwinsManifest();
  delete manifest.settings.assistant;
  assert.deepEqual(validateManifest("fairwins", manifest, loadFeatures()), []);
});

test("a well-formed referral code on a tenant that offers the rail is accepted", () => {
  const manifest = fairwinsManifest();
  manifest.settings.assistant = { guttertokenReferralCode: "FAIRWINS-2026_a" };
  assert.deepEqual(validateManifest("fairwins", manifest, loadFeatures()), []);
});

test("MUST-FAIL: assistant-byok without assistant is rejected", () => {
  const manifest = fairwinsManifest();
  manifest.settings.features = manifest.settings.features.filter((f) => f !== "assistant");
  const errors = validateManifest("fairwins", manifest, loadFeatures());
  assert.ok(errors.some((e) => /"assistant-byok" requires "assistant"/.test(e)), errors.join("\n"));
});

test("MUST-FAIL: a referral code that could carry a query string or path is rejected", () => {
  for (const bad of ["abc?utm=1", "a/b", "", "x".repeat(65), 42]) {
    const manifest = fairwinsManifest();
    manifest.settings.assistant = { guttertokenReferralCode: bad };
    const errors = validateManifest("fairwins", manifest, loadFeatures());
    assert.ok(
      errors.some((e) => /guttertokenReferralCode must match/.test(e)),
      `expected rejection of ${JSON.stringify(bad)}:\n${errors.join("\n")}`
    );
  }
});

test("MUST-FAIL: a referral code on a tenant that does not offer the rail is dead config", () => {
  const manifest = fairwinsManifest();
  manifest.settings.features = manifest.settings.features.filter((f) => f !== "assistant-byok");
  manifest.settings.assistant = { guttertokenReferralCode: "FAIRWINS" };
  const errors = validateManifest("fairwins", manifest, loadFeatures());
  assert.ok(errors.some((e) => /"assistant-byok" is not enabled/.test(e)), errors.join("\n"));
});

test("MUST-FAIL: an unknown key under settings.assistant is rejected", () => {
  const manifest = fairwinsManifest();
  manifest.settings.assistant = { guttertokenApiKey: "sk-nope" };
  const errors = validateManifest("fairwins", manifest, loadFeatures());
  assert.ok(errors.some((e) => /unknown key "guttertokenApiKey"/.test(e)), errors.join("\n"));
});
