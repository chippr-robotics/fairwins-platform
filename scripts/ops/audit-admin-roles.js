#!/usr/bin/env node
/**
 * scripts/ops/audit-admin-roles.js — who holds privileged roles, across every chain, right now.
 *
 * WHY THIS EXISTS. The admin-authority claims in this repo were wrong in both directions for
 * months: `hardhat.config.js` once said the migration was finished (it was not), was corrected to
 * "~260 (contract, role) pairs across eight chains" (overstated by more than two orders of
 * magnitude), and issue #966 planned against that number. Neither figure had been measured. The
 * fix is not a better comment — it is a command anyone can re-run, so the record can be checked
 * instead of believed.
 *
 * READ-ONLY BY CONSTRUCTION. `view` calls only, over PUBLIC RPCs. It takes no key, needs no secret
 * profile, and has no code path that sends a transaction — so it is safe to run at any time, by
 * anyone, including while a handoff is half-done. That is the point: an auditor you hesitate to run
 * is an auditor nobody runs.
 *
 * THREE STATES, NEVER TWO. A role read that FAILS is reported `unknown`, never `not held`. This is
 * the estate rule from spec 071 and it matters more here than almost anywhere else: rendering an
 * unreachable chain as "the old Safe holds nothing" would report a completed handoff that never
 * happened. Any chain with an unknown is named, and the totals are labelled partial.
 *
 * Usage:
 *   node scripts/ops/audit-admin-roles.js                # every chain
 *   node scripts/ops/audit-admin-roles.js --chain 137    # one chain
 *   node scripts/ops/audit-admin-roles.js --json         # machine-readable
 *
 * Deliberately dependency-free beyond `ethers`, which the repo already has (spec 097 rule 2: an npm
 * dependency added here re-resolves the root lockfile and drops the platform rolldown binary).
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..", "..");
const DEFAULT_ADMIN_ROLE = "0x" + "00".repeat(32);

/** Accounts whose authority we care about. Read from the record so this cannot drift from it. */
function principals() {
  const safe = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "admin-safe.json"), "utf8"));
  return {
    "deploy EOA": "0x52502d049571C7893447b86c4d8B38e6184bF6e1",
    "current Safe": safe.chains["137"].address,
    "superseded Safe": safe.superseded.address,
  };
}

/** Same MANAGED list as transfer-roles.js — the two must agree on what "managed" means. */
const MANAGED = [
  ["feeRouter", "FeeRouter"], ["bridgeRouter", "BridgeRouter"], ["liquidityRouter", "LiquidityRouter"],
  ["stakingRouter", "StakingRouter"], ["wagerRegistry", "WagerRegistry"], ["membershipManager", "MembershipManager"],
  ["callsignRegistry", "CallsignRegistry"], ["wagerPoolFactory", "WagerPoolFactory"],
  ["fundingPoolFactory", "FundingPoolFactory"], // spec 103 (#1410); absent until deployed
];

/**
 * Public endpoints, with a second provider behind each. A single public RPC going dark would
 * otherwise turn a whole chain `unknown` — honest, but useless.
 */
const CHAINS = [
  { id: 1, file: "mainnet-chain1-v2.json", rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"] },
  { id: 10, file: "optimism-chain10-v2.json", rpcs: ["https://optimism-rpc.publicnode.com", "https://optimism.drpc.org"] },
  { id: 61, file: "etc-chain61-v2.json", rpcs: ["https://etc.rivet.link", "https://etc.etcdesktop.com"] },
  { id: 63, file: "mordor-chain63-v2.json", rpcs: ["https://rpc.mordor.etccooperative.org", "https://geth-mordor.etc-network.info"] },
  { id: 137, file: "polygon-chain137-v2.json", rpcs: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"] },
  { id: 8453, file: "base-chain8453-v2.json", rpcs: ["https://base-rpc.publicnode.com", "https://base.drpc.org"] },
  { id: 42161, file: "arbitrum-chain42161-v2.json", rpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"] },
  { id: 80002, file: "amoy-chain80002-v2.json", rpcs: ["https://polygon-amoy-bor-rpc.publicnode.com", "https://rpc-amoy.polygon.technology"] },
];

/** Locate a compiled artifact by contract name. Roles are discovered from its ABI, never hardcoded. */
function findArtifact(name) {
  const stack = [path.join(ROOT, "artifacts", "contracts")];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === `${name}.json`) return JSON.parse(fs.readFileSync(p, "utf8"));
    }
  }
  return null;
}

