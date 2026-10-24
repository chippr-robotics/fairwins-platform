// =============================================================================
// 39-api-access.cy.js
// Fast-tier E2E tests for Settings ▸ API access — private member API keys (spec 095).
//
// Spec directory `specs/095-member-api-agentic-access/`; tracking issue #TBD
// (the matrix row `095-member-api-agentic-access` carries the same reference).
// Flows: `api-access.create-key`, `api-access.revoke-key`, `api-access.console`.
//
// ── WHY THIS IS IN THE NO-CHAIN TIER ────────────────────────────────────────
// A key is an OFF-CHAIN capability. Creating one is a signature over an
// `ApiKeyGrant`; there is no transaction, no escrow and no fee, and the scopes
// it can carry are read-shaped — there is deliberately no `write:` scope at all.
// Nothing here costs a member money, so the admission rule in
// docs/developer-guide/e2e-testing-policy.md keeps all of it out of the on-chain
// tier.
//
// ── WHAT IS STUBBED ─────────────────────────────────────────────────────────
// · MEMBERSHIP at the RPC transport (the card is gated on an active membership
//   read from the reference chain), with the honest-unreadable arm as its own
//   test. Anything unanswered returns '0x', which ethers rejects, so a forgotten
//   read surfaces as the app's unavailable state rather than as a fake tier.
// · THE REVOKE ENDPOINT with `cy.intercept`, its body copied from the handler in
//   services/relay-gateway/src/memberApi/routes.js. The stub matches the
//   PRODUCER; a stub matching only the test would prove the spec agrees with
//   itself.
// · Nothing else. The no-chain dev server points VITE_RELAYER_URL at a dead
//   port, which is exactly the world [API-03] needs.
//
// ── THE TWO ASSERTIONS THIS FILE EXISTS FOR ─────────────────────────────────
// 1. THE TOKEN IS SHOWN ONCE AND PERSISTED NOWHERE. After the member dismisses
//    the reveal, `cy.assertNoClearSecret` sweeps every storage key and the whole
//    DOM — not just the key the metadata is expected to live under, because the
//    invariant is "the credential is not persisted", not "one store is clean".
// 2. REVOCATION NEVER OVERSTATES ITSELF. The gateway holds revocations in
//    process memory, so a registered revocation must SAY it does not survive a
//    restart, and a revocation that could not be delivered must never read as
//    one that was.
// =============================================================================

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

/**
 * Card ids double as `data-attention` markers and as deep-link hashes (spec 081). The id survived
 * spec 104's move of this card off Settings onto the Assistant tab in Tools, so the OLD link below
 * still lands on it — by redirect, which is why every assertion here names the card and none names
 * the tab. The redirect itself is held once, in 47-assistant-rails.cy.js [GT-07].
 */
const API_ACCESS_URL = '/wallet?tab=settings#api-access'

/** Wallet-scoped metadata store — `lib/apiAccess/apiKeys.js` + `utils/userStorage.js`. */
const KEYS_STORAGE = `fw_user_${ACCOUNT.toLowerCase()}_api_access_keys`

/** Every shipped read provider this build resolves runs through publicnode. */
// BOTH rails, or the stub is a lie: since 480720bf every EVM mainnet has a drpc.org FAILOVER,
// so makeReadProvider builds a FallbackProvider — a stub that fails only the publicnode primary
// is answered by LIVE drpc, and "the chain is unreachable" quietly becomes "the chain answered
// tier 0 from production" (issue #1463; spec 42 and the passkey suite hit the same class).
const RPC_PATTERN = /publicnode\.com|drpc\.org/

/*
 * ── The membership answer, encoded by hand ─────────────────────────────────────────────────────
 * Provenance is stated in full at the head of 38-assistant.cy.js, which gates on the same read:
 * the selector is keccak256("getMembership(address,bytes32)")[0..4) over the signature declared in
 * frontend/src/abis/MembershipManager.js, and the return is a STATIC tuple
 * (uint8, uint64, uint32, uint32, uint64) — five 32-byte words, no head offset.
 */
