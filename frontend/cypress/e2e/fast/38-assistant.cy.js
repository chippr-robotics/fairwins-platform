// =============================================================================
// 38-assistant.cy.js
// Fast-tier E2E tests for the opt-in agentic assistant (spec 095).
//
// Spec directory `specs/095-member-api-agentic-access/`; tracking issue #TBD
// (the matrix row `095-member-api-agentic-access` carries the same reference).
// Flows: `assistant.opt-in`, `assistant.honest-unreachable`,
// `assistant.memory-clear`.
//
// ── WHY THIS IS IN THE NO-CHAIN TIER ────────────────────────────────────────
// Nothing here costs a member anything. The assistant reads and explains; it
// never signs a transaction and never submits one, and the one signature it does
// ask for authorises a 24-hour READ capability that cannot move value. So the
// admission rule in docs/developer-guide/e2e-testing-policy.md puts all of it
// here rather than in the on-chain tier.
//
// ── WHAT IS STUBBED, AND WHY EACH SEAM IS THE RIGHT ONE ─────────────────────
// 1. MEMBERSHIP is answered at the RPC TRANSPORT, exactly as 29-miniapp-catalog
//    answers the registry: the app makes its real read against the membership
//    reference chain, decodes it with its own ABI, and only the transport is
//    ours. Anything unanswered returns '0x', which ethers rejects — so a read
//    this file forgot surfaces as the app's honest unavailable state rather than
//    as a fabricated tier.
// 2. THE GATEWAY IS NOT STUBBED IN [AS-02]. The no-chain dev server points
//    VITE_RELAYER_URL at a port nothing serves, so "the assistant service could
//    not be reached" is the world the app is already in. That test needs no
//    intercept at all, which is the strongest possible version of it: the
//    failure is real.
// 3. THE MEMBER'S SIGNATURE IS THE MOCK'S. `eth_signTypedData_v4` returns a
//    deterministic per-account value that does NOT verify (see the note beside
//    it in cypress/support/commands.js). That is sound here because the session
//    grant is verified by the GATEWAY, which this tier stubs or refuses — the
//    signature never has to be real for the ceremony to be real.
//
// ── THE ASSERTION THIS FILE EXISTS FOR ──────────────────────────────────────
// An assistant that answers when its backend did not is the single worst
// failure this surface can have, because the member cannot tell an invented
// reply from a real one. [AS-02] is that test: an unreachable gateway must
// produce a named error and a retry, and NO assistant bubble.
// =============================================================================

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

/**
 * The Assistant card. Card ids double as `data-attention` markers and as deep-link hashes (spec
 * 081), and the id did not change when spec 104 moved the card off Settings onto its own tab in
 * Tools — so `/wallet?tab=settings#assistant-prefs` still resolves here, by redirect. This file
 * names the DESTINATION rather than the redirect: what these tests are about is the card, and a
 * redirect asserted in three places is a redirect that has to be changed in three places. The
 * redirect itself is held once, in 47-assistant-rails.cy.js [GT-07].
 */
const ASSISTANT_TAB = '/wallet?tab=assistant#assistant-prefs'

/** Wallet-scoped preference key — `lib/assistant/assistantPrefs.js` + `utils/userStorage.js`. */
const PREFS_KEY = `fw_user_${ACCOUNT.toLowerCase()}_assistant_prefs`

/**
 * Every shipped read provider this build resolves runs through publicnode, and membership resolves
 * to Polygon on a mainnet build (`membershipChainId()` in src/config/networks.js).
 */
const RPC_PATTERN = /publicnode\.com/

