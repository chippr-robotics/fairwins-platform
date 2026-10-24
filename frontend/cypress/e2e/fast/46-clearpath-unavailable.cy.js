// =============================================================================
// 46-clearpath-unavailable.cy.js
// No-chain E2E for ClearPath's Launch tab where a DAO CANNOT be created
// (spec 030 pillar A, the 2026-08-30 amendment on issue #1268; issue #1400 §A).
//
//   CDU-01  miniapp.clearpath-create-dao-unavailable — pre-Cancun (permanent)
//   CDU-02  miniapp.clearpath-create-dao-unavailable — not deployed (a state)
//
// ── WHY THIS IS IN THE NO-CHAIN TIER ────────────────────────────────────────
// Admission rule 1: this is disclosure copy and a withheld control. Nothing
// signs, nothing settles, and the decision under test — `canCreate` is false, so
// say WHICH of the two reasons it is — is made entirely from what the host told
// the package about the estate. Spending an on-chain shard on it would spend the
// merge gate's wall clock proving that a button is absent.
//
// ── WHAT THIS FLOW IS ACTUALLY DEFENDING ────────────────────────────────────
// The two reasons are NOT the same fact, and collapsing them is the regression
// that would never fail a unit test of the surrounding app:
//
//   "This chain runs a pre-Cancun EVM" is PERMANENT. OpenZeppelin 5.4.0's
//   `Governor` uses `mcopy`, ETC 61 and Mordor 63 do not have it, and the
//   maintainer's decision on #1268 is an exclusion, not a deferral. An ETC
//   member told only "not available" waits for a rollout that is never coming.
//
//   "The factory is not deployed there" is a state of the estate that changes
//   the day somebody runs `deploy-clearpath.js` against that chain.
//
// Both branches must also withhold the control rather than disable it: a greyed
// "Launch DAO" with no explanation is exactly the failure this replaces.
//
// ── WHAT IS STUBBED ─────────────────────────────────────────────────────────
// The registry READ (over Polygon's RPC, the mainnet build's `miniAppChainId()`)
// and the IPFS gateway TRANSPORT. The bytes are the REAL ClearPath package as
// `npm run build --workspace @fairwins/miniapp-clearpath` produced them, and the
// loader still takes keccak256 of the manifest and compares it to the hash the
// (stubbed) registry holds, then sha256 of every file it executes — so what runs
// here is the shipped package, verified by the shipped pipeline.
//
// ── THE ONE THING THIS SPEC NEEDS FROM CI ───────────────────────────────────
// `frontend/miniapps/clearpath/dist/` must exist. The on-chain tier gets it from
// `setup:e2e`'s `publish:local:miniapps`; this tier installs only the frontend
// workspace and builds nothing, so the fast job needs one build step (~0.3s).
// The `miniappRealPackage` task says so in as many words when it is missing,
// rather than failing on a selector.
// =============================================================================

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

/** Polygon is the mainnet build's registry home (`miniAppChainId()`). */
const POLYGON = 137
/** Pre-Cancun by decision (#1268). ETC is the mainnet cohort's, so no chain-switch prompt. */
const ETHEREUM_CLASSIC = 61

/** `host.network(chainId).name` — the package never invents a network name. */
const POLYGON_NAME = 'Polygon'
const ETC_NAME = 'Ethereum Classic'

/**
 * dev:fast sets no VITE_MINIAPP_GATEWAY, so `resolveMiniAppGateways()` falls through to
 * `IPFS_GATEWAY` (frontend/src/constants/ipfs.js → PINATA_CONFIG.GATEWAY).
 */
const GATEWAY = 'https://gateway.pinata.cloud'

/**
 * The two sentences, verbatim from
 * `frontend/miniapps/clearpath/src/config/nativeDaoChains.js#nativeDaoUnavailableReason`.
 *
 * Written out here rather than matched by keyword because the CLAIM is the wording: a member on
 * ETC has to be told this is not coming AND that pillar B still works for them, and a member on a
 * Cancun chain has to be told the opposite kind of thing. A `/not available/i` assertion would
 * pass on either sentence, which is the collapse this flow exists to catch.
 */
const PRE_CANCUN_NOTICE = (where) =>
  `${where} runs a pre-Cancun EVM, which cannot run the OpenZeppelin Governor a standard DAO is ` +
  `built from. Launching a DAO here is not planned — but registering, tracking and governing DAOs ` +
  `on ${where} works normally, on the Register / Track tab.`

const NOT_DEPLOYED_NOTICE = (where) =>
  `Launching a DAO is not available on ${where} — the DAO factory is not deployed there.`

/** Chain ids the app's read providers will ask for, by RPC host (config/networks.js). */
const CHAIN_ID_BY_HOST = [
  [/polygon-bor-rpc\.publicnode\.com/, '0x89'],
  [/ethereum-rpc\.publicnode\.com/, '0x1'],
  [/optimism-rpc\.publicnode\.com/, '0xa'],
  [/base-rpc\.publicnode\.com/, '0x2105'],
  [/arbitrum-one-rpc\.publicnode\.com/, '0xa4b1'],
  [/etc\.etcdesktop\.com/, '0x3d'],
]

/**
 * Answer every chain read this build can make, and answer the REGISTRY reads only on Polygon.
 *
 * Each host is told its own chain id, so a provider never sees a chain mismatch it would have to
 * recover from — noise that has nothing to do with what is under test. `eth_call` on any other
 * host returns '0x', which ethers rejects, so ClearPath's cross-chain DAO reads surface as its own
 * honest error rather than as fabricated DAOs.
 */
