#!/usr/bin/env node
/**
 * scripts/ops/revoke-stale-admin.js — remove a stale admin (the superseded Safe, the retired deploy
 * EOA) from every role it still holds, executed BY THE CURRENT SAFE.
 *
 * WHY THIS IS NOT A MODE IN transfer-roles.js
 * -------------------------------------------
 * That script's whole shape is "an EOA signer hands its own roles to the Safe": it signs with
 * `ethers.getSigners()[0]` and its only removal verb is `renounceRole`, which is SELF-ONLY. Neither
 * fits here. The executor is a 2-of-3 multisig, the removal is `revokeRole` against a THIRD PARTY,
 * and the ceremony spans several sittings and two different signing devices. Bolting that onto the
 * one script in the repo that can permanently destroy control of a contract would make both harder
 * to reason about, so this is its own tool with its own guards.
 *
 * WHY REVOKE AND NOT RENOUNCE (issue #966)
 * ----------------------------------------
 * The superseded Safe 0x8cc564E3… co-holds 79 (contract, role) pairs — measured 2026-09-01, see
 * `npm run audit:admin-roles` — including UPGRADER_ROLE on every UUPS proxy. Renouncing them would
 * mean executing FROM that Safe, whose owner set includes the compromised deploy EOA: to finish
 * de-risking the compromised key you would first have to use it. The current Safe holds
 * DEFAULT_ADMIN_ROLE on all of them, and in OpenZeppelin AccessControl a role's admin may revoke any
 * account, so it can do this unilaterally and the old Safe's signers are never involved.
 *
 * The retired deploy EOA's one remaining pair (Mordor 63 feeRouter DEFAULT_ADMIN_ROLE) rides the
 * same ceremony for the same reason: `fairwins-deployer-key` is DISABLED in Secret Manager, and
 * re-enabling a retired compromised key to tidy one testnet role would be a poor trade.
 *
 * THE CEREMONY
 * ------------
 *   1. plan     read-only. What would be revoked, in what order, and what remains admin afterwards.
 *   2. build    compute the MultiSend batch and the safeTxHash. Writes a proposal file. No signing.
 *   2b. propose PUBLISH THE PREIMAGE so a UI can show what the hash means (see below).
 *   3. approve  the KMS owner calls approveHash(safeTxHash) on-chain.  ← this tool, 1 of 2
 *   4. (you)    a second owner approves on a Ledger/Trezor.            ← hardware, 2 of 2
 *   5. execute  anyone sends execTransaction with the pre-validated signature bundle.
 *
 * WHY `propose` EXISTS, AND WHY THE SAFE APP CANNOT SEE THESE OTHERWISE
 * --------------------------------------------------------------------
 * This tool is entirely on-chain: it computes a safeTxHash and calls `approveHash`. The Safe web app
 * reads PENDING transactions from Safe's off-chain Transaction Service, which never saw the
 * proposal — so the approvals show up on a block explorer while the app shows nothing at all. The
 * app is not broken and the approvals are not lost; the hash simply has no preimage anywhere it can
 * look, so it cannot render `revokeRole(...) x12` or offer a signature button.
 *
 * Spec 043 already solved this for the same reason (this estate spans chains Safe's service does not
 * cover, e.g. Mordor): `SafeProposalHub` is an on-chain, PERMISSIONLESS log of proposal preimages,
 * and FairWins Protect reads it. `propose` publishes there, after which the batch appears in
 * Protect ▸ On chain and can be approved with a hardware wallet like any other vault proposal.
 * Publishing is safe precisely because it is untrusted: readers recompute the safeTxHash from the
 * preimage and discard a mismatch (lib/custody/proposalHub.js), so a bogus proposal cannot
 * impersonate a real one.
 *
 * Ethereum mainnet has NO hub deployed, so chain 1 cannot use this route.
 *
 * Usage:
 *   node scripts/ops/revoke-stale-admin.js --chain 63 --target superseded
 *   node scripts/ops/revoke-stale-admin.js --chain 63 --target superseded --mode build
 *   node scripts/ops/revoke-stale-admin.js --chain 63 --target superseded --mode approve  --confirm 63
 *   node scripts/ops/revoke-stale-admin.js --chain 63 --target superseded --mode execute  --confirm 63
 *
 *   --target superseded | deployer | 0x…
 *
 * Dependency-free beyond ethers + @google-cloud/kms, both already present (spec 097 rule 2).
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.join(__dirname, "..", "..");
const DEFAULT_ADMIN_ROLE = "0x" + "00".repeat(32);
const CALL = 0;
const DELEGATECALL = 1;

/** Safe 1.4.1 canonical deployments — same addresses on every chain we run on. */
const MULTI_SEND_CALL_ONLY = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";