/** First RPC that answers eth_chainId with the id we expect. Null if none — the chain is `unknown`. */
async function pickProvider(chain) {
  for (const url of chain.rpcs) {
    try {
      const p = new ethers.JsonRpcProvider(url, chain.id, { staticNetwork: true });
      const net = await p.getNetwork();
      // A wrong chainId here is not a fallback candidate, it is a misconfiguration: reading role
      // state off the wrong chain would be worse than reading none.
      if (Number(net.chainId) === chain.id) return p;
    } catch { /* try the next one */ }
  }
  return null;
}

async function auditChain(chain, who) {
  const out = { chainId: chain.id, reachable: false, rows: [], unknowns: 0, contracts: 0 };
  let record;
  try { record = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", chain.file), "utf8")); }
  catch { out.note = "no deployment record"; return out; }
  const contracts = record.contracts ?? record;

  const provider = await pickProvider(chain);
  if (!provider) { out.note = "no public RPC answered — every row below is UNKNOWN, not clean"; return out; }
  out.reachable = true;

  for (const [key, cname] of MANAGED) {
    const address = contracts[key];
    if (!address) continue;
    const artifact = findArtifact(cname);
    if (!artifact) { out.rows.push({ contract: key, role: "(artifact missing)", holders: "unknown" }); out.unknowns += 1; continue; }
    out.contracts += 1;
    const instance = new ethers.Contract(address, artifact.abi, provider);

    // DEFAULT_ADMIN_ROLE is the zero hash and is ALSO exposed as a getter; dedupe or every row doubles.
    const roles = [["DEFAULT_ADMIN_ROLE", DEFAULT_ADMIN_ROLE]];
    const seen = new Set(["DEFAULT_ADMIN_ROLE"]);
    for (const f of artifact.abi) {
      if (f.type !== "function" || (f.inputs ?? []).length !== 0) continue;
      if (!/^[A-Z0-9_]+_ROLE$/.test(f.name) || seen.has(f.name)) continue;
      if (f.outputs?.length !== 1 || f.outputs[0].type !== "bytes32") continue;
      seen.add(f.name);
      try { roles.push([f.name, await instance[f.name]()]); } catch { /* not readable; skip */ }
    }

    for (const [roleName, roleId] of roles) {
      const holders = {};
      for (const [label, account] of Object.entries(who)) {
        try { holders[label] = await instance.hasRole(roleId, account); }
        catch { holders[label] = null; out.unknowns += 1; } // null = UNKNOWN, never false
      }
      out.rows.push({ contract: key, role: roleName, holders });
    }
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes("--chain") ? Number(args[args.indexOf("--chain") + 1]) : null;
  const asJson = args.includes("--json");
  const who = principals();
  const labels = Object.keys(who);

  const results = [];
  for (const chain of CHAINS) {
    if (only !== null && chain.id !== only) continue;
    results.push(await auditChain(chain, who));
  }

  if (asJson) { console.log(JSON.stringify({ principals: who, results }, null, 2)); return; }

  const totals = Object.fromEntries(labels.map((l) => [l, 0]));
  const partial = [];

  for (const r of results) {
    const held = r.rows.filter((row) => row.holders && Object.values(row.holders).some(Boolean));
    console.log(`\n=== chain ${r.chainId} ===`);
    if (r.note) console.log(`  ${r.note}`);
    if (!r.reachable) { partial.push(r.chainId); continue; }
    if (r.contracts === 0) { console.log("  no managed contracts recorded on this chain"); continue; }
    if (r.unknowns > 0) partial.push(r.chainId);

    for (const row of held) {
      const marks = labels.map((l) => {
        const v = row.holders[l];
        return `${l}=${v === null ? "UNKNOWN" : v ? "YES" : "no"}`;
      }).join("  ");
      console.log(`  ${row.contract.padEnd(20)} ${row.role.padEnd(24)} ${marks}`);
    }
    for (const row of r.rows) {
      for (const l of labels) if (row.holders?.[l] === true) totals[l] += 1;
    }
    if (held.length === 0) console.log("  no privileged role held by any audited principal");
  }

  console.log("\n=== totals: (contract, role) pairs held ===");
  for (const l of labels) console.log(`  ${l.padEnd(18)} ${totals[l]}`);
  if (partial.length) {
    console.log(`\n⚠ PARTIAL — chains ${[...new Set(partial)].join(", ")} had unreadable rows.`);
    console.log("  Totals above are a FLOOR, not a count. Re-run before acting on them.");
  } else {
    console.log("\nEvery audited row was read successfully; totals are complete.");
  }
}

main().catch((e) => { console.error(`audit-admin-roles: ${e.message}`); process.exit(1); });
