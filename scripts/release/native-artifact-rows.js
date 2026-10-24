#!/usr/bin/env node
/**
 * Native channel rows for the release artifact table (spec 102,
 * contracts/release-artifacts.md).
 *
 * The android/ios artifact jobs each write a digest JSON
 * (`{ channel, artifact, sha256, signed }`); this script folds every digest
 * file found under --digests into a markdown section appended to the
 * artifacts table BEFORE the changelog is generated — so a record row exists
 * exactly when its artifact was built (the workflow's `needs` ordering is
 * what guarantees "…and smoked": the release job does not run at all unless
 * every native build and smoke job passed).
 *
 * Usage:
 *   node scripts/release/native-artifact-rows.js \
 *     --digests <dir> --version vX.Y.Z --append artifacts.md
 */
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = { digests: null, version: null, append: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--digests") args.digests = argv[++i];
    else if (argv[i] === "--version") args.version = argv[++i];
    else if (argv[i] === "--append") args.append = argv[++i];
    else {
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  if (!args.digests || !args.version || !args.append) {
    console.error("Usage: native-artifact-rows.js --digests <dir> --version vX.Y.Z --append <artifacts.md>");
    process.exit(2);
  }
  return args;
}

function collectDigests(dir) {
  const found = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".digest.json")) found.push(JSON.parse(fs.readFileSync(full, "utf8")));
    }
  };
  walk(dir);
  return found.sort((a, b) => a.channel.localeCompare(b.channel));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const digests = collectDigests(args.digests);
  if (digests.length === 0) {
    console.error(`✖ No *.digest.json under ${args.digests} — the native artifact jobs did not hand ` +
      "anything over. A release with native channels enabled must not publish a record without them.");
    process.exit(1);
  }
  for (const d of digests) {
    for (const key of ["channel", "artifact", "sha256", "signed"]) {
      if (!(key in d)) {
        console.error(`✖ digest for ${d.channel || "?"} is missing "${key}"`);
        process.exit(1);
      }
    }
  }
  const lines = [
    "",
    `### Native channel artifacts (${args.version})`,
    "",
    "| Channel | Artifact | SHA-256 | Signed |",
    "|---|---|---|---|",
    ...digests.map((d) => `| ${d.channel} | \`${d.artifact}\` | \`${d.sha256}\` | ${d.signed ? "yes" : "no — operator signing ceremony (see docs/runbooks/native-release-operations.md)"} |`),
    "",
  ];
  fs.appendFileSync(args.append, lines.join("\n"));
  console.log(`✔ appended ${digests.length} native artifact row(s) to ${args.append}`);
}

if (require.main === module) {
  main();
}

module.exports = { collectDigests };
