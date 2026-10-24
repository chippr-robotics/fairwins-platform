/**
 * Hand AccessControl roles from the deployer EOA to the admin multisig — grant, verify, renounce.
 *
 * This is the one script in the repo that can permanently destroy control of a contract, so its
 * shape is dictated by that:
 *
 *   1. GRANT and RENOUNCE are SEPARATE COMMANDS. Never one run. An operator grants, walks away,
 *      verifies independently, and only then renounces. A single "migrate" verb that did both would
 *      make a bad grant unrecoverable in the same breath that created it.
 *   2. RENOUNCE re-reads the chain first and refuses unless the multisig VERIFIABLY holds the role
 *      right now. It does not trust the grant step's own output, this script's earlier run, or the
 *      deployment record.
 *   3. The multisig must have BYTECODE on the target chain. Granting admin to an address that is a
 *      Safe on one chain and nothing on another is the classic way to brick a contract forever.
 *   4. Nothing runs without CONFIRM=<network>. There is no interactive prompt to fat-finger past.
 *
 * The ordering hazard this script also guards (issue #966): renouncing DEFAULT_ADMIN_ROLE on the
 * FeeRouter before the routers have registered their fee services leaves live routers that revert
 * ServiceUnknown on every member action, with no admin left to fix it. `renounce` refuses to touch
 * the FeeRouter while any known service is unregistered.
 *
 * Usage:
 *   npx hardhat run scripts/ops/transfer-roles.js --network <net>                 # plan (read-only)
 *   MODE=grant    CONFIRM=<net> npx hardhat run scripts/ops/transfer-roles.js --network <net>
 *   MODE=renounce CONFIRM=<net> npx hardhat run scripts/ops/transfer-roles.js --network <net>
 *
 *   ONLY=feeRouter,bridgeRouter   restrict to specific contracts
 *   MULTISIG=0x…                  override the admin Safe from deployments/admin-safe.json
 */
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;
const { getDeploymentFilename } = require("../deploy/lib/helpers");
const { LAUNCH_FEE_SERVICES } = require("../deploy/lib/feeServices");

const ROOT = path.join(__dirname, "..", "..");

/**
 * Contracts whose roles we manage, and the artifact to read their role ids from. A contract absent
 * from the network's deployment record is skipped, not an error — not every chain hosts every one.
 */
const MANAGED = [
  { key: "feeRouter", contract: "FeeRouter" },
  { key: "bridgeRouter", contract: "BridgeRouter" },
  { key: "liquidityRouter", contract: "LiquidityRouter" },
  { key: "stakingRouter", contract: "StakingRouter" },
  { key: "wagerRegistry", contract: "WagerRegistry" },
  { key: "membershipManager", contract: "MembershipManager" },
  { key: "callsignRegistry", contract: "CallsignRegistry" },
  { key: "wagerPoolFactory", contract: "WagerPoolFactory" },
  // spec 103 (#1410). deploy-funding-pool-factory.js now initialises with the chain's admin Safe
  // (#966), so a fresh deploy needs no handoff; factories deployed before that, or with
  // POOL_ADMIN=deployer, hold a deployer admin and need the same handoff as the rest.
  { key: "fundingPoolFactory", contract: "FundingPoolFactory" },
];

/** Every `X_ROLE()` view a contract exposes — so a new role cannot be silently left behind. */
async function discoverRoles(instance) {
  const roles = [];
  for (const f of instance.interface.fragments) {
    if (f.type !== "function" || f.inputs.length !== 0) continue;
    if (!/^[A-Z0-9_]+_ROLE$/.test(f.name)) continue;
    if (f.outputs?.length !== 1 || f.outputs[0].type !== "bytes32") continue;
    roles.push({ name: f.name, id: await instance[f.name]() });
  }
  return roles;
}

function loadMultisig(chainId) {
  if (process.env.MULTISIG) {
    if (!ethers.isAddress(process.env.MULTISIG)) throw new Error(`MULTISIG=${process.env.MULTISIG} is not an address`);
    return ethers.getAddress(process.env.MULTISIG);
  }
  const file = path.join(ROOT, "deployments", "admin-safe.json");
  if (!fs.existsSync(file)) throw new Error("no deployments/admin-safe.json and no MULTISIG= override");
  const rec = JSON.parse(fs.readFileSync(file, "utf8"));
  const entry = rec.chains?.[String(chainId)];
  if (!entry?.address) throw new Error(`admin-safe.json has no entry for chain ${chainId}`);
  return ethers.getAddress(entry.address);
}

/** The FeeRouter ordering hazard — renouncing here while a service is unregistered strands members. */
async function feeRouterServicesComplete(feeRouterAddress) {
  const fr = await ethers.getContractAt("FeeRouter", feeRouterAddress);
  const missing = [];
  const known = [...LAUNCH_FEE_SERVICES, { label: "bridge.transfer" }, { label: "liquidity.deposit" }];
  for (const svc of known) {
    const id = ethers.keccak256(ethers.toUtf8Bytes(svc.label));
    const s = await fr.getService(id).catch(() => null);
    if (!s || Number(s.kind) === 0) missing.push(svc.label);
  }
  return missing;
}

