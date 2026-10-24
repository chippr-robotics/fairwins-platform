#!/usr/bin/env node

const fs = require('fs')
const path = require('path')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--network') out.network = argv[++i]
    else if (a === '--chainId') out.chainId = Number(argv[++i])
    else if (a === '--deploymentFile') out.deploymentFile = argv[++i]
    else if (a === '--contractsFile') out.contractsFile = argv[++i]
    else if (a === '--tenant') out.tenant = argv[++i]
  }
  return out
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}


function findDeploymentFile({ deploymentsDir, network, chainId }) {
  // Prefer v2 file (P2P betting architecture)
  const v2 = path.join(deploymentsDir, `${network}-chain${chainId}-v2.json`)
  if (fs.existsSync(v2)) return v2

  const explicit = path.join(deploymentsDir, `${network}-chain${chainId}-deterministic-deployment.json`)
  if (fs.existsSync(explicit)) return explicit

  const fallback = path.join(deploymentsDir, `${network}-deployment.json`)
  if (fs.existsSync(fallback)) return fallback

  // As a last resort, pick newest file that matches the network prefix.
  const files = fs
    .readdirSync(deploymentsDir)
    .filter((f) => f.startsWith(`${network}-`) && f.endsWith('.json'))
    .map((f) => path.join(deploymentsDir, f))

  if (files.length === 0) return null

  files.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs
    } catch {
      return 0
    }
  })

  return files[0]
}

/**
 * Optionally scope a regex update to a named block (e.g. AMOY_CONTRACTS = { ... }).
 * If blockName is null, behaves as before (updates first occurrence anywhere).
 */
function updateObjectLiteralValue(source, key, newValueLiteral, blockName = null) {
  if (blockName) {
    // Find the named block and constrain the update to its body.
    const blockStartRe = new RegExp(`(?:const|let|var)\\s+${blockName}\\s*=\\s*\\{`)
    const startMatch = blockStartRe.exec(source)
    if (!startMatch) {
      throw new Error(`Block ${blockName} not found in contracts file`)
    }
    const bodyStart = startMatch.index + startMatch[0].length
    // Find matching closing brace by depth tracking
    let depth = 1
    let bodyEnd = bodyStart
    for (let i = bodyStart; i < source.length; i++) {
      const c = source[i]
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) { bodyEnd = i; break }
      }
    }
    const before = source.slice(0, bodyStart)
    const block = source.slice(bodyStart, bodyEnd)
    const after = source.slice(bodyEnd)

    // Trailing `// comment` after the value must be tolerated, else the `$`
    // anchor fails to match and the key is wrongly treated as missing → a
    // duplicate gets inserted (e.g. sanctionsGuard/polymarketAdapter).
    const re = new RegExp(`(^\\s*${key}\\s*:\\s*)([^,\\n]+)(\\s*,?)(\\s*\\/\\/[^\\n]*)?$`, 'm')
    if (re.test(block)) {
      const updated = block.replace(re, `$1${newValueLiteral}$3$4`)
      return before + updated + after
    }
    // Insert at end of block (before closing brace)
    const line = `  ${key}: ${newValueLiteral},\n`
    return before + block + line + after
  }

  // Matches: <spaces>key: <value>,  (optionally followed by a // comment, which
  // must be tolerated so the key isn't treated as missing and re-inserted).
  // key is assumed to be a simple identifier (no quotes) as used in contracts.js.
  const re = new RegExp(`(^\\s*${key}\\s*:\\s*)([^,\\n]+)(\\s*,?)(\\s*\\/\\/[^\\n]*)?$`, 'm')
  if (re.test(source)) {
    return source.replace(re, `$1${newValueLiteral}$3$4`)
  }

  // Insert before closing brace of DEPLOYED_CONTRACTS.
  const insertionPoint = source.indexOf('}\n\n/**')
  if (insertionPoint === -1) {
    throw new Error(`Could not find insertion point to add ${key} in contracts.js`)
  }

  const before = source.slice(0, insertionPoint)
  const after = source.slice(insertionPoint)
  const line = `  ${key}: ${newValueLiteral},\n`
  return `${before}${line}${after}`
}