const SAFE_ABI = [
  "function nonce() view returns (uint256)",
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function isOwner(address) view returns (bool)",
  "function approvedHashes(address,bytes32) view returns (uint256)",
  "function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)",
  "function approveHash(bytes32)",
  "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns (bool)",
];
const ACCESS_ABI = [
  "function hasRole(bytes32,address) view returns (bool)",
  "function getRoleMemberCount(bytes32) view returns (uint256)",
  "function revokeRole(bytes32,address)",
];
const MULTISEND_ABI = ["function multiSend(bytes transactions)"];
const HUB_ABI = ["function propose(address safe,address to,uint256 value,bytes data,uint8 operation,uint256 nonce,bytes32 safeTxHash)"];

const MANAGED = [
  ["feeRouter", "FeeRouter"], ["bridgeRouter", "BridgeRouter"], ["liquidityRouter", "LiquidityRouter"],
  ["stakingRouter", "StakingRouter"], ["wagerRegistry", "WagerRegistry"], ["membershipManager", "MembershipManager"],
  ["callsignRegistry", "CallsignRegistry"], ["wagerPoolFactory", "WagerPoolFactory"],
  // spec 103 (#1410). Deployed with initArgs[0] = deployer, so it lands holding a deployer admin and
  // joins this ceremony rather than needing one of its own.
  ["fundingPoolFactory", "FundingPoolFactory"],
];