const GET_MEMBERSHIP_SELECTOR = '0x91f9dd2a'
const word = (value) => BigInt(value).toString(16).padStart(64, '0')
const encodeMembership = ({ tier, expiresAt, monthCount = 0, activeCount = 0, monthAnchor = 0 }) =>
  `0x${word(tier)}${word(expiresAt)}${word(monthCount)}${word(activeCount)}${word(monthAnchor)}`

/*
 * The wallet chain is pinned, and it is pinned AWAY from the membership reference chain on purpose.
 * `hooks/useRoleDetails.js` reuses the WALLET's provider when the connected chain already is the
 * reference chain, and reaches for `getReadProvider(referenceChain)` otherwise. Only the second
 * route runs through the RPC endpoint this file intercepts — so a build (or a CI env var) that put
 * the mock on 137 would send the read to the wallet mock instead and quietly bypass the stub.
 */
const WALLET_CHAIN_ID = 1337

/** Gold, expiring in 2100 — a fixed timestamp, never `Date.now()` in a test body (anti-pattern 9). */
const ACTIVE_MEMBERSHIP = encodeMembership({ tier: 3, expiresAt: 4102444800 })

function stubMembership({ fail = false, membership = ACTIVE_MEMBERSHIP } = {}) {
  cy.intercept({ method: 'POST', url: RPC_PATTERN }, (req) => {
    const one = (payload) => {
      const { method, params, id } = payload
      if (fail) {
        return { jsonrpc: '2.0', id, error: { code: -32000, message: 'reference chain unreachable' } }
      }
      let result
      switch (method) {
        case 'eth_chainId':
          result = '0x89'
          break
        case 'net_version':
          result = '137'
          break
        case 'eth_blockNumber':
          result = '0x4000000'
          break
        case 'eth_getCode':
          result = '0x60806040'
          break
        case 'eth_call':
          result =
            String(params?.[0]?.data || '').slice(0, 10) === GET_MEMBERSHIP_SELECTOR ? membership : '0x'
          break
        default:
          result = '0x'
      }
      return { jsonrpc: '2.0', id, result }
    }
    req.reply({
      statusCode: 200,
      body: Array.isArray(req.body) ? req.body.map(one) : one(req.body || {}),
    })
  }).as('referenceChainRpc')
}

/**
 * A key this device already knows about — the precondition for the revoke tests, not their subject.
 * Shaped exactly like `recordApiKey`'s output (`lib/apiAccess/apiKeys.js#toRecord` drops anything
 * else), with fixed timestamps so the record's state is the same on every run.
 */
const STORED_KEY = {
  keyId: `0x${'11'.repeat(32)}`,
  label: 'agent one',
  scopes: ['read:membership', 'read:profile'],
  issuedAt: 1750000000,
  expiresAt: 4102444800,
  revokedAt: null,
}

/**
 * The gateway's own answer to a registered revocation, from the `revoke` handler in
 * services/relay-gateway/src/memberApi/routes.js. `durable: false` is not a footnote there and is
 * not one here.
 */
const REVOKE_BODY = {
  revoked: true,
  durable: false,
  reason:
    'This revocation is held in the live gateway process and does NOT survive a gateway restart. ' +
    'What does survive is the grant’s own expiry, which was signed into the key when it was created: ' +
    're-submit this revocation after a restart, or let the key expire.',
}

/**
 * Land on the API access card.
 *
 * `mock: false` is for a SECOND visit inside one test: `cy.mockWeb3Provider` registers a
 * `window:before:load` handler that stays registered for the whole test, so the wallet is already
 * installed on every later page load. Calling it twice would register a second handler for no
 * benefit — and mocking twice is how a spec ends up with two disagreeing wallet states.
 */
function openApiAccess({ keys = null, mock = true } = {}) {
  if (mock) cy.mockWeb3Provider({ account: ACCOUNT, networkId: WALLET_CHAIN_ID, preAuthorized: true })
  cy.visit(API_ACCESS_URL, {
    onBeforeLoad(win) {
      if (keys) win.localStorage.setItem(KEYS_STORAGE, JSON.stringify(keys))
    },
  })
  // The deep link OPENS the card rather than leaving the member at a closed heading.
  cy.get('[data-attention="api-access"]', { timeout: 40000 }).should('have.attr', 'data-open', 'true')
}

