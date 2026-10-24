#!/usr/bin/env node
/**
 * Native config sync (spec 102, contracts/release-artifacts.md).
 *
 * Writes EVERY tenant-identity and version field in the native shells from
 * their two sources of truth — the tenant manifest (`tenants/<id>/manifest.json`
 * → `native` block) and the single version source (`scripts/release/version.js`)
 * — so no native version or identity field is ever edited by hand.
 * `check-native-versions.js` runs this in --check mode as the
 * regenerate-and-diff CI gate.
 *
 * Written fields:
 *   frontend/capacitor.config.ts                    appId, appName
 *   frontend/android/app/build.gradle               namespace, applicationId, versionCode, versionName
 *   frontend/android/app/src/main/res/values/strings.xml   app_name, title_activity_main, package_name, custom_url_scheme
 *   frontend/ios/App/App.xcodeproj/project.pbxproj  MARKETING_VERSION, CURRENT_PROJECT_VERSION, PRODUCT_BUNDLE_IDENTIFIER
 *   frontend/ios/App/App/Info.plist                 CFBundleDisplayName
 *
 * Version derivation (one source ⇒ one build number):
 *   versionName / MARKETING_VERSION   = X.Y.Z
 *   versionCode / CURRENT_PROJECT_VERSION = X*1_000_000 + Y*1_000 + Z
 *
 * Usage:
 *   node scripts/native/sync-native-config.js [--tenant <id>] [--version vX.Y.Z] [--check]
 *
 * An unknown tenant, or a tenant without a `native` block, FAILS naming the
 * tenant — identity never falls back to another tenant (spec 072 / FR-007).
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const FRONTEND = path.join(REPO_ROOT, "frontend");

function parseArgs(argv) {
  const args = { tenant: process.env.VITE_TENANT_ID || "fairwins", version: null, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--tenant") args.tenant = argv[++i];
    else if (argv[i] === "--version") args.version = argv[++i];
    else if (argv[i] === "--check") args.check = true;
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return args;
}

function loadNativeIdentity(tenantId) {
  const manifestPath = path.join(REPO_ROOT, "tenants", tenantId, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`✖ Unknown tenant "${tenantId}" — no tenants/${tenantId}/manifest.json. ` +
      `Identity NEVER falls back to another tenant.`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const native = manifest.native;
  if (!native || typeof native !== "object") {
    console.error(`✖ Tenant "${tenantId}" has no \`native\` block in its manifest — it has no ` +
      `native channel. Add the block (see tenants/manifest.schema.json) to enable one.`);
    process.exit(1);
  }
  return native;
}

/** The tenant's primary web domain — the RP id and link host (specs 102 R3/R5). */
function loadTenantDomain(tenantId) {
  const manifestPath = path.join(REPO_ROOT, "tenants", tenantId, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const domain = manifest?.identity?.domains?.[0];
  if (!domain) {
    console.error(`✖ Tenant "${tenantId}" declares no identity.domains — nothing to associate the apps with.`);
    process.exit(1);
  }
  return domain;
}

function resolveVersion(explicit) {
  const raw = explicit ?? execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "release", "version.js"), "--current"],
    { encoding: "utf8" }
  ).trim();
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw);
  if (!match) {
    console.error(`✖ Cannot resolve a release version (got "${raw}"). Pass --version vX.Y.Z, ` +
      `or run in a clone with release tags — the native shells never invent a version.`);
    process.exit(1);
  }
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return {
    semver: `${major}.${minor}.${patch}`,
    // Monotonic in semver order; bounded (minor/patch < 1000 by construction of the scheme).
    code: major * 1_000_000 + minor * 1_000 + patch,
  };
}

function replaceAll(content, replacements, fileLabel, problems) {
  let updated = content;
  for (const { pattern, replacement, field } of replacements) {
    if (!pattern.test(updated)) {
      problems.push(`${fileLabel}: expected to find ${field} (pattern ${pattern}) — shell layout changed?`);
      continue;
    }
    updated = updated.replace(pattern, replacement);
  }
  return updated;
}