/**
 * chainId → the name of that chain's contracts block in contracts.js.
 *
 * This table MUST cover every chain in `NETWORK_CONTRACTS` (frontend/src/config/contracts.js).
 * An unmapped chain is not a harmless gap — it is a silent cross-chain corruption. With a null
 * blockName, `updateObjectLiteralValue` rewrites the FIRST `key:` line anywhere in the file, and
 * the first block in contracts.js is MORDOR_CONTRACTS. So before this table covered chain 1,
 * syncing an Ethereum-mainnet record wrote Ethereum's `bridgeRouter`/`liquidityRouter` addresses
 * into the MORDOR block and left ETHEREUM_CONTRACTS empty: the frontend then handed Mordor users
 * a contract address that only exists on chain 1, and the chain it was actually deployed on still
 * read as undeployed. Nothing failed; the sync printed "Synced".
 *
 * Hence `resolveBlockName()` below refuses instead of falling back whenever the file uses the
 * per-chain layout. Add a chain here AND add its block to contracts.js — one without the other is
 * caught, loudly, at sync time.
 */
const CHAIN_BLOCK_NAMES = {
  1: 'ETHEREUM_CONTRACTS', // spec 067 — router-only control-plane network
  10: 'OPTIMISM_CONTRACTS', // spec 067 — router-only control-plane network
  61: 'ETC_CONTRACTS', // Ethereum Classic mainnet (hardhat network `etc`)
  63: 'MORDOR_CONTRACTS',
  137: 'POLYGON_CONTRACTS',
  8453: 'BASE_CONTRACTS', // spec 067 — router-only control-plane network
  42161: 'ARBITRUM_CONTRACTS', // spec 067 — router-only control-plane network
  80002: 'AMOY_CONTRACTS',
  1337: 'HARDHAT_CONTRACTS',
  31337: 'HARDHAT_CONTRACTS',
}

function blockNameForChain(chainId) {
  return CHAIN_BLOCK_NAMES[chainId] || null
}

/**
 * Does this contracts file use the per-chain block layout, or the older flat single-network one
 * (`export const DEPLOYED_CONTRACTS = { ... }`)?
 *
 * Only the flat layout has an unambiguous "the whole file is the block" meaning, so it is the one
 * and only case where a whole-file update is safe. Detection is by NAME, not by shape: a loose
 * `[A-Z_]+_CONTRACTS` pattern also matches the flat file's own `DEPLOYED_CONTRACTS`, which would
 * misread the legacy layout as multi-network and refuse to sync it at all.
 */
