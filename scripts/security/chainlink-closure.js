#!/usr/bin/env node
/**
 * Re-derive the reachability argument behind the #1520 dismissals.
 *
 * The dismissals claim that no OpenZeppelin code reaches solc through `@chainlink/contracts`. The
 * FIRST draft of that argument said nitro-contracts is "reachable only from `automation/**`", and
 * that is simply false: 16 files in `@chainlink/contracts@1.5.0` import nitro and 11 are outside
 * `automation/`, including `shared/util/ChainSpecificUtil.sol` and three under `functions/` — the
 * two directories this repo does import from. Anyone grepping for nitro under `shared/` would have
 * found a hit and concluded the dismissal was wrong. It was caught by a reviewing agent before any
 * alert carried the text.
 *
 * The correct argument does not mention directories at all, because SOLC READS A CLOSURE. Start at
 * the chainlink files `contracts/` actually imports, follow every import, and see what you reach.
 * The answer is 11 files with NO non-relative imports anywhere in them — a closure that cannot
 * reach `node_modules` reaches neither OpenZeppelin nor nitro, whatever else the package contains.
 *
 * That is a claim about an installed package, so it is checked rather than asserted. An absent
 * package is reported as UNVERIFIED and exits non-zero — it is not evidence of safety (the D-05
 * rule one level down).
 *
 * Usage: node scripts/security/chainlink-closure.js [--json]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PKG = path.join(ROOT, 'node_modules', '@chainlink', 'contracts');
const CONTRACTS = path.join(ROOT, 'contracts');

const IMPORT = /import\s+(?:[\s\S]*?\s+from\s*)?["']([^"']+)["']/g;
const CHAINLINK = /^@chainlink\/contracts\/(.+)$/;

/** Every `@chainlink/contracts/...` specifier appearing anywhere under `contracts/`. */
function chainlinkImportsInContracts(dir = CONTRACTS) {
  const found = new Set();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.sol')) {
        const text = fs.readFileSync(full, 'utf8');
        for (const m of text.matchAll(IMPORT)) if (CHAINLINK.test(m[1])) found.add(m[1]);
      }
    }
  };
  walk(dir);
  return [...found].sort();
}

/**
 * Walk relative imports from the given roots inside the installed package.
 *
 * `external` collects any non-relative specifier reached. That list being EMPTY is the whole
 * proof — it means nothing in the closure can name a package at all.
 */
function closureOf(specs, pkgDir = PKG) {
  const base = path.join(pkgDir);
  const seen = new Set();
  const external = new Set();
  const missing = new Set();
  const stack = specs.map((s) => path.join(base, s.replace(CHAINLINK, '$1')));

  while (stack.length) {
    const file = path.normalize(stack.pop());
    if (seen.has(file)) continue;
    if (!fs.existsSync(file)) { missing.add(path.relative(base, file)); continue; }
    seen.add(file);
    for (const m of fs.readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const spec = m[1];
      if (spec.startsWith('.')) stack.push(path.join(path.dirname(file), spec));
      else external.add(spec);
    }
  }
  return {
    files: [...seen].map((f) => path.relative(base, f)).sort(),
    external: [...external].sort(),
    missing: [...missing].sort(),
  };
}

function analyze() {
  const roots = chainlinkImportsInContracts();
  if (!fs.existsSync(PKG)) {
    return { verified: false, reason: 'node_modules/@chainlink/contracts is not installed', roots };
  }
  const { files, external, missing } = closureOf(roots);
  const text = files.map((f) => fs.readFileSync(path.join(PKG, f), 'utf8')).join('');
  return {
    verified: true,
    roots,
    files,
    external,
    missing,
    mentionsOpenZeppelin: /@openzeppelin/i.test(text),
    mentionsNitro: /nitro-contracts/i.test(text),
  };
}

function main(argv) {
  const res = analyze();
  if (argv.includes('--json')) {
    console.log(JSON.stringify(res, null, 2));
  } else if (!res.verified) {
    console.error(`❌ UNVERIFIED — ${res.reason}.`);
    console.error('   Not the same as verified-clean: run `npm run deps:reinstall` (never `npm install`), then retry.');
    return 1;
  } else {
    console.log(`Roots (${res.roots.length} chainlink imports in contracts/):`);
    for (const r of res.roots) console.log(`  · ${r}`);
    console.log(`\nClosure: ${res.files.length} file(s)`);
    for (const f of res.files) console.log(`  · ${f}`);
    console.log(`\nNon-relative imports anywhere in the closure: ${res.external.length ? res.external.join(', ') : 'NONE'}`);
    console.log(`Mentions @openzeppelin: ${res.mentionsOpenZeppelin}`);
    console.log(`Mentions nitro-contracts: ${res.mentionsNitro}`);
  }
  if (!res.verified) return 1;

  const problems = [];
  if (res.missing.length) problems.push(`unresolved import(s): ${res.missing.join(', ')}`);
  if (res.external.length) problems.push(`closure reaches package(s): ${res.external.join(', ')}`);
  if (res.mentionsOpenZeppelin) problems.push('closure mentions @openzeppelin');
  if (res.mentionsNitro) problems.push('closure mentions nitro-contracts');

  if (problems.length) {
    console.error(`\n❌ The #1520 dismissal argument NO LONGER HOLDS: ${problems.join('; ')}.`);
    console.error('   Alerts dismissed under it were dismissed for a reason that has stopped being true.');
    return 1;
  }
  console.log('\n✅ Closure is self-contained — it cannot reach node_modules, so it reaches no OpenZeppelin.');
  return 0;
}

module.exports = { chainlinkImportsInContracts, closureOf, analyze, PKG };

if (require.main === module) process.exit(main(process.argv.slice(2)));
