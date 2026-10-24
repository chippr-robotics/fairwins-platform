/**
 * Publish the local passkey stack's addresses to the rest of the job, and isolate the deployment
 * record the relay gateway reads.
 *
 * TWO JOBS, both of which have a silent failure mode if skipped:
 *
 * 1. **A private deployments dir for the gateway.** `loadDeployment` picks the FIRST file matching
 *    `*-chain<id>-v2.json` in the directory it is given, and the repo's `deployments/` holds both
 *    the real `amoy-chain80002-v2.json` and the local `localhost-chain80002-v2.json`. Pointed at
 *    the repo the gateway would boot on the REAL Amoy addresses — its sanctions screen would read a
 *    SanctionsGuard that has no code on this node, fail closed, and refuse every sponsorship. The
 *    symptom would be a passkey member silently self-funding, i.e. exactly the thing the sponsored
 *    flow exists to distinguish. So the local record is copied out ALONE.
 *
 * 2. **The FR-023 cross-check.** The SPA resolves `accountFactory`/`entryPoint` for the
 *    80002-impersonating build from the committed table, so the factory this chain actually got
 *    must be the same address. It will be — both come from the same salt and the same bytecode —
 *    but "will be" is an assumption about compiler reproducibility, and if it ever stops holding
 *    the accounts the app derives are addresses this chain's factory cannot deploy. Fail here,
 *    where the reason is one line, rather than inside a WebAuthn ceremony as an AA14.
 *
 *   node scripts/e2e/passkey-stack/stack-env.js >> "$GITHUB_ENV"
 */
const fs = require('fs')
const path = require('path')

const CHAIN_ID = Number(process.env.CHAIN_ID || 80002)
const OUT_DIR = process.env.STACK_DIR || '/tmp/fairwins-passkey-stack'
const repo = process.cwd()

const localFile = path.join(repo, 'deployments', `localhost-chain${CHAIN_ID}-v2.json`)
if (!fs.existsSync(localFile)) {
  console.error(`::error::${localFile} does not exist — the local deploy did not run or wrote elsewhere.`)
  process.exit(1)
}
const local = JSON.parse(fs.readFileSync(localFile, 'utf8'))
const c = local.contracts || {}

const required = ['entryPoint', 'accountFactory', 'verifyingPaymaster', 'sanctionsGuard', 'wagerRegistry', 'membershipManager']
const missing = required.filter((k) => !/^0x[0-9a-fA-F]{40}$/.test(c[k] || ''))
if (missing.length) {
  console.error(`::error::${localFile} is missing addresses: ${missing.join(', ')}`)
  process.exit(1)
}

// The address table the SPA build will use for this chain (see config/contracts.js, E2E branch).
const shipped = JSON.parse(fs.readFileSync(path.join(repo, 'deployments', `amoy-chain${CHAIN_ID}-v2.json`), 'utf8')).contracts
for (const key of ['entryPoint', 'accountFactory']) {
  if (c[key].toLowerCase() !== String(shipped[key]).toLowerCase()) {
    console.error(
      `::error::${key} on the local chain is ${c[key]} but the app is built against ${shipped[key]}. ` +
        `Deterministic deployment did not reproduce — every derived account address would be unspendable.`
    )
    process.exit(1)
  }
}

const deployDir = path.join(OUT_DIR, 'deployments')
fs.mkdirSync(deployDir, { recursive: true })
fs.copyFileSync(localFile, path.join(deployDir, path.basename(localFile)))

const lines = [
  `PASSKEY_ENTRYPOINT=${c.entryPoint}`,
  `PASSKEY_ACCOUNT_FACTORY=${c.accountFactory}`,
  `PASSKEY_PAYMASTER=${c.verifyingPaymaster}`,
  `PASSKEY_DEPLOYMENTS_DIR=${deployDir}`,
]
console.log(lines.join('\n'))
console.error(`stack-env: ${lines.join(' ')}`)