async function main() {
  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const mode = (process.env.MODE || "plan").toLowerCase();
  const confirmed = process.env.CONFIRM === hre.network.name;

  const [signer] = await ethers.getSigners();
  const multisig = loadMultisig(chainId);

  console.log("=".repeat(66));
  console.log(`Role handoff — chain ${chainId} (${hre.network.name})  MODE=${mode}`);
  console.log("=".repeat(66));
  console.log(`  from (EOA):   ${signer.address}`);
  console.log(`  to (multisig): ${multisig}`);

  // A multisig with no bytecode here cannot ever act. Granting it admin and renouncing would brick
  // every contract on this chain, irreversibly.
  const code = await ethers.provider.getCode(multisig);
  if (code === "0x") {
    throw new Error(
      `${multisig} has NO BYTECODE on chain ${chainId}. Granting it admin here would be unrecoverable. ` +
        `Deploy the Safe on this chain first (scripts/ops/deploy-admin-safe.js).`,
    );
  }
  console.log(`  multisig code: ${(code.length - 2) / 2} bytes ✓`);

  const recordPath = path.join(ROOT, "deployments", getDeploymentFilename(network, "v2"));
  if (!fs.existsSync(recordPath)) throw new Error(`no deployment record at ${recordPath}`);
  const contracts = JSON.parse(fs.readFileSync(recordPath, "utf8")).contracts || {};

  const only = process.env.ONLY ? process.env.ONLY.split(",").map((s) => s.trim()) : null;
  const targets = MANAGED.filter((m) => contracts[m.key] && (!only || only.includes(m.key)));
  if (targets.length === 0) {
    console.log("\nNothing to do: no managed contracts recorded on this chain.");
    return;
  }

  let planned = 0;
  let acted = 0;

  for (const { key, contract } of targets) {
    const address = contracts[key];
    let instance;
    try {
      instance = await ethers.getContractAt(contract, address);
      await instance.DEFAULT_ADMIN_ROLE();
    } catch {
      console.log(`\n${key} (${address}) — not an AccessControl contract, skipping`);
      continue;
    }

    console.log(`\n${key}  ${address}`);
    const roles = await discoverRoles(instance);
    for (const role of roles) {
      const [eoaHas, msHas] = await Promise.all([
        instance.hasRole(role.id, signer.address),
        instance.hasRole(role.id, multisig),
      ]);
      const state = `EOA=${eoaHas ? "yes" : "no "} multisig=${msHas ? "yes" : "no "}`;

      if (mode === "grant") {
        if (msHas) {
          console.log(`  · ${role.name.padEnd(20)} ${state}  already granted`);
          continue;
        }
        if (!eoaHas) {
          console.log(`  · ${role.name.padEnd(20)} ${state}  EOA cannot grant (not a member)`);
          continue;
        }
        planned++;
        if (!confirmed) {
          console.log(`  → ${role.name.padEnd(20)} ${state}  WOULD GRANT`);
          continue;
        }
        await (await instance.grantRole(role.id, multisig)).wait();
        // Re-read: a receipt is not proof the role is held. Retry before concluding failure — a
        // load-balanced RPC can serve this read from a node that has not yet applied the block the
        // receipt came from (seen repeatedly on Base). The GUARANTEE is unchanged: we still refuse
        // to report success on state we have not read back. We just stop mistaking lag for failure.
        let held = false;
        for (let i = 0; i < 10 && !held; i++) {
          held = await instance.hasRole(role.id, multisig);
          if (!held) await new Promise((r) => setTimeout(r, 3000));
        }
        if (!held) {
          throw new Error(
            `${key}.${role.name}: grant transaction mined but the multisig still lacks the role after retries. ` +
              `Check an explorer before re-running — do NOT renounce anything.`,
          );
        }
        acted++;
        console.log(`  ✓ ${role.name.padEnd(20)} granted to multisig`);
      } else if (mode === "renounce") {
        if (!eoaHas) {
          console.log(`  · ${role.name.padEnd(20)} ${state}  nothing to renounce`);
          continue;
        }
        // THE GUARD: never give up a role the multisig does not verifiably hold right now.
        if (!msHas) {
          console.log(`  ✗ ${role.name.padEnd(20)} ${state}  REFUSING — multisig does not hold it. Run MODE=grant first.`);
          continue;
        }
        if (key === "feeRouter" && role.name === "DEFAULT_ADMIN_ROLE") {
          const missing = await feeRouterServicesComplete(address);
          if (missing.length) {
            console.log(
              `  ✗ ${role.name.padEnd(20)} REFUSING — fee services not registered: ${missing.join(", ")}. ` +
                `Renouncing now would leave routers reverting ServiceUnknown with no admin to fix it.`,
            );
            continue;
          }
        }
        planned++;
        if (!confirmed) {
          console.log(`  → ${role.name.padEnd(20)} ${state}  WOULD RENOUNCE`);
          continue;
        }
        await (await instance.renounceRole(role.id, signer.address)).wait();
        acted++;
        console.log(`  ✓ ${role.name.padEnd(20)} renounced by EOA`);
      } else {
        console.log(`  · ${role.name.padEnd(20)} ${state}`);
      }
    }
  }

  console.log("\n" + "=".repeat(66));
  if (mode === "plan") {
    console.log("Read-only plan. Re-run with MODE=grant CONFIRM=<network> to grant.");
  } else if (!confirmed) {
    console.log(`${planned} action(s) planned. Set CONFIRM=${hre.network.name} to execute.`);
  } else {
    console.log(`${acted} action(s) executed.`);
    if (mode === "grant") {
      console.log("NEXT: verify independently, THEN run MODE=renounce. Do not renounce in the same sitting.");
    } else {
      console.log("The EOA no longer holds these roles. The multisig is now the only admin.");
    }
  }
}

main().catch((e) => {
  console.error("\n" + (e.message || e));
  process.exitCode = 1;
});
