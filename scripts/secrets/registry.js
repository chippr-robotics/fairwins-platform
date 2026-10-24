/**
 * scripts/secrets/registry.js — the ONE inventory of what this workstation treats as a secret.
 *
 * Spec 088. This file is the answer to "is X a secret, and where does it live?" for every operator
 * tool that runs on a developer or deployment workstation. It is deliberately data, not logic, so a
 * reviewer can audit the whole surface by reading one table.
 *
 * Four invariants, each of which has a corresponding test in `__tests__/registry.test.js`:
 *
 *   1. THE REGISTRY IS AUTHORITATIVE, `.env` IS NOT. `check-env-hygiene.js` reads this table and
 *      fails if a value for any `env` name below is present in a tracked `.env`. Adding a secret to
 *      the repo therefore means adding it here first — there is no path that ships a credential
 *      without it appearing in this list.
 *
 *   2. ONE SECRET MAY FEED SEVERAL VARIABLES, AND THAT IS DECLARED, NOT INFERRED. `POLYGON_RPC_URL`,
 *      `QUICKNODE_POLYGON_RPC_URL` and `ALTO_RPC_URL` were three byte-identical copies of one
 *      QuickNode URL with the token embedded in the path. They are one secret with three `env`
 *      aliases. Three secrets would rotate independently and silently drift — which is exactly how
 *      two of them end up stale and pointing at a revoked token.
 *
 *   3. A PROFILE IS A LEAST-PRIVILEGE BUNDLE. Nothing fetches "all secrets". A tool declares the
 *      profile it needs (`compile` needs none, `verify` needs an explorer key, `deploy` needs a
 *      signing key) and receives exactly that. The profile is also what the Terraform module grants
 *      `secretAccessor` on, so the code and the IAM describe the same thing.
 *
 *   4. CLASSIFICATION DRIVES BEHAVIOUR, NOT DOCUMENTATION. `key` material is refused a `.env`
 *      fallback on a public network no matter what the caller passes (see `fetch.js`), because the
 *      failure mode of getting that wrong is signing a mainnet transaction with a key nobody meant
 *      to use.
 *
 * Secret ids are matched by the spec-087 guardrail G-10 allow-list via `/^fairwins[-_]/`, so every
 * name here must keep the `fairwins-` prefix or `npm run check:iac` will reject the Terraform that
 * declares it.
 */

/** GCP project holding the secrets. Shared with unrelated Chippr workloads — see spec 087. */
export const PROJECT_ID = process.env.FW_SECRETS_PROJECT || 'chippr-bots-site-wp'

/**
 * Classification. Determines fallback rules and how loudly a miss fails.
 *
 * - `key`      raw private key material. Never falls back on a public network.
 * - `password` unlocks key material held elsewhere (the floppy keystore).
 * - `token`    a vendor API credential. Losing it degrades a feature, it does not move funds.
 * - `endpoint` a URL with an embedded credential. Secret because of the credential, not the host.
 */
export const CLASS = /** @type {const} */ ({
  KEY: 'key',
  PASSWORD: 'password',
  TOKEN: 'token',
  ENDPOINT: 'endpoint',
})

/**
 * @typedef {object} SecretEntry
 * @property {string}   id        Secret Manager secret id (the container name).
 * @property {string}   version   Version to read. Pinned like the VM's fetch-secrets.sh; `latest`
 *                                is only correct where no consumer pins a specific version.
 * @property {string[]} env       Environment variable name(s) this payload is delivered as.
 * @property {string}   class     One of CLASS.*
 * @property {string[]} profiles  Which least-privilege bundles include this secret.
 * @property {string}   note      Why it exists / what breaks without it. Shown by `secrets:doctor`.
 * @property {boolean} [json]     Payload is a JSON document expanded into several variables.
 * @property {string[]} [expand]  For json entries: the variable names produced, in order.
 * @property {string}  [derived]  The payload is COMPUTED by a named command, not copied from a
 *                                local `.env`. `migrate.js` refuses to upload or prune these: the
 *                                value sitting on disk is a stand-in (a public endpoint), and
 *                                uploading it would fill a container labelled "archive endpoint"
 *                                with a public URL that then reads back as correct forever.
 */