describe('API access (spec 095)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[API-01] api-access.create-key — a signed grant is revealed once, persisted nowhere, and leaves only metadata behind', () => {
    stubMembership()
    openApiAccess()

    // The console appears only once the membership read has RESOLVED — the card is gated on an
    // active membership, and "still checking" is its own state.
    cy.get('[data-testid="api-access-console"]', { timeout: 40000 }).should('exist')
    cy.get('[data-testid="api-access-create"]').should('exist')

    cy.get('#api-access-label').type('my research agent', { delay: 0, log: false })
    cy.get('[data-testid="api-access-create"]').contains('button', 'Create key').click()

    cy.get('[data-testid="api-access-reveal"]', { timeout: 30000 }).should('be.visible')
    cy.get('[data-testid="api-access-token"]')
      .invoke('text')
      .then((token) => {
        // The `fw1` wire format: three dot-separated parts, the last two base64url.
        expect(token, 'the reveal is an fw1 capability token').to.match(
          /^fw1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
        )

        // Dismissing destroys the only copy this app ever held. There is no "show it again".
        cy.get('[data-testid="api-access-reveal"]').contains('button', 'I have stored it').click()
        cy.get('[data-testid="api-access-reveal"]').should('not.exist')

        // Every storage key and the whole DOM — not just the store we expect to be clean.
        cy.assertNoClearSecret(token)

        // What survives is METADATA, and it is what makes a key revocable after the token is gone.
        cy.get('[data-testid="api-access-key"]')
          .should('have.length', 1)
          .and('contain.text', 'my research agent')
          .and('contain.text', 'active')

        // Read back from the authority that decides it — the stored record, not component state.
        cy.reload()
        cy.get('[data-attention="api-access"]', { timeout: 40000 }).should(
          'have.attr',
          'data-open',
          'true'
        )
        cy.get('[data-testid="api-access-key"]').should('have.length', 1)
        cy.assertNoClearSecret(token)
      })
  })

  it('[API-02] api-access.revoke-key — a registered revocation is signed by the member and states that it does not outlive the gateway process', () => {
    stubMembership()
    cy.intercept('POST', '**/v1/member/keys/revoke', { statusCode: 200, body: REVOKE_BODY }).as('revoke')
    openApiAccess({ keys: [STORED_KEY] })

    cy.get('[data-testid="api-access-key"]', { timeout: 40000 }).contains('button', 'Revoke').click()

    cy.wait('@revoke')
      .its('request.body')
      .then((body) => {
        expect(body.revocation.keyId, 'the signed struct names the key being withdrawn').to.equal(
          STORED_KEY.keyId
        )
        expect(body.revocation.account.toLowerCase(), 'and the account that owns it').to.equal(
          ACCOUNT.toLowerCase()
        )
        // Self-authorizing: the request carries its own member signature and no bearer token,
        // because a key is revoked precisely when the token is the thing that got out.
        expect(body.signature, 'a member signature travels with the revocation').to.match(
          /^0x[0-9a-f]{130}$/
        )
      })

    cy.get('.api-access__notice--success')
      .should('be.visible')
      .and('contain.text', 'does NOT survive a gateway restart')
      // The bound that DOES survive is the grant's own expiry, and it is stated beside it.
      .and('contain.text', 'It also expires on its own on')

    cy.get('[data-testid="api-access-key"]').should('contain.text', 'revoked')
  })

  it('[API-03] api-access.revoke-key — a gateway that cannot be reached is said out loud, and never reported as a registered revocation', () => {
    /*
     * NO INTERCEPT, DELIBERATELY: the no-chain dev server configures the gateway at a port nothing
     * serves, so the transport failure is real rather than posed.
     *
     * This is the case where a comfortable message would be a dangerous one. The member signed a
     * withdrawal and the gateway never heard it, so the key still works — saying "revoked" here
     * would tell someone their leaked credential was dead while it was live.
     */
    stubMembership()
    openApiAccess({ keys: [STORED_KEY] })

    cy.get('[data-testid="api-access-key"]', { timeout: 40000 }).contains('button', 'Revoke').click()

    cy.get('.api-access__notice--error', { timeout: 40000 })
      .should('be.visible')
      .and('have.attr', 'role', 'alert')
      .and('contain.text', 'NOT registered')
      .and('contain.text', 'the gateway could not be reached')
      .and('contain.text', 'The key still works until it is registered or expires')

    // And no claim to the contrary anywhere on the card: the key's own state chip says the
    // withdrawal was signed but NOT delivered, never a plain "revoked" the gateway may disagree with.
    cy.get('[data-testid="api-access-console"]').should('not.contain.text', 'Revocation registered')
    cy.get('[data-testid="api-access-key-state"]').should('contain.text', 'revocation signed — not delivered')
  })

  it('[API-04] api-access.console — the MCP setup snippet carries a placeholder, never a credential, and points at the packaged console', () => {
    /*
     * The developer console proper is a spec-073 registry package, so the host card's job is to
     * hand the member a correct configuration and send them to it. What must not happen is the
     * generator writing a live token into example config a member will paste into a file.
     */
    stubMembership()
    openApiAccess()

    cy.get('[data-testid="api-access-console"]', { timeout: 40000 })
      .contains('button', 'Show setup snippet')
      .click()
    cy.get('[data-testid="api-access-snippet"]')
      .should('be.visible')
      .and('contain.text', 'FAIRWINS_API_URL')
      .and('contain.text', 'PASTE_YOUR_FW1_TOKEN_HERE')
    // Lowercase `fw1.` is the token prefix; the uppercase placeholder above is not a match for it.
    cy.get('[data-testid="api-access-snippet"]').should('not.contain.text', 'fw1.')

    // Signing lives in the host; the console lives in Apps. The card links to it rather than
    // pretending a package could mint a key.
    cy.get('[data-testid="api-access-console"]').find('a[href="/apps"]').should('exist')
  })

  it('[API-05] api-access.create-key — an unreadable membership and an inactive one are different sentences, and neither is the console', () => {
    /*
     * The three-state rule at the point it matters most, asserted in BOTH directions — because a
     * surface that renders one state correctly proves nothing about whether it can tell the two
     * apart.
     *
     * `readable: false` means the reference chain would not answer. Showing the upgrade offer there
     * would tell a paid member they are not one, on the strength of an RPC timeout. Tier 0 with a
     * chain that DID answer is the opposite fact, and it earns the upgrade route.
     */
    stubMembership({ fail: true })
    openApiAccess()

    /*
     * `fail: true` refuses EVERY call, `eth_chainId` included, so the provider cannot even finish
     * network detection — a deliberately hostile chain, and the arm is written that way on purpose.
     * Reaching the unreadable state from there is `useRoleDetails`' own doing: the read is bounded
     * by `MEMBERSHIP_READ_TIMEOUT_MS` and expires to `readable: false`. Before that bound existed
     * this assertion was a race against ethers' retry backoff, which is why it was ~40% red on
     * `staging` (issue #1463). Do NOT "fix" a future flake here by narrowing the stub to leave
     * `eth_chainId` answering: that would make the test agree with the app, and this arm exists to
     * hold the app to a member-facing promise — a spinner is not an answer.
     */
    cy.get('[data-testid="api-access-unreadable"]', { timeout: 40000 }).should('be.visible')
    cy.get('[data-testid="api-access-unreadable"]').contains('button', 'Try again').should('exist')
    cy.get('[data-testid="api-access-upgrade"]').should('not.exist')
    cy.get('[data-testid="api-access-console"]').should('not.exist')

    // Now a chain that answers, with nothing to report. The later intercept wins for every request
    // made after this line — and the transition is driven through the card's own "Try again"
    // control rather than a second cy.visit: visiting the SAME URL is a no-op in Cypress (no
    // reload, no refetch), which left the phase-1 state on screen and failed this test's first CI
    // run. Clicking retry also proves the recovery affordance actually recovers.
    stubMembership({ membership: encodeMembership({ tier: 0, expiresAt: 0 }) })
    cy.get('[data-testid="api-access-unreadable"]').contains('button', 'Try again').click()

    cy.get('[data-testid="api-access-upgrade"]', { timeout: 40000 })
      .should('be.visible')
      .and('contain.text', 'they never move funds')
    cy.get('[data-testid="api-access-unreadable"]').should('not.exist')
    cy.get('[data-testid="api-access-console"]').should('not.exist')
  })
})