function stubChainReads(answers) {
  cy.intercept({ method: 'POST', url: /publicnode\.com|etc\.etcdesktop\.com/ }, (req) => {
    const entry = CHAIN_ID_BY_HOST.find(([pattern]) => pattern.test(req.url))
    const chainHex = entry ? entry[1] : '0x89'
    const isRegistryHost = /polygon-bor-rpc\.publicnode\.com/.test(req.url)
    const one = (payload) => {
      const { method, params, id } = payload
      let result
      switch (method) {
        case 'eth_chainId':
          result = chainHex
          break
        case 'net_version':
          result = String(parseInt(chainHex, 16))
          break
        case 'eth_blockNumber':
          result = '0x4000000'
          break
        case 'eth_getCode':
          result = '0x60806040'
          break
        case 'eth_call':
          result = isRegistryHost ? (answers[String(params?.[0]?.data || '').slice(0, 10)] ?? '0x') : '0x'
          break
        default:
          result = '0x'
      }
      return { jsonrpc: '2.0', id, result }
    }
    const body = req.body
    req.reply({ statusCode: 200, body: Array.isArray(body) ? body.map(one) : one(body || {}) })
  }).as('chainRpc')
}

/** Serve the package's own bytes for the loader's `/ipfs/<cid>/<path>` fetches. */
function serveFiles({ cid, files }) {
  for (const [path, text] of Object.entries(files)) {
    cy.intercept('GET', `${GATEWAY}/ipfs/${cid}/${path}`, (req) => {
      req.reply({ statusCode: 200, body: text, headers: { 'content-type': 'text/plain' } })
    })
  }
}

/**
 * Launch the real ClearPath package with the wallet on `chainId`, and land on the Launch tab.
 *
 * The registry record is built from the package that will actually be served, so the loader's
 * keccak comparison is a real comparison between two independently produced values.
 */
function openLaunchTab(chainId) {
  return cy
    .task('miniappRealPackage', { app: 'clearpath' })
    .then((pkg) => {
      expect(pkg.ok, `miniappRealPackage: ${pkg.error || 'no error message returned'}`).to.equal(true)
      serveFiles(pkg)
      return cy.task('clearpathRegistryWorld', { cid: pkg.cid, manifestHash: pkg.manifestHash })
    })
    .then((world) => {
      expect(world.ok, `clearpathRegistryWorld: ${world.error || 'no error message returned'}`).to.equal(true)
      stubChainReads(world.answers)

      cy.mockWeb3Provider({ account: ACCOUNT, preAuthorized: true, networkId: chainId })
      cy.visit('/apps/clearpath')
      cy.get('.miniapp-workspace-root', { timeout: 60000 }).should('exist')
      cy.get('.miniapp-workspace-refusal').should('not.exist')
      cy.contains('.cp-tab', /^Launch$/, { timeout: 30000 }).click()
    })
}

/** The notice, with its whitespace normalised the way a reader sees it. */
const noticeText = () =>
  cy
    .get('.cp-card [role="status"].cp-notice', { timeout: 20000 })
    .should('be.visible')
    .invoke('text')
    .then((raw) => raw.replace(/\s+/g, ' ').trim())

/** Neither branch may leave a control that would send a transaction. */
function assertNoCreateControl() {
  cy.contains('button', /Launch DAO/i).should('not.exist')
  cy.get('#cp-dao-name').should('not.exist')
  cy.get('#cp-dao-token-symbol').should('not.exist')
  // Every button still on screen belongs to the tab strip, and none of them is disabled — the
  // surface withholds the action instead of greying one out with no explanation.
  cy.get('.cp-card button').should('not.exist')
}

describe('ClearPath Launch tab where a DAO cannot be created (spec 030 pillar A)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[CDU-01] miniapp.clearpath-create-dao-unavailable — a pre-Cancun chain is told this is not coming, and that pillar B still works there', () => {
    openLaunchTab(ETHEREUM_CLASSIC)

    // The heading is still offered — the tab is never hidden, because hiding it leaves the member
    // to guess whether the feature exists at all.
    cy.contains('.cp-card h4', /^Launch a DAO$/).should('be.visible')

    noticeText().then((text) => {
      expect(text, 'the pre-Cancun sentence, verbatim').to.equal(PRE_CANCUN_NOTICE(ETC_NAME))
      // …and it is NOT the other one. The whole point is that these two facts read differently.
      expect(text, 'never the not-deployed wording').to.not.match(/not deployed/i)
      // The member is told what still works for them, by name.
      expect(text, 'names the tab that does work here').to.include('Register / Track')
    })

    assertNoCreateControl()

    // Pillar B is genuinely unaffected on this chain: the tab it names is really there.
    cy.contains('.cp-tab', /Register \/ Track/i).should('be.visible')
  })

  it('[CDU-02] miniapp.clearpath-create-dao-unavailable — a Cancun chain with no factory recorded is told the factory is not deployed, and nothing about mcopy', () => {
    /*
     * Polygon is a Cancun chain the spec-030 amendment lists as ELIGIBLE, and
     * `POLYGON_CONTRACTS.standardDaoFactory` is currently `''` — so the honest answer is "not
     * deployed there", and it must not borrow ETC's permanent one.
     *
     * If pillar A ever ships to Polygon this test fails, and that failure is correct rather than
     * spurious: re-point it at whichever Cancun chain still has no factory recorded.
     */
    openLaunchTab(POLYGON)

    cy.contains('.cp-card h4', /^Launch a DAO$/).should('be.visible')

    noticeText().then((text) => {
      expect(text, 'the not-deployed sentence, verbatim').to.equal(NOT_DEPLOYED_NOTICE(POLYGON_NAME))
      // A Cancun chain must never be told it cannot run the Governor — that would be false, and it
      // would tell a member to stop waiting for something that IS coming.
      expect(text, 'never the pre-Cancun wording').to.not.match(/pre-Cancun|mcopy/i)
    })

    assertNoCreateControl()
  })
})