/** @type {SecretEntry[]} */
export const SECRETS = [
  {
    id: 'fairwins-deployer-key',
    version: 'latest',
    env: ['PRIVATE_KEY'],
    class: CLASS.KEY,
    profiles: ['deploy'],
    note: 'Funded deploy signer (0x5250…F6e1) and the spec-050 paymaster deployer. Holds real POL.',
  },
  {
    id: 'fairwins-creator-key',
    version: 'latest',
    env: ['CREATOR_PRIVATE_KEY'],
    class: CLASS.KEY,
    profiles: ['seed'],
    note: 'Creates wagers in the seeding/demo flows. Not an admin key.',
  },
  {
    id: 'fairwins-seed-player-keys',
    version: 'latest',
    env: ['SEED_PLAYER_KEYS'],
    class: CLASS.KEY,
    profiles: ['seed'],
    json: true,
    // One container, ten keys. They are a set that is always rotated together; ten containers would
    // let them drift out of step and cost ten IAM bindings to say one thing.
    expand: Array.from({ length: 10 }, (_, i) => `SEED_PLAYER_${i + 1}`),
    note: 'JSON array of the 10 testnet player keys used by the market seeder.',
  },
  {
    id: 'fairwins-floppy-keystore-password',
    version: 'latest',
    env: ['FLOPPY_KEYSTORE_PASSWORD'],
    class: CLASS.PASSWORD,
    profiles: ['deploy'],
    note: 'Decrypts admin-keystore.json / mnemonic-keystore.json on the mounted floppy.',
  },
  {
    id: 'fairwins-floppy-mordor-password',
    version: 'latest',
    env: ['FLOPPY_MORDOR_PASSWORD'],
    class: CLASS.PASSWORD,
    profiles: ['deploy'],
    note: 'Mordor (ETC testnet) floppy keystore password.',
  },
  {
    id: 'fairwins-floppy-nazgul-prime-password',
    version: 'latest',
    env: ['FLOPPY_NAZGUL_PRIME_PASSWORD'],
    class: CLASS.PASSWORD,
    profiles: ['deploy'],
    note: 'Nazgul Prime floppy keystore password.',
  },
  {
    id: 'fairwins-etherscan-api-key',
    version: 'latest',
    env: ['ETHERSCAN_API_KEY'],
    class: CLASS.TOKEN,
    profiles: ['verify'],
    note: 'Etherscan V2 multichain key used by `npm run verify:<net>`.',
  },
  {
    id: 'fairwins-pinata-jwt',
    version: 'latest',
    env: ['PINATA_JWT'],
    class: CLASS.TOKEN,
    profiles: ['publish'],
    note: 'Pinata scoped-key JWT for pinning mini-app packages and backup bundles to IPFS.',
  },
  {
    id: 'fairwins-graph-deploy-key',
    version: 'latest',
    env: ['GRAPH_DEPLOY'],
    class: CLASS.TOKEN,
    profiles: ['publish'],
    // The two Graph credentials are NOT interchangeable and have been confused before:
    // GRAPH_DEPLOY authorises `graph deploy`; GRAPH_API_KEY only authorises queries.
    note: 'The Graph Studio DEPLOY key. Authorises publishing a subgraph — not querying one.',
  },
  {
    id: 'fairwins-graph-api-key',
    version: 'latest',
    env: ['GRAPH_API_KEY'],
    class: CLASS.TOKEN,
    profiles: ['publish'],
    note: 'The Graph QUERY key. Read-only against the gateway; cannot deploy.',
  },
  {
    id: 'fairwins-quicknode-polygon-token',
    version: 'latest',
    env: ['QUICKNODE_POLYGON_TOKEN'],
    class: CLASS.TOKEN,
    profiles: ['rpc'],
    note: 'Bare QuickNode token, for callers that build the URL themselves.',
  },
  {
    id: 'fairwins-quicknode-polygon-url',
    version: 'latest',
    // One payload, three historical variable names. See invariant 2 at the top of this file.
    env: ['POLYGON_RPC_URL', 'QUICKNODE_POLYGON_RPC_URL', 'ALTO_RPC_URL'],
    class: CLASS.ENDPOINT,
    profiles: ['rpc', 'deploy'],
    note: 'QuickNode Polygon archive endpoint with the token in the path. Archive reads matter: the '
      + 'public RPC 403s on eth_getLogs, which is what stalled the bundler UI (see ops memory).',
  },

  // ---- PER-CHAIN archive endpoints for the four EVM mainnets that had none ------------------
  //
  // ONE CONTAINER PER CHAIN, deliberately, and this is the opposite of invariant 2 rather than a
  // violation of it. Invariant 2 collapses aliases of the SAME payload; these are four DIFFERENT
  // payloads. They are derived from one QuickNode multichain endpoint (QUICKNODE_RPC_001_API,
  // base network eth) by swapping a hostname infix — `<name>.<slug>.quiknode.pro/<token>`, with
  // Ethereum mainnet omitting the infix entirely — so a single container holding "the multichain
  // URL" would leave every reader to re-derive its own chain's URL. That derivation is precisely
  // the step with the bad failure mode: A WRONG INFIX ANSWERS 200 WITH ANOTHER CHAIN'S STATE, not
  // 401. Deriving once, verifying eth_chainId, and storing the verified per-chain URL moves that
  // risk to a single audited moment — `node scripts/secrets/quicknode-chains.js --provision`,
  // which refuses to write a chain that did not verify.
  //
  // Until these were provisioned, MAINNET_RPC_URL / OPTIMISM_RPC_URL / BASE_RPC_URL /
  // ARBITRUM_RPC_URL were PUBLIC endpoints listed in PUBLIC_ENV_KEYS below and pasted into a local
  // `.env`. They are hard requirements of hardhat.config.js (`requiredRpcUrl`), so a deploy or a
  // fork test on any of these four chains ran on a public node with no archive depth and no rate
  // limit worth the name. Moving them here is what makes `npm run sec -- --profile deploy` deliver
  // a real endpoint instead of the operator remembering to keep four URLs in a file.
  //
  // Polygon 137 is the fifth EVM mainnet and is NOT in this group: it already had
  // `fairwins-quicknode-polygon-url` above, and its node-facing twin is alto's ONLY RPC endpoint.
  // Amoy 80002 has no per-chain endpoint at all (no Amoy-cohort node; fork tests use the public
  // RPC), which is recorded as `secretId: null` in quicknode-chains.js rather than left implicit.
  {
    id: 'fairwins-quicknode-ethereum-url',
    version: 'latest',
    derived: 'node scripts/secrets/quicknode-chains.js --provision 1',
    env: ['MAINNET_RPC_URL'],
    class: CLASS.ENDPOINT,
    profiles: ['rpc', 'deploy'],
    note: 'QuickNode Ethereum mainnet (1) archive endpoint. Required by hardhat.config.js for the '
      + '`mainnet` network; note ops memory — L1 deploys go through scripts/ops/*-direct.js.',
  },
  {
    id: 'fairwins-quicknode-optimism-url',
    version: 'latest',
    derived: 'node scripts/secrets/quicknode-chains.js --provision 10',
    env: ['OPTIMISM_RPC_URL'],
    class: CLASS.ENDPOINT,
    profiles: ['rpc', 'deploy'],
    note: 'QuickNode Optimism (10) archive endpoint. Spec 067 bridge/liquidity routers live here.',
  },
  {
    id: 'fairwins-quicknode-base-url',
    version: 'latest',
    derived: 'node scripts/secrets/quicknode-chains.js --provision 8453',
    env: ['BASE_RPC_URL'],
    class: CLASS.ENDPOINT,
    profiles: ['rpc', 'deploy'],
    note: 'QuickNode Base (8453) archive endpoint. Base serves stale reads after writes on public '
      + 'nodes (ops memory) — an archive endpoint is what makes a post-deploy verify trustworthy.',
  },
  {
    id: 'fairwins-quicknode-arbitrum-url',
    version: 'latest',
    derived: 'node scripts/secrets/quicknode-chains.js --provision 42161',
    env: ['ARBITRUM_RPC_URL'],
    class: CLASS.ENDPOINT,
    profiles: ['rpc', 'deploy'],
    note: 'QuickNode Arbitrum One (42161) archive endpoint. Spec 067 routers live here.',
  },
]

