// =============================================================================
// 31-identity-access.cy.js
// Fast-tier E2E tests for endpoints, callsigns and compliance gating
// (specs 069 + 054 + 007).
//
// Issue #1241. Every flow here is decided on the member's own device, or by a
// single contract READ that changes what they are shown: an endpoint saved to
// device-scoped preferences, a credential redacted before it reaches the DOM, a
// tier gate, a screening verdict. None of it moves value, so admission rule 1
// puts all of it in the no-chain tier, and the reads are answered at the RPC
// boundary using the app's OWN ABI fragments.
//
// SPLIT FROM THE VERIFY SPEC DELIBERATELY. Seven heavy tests in one file killed
// the browser mid-run — a reproducible ECONNRESET after the fifth — and the fast
// tier is already over its per-leg budget (#1249). Two focused specs also shard
// better than one long one.
// =============================================================================

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const NETWORK_URL = '/wallet?tab=network'
const MEMBERSHIP_URL = '/wallet?tab=membership'

/** A counterparty the screening world below reports as restricted. */
const FLAGGED_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

/** Every shipped read provider this build resolves runs through publicnode. */
// BOTH rails, or the stub is a lie: since 480720bf every EVM mainnet has a drpc.org FAILOVER,
// so makeReadProvider builds a FallbackProvider — a stub that fails only the publicnode primary
// is answered by LIVE drpc, and "the chain is unreachable" quietly becomes "the chain answered
// tier 0 from production" (issue #1463; spec 42 and the passkey suite hit the same class).
const RPC_PATTERN = /publicnode\.com|drpc\.org/

/*
 * The WALLET's own transport, pointed at the same host the intercept covers.
 *
 * `cy.mockWeb3Provider` forwards every request to `rpcUrl`, which defaults to localhost:8545 — a
 * node that is not running in this tier, or worse, one running a DIFFERENT chain. A wallet that
 * claims 137 while reading from an 80002 node finds no contract at Polygon's guard address, the
 * read reverts, and the surface renders "Screening unavailable" — a truthful answer to a question
 * the test never meant to ask. Pointing it here puts the wallet's reads under the same stub as
 * the app's.
 */
const POLYGON_RPC = 'https://polygon-bor-rpc.publicnode.com'

/**
 * Answer the app's contract READS from `answers` (selector -> encoded result).
 *
 * Deliberately narrow: only the selectors a flow needs are listed, and everything else returns
 * `0x`, which ethers rejects — so a read this world does not model surfaces as the app's own
 * unavailable state rather than as a fabricated value.
 */
function stubReads(answers) {
  cy.intercept({ method: 'POST', url: RPC_PATTERN }, (req) => {
    const body = req.body
    const one = ({ method, params, id }) => {
      switch (method) {
        case 'eth_chainId':
          return { jsonrpc: '2.0', id, result: '0x89' }
        case 'net_version':
          return { jsonrpc: '2.0', id, result: '137' }
        case 'eth_blockNumber':
          return { jsonrpc: '2.0', id, result: '0x4000000' }
        case 'eth_getCode':
          return { jsonrpc: '2.0', id, result: '0x60806040' }
        case 'eth_call':
          return { jsonrpc: '2.0', id, result: answers[String(params?.[0]?.data || '').slice(0, 10)] ?? '0x' }
        default:
          return { jsonrpc: '2.0', id, result: '0x' }
      }
    }
    req.reply({ statusCode: 200, body: Array.isArray(body) ? body.map(one) : one(body || {}) })
  }).as('identityRpc')
}

