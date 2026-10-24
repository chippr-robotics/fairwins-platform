// Spec 102 — the tenant `native` block gate, with must-fail fixtures.
//
// A gate that enforces nothing and a gate that enforces everything look
// identical from outside (chippr-tf-modules convention), so every rule here is
// proven by a fixture the validator must REJECT.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const {
  validateManifest,
  checkNativeAppIdUniqueness,
} = require("../validate-tenant-manifest.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function loadFeatures() {
  const catalog = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "tenants", "features.json"), "utf8")
  );
  return new Set(catalog.features);
}

function fairwinsManifest() {
  return JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "tenants", "fairwins", "manifest.json"), "utf8")
  );
}

test("the shipped fairwins manifest carries a valid native block", () => {
  const errors = validateManifest("fairwins", fairwinsManifest(), loadFeatures());
  assert.deepEqual(errors, []);
});

test("a manifest WITHOUT a native block stays valid — absence means no native channel", () => {
  const manifest = fairwinsManifest();
  delete manifest.native;
  const errors = validateManifest("fairwins", manifest, loadFeatures());
  assert.deepEqual(errors, []);
});

test("MUST-FAIL: a native block missing a platform appId is rejected", () => {
  const manifest = fairwinsManifest();
  delete manifest.native.android;
  const errors = validateManifest("fairwins", manifest, loadFeatures());
  assert.ok(errors.some((e) => /native\.android\.appId is required/.test(e)), errors.join("\n"));
});

test("MUST-FAIL: a non-reverse-DNS appId is rejected", () => {
  const manifest = fairwinsManifest();
  manifest.native.ios.appId = "not a bundle id";
  const errors = validateManifest("fairwins", manifest, loadFeatures());
  assert.ok(errors.some((e) => /not a valid reverse-DNS app id/.test(e)), errors.join("\n"));
});

test("MUST-FAIL: a native block without displayName or iconSource is rejected", () => {
  const manifest = fairwinsManifest();
  manifest.native.displayName = "  ";
  delete manifest.native.iconSource;
  const errors = validateManifest("fairwins", manifest, loadFeatures());
  assert.ok(errors.some((e) => /native\.displayName is required/.test(e)), errors.join("\n"));
  assert.ok(errors.some((e) => /native\.iconSource is required/.test(e)), errors.join("\n"));
});

test("MUST-FAIL: two TENANTS claiming one appId collide; one tenant on both platforms does not", () => {
  const shared = {
    native: {
      ios: { appId: "app.example.member" },
      android: { appId: "app.example.member" },
      displayName: "X",
      iconSource: "icons/",
    },
  };
  // Same tenant, both platforms: fine — that is fairwins' own shape.
  assert.deepEqual(checkNativeAppIdUniqueness([{ id: "a", manifest: shared }]), []);

  const collisions = checkNativeAppIdUniqueness([
    { id: "a", manifest: shared },
    { id: "b", manifest: shared },
  ]);
  // One message per colliding platform claim — both of b's platforms collide.
  assert.equal(collisions.length, 2);
  for (const message of collisions) assert.match(message, /claimed by both "a" and "b"/);
});
