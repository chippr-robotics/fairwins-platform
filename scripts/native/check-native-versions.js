#!/usr/bin/env node
/**
 * Regenerate-and-diff gate over the native shells' synced fields (spec 102).
 *
 * Thin wrapper: runs sync-native-config.js in --check mode for the default
 * tenant at the current published version. A hand edit to any synced field
 * (native version numbers, app ids, display names) fails here with the file
 * named — the fix is always to change the SOURCE (tenant manifest or a real
 * release tag) and re-run the sync, never the shell files.
 */
const { spawnSync } = require("child_process");
const path = require("path");

const result = spawnSync(
  process.execPath,
  [path.join(__dirname, "sync-native-config.js"), "--check", ...process.argv.slice(2)],
  { stdio: "inherit" }
);
process.exit(result.status ?? 1);