describe('Endpoints, callsigns and compliance (specs 069 / 054 / 007)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[EP-01] endpoints.save-custom-rpc — a member endpoint is saved, disclosed as theirs, and shown redacted', () => {
    const MY_HOST = 'https://my-own-node.example'
    const MY_NODE = `${MY_HOST}/rpc/secret-path`

    cy.mockWeb3Provider({ account: ACCOUNT, preAuthorized: true })
    cy.visit(NETWORK_URL)
    cy.get('.network-endpoint-row', { timeout: 40000 }).should('exist')

    /*
     * The FIRST network card, whichever it is. The visible label is "Edit endpoints" — the
     * network name lives only in the button's accessible name — so a regex expecting the name in
     * the text matches nothing. Which network this is does not matter to the claim: what is under
     * test is that a member endpoint is saved and disclosed as theirs.
     */
    cy.contains('button', /^Edit endpoints$/).first().click()
    cy.get('.network-endpoint-form input[type="url"]').first().as('url')
    cy.get('@url').clear().type(MY_NODE)
    cy.get('.network-endpoint-form').contains('button', /^Save$/).click()

    cy.get('.network-endpoint-saved', { timeout: 20000 }).should('be.visible')

    /*
     * The row now says the route is the member's. "Your endpoint" versus "App default" is the
     * whole disclosure — a member has to be able to see which one is in force.
     *
     * And it shows the endpoint REDACTED to its host: a provider URL routinely carries the key in
     * its path, so the path is replaced with `/…` even for a URL the member typed themselves.
     * Asserting the host is present AND the path absent is what makes this a redaction test rather
     * than a rendering test.
     */
    cy.get('.network-endpoint-form').contains('button', /^Close$/).click()
    cy.contains('.network-endpoint-row', MY_HOST)
      .find('.network-endpoint-source')
      .should('contain.text', 'Your endpoint')
    cy.contains('.network-endpoint-row', MY_HOST)
      .find('.network-endpoint-url')
      .should('contain.text', `${MY_HOST}/…`)
      .and('not.contain.text', 'secret-path')
  })

  it('[EP-02] endpoints.wrong-chain-refused — an endpoint answering with another chain id is refused', () => {
    /*
     * The failure this prevents is silent and total: an endpoint that answers for a different
     * network would serve that network's state into every read for this one, and nothing else in
     * the app would notice. So a TESTED mismatch is a hard stop at save, not a warning.
     */
    const WRONG_CHAIN_NODE = 'https://answers-for-another-chain.example/rpc'

    cy.intercept({ method: 'POST', url: /answers-for-another-chain\.example/ }, (req) => {
      // 0x2a (42) is deliberately a chain NO card in this list is for. An answer of `0x1` would be
      // correct for the Ethereum card the test happens to open first, and the probe would pass —
      // which is the right behaviour and the wrong test.
      const one = ({ id }) => ({ jsonrpc: '2.0', id, result: '0x2a' })
      const body = req.body
      req.reply({ statusCode: 200, body: Array.isArray(body) ? body.map(one) : one(body || {}) })
    }).as('wrongChain')

    cy.mockWeb3Provider({ account: ACCOUNT, preAuthorized: true })
    cy.visit(NETWORK_URL)
    cy.contains('button', /^Edit endpoints$/, { timeout: 40000 }).first().click()

    cy.get('.network-endpoint-form input[type="url"]').first().clear().type(WRONG_CHAIN_NODE)
    cy.get('.network-endpoint-form').contains('button', /^Test$/).click()

    cy.get('.network-endpoint-probe.failed', { timeout: 30000 })
      .should('be.visible')
      // The message names the chain it actually serves — "it did not work" would leave the member
      // guessing at a misconfiguration that is entirely knowable.
      .and('contain.text', 'serves chain 42')

    // And the refusal has teeth: saving after a tested mismatch does not go through.
    cy.get('.network-endpoint-form').contains('button', /^Save$/).click()
    cy.get('.network-endpoint-saved').should('not.exist')
    cy.get('.network-endpoint-form .network-endpoint-error').should('be.visible')
  })

  it('[EP-03] endpoints.credentials-redacted — the key is never rendered back into the page', () => {
    /*
     * The credential rides in a HEADER and is device-scoped, so the only way it can leak to a
     * shoulder, a screenshot or a support ticket is by being rendered. This asserts it appears
     * nowhere in the page's text after saving — including inside the endpoint row, which shows a
     * URL that routinely carries a key in its path and is redacted for exactly that reason.
     */
    const SECRET = 'sk-e2e-do-not-render-me-4f31c0'
    const HOST = 'https://keyed-provider.example'
    const NODE = `${HOST}/rpc`

    cy.mockWeb3Provider({ account: ACCOUNT, preAuthorized: true })
    cy.visit(NETWORK_URL)
    cy.contains('button', /^Edit endpoints$/, { timeout: 40000 }).first().click()

    /*
     * Answer the endpoint the member is about to save.
     *
     * Once saved it becomes the route EVERY Polygon read takes, including the ones the reload
     * below issues. Left unanswered it is a host that does not resolve, and the retries outlived
     * the test: the NEXT test's `visit` met a browser still chasing them and the run died with
     * ECONNRESET — reproducibly, and nowhere near the cause. A saved endpoint that answers is also
     * simply the honest arrangement.
     */
    cy.intercept({ method: 'POST', url: /keyed-provider\.example/ }, (req) => {
      const one = ({ id }) => ({ jsonrpc: '2.0', id, result: '0x89' })
      const body = req.body
      req.reply({ statusCode: 200, body: Array.isArray(body) ? body.map(one) : one(body || {}) })
    }).as('memberEndpoint')

    cy.get('.network-endpoint-form input[type="url"]').first().clear().type(NODE)
    cy.get('.network-endpoint-form select').first().select('header')
    cy.get('.network-endpoint-form input[placeholder="x-api-key"]').clear().type('x-api-key')
    cy.get('.network-endpoint-secret input').clear().type(SECRET)

    // Masked while typing, before anything is saved.
    cy.get('.network-endpoint-secret input').should('have.attr', 'type', 'password')

    cy.get('.network-endpoint-form').contains('button', /^Save$/).click()
    cy.get('.network-endpoint-saved', { timeout: 20000 }).should('be.visible')
    cy.get('.network-endpoint-form').contains('button', /^Close$/).click()

    // The row discloses THAT a key is set — which the member needs — without disclosing it.
    cy.contains('.network-endpoint-row', HOST)
      .find('.network-endpoint-auth-badge')
      .should('contain.text', 'API key')

    cy.get('body').invoke('text').should('not.contain', SECRET)

    // And still not after a reload, when the value is re-read from storage rather than held in a
    // form the member just filled in.
    cy.reload()
    cy.get('.network-endpoint-row', { timeout: 40000 }).should('exist')
    cy.get('body').invoke('text').should('not.contain', SECRET)
  })

  it('[CS-01] callsign.gated-below-gold — below Gold the member is told why, and offered the way up', () => {
    /*
     * Callsigns are OPTIONAL and Gold-gated, and the gate's job is to be an actionable route
     * rather than a dead disabled control. The tier read is answered here as `None`, which is what
     * a member who has never bought a membership genuinely reads back.
     */
    cy.task('identityWorld', { tier: 0 }).then(({ answers }) => {
      stubReads(answers)
      /*
       * ON POLYGON, explicitly. The callsign registry is deployed on Polygon in this build, and
       * the panel reads it for the CONNECTED chain — so the mock's default 1337 makes the panel
       * answer "not available on this network yet", which is correct behaviour and a different
       * test. The gate under test is the TIER gate, which only exists where a registry does.
       */
      cy.mockWeb3Provider({ account: ACCOUNT, networkId: 137, rpcUrl: POLYGON_RPC, preAuthorized: true })
      cy.visit(MEMBERSHIP_URL)

      cy.get('[data-testid="callsign-upgrade"]', { timeout: 40000 })
        .should('be.visible')
        .and('contain.text', 'Gold')
      // The sentence that keeps this a perk rather than a gate on anything that matters.
      cy.get('[data-testid="callsign-upgrade"]').should('contain.text', 'never need one to wager')
      cy.get('[data-testid="callsign-upgrade"]').contains('button', /Membership/i).should('be.visible')
    })
  })

  it('[CM-01] compliance.sanctioned-address-refused — a screened recipient is refused before any transaction is offered', () => {
    /*
     * The refusal has to land on the RECIPIENT, before a member has committed to anything — which
     * is why this drives the home screen's own address entry rather than a confirm step. The
     * screening read is answered as "not allowed"; everything else about the panel is real.
     */
    cy.task('identityWorld', { allowed: false }).then(({ answers }) => {
      stubReads(answers)
      cy.mockWeb3Provider({ account: ACCOUNT, networkId: 137, rpcUrl: POLYGON_RPC, preAuthorized: true, realBalances: true })
      cy.visit('/fairwins')

      cy.get('.pay-panel', { timeout: 40000 }).should('be.visible')
      cy.get('#pay-to').clear().type(FLAGGED_ADDRESS, { delay: 0 })

      cy.contains('.fm-error-banner', /flagged by sanctions screening/i, { timeout: 30000 })
        .should('be.visible')

      // And the estate-wide pill (issue #1458) reaches the same verdict from the same read, naming
      // the FairWins guard as the list that said no — the pill and the gate never disagree here.
      cy.get('.ab-screen-notice[role="alert"]', { timeout: 30000 })
        .should('be.visible')
        .and('contain.text', 'FairWins sanctions guard')

      // And the refusal is not cosmetic: the action is withheld, not merely annotated.
      cy.get('.pay-panel .fm-success-actions')
        .contains('button', /^Pay$/)
        .should('be.disabled')
    })
  })

  it('[CS-02] callsign.resolve-in-address-entry — a %callsign resolves to its owner, shown before any value moves', () => {
    /*
     * The address field is where a callsign earns its keep, and where it is most dangerous: a
     * member typing `%name` is about to send somebody money. So the surface resolves it and shows
     * the FULL resolved address for confirmation before any value-bearing action (FR-011) rather
     * than silently substituting one.
     *
     * Nothing on the value path is gated on owning a callsign, and this flow does not assert that
     * it is — a test that required a callsign to send would be asserting a rule the product does
     * not have.
     */
    const CALLSIGN = 'chipprbots'
    const OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

    cy.task('identityWorld', { callsign: CALLSIGN, owner: OWNER, allowed: true }).then(({ answers }) => {
      stubReads(answers)
      cy.mockWeb3Provider({ account: ACCOUNT, networkId: 137, rpcUrl: POLYGON_RPC, preAuthorized: true, realBalances: true })
      cy.visit('/fairwins')

      cy.get('.pay-panel', { timeout: 40000 }).should('be.visible')
      cy.get('#pay-to').clear().type(`%${CALLSIGN}`, { delay: 0 })

      // The confirmation line names the callsign AND the address it resolved to. Both halves
      // matter: the name alone is what a member typed, and the address alone is unreadable.
      cy.contains(`%${CALLSIGN}`, { timeout: 30000 }).should('be.visible')
      cy.contains('resolves to', { timeout: 30000 }).should('be.visible')

      // The resolved owner reaches the form, not just the hint — the abbreviated form the hint
      // renders is checked at its ends so this cannot pass on a truncation that hid a different
      // address in the middle.
      cy.contains('code', OWNER.slice(0, 6)).should('contain.text', OWNER.slice(-4))
    })
  })

  it('[TN-01] tenant.brand-resolves-from-manifest — the build shows its own tenant, and no other', () => {
    /*
     * Tenant selection is BUILD-TIME and one origin serves exactly one tenant, so the failure this
     * guards is a build that renders somebody else's identity — a brand leak, not a layout bug.
     *
     * Every expected value comes from `tenants/<id>/manifest.json` read on the Node side rather
     * than from constants written here: comparing the page to a spec's own copy would only prove
     * the two agree with each other. The names it must NOT show are derived the same way, from
     * whichever other tenants exist.
     */
    cy.task('tenantManifests', { id: 'fairwins' }).then((t) => {
      expect(t.ok, 'the default tenant manifest was read').to.equal(true)
      expect(t.others, 'there is another tenant to be confused with').to.have.length.greaterThan(0)

      /*
       * The LANDING page, and no wallet. A tenant's brand is what a visitor meets before anything
       * else, so this is where it is most on display — and `/fairwins` deliberately hides the page
       * footer (the nav drawer carries its own copy), so the copyright would simply be absent
       * there for a reason that has nothing to do with tenancy.
       */
      // `?stay=1` is the app's own "do not forward me past the landing page" switch
      // (`LandingRoute`): without it a browser carrying any wallet history is redirected straight
      // into the app, which is correct behaviour and lands on a route that hides the footer.
      cy.visit('/?stay=1')
      cy.get('footer', { timeout: 40000 }).should('exist')

      // The document title is the manifest's, verbatim.
      cy.title().should('equal', t.htmlTitle)

      // The copyright is the manifest's legal notice, not a hardcoded string in a component.
      cy.get('body').invoke('text').should('contain', t.copyrightNotice)

      // And the logo is the manifest's asset path.
      cy.get(`img[src="${t.logo}"], img[src$="${t.logo.split('/').pop()}"]`).should('exist')

      // No other tenant's identity appears anywhere on the page.
      cy.get('body').invoke('text').then((text) => {
        for (const other of t.others) {
          expect(text, `no trace of tenant "${other}"`).to.not.contain(other)
        }
      })
    })
  })

})