/*
 * ── The membership answer, encoded by hand ─────────────────────────────────────────────────────
 *
 * `identityWorld` (cypress.config.js) encodes `getActiveTier`, not `getMembership`, and adding a
 * Node task is outside this change — so the two values below are stated here with their provenance.
 *
 *   selector — keccak256("getMembership(address,bytes32)")[0..4). The signature is the one declared
 *              in frontend/src/abis/MembershipManager.js, which is also the ABI
 *              `hooks/useRoleDetails.js` decodes the answer with: a field added to that struct makes
 *              this decode loudly wrong rather than silently shifting a column.
 *   result   — the return is the STATIC tuple
 *              (uint8 tier, uint64 expiresAt, uint32 monthCount, uint32 activeCount,
 *               uint64 monthAnchor),
 *              so it encodes as five 32-byte words with no head offset.
 *
 * The same two constants appear in 39-api-access.cy.js, which gates on the same read.
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

/**
 * Answer the membership read over the reference chain's RPC, and the handful of chain-plumbing
 * calls a provider makes on the way. `fail: true` refuses every call instead — an unreadable
 * membership, which is a different fact from "no membership" and must never render as one.
 */
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
 * The gateway's own answer shape, from `assistant.chat()` in
 * services/relay-gateway/src/memberApi/assistant.js — `{ reply, model, usage }`, with counts that
 * stay null rather than becoming 0 when the provider reported none. The reply names an in-app path
 * on purpose: turning one into a shortcut is `lib/assistant/replyLinks.js`'s whole job.
 */
const CHAT_BODY = {
  reply:
    'Membership lives on one chain per environment, and yours is readable from /wallet?tab=membership.',
  model: 'claude-sonnet-5',
  usage: { inputTokens: 412, outputTokens: 63 },
}

/** Land on the Assistant card with the assistant already opted in — the precondition, not the test. */
function visitOptedIn({ retainMemory = true } = {}) {
  cy.mockWeb3Provider({ account: ACCOUNT, networkId: WALLET_CHAIN_ID, preAuthorized: true })
  cy.visit(ASSISTANT_TAB, {
    onBeforeLoad(win) {
      win.localStorage.setItem(PREFS_KEY, JSON.stringify({ enabled: true, retainMemory }))
    },
  })
}

/** Open the panel and get past the one-signature session authorisation. */
function openPanelAndAuthorize() {
  cy.get('[data-testid="assistant-launcher"]', { timeout: 40000 }).should('be.visible').click()
  cy.get('.assistant-sheet[role="dialog"]', { timeout: 20000 }).should('be.visible')

  // It never asks silently: the panel states what the signature authorises before asking for it.
  cy.get('[data-testid="assistant-authorize"]')
    .should('be.visible')
    .and('contain.text', 'no transaction, no fee, nothing moves')
  cy.get('[data-testid="assistant-authorize-button"]').click()
  cy.get('[data-testid="assistant-thread"]', { timeout: 20000 }).should('be.visible')
}

function ask(text) {
  cy.get('.assistant-sheet #assistant-input').type(text, { delay: 0 })
  cy.get('.assistant-sheet').contains('button', 'Send').click()
}