function buildFileEdits({ native, version, domain }) {
  const iosId = native.ios.appId;
  const androidId = native.android.appId;
  const name = native.displayName;

  return [
    {
      file: path.join(FRONTEND, "ios", "App", "App", "App.entitlements"),
      replacements: [
        { field: "applinks domain", pattern: /<string>applinks:[^<]*<\/string>/, replacement: `<string>applinks:${domain}</string>` },
        { field: "webcredentials domain", pattern: /<string>webcredentials:[^<]*<\/string>/, replacement: `<string>webcredentials:${domain}</string>` },
      ],
    },
    {
      file: path.join(FRONTEND, "android", "app", "src", "main", "AndroidManifest.xml"),
      replacements: [
        { field: "app-link host", pattern: /android:scheme="https" android:host="[^"]*"/, replacement: `android:scheme="https" android:host="${domain}"` },
      ],
    },
    {
      file: path.join(FRONTEND, "capacitor.config.ts"),
      replacements: [
        { field: "appId", pattern: /appId: '[^']*'/, replacement: `appId: '${androidId}'` },
        { field: "appName", pattern: /appName: '[^']*'/, replacement: `appName: '${name}'` },
      ],
    },
    {
      file: path.join(FRONTEND, "android", "app", "build.gradle"),
      replacements: [
        { field: "namespace", pattern: /namespace = "[^"]*"/, replacement: `namespace = "${androidId}"` },
        { field: "applicationId", pattern: /applicationId "[^"]*"/, replacement: `applicationId "${androidId}"` },
        { field: "versionCode", pattern: /versionCode \d+/, replacement: `versionCode ${version.code}` },
        { field: "versionName", pattern: /versionName "[^"]*"/, replacement: `versionName "${version.semver}"` },
      ],
    },
    {
      file: path.join(FRONTEND, "android", "app", "src", "main", "res", "values", "strings.xml"),
      replacements: [
        { field: "app_name", pattern: /<string name="app_name">[^<]*<\/string>/, replacement: `<string name="app_name">${name}</string>` },
        { field: "title_activity_main", pattern: /<string name="title_activity_main">[^<]*<\/string>/, replacement: `<string name="title_activity_main">${name}</string>` },
        { field: "package_name", pattern: /<string name="package_name">[^<]*<\/string>/, replacement: `<string name="package_name">${androidId}</string>` },
        { field: "custom_url_scheme", pattern: /<string name="custom_url_scheme">[^<]*<\/string>/, replacement: `<string name="custom_url_scheme">${androidId}</string>` },
      ],
    },
    {
      file: path.join(FRONTEND, "ios", "App", "App.xcodeproj", "project.pbxproj"),
      replacements: [
        { field: "MARKETING_VERSION", pattern: /MARKETING_VERSION = [^;]+;/g, replacement: `MARKETING_VERSION = ${version.semver};` },
        { field: "CURRENT_PROJECT_VERSION", pattern: /CURRENT_PROJECT_VERSION = [^;]+;/g, replacement: `CURRENT_PROJECT_VERSION = ${version.code};` },
        { field: "PRODUCT_BUNDLE_IDENTIFIER", pattern: /PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, replacement: `PRODUCT_BUNDLE_IDENTIFIER = ${iosId};` },
      ],
    },
    {
      file: path.join(FRONTEND, "ios", "App", "App", "Info.plist"),
      replacements: [
        {
          field: "CFBundleDisplayName",
          pattern: /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/,
          replacement: `$1${name}$2`,
        },
      ],
    },
  ];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const native = loadNativeIdentity(args.tenant);
  const domain = loadTenantDomain(args.tenant);
  const version = resolveVersion(args.version);
  const problems = [];
  const drifted = [];

  for (const { file, replacements } of buildFileEdits({ native, version, domain })) {
    const label = path.relative(REPO_ROOT, file);
    if (!fs.existsSync(file)) {
      problems.push(`${label}: missing — run \`npx cap add\` for the platform first`);
      continue;
    }
    const current = fs.readFileSync(file, "utf8");
    const desired = replaceAll(current, replacements, label, problems);
    if (desired === current) continue;
    if (args.check) drifted.push(label);
    else {
      fs.writeFileSync(file, desired);
      console.log(`✔ synced ${label}`);
    }
  }

  if (problems.length > 0) {
    for (const message of problems) console.error(`✖ ${message}`);
    process.exit(1);
  }
  if (args.check) {
    if (drifted.length > 0) {
      console.error(`✖ Native config drift for tenant "${args.tenant}" @ v${version.semver} — ` +
        `these files do not match what sync-native-config.js would write (hand edit?):`);
      for (const label of drifted) console.error(`    - ${label}`);
      console.error(`  Fix: node scripts/native/sync-native-config.js --tenant ${args.tenant}` +
        (args.version ? ` --version v${version.semver}` : ""));
      process.exit(1);
    }
    console.log(`✔ native config matches tenant "${args.tenant}" @ v${version.semver}`);
    return;
  }
  console.log(`Done — tenant "${args.tenant}", version ${version.semver} (build ${version.code}).`);
}

if (require.main === module) {
  main();
}

module.exports = { resolveVersion, buildFileEdits, loadNativeIdentity, loadTenantDomain };
