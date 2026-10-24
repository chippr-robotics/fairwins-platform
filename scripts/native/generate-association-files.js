#!/usr/bin/env node
/**
 * Platform association files (spec 102, R3 + R5).
 *
 * The tenant's web origin proves the native apps' identity to both OSes by
 * serving two static documents:
 *
 *   /.well-known/apple-app-site-association   (no extension, JSON body)
 *     - `webcredentials`: lets the iOS app run passkey ceremonies for the
 *       tenant domain (same passkey on web and native — FR-003).
 *     - `applinks`: routes Universal Links into the app (Story 5).
 *   /.well-known/assetlinks.json
 *     - `handle_all_urls`: Android App Links.
 *     - `get_login_creds`: Credential Manager passkeys for the domain.
 *
 * App ids come from the tenant manifest. The OPERATOR-HELD halves — the Apple
 * Team ID and the Android signing-cert SHA-256 fingerprints — are passed as
 * flags (they are identity of real store credentials and never live in the
 * repo); without them the output carries loud REPLACE-ME placeholders that
 * both platforms will reject, so a template can never accidentally serve as
 * a live grant. Deployment is the operator ceremony in
 * docs/runbooks/native-release-operations.md.
 *
 * Usage:
 *   node scripts/native/generate-association-files.js --out <dir> \
 *     [--tenant <id>] [--team-id <APPLE_TEAM_ID>] \
 *     [--android-cert-sha256 <AA:BB:...>[,<...>]]
 */
const fs = require("fs");
const path = require("path");
const { loadNativeIdentity } = require("./sync-native-config.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function parseArgs(argv) {
  // --out is REQUIRED: defaulting into frontend/public/ would ship
  // placeholder association files with the web bundle, and a placeholder
  // served from the live origin is noise at best and a broken grant at worst.
  const args = {
    tenant: process.env.VITE_TENANT_ID || "fairwins",
    teamId: null,
    certs: [],
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--tenant") args.tenant = argv[++i];
    else if (argv[i] === "--team-id") args.teamId = argv[++i];
    else if (argv[i] === "--android-cert-sha256") args.certs = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (argv[i] === "--out") args.out = path.resolve(argv[++i]);
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return args;
}

function buildAssociationFiles({ native, teamId, certs }) {
  const appleAppId = `${teamId || "REPLACE-ME-TEAM-ID"}.${native.ios.appId}`;
  const fingerprints = certs.length > 0 ? certs : ["REPLACE-ME-UPLOAD-KEY-SHA256"];
  return {
    "apple-app-site-association": {
      applinks: {
        apps: [],
        details: [{ appIDs: [appleAppId], components: [{ "/": "*" }] }],
      },
      webcredentials: { apps: [appleAppId] },
    },
    "assetlinks.json": [
      {
        relation: [
          "delegate_permission/common.handle_all_urls",
          "delegate_permission/common.get_login_creds",
        ],
        target: {
          namespace: "android_app",
          package_name: native.android.appId,
          sha256_cert_fingerprints: fingerprints,
        },
      },
    ],
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.out) {
    console.error("✖ --out <dir> is required (never generated into the shipped web tree).");
    process.exit(2);
  }
  const native = loadNativeIdentity(args.tenant);
  const files = buildAssociationFiles({ native, teamId: args.teamId, certs: args.certs });

  fs.mkdirSync(args.out, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(args.out, name);
    fs.writeFileSync(target, JSON.stringify(body, null, 2) + "\n");
    console.log(`✔ wrote ${path.relative(REPO_ROOT, target)}`);
  }
  if (!args.teamId || args.certs.length === 0) {
    console.log(
      "NOTE: output contains REPLACE-ME placeholders (missing --team-id and/or " +
      "--android-cert-sha256). Both platforms reject placeholder files, so these " +
      "are templates — the operator ceremony fills and deploys them " +
      "(docs/runbooks/native-release-operations.md)."
    );
  }
}

if (require.main === module) {
  main();
}

module.exports = { buildAssociationFiles };