describe('Assistant (spec 095)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[AS-01] assistant.opt-in — the assistant exists only after Tools ▸ Assistant turns it on, and stops existing when it is turned off', () => {
    /*
     * DEFAULT OFF is not a UI state here, it is the absence of the feature: no launcher, no
     * session, nothing sent. So "off" has to be proved by absence at both ends — before the switch
     * and after it is switched back — rather than by a disabled-looking button, which would still
     * be a surface that exists.
     */
    stubMembership()
    cy.mockWeb3Provider({ account: ACCOUNT, networkId: WALLET_CHAIN_ID, preAuthorized: true })
    cy.visit(ASSISTANT_TAB)

    // The deep link OPENS the card rather than leaving the member at a closed heading.
    cy.get('[data-attention="assistant-prefs"]', { timeout: 40000 })
      .should('have.attr', 'data-open', 'true')

    cy.get('[data-testid="assistant-enable-switch"]').should('have.attr', 'aria-checked', 'false')
    cy.get('[data-testid="assistant-launcher"]').should('not.exist')

    cy.get('[data-testid="assistant-enable-switch"]').scrollIntoView().click()
    cy.get('[data-testid="assistant-enable-switch"]').should('have.attr', 'aria-checked', 'true')
    cy.get('[data-testid="assistant-launcher"]', { timeout: 40000 }).should('be.visible')

    cy.get('[data-testid="assistant-enable-switch"]').scrollIntoView().click()
    cy.get('[data-testid="assistant-enable-switch"]').should('have.attr', 'aria-checked', 'false')
    cy.get('[data-testid="assistant-launcher"]').should('not.exist')
  })

  it('[AS-02] assistant.honest-unreachable — an unreachable service is named, retryable, and never answered for', () => {
    /*
     * NO INTERCEPT, DELIBERATELY. The no-chain dev server configures the gateway at a port nothing
     * serves, so this is the app's real behaviour against a real transport failure rather than a
     * posed one.
     *
     * Three separate claims, and the surface turns on all three: the failure is STATED, a retry is
     * OFFERED (an unreachable service is exactly the case that recovers), and there is NO assistant
     * bubble. A reply invented while the backend was silent is indistinguishable from a real one.
     */
    stubMembership()
    visitOptedIn()
    openPanelAndAuthorize()
    ask('what is my membership tier')

    cy.get('[data-testid="assistant-error"]', { timeout: 40000 })
      .should('be.visible')
      .and('have.attr', 'role', 'alert')
      .and('contain.text', 'could not be reached')
    cy.get('[data-testid="assistant-error"]').contains('button', 'Try again').should('exist')

    cy.get('.assistant-panel__message--assistant').should('not.exist')
    // The member's own turn is still on screen — it was not swallowed along with the failure.
    cy.get('.assistant-panel__message--user').should('contain.text', 'what is my membership tier')
  })

  it('[AS-03] assistant.memory-clear — an exchange is remembered on this device, counted on the Assistant tab, and Clear takes the count to nothing', () => {
    /*
     * "Clear" that does not say what it cleared is a promise. A number the member watches go to
     * zero is a fact — which is why the count is asserted before and after rather than the button
     * merely being pressed.
     */
    stubMembership()
    cy.intercept('POST', '**/v1/member/assistant/chat', { statusCode: 200, body: CHAT_BODY }).as('chat')
    visitOptedIn()
    openPanelAndAuthorize()
    ask('where do I check my membership')

    cy.wait('@chat').its('request.body.messages').should('have.length', 1)
    cy.get('.assistant-panel__message--assistant', { timeout: 20000 })
      .should('contain.text', 'Membership lives on one chain')
    // The disclaimer rides under EVERY reply, not once at the top where it scrolls away.
    cy.get('.assistant-panel__disclaimer').should('contain.text', 'never signs or submits')
    // An in-app path the assistant mentioned becomes a shortcut, and it is an in-app href.
    cy.get('.assistant-panel__links a')
      .should('have.attr', 'href')
      .and('contain', 'tab=membership')

    cy.get('.assistant-sheet .action-sheet__close').click()
    cy.get('.assistant-sheet[role="dialog"]').should('not.exist')

    // Both turns are held on this device — the count is read from the same store the panel wrote.
    cy.get('[data-testid="assistant-memory-count"]')
      .should('contain.text', '2 messages stored on this device')

    cy.get('[data-testid="assistant-prefs-panel"]')
      .contains('button', 'Clear conversation memory')
      .click()

    cy.get('[data-testid="assistant-memory-count"]')
      .should('contain.text', 'Nothing stored on this device')
    cy.get('[data-testid="assistant-prefs-panel"]')
      .contains('button', 'Clear conversation memory')
      .should('be.disabled')

    // And it is gone from storage, not merely from the panel's state.
    cy.window({ log: false }).then((win) => {
      expect(
        win.localStorage.getItem(`fw_user_${ACCOUNT.toLowerCase()}_assistant_memory_v1`),
        'the remembered conversation is removed from this device'
      ).to.equal(null)
    })
  })
})