function usesPerChainBlocks(source) {
  if (/(?:const|let|var)\s+NETWORK_CONTRACTS\s*=\s*\{/.test(source)) return true
  return Object.values(CHAIN_BLOCK_NAMES).some((name) =>
    new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\{`).test(source)
  )
}

/**
 * Decide which named block this deployment record may write into — or refuse.
 *
 * Refusing is the point. Every alternative to a correct block name writes the addresses of one
 * chain into another chain's map (see blockNameForChain above), and a wrong address in
 * contracts.js is indistinguishable from a right one until someone sends funds to it.
 */
function resolveBlockName(source, chainId, contractsFile) {
  if (!usesPerChainBlocks(source)) {
    // Flat legacy/fixture layout: one network per file, so there is nothing to target wrongly.
    return null
  }

  const blockName = blockNameForChain(chainId)
  if (!blockName) {
    throw new Error(
      `No contracts block is mapped for chainId ${chainId}. ${contractsFile} uses the per-chain ` +
        `layout, so writing without a target block would rewrite whichever block happens to be ` +
        `first in the file (currently MORDOR_CONTRACTS) with this chain's addresses. ` +
        `Add the chain to blockNameForChain() in ${path.relative(process.cwd(), __filename)} and ` +
        `add its block + NETWORK_CONTRACTS entry to contracts.js, then re-run.`
    )
  }

  const hasBlock = new RegExp(`(?:const|let|var)\\s+${blockName}\\s*=\\s*\\{`).test(source)
  if (!hasBlock) {
    throw new Error(
      `chainId ${chainId} maps to block ${blockName}, but ${contractsFile} has no such block. ` +
        `Add "const ${blockName} = { ... }" and register it in NETWORK_CONTRACTS (contracts.js) ` +
        `before syncing this network — otherwise these addresses land in another chain's map.`
    )
  }

  return blockName
}

/**
 * Tenant mode (spec 072, T015): `--tenant <id>` reads the tenant's records
 * from deployments/tenants/<id>/ and MERGES the per-chain v2 mapping into
 * frontend/src/config/tenants/<id>.contracts.json — the generated set a
 * dedicated tenant build resolves from (injected via virtual:tenant). It never
 * touches contracts.js: the shared estate's maps stay the default tenant's.
 */
function syncTenant({ repoRoot, tenant, network, chainId, deploymentFileArg }) {
  if (tenant === 'fairwins') {
    throw new Error(
      '--tenant fairwins is the default tenant (the shared estate); run the sync without --tenant.'
    )
  }
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(tenant)) {
    throw new Error(`--tenant "${tenant}" is invalid — must match ^[a-z][a-z0-9-]{1,30}$`)
  }

  const deploymentsDir = path.join(repoRoot, 'deployments', 'tenants', tenant)
  const deploymentFile = deploymentFileArg
    ? path.resolve(repoRoot, deploymentFileArg)
    : findDeploymentFile({ deploymentsDir, network, chainId })

  if (!deploymentFile || !fs.existsSync(deploymentFile)) {
    throw new Error(
      `Tenant deployment JSON not found for "${tenant}". Looked for ${network} chainId=${chainId} ` +
        `in ${deploymentsDir}. Deploy with TENANT_ID=${tenant} first, or pass --deploymentFile <path>.`
    )
  }

  const deployment = readJson(deploymentFile)
  const deployed = deployment.contracts || {}
  const deploymentChainId = Number(deployment.chainId) || chainId

  // Same v2 key surface as the shared sync below — one record schema (D5).
  const record = {}
  const keys = [
    'wagerRegistry', 'membershipManager', 'membershipVoucher', 'voucherBatchMinter',
    'keyRegistry', 'sanctionsGuard', 'tokenFactory', 'externalDAORegistry', 'standardDaoFactory',
    'backupPointerRegistry', 'wagerPoolFactory', 'fundingPoolFactory', 'callsignRegistry', 'feeRouter',
    'stakingRouter', 'bridgeRouter', 'liquidityRouter', 'miniAppRegistry', 'safeProposalHub',
    'safePolicyGuard', 'safePolicyGuardV2', 'policyGuardSetup', 'entryPoint',
    'accountFactory', 'p256Verifier', 'polymarketAdapter', 'chainlinkDataFeedAdapter',
    'chainlinkFunctionsAdapter', 'umaAdapter',
  ]
  for (const key of keys) {
    if (deployed[key]) record[key] = deployed[key]
  }
  if (deployment.paymentToken) record.paymentToken = deployment.paymentToken
  if (deployment.wmatic) record.wmatic = deployment.wmatic
  if (deployment.deployer) record.deployer = deployment.deployer

  const outPath = path.join(repoRoot, 'frontend', 'src', 'config', 'tenants', `${tenant}.contracts.json`)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  const existing = fs.existsSync(outPath) ? readJson(outPath) : {}
  existing[deploymentChainId] = record
  fs.writeFileSync(outPath, JSON.stringify(existing, null, 2) + '\n')

  console.log(`Synced tenant "${tenant}" contracts from: ${deploymentFile}`)
  console.log(`Updated: ${outPath} (chain ${deploymentChainId})`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  const repoRoot = path.join(__dirname, '..', '..')
  const deploymentsDir = path.join(repoRoot, 'deployments')

  const network = args.network || 'amoy'
  const chainId = Number.isFinite(args.chainId) ? args.chainId : 80002

  if (args.tenant) {
    syncTenant({ repoRoot, tenant: args.tenant, network, chainId, deploymentFileArg: args.deploymentFile })
    return
  }

  const deploymentFile = args.deploymentFile
    ? path.resolve(repoRoot, args.deploymentFile)
    : findDeploymentFile({ deploymentsDir, network, chainId })

  if (!deploymentFile || !fs.existsSync(deploymentFile)) {
    throw new Error(
      `Deployment JSON not found. Looked for ${network} chainId=${chainId} in ${deploymentsDir}. ` +
        `You can pass --deploymentFile <path>.`
    )
  }

  const contractsFile = args.contractsFile
    ? path.resolve(repoRoot, args.contractsFile)
    : path.join(repoRoot, 'frontend', 'src', 'config', 'contracts.js')

  const deployment = readJson(deploymentFile)
  const deployed = deployment.contracts || {}

  // Which mapping applies. The old test — "does the record have a wagerRegistry?" — assumed every
  // v2 record contains the core escrow, which stopped being true with the spec-067 control-plane
  // networks: Ethereum/Optimism/Base/Arbitrum host ONLY feeRouter + bridgeRouter + liquidityRouter
  // and have no wagerRegistry at all. Such a record fell through to the v1 mapping, which carries
  // none of those keys, so the sync copied nothing and still printed "Synced" — the exact silent
  // no-op this file must not produce. The `-v2.json` filename and the v2 salt prefix are both
  // written by the v2 deploy tooling, so either one is a positive statement of the record's shape;
  // the contract probe stays as a fallback for hand-written records that predate both.
  const isV2 =
    /-v2\.json$/.test(deploymentFile) ||
    String(deployment.saltPrefix || '').startsWith('FairWins-P2P-v2') ||
    Boolean(deployed.wagerRegistry || (deployed.membershipManager && deployed.keyRegistry))

  let source = fs.readFileSync(contractsFile, 'utf8')

  // Build mapping. v2 = lean P2P architecture; v1 = legacy full futarchy stack.
  const mapping = isV2
    ? {
        wagerRegistry: deployed.wagerRegistry,
        membershipManager: deployed.membershipManager,
        membershipVoucher: deployed.membershipVoucher,
        voucherBatchMinter: deployed.voucherBatchMinter,
        keyRegistry: deployed.keyRegistry,
        sanctionsGuard: deployed.sanctionsGuard,
        tokenFactory: deployed.tokenFactory, // spec 028 — token issuance (only present where deployed)
        externalDAORegistry: deployed.externalDAORegistry, // spec 030 — ClearPath external-DAO registry
        // spec 030 pillar A — native standard-DAO factory. Cancun-only (issue #1268), so it is
        // absent on ETC 61 / Mordor 63 BY DECISION; absence is the honest answer there, not a gap.
        standardDaoFactory: deployed.standardDaoFactory,
        backupPointerRegistry: deployed.backupPointerRegistry, // spec 032 — encrypted-backup pointer registry
        wagerPoolFactory: deployed.wagerPoolFactory, // spec 034 — WagerPools factory, address-based (only where deployed)
        fundingPoolFactory: deployed.fundingPoolFactory, // spec 103 — funding pools factory (only where deployed)
        callsignRegistry: deployed.callsignRegistry, // spec 054 — %callsign naming registry (only where deployed)
        feeRouter: deployed.feeRouter, // spec 060 — unified platform-fee registry + wrapper (only where deployed)
        stakingRouter: deployed.stakingRouter, // spec 066 — staking control surface + liquid fee router (only where deployed)
        bridgeRouter: deployed.bridgeRouter, // spec 067 — cross-chain bridge control surface + fee router (only where deployed)
        liquidityRouter: deployed.liquidityRouter, // spec 067 — liquidity-supply control surface + fee router (only where deployed)
        miniAppRegistry: deployed.miniAppRegistry, // spec 073 — mini-app catalog + curation authority (only where deployed)
        safeProposalHub: deployed.safeProposalHub, // spec 043 — Safe custody proposal broadcaster (only where deployed)
        safePolicyGuard: deployed.safePolicyGuard, // spec 049 — multisig policy engine guard (only where deployed)
        // spec 068 — ordered policy engine. Deployed ALONGSIDE v1, never replacing it: vaults adopt
        // it through a threshold-approved setGuard, so both addresses must stay resolvable.
        safePolicyGuardV2: deployed.safePolicyGuardV2,
        policyGuardSetup: deployed.policyGuardSetup, // spec 049/068 — Safe.setup policy attach helper (guard-agnostic)
        entryPoint: deployed.entryPoint, // spec 041 — ERC-4337 EntryPoint v0.6 (canonical or self-deployed)
        accountFactory: deployed.accountFactory, // spec 041 — deterministic CoinbaseSmartWalletFactory (same address on every network)
        p256Verifier: deployed.p256Verifier, // spec 041 — only on networks needing an external P-256 verifier
        polymarketAdapter: deployed.polymarketAdapter,
        chainlinkDataFeedAdapter: deployed.chainlinkDataFeedAdapter,
        chainlinkFunctionsAdapter: deployed.chainlinkFunctionsAdapter,
        umaAdapter: deployed.umaAdapter,
        paymentToken: deployment.paymentToken,
        wmatic: deployment.wmatic,
      }
    : {
        // v1 mapping (kept for legacy Mordor reads)
        tieredRoleManager: deployed.tieredRoleManager,
        roleManager: deployed.tieredRoleManager,
        roleManagerCore: deployed.roleManagerCore || deployed.tieredRoleManager,
        tierRegistry: deployed.tierRegistry,
        usageTracker: deployed.usageTracker,
        membershipManager: deployed.membershipManager,
        paymentProcessor: deployed.paymentProcessor,
        membershipPaymentManager: deployed.membershipPaymentManager,
        welfareRegistry: deployed.welfareRegistry,
        proposalRegistry: deployed.proposalRegistry,
        marketFactory: deployed.marketFactory,
        privacyCoordinator: deployed.privacyCoordinator,
        oracleResolver: deployed.oracleResolver,
        ragequitModule: deployed.ragequitModule,
        futarchyGovernor: deployed.futarchyGovernor,
        tokenMintFactory: deployed.tokenMintFactory,
        daoFactory: deployed.daoFactory,
        ctf1155: deployed.ctf1155,
        friendGroupMarketFactory: deployed.friendGroupMarketFactory,
        marketCorrelationRegistry: deployed.marketCorrelationRegistry,
        nullifierRegistry: deployed.nullifierRegistry,
      }

  // Determine the target block in contracts.js. Null means (and now ONLY means) the flat
  // single-network layout, where a whole-file update is unambiguous; anything else refuses
  // rather than writing this chain's addresses into another chain's block.
  const deploymentChainId = Number(deployment.chainId) || chainId
  const blockName = resolveBlockName(source, deploymentChainId, contractsFile)

  for (const [key, value] of Object.entries(mapping)) {
    if (!value) continue
    source = updateObjectLiteralValue(source, key, `'${value}'`, blockName)
  }

  // Keep deployer in sync too (use explicit field if present).
  if (deployment.deployer) {
    source = updateObjectLiteralValue(source, 'deployer', `'${deployment.deployer}'`, blockName)
  }

  fs.writeFileSync(contractsFile, source)

  console.log(`Synced frontend contracts from: ${deploymentFile}`)
  console.log(`Updated: ${contractsFile}`)

  // ABI emission REMOVED (spec 075, FR-034). This used to derive the subgraph's WagerRegistry.json
  // from the HAND-WRITTEN frontend/src/abis/WagerRegistry.js — the comment claimed "generated
  // artifact, not hand-copied", but its source was hand-copied, so it laundered a hand-maintained
  // ABI into something that looked generated. That hand-written ABI was missing 35 members of the
  // merged two-facet registry, including 9 intents-facet errors the UI therefore could not decode.
  // ABIs now come from `npm run codegen:abis` (packages/abi), generated from compiled artifacts and
  // gated by `npm run check:abis`.
  //
  // The ADDRESS sync above stays: it regex-rewrites frontend/src/config/contracts.js in place, and
  // untangling that is blocked on that file's transitive `virtual:tenant` import.
}

main()
