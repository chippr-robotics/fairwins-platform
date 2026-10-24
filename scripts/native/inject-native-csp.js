#!/usr/bin/env node
/**
 * Inject the derived native CSP into the built index.html (spec 102, R7).
 *
 * Run AFTER `vite build` and BEFORE `cap sync` in a native build. The web
 * channel is untouched — nginx keeps serving its header; this edits only the
 * copy of dist/index.html the shells bundle.
 *
 * Usage: node scripts/native/inject-native-csp.js [path/to/dist/index.html]
 */
const fs = require("fs");
const path = require("path");
const { parseNginxCsp, buildNativePolicy, injectMetaCsp } = require("./nativeCsp.js");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const indexPath = process.argv[2] || path.join(REPO_ROOT, "frontend", "dist", "index.html");
const nginxPath = path.join(REPO_ROOT, "frontend", "nginx.conf");

if (!fs.existsSync(indexPath)) {
  console.error(`✖ ${indexPath} does not exist — run the frontend build first.`);
  process.exit(1);
}

const policy = buildNativePolicy(parseNginxCsp(fs.readFileSync(nginxPath, "utf8")));
const updated = injectMetaCsp(fs.readFileSync(indexPath, "utf8"), policy);
fs.writeFileSync(indexPath, updated);
console.log(`✔ native CSP meta injected into ${path.relative(REPO_ROOT, indexPath)}`);