/** Every profile name that appears in the registry, sorted. */
export const PROFILES = [...new Set(SECRETS.flatMap((s) => s.profiles))].sort()

/** Secrets belonging to a profile. Throws on an unknown profile rather than returning nothing —
 *  a typo must not silently resolve to "no secrets needed". */
export function secretsForProfile(profile) {
  if (!PROFILES.includes(profile)) {
    throw new Error(
      `Unknown secret profile "${profile}". Known profiles: ${PROFILES.join(', ')}.`,
    )
  }
  return SECRETS.filter((s) => s.profiles.includes(profile))
}

/** Every environment variable name the registry can deliver, including JSON expansions. */
export function allManagedEnvNames() {
  return SECRETS.flatMap((s) => [...s.env, ...(s.expand ?? [])])
}

/** Secret ids, for the Terraform `managed_secret_ids` / `secret_accessor_secrets` inputs. */
export function allSecretIds() {
  return SECRETS.map((s) => s.id).sort()
}

/**
 * Non-secret configuration that legitimately stays in `.env`. Listed explicitly so the hygiene
 * check can tell "safe to keep" apart from "not classified yet" — an unclassified key is reported,
 * because silence about a new variable is how the next credential gets committed.
 */
export const PUBLIC_ENV_KEYS = [
  'ADMIN',
  'FLOPPY_ACTIVE',
  'FLOPPY_MORDOR_ADDRESS',
  'FLOPPY_NAZGUL_PRIME_ADDRESS',
  'MARKET_FACTORY_ADDRESS',
  // MAINNET_RPC_URL / OPTIMISM_RPC_URL / BASE_RPC_URL / ARBITRUM_RPC_URL were listed here while
  // they held public endpoints. They are now managed per-chain QuickNode endpoints above, so they
  // must NOT appear here as well — `check:env-hygiene` will report a value for any of them left in
  // a local `.env`, which is the intended migration prompt, not a false positive.
  'SEED_INTERVAL_MS',
  'SEED_MARKETS_PER_CYCLE',
  'SEED_TRADES_PER_CYCLE',
  'FW_SECRETS_PROJECT',
  'FW_SECRETS_IMPERSONATE',
  'FW_ALLOW_ENV_SECRETS',
]