const CHAINS = {
  1: { file: "mainnet-chain1-v2.json", rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"] },
  10: { file: "optimism-chain10-v2.json", rpcs: ["https://optimism-rpc.publicnode.com", "https://optimism.drpc.org"] },
  61: { file: "etc-chain61-v2.json", rpcs: ["https://etc.rivet.link", "https://etc.etcdesktop.com"] },
  63: { file: "mordor-chain63-v2.json", rpcs: ["https://rpc.mordor.etccooperative.org", "https://geth-mordor.etc-network.info"] },
  137: { file: "polygon-chain137-v2.json", rpcs: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"] },
  8453: { file: "base-chain8453-v2.json", rpcs: ["https://base-rpc.publicnode.com", "https://base.drpc.org"] },
  42161: { file: "arbitrum-chain42161-v2.json", rpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.drpc.org"] },
  80002: { file: "amoy-chain80002-v2.json", rpcs: ["https://polygon-amoy-bor-rpc.publicnode.com", "https://rpc-amoy.polygon.technology"] },
};

const safeRecord = () => JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", "admin-safe.json"), "utf8"));

function resolveTarget(spec, rec) {
  if (spec === "superseded") return ethers.getAddress(rec.superseded.address);
  if (spec === "deployer") return ethers.getAddress("0x52502d049571C7893447b86c4d8B38e6184bF6e1");
  if (ethers.isAddress(spec)) return ethers.getAddress(spec);
  throw new Error(`--target must be "superseded", "deployer" or an address (got ${spec})`);
}

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

async function pickProvider(chainId) {
  // An operator override, because a public endpoint that answers eth_chainId can still refuse other
  // methods later (publicnode 403s archive requests) — and the only fix in the moment is a different
  // endpoint, not a different tool.
  const urls = process.env.RPC_URL ? [process.env.RPC_URL, ...CHAINS[chainId].rpcs] : CHAINS[chainId].rpcs;
  for (const url of urls) {
    try {
      const p = new ethers.JsonRpcProvider(url, chainId, { staticNetwork: true });
      if (Number((await p.getNetwork()).chainId) === chainId) return p;
    } catch { /* next */ }
  }
  throw new Error(`no public RPC answered for chain ${chainId}`);
}

/**
 * Every (contract, role) the target still holds, ORDERED WITH DEFAULT_ADMIN_ROLE LAST PER CONTRACT.
 *
 * That ordering is load-bearing and is the single easiest way to brick this: DEFAULT_ADMIN_ROLE is
 * the admin OF the other roles, so revoking it first inside the same batch removes the authority the
 * later revokes need, and they revert — leaving the stale holder holding exactly the roles you most
 * wanted gone.
 */
async function planRevocations(provider, chainId, target, safeAddr) {
  const record = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", CHAINS[chainId].file), "utf8"));
  const contracts = record.contracts ?? record;
  const out = [];

  for (const [key, cname] of MANAGED) {
    const address = contracts[key];
    if (!address) continue;
    const artifact = findArtifact(cname);
    if (!artifact) throw new Error(`no compiled artifact for ${cname} — run npm run compile`);
    const inst = new ethers.Contract(address, [...ACCESS_ABI, ...artifact.abi.filter((f) => f.type === "function")], provider);

    const roles = [];
    const seen = new Set(["DEFAULT_ADMIN_ROLE"]);
    for (const f of artifact.abi) {
      if (f.type !== "function" || (f.inputs ?? []).length !== 0) continue;
      if (!/^[A-Z0-9_]+_ROLE$/.test(f.name) || seen.has(f.name)) continue;
      if (f.outputs?.length !== 1 || f.outputs[0].type !== "bytes32") continue;
      seen.add(f.name);
      try { roles.push({ name: f.name, id: await inst[f.name]() }); } catch { /* unreadable */ }
    }
    // DEFAULT_ADMIN_ROLE appended LAST — see the doc comment above.
    roles.push({ name: "DEFAULT_ADMIN_ROLE", id: DEFAULT_ADMIN_ROLE });

    for (const role of roles) {
      let held;
      try { held = await inst.hasRole(role.id, target); }
      catch { throw new Error(`${key}.${role.name}: hasRole read FAILED. Refusing to plan on unknown state.`); }
      if (!held) continue;

      // THE INVARIANT THAT MATTERS MOST: never revoke a role the current Safe does not also hold,
      // or this batch removes the last holder and the contract becomes unadministrable forever.
      const safeHolds = await inst.hasRole(role.id, safeAddr);
      out.push({ key, address, role: role.name, roleId: role.id, safeHolds });
    }
  }
  return out;
}

function proposalPath(chainId, target) {
  const dir = path.join(ROOT, ".safe-proposals");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `revoke-${chainId}-${target.toLowerCase()}.json`);
}

function encodeMultiSend(inner) {
  let packed = "";
  for (const tx of inner) {
    const data = tx.data.slice(2);
    packed += "00"
      + ethers.getAddress(tx.to).slice(2).toLowerCase()
      + ethers.toBeHex(0n, 32).slice(2)
      + ethers.toBeHex(BigInt(data.length / 2), 32).slice(2)
      + data;
  }
  return new ethers.Interface(MULTISEND_ABI).encodeFunctionData("multiSend", ["0x" + packed]);
}

/** Pre-validated ("approved hash") signature bundle: r=owner, s=0, v=1, sorted by owner ascending. */
function approvedHashSignatures(owners) {
  return "0x" + [...owners]
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1))
    .map((o) => ethers.zeroPadValue(o, 32).slice(2) + ethers.toBeHex(0n, 32).slice(2) + "01")
    .join("");
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
  const chainId = Number(arg("--chain"));
  const mode = (arg("--mode", "plan") || "plan").toLowerCase();
  const targetSpec = arg("--target", "superseded");
  const confirmed = arg("--confirm") === String(chainId);

  if (!CHAINS[chainId]) throw new Error(`--chain must be one of ${Object.keys(CHAINS).join(", ")}`);

  const rec = safeRecord();
  const safeAddr = ethers.getAddress(rec.chains[String(chainId)].address);
  const target = resolveTarget(targetSpec, rec);

  if (target.toLowerCase() === safeAddr.toLowerCase()) {
    throw new Error("REFUSING: the target is the CURRENT Safe. This would revoke the estate's own admin.");
  }

  const provider = await pickProvider(chainId);
  const safe = new ethers.Contract(safeAddr, SAFE_ABI, provider);

  if ((await provider.getCode(safeAddr)) === "0x") {
    throw new Error(`the current Safe has NO BYTECODE on chain ${chainId} — it cannot execute anything here`);
  }

  console.log("=".repeat(72));
  console.log(`Revoke stale admin — chain ${chainId}   MODE=${mode}`);
  console.log("=".repeat(72));
  console.log(`  executing Safe: ${safeAddr}`);
  console.log(`  target:         ${target} (${targetSpec})`);

  const plan = await planRevocations(provider, chainId, target, safeAddr);
  if (plan.length === 0) { console.log("\nNothing to revoke: the target holds no managed role on this chain."); return; }

  const unsafe = plan.filter((p) => !p.safeHolds);
  console.log(`\n${plan.length} (contract, role) pair(s) held by the target:\n`);
  for (const p of plan) {
    console.log(`  ${p.key.padEnd(20)} ${p.role.padEnd(24)} ${p.safeHolds ? "safe also holds ✓" : "⚠ SAFE DOES NOT HOLD"}`);
  }
  if (unsafe.length) {
    throw new Error(
      `\nREFUSING: ${unsafe.length} role(s) above are NOT held by the current Safe. Revoking them would `
      + `remove the last holder and leave those roles unadministrable forever. Grant the Safe first.`,
    );
  }
  console.log("\nOrdering: DEFAULT_ADMIN_ROLE is revoked LAST per contract, so each contract keeps the");
  console.log("authority its own remaining revokes need.");

  if (mode === "plan") { console.log("\nRead-only plan. Re-run with --mode build to compute the Safe transaction."); return; }

  // ---- build ------------------------------------------------------------------------------
  const access = new ethers.Interface(ACCESS_ABI);
  const inner = plan.map((p) => ({ to: p.address, data: access.encodeFunctionData("revokeRole", [p.roleId, target]) }));
  const batchData = encodeMultiSend(inner);
  const nonce = await safe.nonce();
  const params = [MULTI_SEND_CALL_ONLY, 0n, batchData, DELEGATECALL, 0n, 0n, 0n, ethers.ZeroAddress, ethers.ZeroAddress, nonce];
  const safeTxHash = await safe.getTransactionHash(...params);

  const file = proposalPath(chainId, target);
  if (mode === "build") {
    fs.writeFileSync(file, JSON.stringify({ chainId, safe: safeAddr, target, nonce: nonce.toString(), safeTxHash, calls: plan.length, params: params.map(String) }, null, 2) + "\n");
    console.log(`\n  Safe nonce:  ${nonce}`);
    console.log(`  safeTxHash:  ${safeTxHash}`);
    console.log(`  proposal:    ${path.relative(ROOT, file)}`);
    console.log(`\n⚠ THE HASH IS PINNED TO NONCE ${nonce}. Any other Safe transaction executed before this one`);
    console.log("  invalidates it — re-run --mode build and re-approve. Approvals do NOT carry over.");

    // Two proposals for the same chain at the same nonce is the likely mistake here: this estate
    // usually has BOTH a superseded Safe and a retired EOA to clear on a chain, and building the
    // second before executing the first silently produces a hash that can never execute. Executing
    // either one bumps the nonce and invalidates the other.
    const siblings = fs.readdirSync(path.dirname(file))
      .filter((f) => f.startsWith(`revoke-${chainId}-`) && f !== path.basename(file))
      .map((f) => JSON.parse(fs.readFileSync(path.join(path.dirname(file), f), "utf8")))
      .filter((s) => s.nonce === nonce.toString());
    if (siblings.length) {
      console.log(`\n⚠ ANOTHER PROPOSAL ON THIS CHAIN IS ALSO PINNED TO NONCE ${nonce}:`);
      for (const s of siblings) console.log(`    target ${s.target}  ${s.safeTxHash}`);
      console.log("  Only ONE of them can ever execute. Execute this one, then re-run --mode build");
      console.log("  for the other(s) so they pin to the new nonce.");
    }
    console.log("\nNEXT: --mode approve --confirm <chain> (KMS owner), then a second owner on hardware.");
    return;
  }

  const threshold = await safe.getThreshold();
  const owners = await safe.getOwners();
  const approvals = [];
  for (const o of owners) if ((await safe.approvedHashes(o, safeTxHash)) === 1n) approvals.push(o);
  console.log(`\n  safeTxHash:  ${safeTxHash}  (nonce ${nonce})`);
  console.log(`  approvals:   ${approvals.length}/${threshold}  ${approvals.map((a) => a.slice(0, 10)).join(" ") || "(none)"}`);

  // ---- propose: publish the preimage so a UI can resolve the hash ---------------------------
  if (mode === "propose") {
    const rp = path.join(ROOT, "deployments", CHAINS[chainId].file);
    const hub = (JSON.parse(fs.readFileSync(rp, "utf8")).contracts ?? {}).safeProposalHub;
    if (!hub) {
      throw new Error(
        `no safeProposalHub recorded on chain ${chainId}, so there is nowhere to publish the preimage. `
        + `Approve this hash directly from the hardware wallet instead (approveHash on the Safe).`,
      );
    }
    const keyName = process.env.KMS_ADMIN_KEY
      || "projects/chippr-bots-site-wp/locations/us-central1/keyRings/fairwins-relayer/cryptoKeys/admin-signer-polygon/cryptoKeyVersions/1";
    const { createKmsTransactionSigner } = require("./lib/kmsSigner");
    const signer = await createKmsTransactionSigner({ keyName, provider });
    const data = new ethers.Interface(HUB_ABI).encodeFunctionData("propose", [
      safeAddr, params[0], params[1], params[2], params[3], params[9], safeTxHash,
    ]);
    console.log(`\n  hub:         ${hub}`);
    if (!confirmed) { console.log(`  WOULD publish the preimage for ${safeTxHash}. Re-run with --confirm ${chainId}.`); return; }
    try {
      const r = await signer.sendTransaction({ to: hub, data });
      console.log(`  ✓ preimage published: ${r.hash ?? r.transactionHash}`);
    } catch (err) {
      // Same reasoning as approve: the receipt poll is not the transaction. There is no cheap
      // on-chain read-back for an event-only call, so this reports honestly rather than guessing.
      console.log(`  send/wait reported: ${String(err.shortMessage || err.message).slice(0, 90)}`);
      console.log("  This may still have landed — propose only emits an event, so there is no state");
      console.log("  to read back. Check the KMS owner's recent transactions before re-sending.");
    }
    console.log("\n  It should now appear in FairWins Protect ▸ On chain for hardware approval.");
    return;
  }

  // ---- approve (KMS) ----------------------------------------------------------------------
  if (mode === "approve") {
    const keyName = process.env.KMS_ADMIN_KEY
      || "projects/chippr-bots-site-wp/locations/us-central1/keyRings/fairwins-relayer/cryptoKeys/admin-signer-polygon/cryptoKeyVersions/1";
    const { createKmsTransactionSigner } = require("./lib/kmsSigner");
    const signer = await createKmsTransactionSigner({ keyName, provider });
    console.log(`  KMS owner:   ${signer.address}`);
    if (!(await safe.isOwner(signer.address))) throw new Error(`${signer.address} is not an owner of this Safe`);

    // GAS PREFLIGHT. approveHash must be sent BY the approving owner, so the KMS key needs native
    // balance on THIS chain. Measured 2026-09-02 it had gas only on Polygon 137 and zero on
    // 1 / 10 / 63 / 8453 / 42161 — so on five of six chains this ceremony stops here. Checked up
    // front because the alternative is an opaque "insufficient funds" from deep inside the signer,
    // which reads like a KMS or IAM fault rather than an empty wallet.
    const bal = await provider.getBalance(signer.address);
    if (bal === 0n) {
      throw new Error(
        `the KMS owner ${signer.address} has ZERO native balance on chain ${chainId} and cannot send `
        + `approveHash. Fund it, or have TWO hardware owners approve instead — the KMS key is only `
        + `needed for gas when it is one of the approvers.`,
      );
    }
    console.log(`  KMS balance: ${ethers.formatEther(bal)} (native)`);
    if (approvals.some((a) => a.toLowerCase() === signer.address.toLowerCase())) { console.log("\nAlready approved by the KMS owner. Nothing to do."); return; }
    if (!confirmed) { console.log(`\nWOULD approveHash(${safeTxHash}). Re-run with --confirm ${chainId}.`); return; }

    // A FAILED WAIT IS NOT A FAILED TRANSACTION, and conflating them is the more dangerous mistake.
    // Measured on Optimism: publicnode broadcast the approveHash fine and then answered the receipt
    // poll with `403 Archive requests require a personal token`. The tool reported an error for an
    // operation that had ALREADY SUCCEEDED — which sends an operator to re-run, or worse, to
    // conclude the ceremony is stuck when it is one hardware signature from done. The chain's
    // `approvedHashes` is the truth here, not the receipt, so ask it before believing the error.
    try {
      const receipt = await signer.sendTransaction({ to: safeAddr, data: new ethers.Interface(SAFE_ABI).encodeFunctionData("approveHash", [safeTxHash]) });
      console.log(`\n  ✓ approveHash mined: ${receipt.hash ?? receipt.transactionHash}`);
    } catch (err) {
      process.stdout.write(`\n  send/wait reported: ${String(err.shortMessage || err.message).slice(0, 90)}\n`);
      process.stdout.write("  checking the chain before concluding anything");
      let approved = false;
      for (let i = 0; i < 10 && !approved; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        process.stdout.write(".");
        try { approved = (await safe.approvedHashes(signer.address, safeTxHash)) === 1n; } catch { /* keep polling */ }
      }
      console.log("");
      if (!approved) {
        throw new Error(
          `approveHash did NOT land (approvedHashes still 0 after retries). The error above was real. `
          + `Check the KMS owner's transaction count before re-running.`,
        );
      }
      console.log("  ✓ approveHash DID land — the error was the receipt poll, not the transaction.");
    }
    console.log(`\nNEXT: a second owner approves on hardware, then --mode execute --confirm ${chainId}.`);
    return;
  }

  // ---- execute ----------------------------------------------------------------------------
  if (mode === "execute") {
    if (BigInt(approvals.length) < threshold) {
      throw new Error(`only ${approvals.length}/${threshold} owners have approved this hash. Collect the remaining approval(s) first.`);
    }
    if (!confirmed) { console.log(`\nWOULD execTransaction with ${approvals.length} pre-validated approvals. Re-run with --confirm ${chainId}.`); return; }
    const keyName = process.env.KMS_ADMIN_KEY
      || "projects/chippr-bots-site-wp/locations/us-central1/keyRings/fairwins-relayer/cryptoKeys/admin-signer-polygon/cryptoKeyVersions/1";
    const { createKmsTransactionSigner } = require("./lib/kmsSigner");
    const signer = await createKmsTransactionSigner({ keyName, provider });
    const sigs = approvedHashSignatures(approvals.slice(0, Number(threshold)));
    const data = new ethers.Interface(SAFE_ABI).encodeFunctionData("execTransaction", [...params.slice(0, 9), sigs]);
    const receipt = await signer.sendTransaction({ to: safeAddr, data });
    console.log(`\n  execTransaction mined: ${receipt.hash ?? receipt.transactionHash}`);

    // A receipt is not proof. execTransaction returns false on inner failure rather than reverting,
    // so the ONLY honest confirmation is re-reading every role off the chain.
    let remaining = 0;
    for (const p of plan) {
      const inst = new ethers.Contract(p.address, ACCESS_ABI, provider);
      if (await inst.hasRole(p.roleId, target)) { remaining += 1; console.log(`  ✗ STILL HELD: ${p.key}.${p.role}`); }
    }
    console.log(remaining === 0
      ? `\n  ✓ verified: the target holds none of the ${plan.length} roles on chain ${chainId}.`
      : `\n  ⚠ ${remaining} role(s) still held — the batch did not fully apply. Do NOT assume success.`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return;
  }

  throw new Error(`unknown --mode ${mode} (plan | build | propose | approve | execute)`);
}

main().catch((e) => { console.error("\n" + (e.message || e)); process.exitCode = 1; });
