// =============================================================================
// 47-assistant-rails.cy.js
// Fast-tier E2E tests for the GutterToken assistant rail, the provider choice,
// the client-side tool loop and the move of the agent controls into Tools
// (spec 104).
//
// Spec directory `specs/104-guttertoken-assistant-rail/`. Flows:
// `byok.key-lifecycle`, `byok.non-member-chat`, `byok.honest-failures`,
// `provider.choice`, `tools.honest-progress`, `controls.moved-to-tools` — the
// matrix rows in frontend/cypress/coverage/matrix.json cite the case ids below.
//
// ── WHY THIS IS IN THE NO-CHAIN TIER ────────────────────────────────────────
// Nothing here is a transaction. The member signs at most one thing — the
// 24-hour READ grant of spec 095, which cannot move value — and the money that
// IS at stake on this rail is the member's own prepaid GutterToken balance,
// spent at a third party we intercept. There is no escrow, no fee and no chain
// write, so the admission rule in docs/developer-guide/e2e-testing-policy.md
// keeps all of it out of the on-chain tier.
//
// ── WHAT IS STUBBED, AND WHY EACH SEAM IS THE RIGHT ONE ─────────────────────
// 1. MEMBERSHIP is answered at the RPC TRANSPORT, exactly as 38-assistant does:
//    the app makes its real read against the membership reference chain and
//    decodes it with its own ABI; only the transport is ours. Tier 0 and tier 3
//    are the same stub with a different word, which is what lets one file drive
//    the non-member and the paid-member journeys without a second mechanism.
// 2. GUTTERTOKEN IS ALWAYS INTERCEPTED. `api.guttertokens.com` is a real third
//    party that bills a real balance: every test here declares the intercept
//    before the app can reach it, and no test depends on the network. The two
//    endpoints are the two the rail uses — `GET /v1/models` (the save check) and
//    `POST /v1/messages` (the turn).
// 3. THE FAIRWINS GATEWAY IS INTERCEPTED ONLY TO COUNT IT. The no-chain dev
//    server points VITE_RELAYER_URL at a port nothing serves, so the chat route
//    is unreachable by default; where a test needs to prove nothing was sent
//    there, the route is intercepted purely so `@gwChat.all` can be asserted at
//    length 0 — an intercept that never fires is a stronger claim than a
//    transport failure, because a failure is what would have happened anyway.
// 4. THE MEMBER'S SIGNATURE IS THE MOCK'S. `eth_signTypedData_v4` returns a
//    deterministic value that does not verify (see cypress/support/commands.js).
//    Sound here for the same reason as in 38: the grant is verified by the
//    GATEWAY, and every gateway read this file makes is stubbed or refused.
//
// ── THE ASSERTIONS THIS FILE EXISTS FOR ─────────────────────────────────────
// · FairWins is not in the path (SC-001). [GT-03] asserts an ABSENCE: a
//   non-member is answered while the FairWins chat route receives nothing.
// · The member's credit is theirs (SC-002). [GT-04] holds each GutterToken
//   failure to its own sentence and its own action, with NO assistant bubble —
//   an invented reply is the one failure a member cannot detect.
// · The key is a credential (SC-003). [GT-01] refuses to save a key GutterToken
//   rejected, sweeps the DOM for the raw value, and proves exactly one storage
//   entry holds it.
// =============================================================================

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const LOWER = ACCOUNT.toLowerCase()

/** Card ids double as `data-attention` markers and as deep-link hashes (spec 081). */
const ASSISTANT_TAB = '/wallet?tab=assistant'
const ASSISTANT_PREFS_URL = `${ASSISTANT_TAB}#assistant-prefs`
const GUTTERTOKEN_KEY_URL = `${ASSISTANT_TAB}#guttertoken-key`

/** Wallet-scoped stores — `lib/assistant/assistantPrefs.js`, `lib/assistant/guttertokenKeyStore.js`. */
const PREFS_KEY = `fw_user_${LOWER}_assistant_prefs`
const GUTTERTOKEN_KEY_STORAGE = `fw_user_${LOWER}_assistant_guttertoken_key_v1`

/** The third party, verbatim from `lib/assistant/providers/guttertoken.js`. Never reached for real. */
const GT_MODELS_URL = 'https://api.guttertokens.com/v1/models'
const GT_MESSAGES_URL = 'https://api.guttertokens.com/v1/messages'
const GT_BILLING_URL = 'https://app.guttertokens.com/billing'

/**
 * Every shipped read provider this build resolves runs through publicnode, and membership resolves
 * to Polygon on a mainnet build (`membershipChainId()` in src/config/networks.js).
 */
const RPC_PATTERN = /publicnode\.com/

/*
 * ── The membership answer, encoded by hand ─────────────────────────────────────────────────────
 *
 * `identityWorld` (cypress.config.js) encodes `getActiveTier`, not `getMembership`, and adding a
 * Node task is outside this change — so the two values below are stated here with their provenance,
 * as they are in 38-assistant.cy.js and 39-api-access.cy.js, which gate on the same read.
 *
 *   selector — keccak256("getMembership(address,bytes32)")[0..4). The signature is the one declared
 *              in frontend/src/abis/MembershipManager.js, which is also the ABI
 *              `hooks/useRoleDetails.js` decodes the answer with: a field added to that struct makes
 *              this decode loudly wrong rather than silently shifting a column.
 *   result   — the return is the STATIC tuple
 *              (uint8 tier, uint64 expiresAt, uint32 monthCount, uint32 activeCount,
 *               uint64 monthAnchor), so it encodes as five 32-byte words with no head offset.
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
/** A chain that ANSWERED, with nothing to report. Not the same fact as a chain that would not answer. */
const NO_MEMBERSHIP = encodeMembership({ tier: 0, expiresAt: 0 })

/**
 * A key of the shape `validateGutterTokenKeyFormat` accepts. Obviously synthetic, and it is never
 * sent anywhere real: both GutterToken endpoints are intercepted before the app can use it.
 */
const RAW_KEY = 'sk-fairwins-e2e-not-a-real-guttertoken-key-abcd'
/** What the app may ever show of it: `sk-…` plus the last four characters, and nothing more. */
const REDACTED_KEY = 'sk-…abcd'

/**
 * Answer the membership read over the reference chain's RPC, and the handful of chain-plumbing
 * calls a provider makes on the way. Anything unanswered returns '0x', which ethers rejects — so a
 * read this file forgot surfaces as the app's honest unavailable state rather than a fabricated tier.
 */
function stubMembership({ membership = ACTIVE_MEMBERSHIP } = {}) {
  cy.intercept({ method: 'POST', url: RPC_PATTERN }, (req) => {
    const one = (payload) => {
      const { method, params, id } = payload
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
 * The FairWins chat route, intercepted so a test can COUNT it. `@gwChat.all` at length 0 is the
 * whole of SC-001; the 200 body exists only so an accidental call is a visible wrong answer rather
 * than a network error indistinguishable from the dev server's dead port.
 */
function stubFairWinsChat(reply = 'Answered by the FairWins gateway.') {
  cy.intercept('POST', '**/v1/member/assistant/chat', {
    statusCode: 200,
    body: { reply, model: 'claude-sonnet-5', usage: { inputTokens: 11, outputTokens: 7 } },
  }).as('gwChat')
}

/**
 * One GutterToken turn per entry, in order; the last entry answers every later call. Each entry is
 * a `req.reply` argument, so a test can vary status, headers and delay per round — which is what
 * [GT-06] needs to hold a tool round on screen long enough to read it.
 */
function stubGutterTokenTurns(responses) {
  let call = 0
  cy.intercept({ method: 'POST', url: GT_MESSAGES_URL }, (req) => {
    const answer = responses[Math.min(call, responses.length - 1)]
    call += 1
    req.reply(answer)
  }).as('gtMessages')
}

/** The Anthropic-shaped body GutterToken answers with (`providers/guttertoken.js` reads exactly this). */
const gtText = (text) => ({
  statusCode: 200,
  body: {
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    model: 'claude-opus-5',
    usage: { input_tokens: 120, output_tokens: 24 },
  },
})

/** Seed the device: the opt-in preference, the chosen rail, and optionally a saved key. */
function seedDevice(win, { enabled = true, provider = 'fairwins', retainMemory = false, key = null } = {}) {
  win.localStorage.setItem(PREFS_KEY, JSON.stringify({ enabled, retainMemory, provider }))
  if (key) {
    win.localStorage.setItem(GUTTERTOKEN_KEY_STORAGE, JSON.stringify({ v: 1, key, savedAt: 1750000000000 }))
  }
}

function visitWith(url, seed) {
  cy.mockWeb3Provider({ account: ACCOUNT, networkId: WALLET_CHAIN_ID, preAuthorized: true })
  cy.visit(url, { onBeforeLoad: (win) => seedDevice(win, seed) })
}

/** Open the floating launcher and wait for the sheet. */
function openPanel() {
  cy.get('[data-testid="assistant-launcher"]', { timeout: 40000 }).should('be.visible').click()
  cy.get('.assistant-sheet[role="dialog"]', { timeout: 20000 }).should('be.visible')
}

function ask(text) {
  cy.get('.assistant-sheet #assistant-input').type(text, { delay: 0 })
  cy.get('.assistant-sheet').contains('button', 'Send').click()
}

/**
 * The raw key appears in the DOM nowhere, and in storage under exactly one key.
 *
 * `cy.assertNoClearSecret` is deliberately NOT used: it forbids the secret in every storage entry,
 * and this credential is stored at rest on purpose (the spec-069 RPC-credential precedent, stated
 * in `guttertokenKeyStore.js`). The invariant that DOES hold is narrower and is the one asserted
 * here — one home, redacted everywhere else.
 */
function assertKeyOnlyInItsOwnStore() {
  cy.window({ log: false }).then((win) => {
    const needle = RAW_KEY.toLowerCase()
    const holders = Object.keys(win.localStorage).filter((k) =>
      String(win.localStorage.getItem(k) || '').toLowerCase().includes(needle)
    )
    expect(holders, 'the raw key lives in exactly one storage entry').to.deep.equal([
      GUTTERTOKEN_KEY_STORAGE,
    ])
    const session = Object.keys(win.sessionStorage)
      .map((k) => win.sessionStorage.getItem(k) || '')
      .join('\n')
      .toLowerCase()
    expect(session, 'the raw key is not in sessionStorage').to.not.include(needle)
    expect(
      win.document.documentElement.innerHTML.toLowerCase(),
      'the raw key is not in the DOM'
    ).to.not.include(needle)
  })
}

describe('Assistant rails (spec 104)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[GT-01] byok.key-lifecycle — a key GutterToken refuses is not saved, a key it could not check is saved with the failure shown, and the raw value stays out of the DOM', () => {
    /*
     * The two save outcomes are the point, and they are OPPOSITE on purpose (spec 069's rule for
     * saving an endpoint, applied to a credential):
     *   · REFUSED (401)      → refuse the save. Storing a key the service has just said is invalid
     *                          would make the Assistant tab claim a rail that cannot answer.
     *   · UNREACHABLE        → save it, and show the failure. A timeout is a fact about the network,
     *                          not about the key, and refusing here strands a member on a flaky
     *                          connection with a perfectly good key.
     */
    stubMembership({ membership: NO_MEMBERSHIP })
    cy.intercept({ method: 'GET', url: GT_MODELS_URL }, { statusCode: 401, body: { error: { type: 'authentication_error' } } }).as('models')
    visitWith(GUTTERTOKEN_KEY_URL, { provider: 'guttertoken' })

    // The deep link OPENS the card rather than leaving the member at a closed heading.
    cy.get('[data-attention="guttertoken-key"]', { timeout: 40000 }).should('have.attr', 'data-open', 'true')
    cy.get('[data-testid="guttertoken-key-value"]').should('contain.text', 'None')

    cy.get('[data-testid="guttertoken-key-add"]').scrollIntoView().click()
    cy.get('[data-testid="guttertoken-key-sheet"]', { timeout: 20000 }).should('be.visible')

    // What the key authorises is stated BEFORE the paste field, not after it.
    cy.get('[data-testid="guttertoken-key-sheet"]')
      .should('contain.text', 'your prepaid credits')
      .and('contain.text', 'stored on this device only')

    cy.a11yScan({ context: '.guttertoken-key-sheet[role="dialog"]', label: 'guttertoken key sheet' })

    cy.get('[data-testid="guttertoken-key-input"]').type(RAW_KEY, { delay: 0, log: false })
    cy.get('[data-testid="guttertoken-key-save"]').click()
    cy.wait('@models')

    cy.get('[data-testid="guttertoken-key-status"]')
      .should('be.visible')
      .and('have.attr', 'role', 'alert')
      .and('contain.text', 'did not accept this key')
      .and('contain.text', 'Nothing was saved.')
    cy.window({ log: false }).then((win) => {
      expect(
        win.localStorage.getItem(GUTTERTOKEN_KEY_STORAGE),
        'a refused key is not written to this device'
      ).to.equal(null)
    })

    // Now GutterToken cannot be reached at all. The later intercept wins for every request after
    // this line; the pasted value is still in the form, which is why the member can simply retry.
    cy.intercept({ method: 'GET', url: GT_MODELS_URL }, { forceNetworkError: true }).as('modelsDown')
    cy.get('[data-testid="guttertoken-key-save"]').click()

    cy.get('[data-testid="guttertoken-key-status"]', { timeout: 20000 })
      .should('be.visible')
      .and('contain.text', 'could not be reached to check it')
      .and('contain.text', REDACTED_KEY)
    cy.window({ log: false }).then((win) => {
      const stored = JSON.parse(win.localStorage.getItem(GUTTERTOKEN_KEY_STORAGE) || 'null')
      expect(stored?.key, 'an unchecked key is saved rather than lost').to.equal(RAW_KEY)
    })

    cy.get('[data-testid="guttertoken-key-done"]').click()
    cy.get('[data-testid="guttertoken-key-sheet"]').should('not.exist')

    // The card describes the key by its redaction, and only by its redaction.
    cy.get('[data-testid="guttertoken-key-value"]').should('contain.text', REDACTED_KEY)
    assertKeyOnlyInItsOwnStore()
  })

  it('[GT-02] byok.key-lifecycle — removing the key clears it from this device and takes the launcher with it', () => {
    /*
     * Removal is asserted from the STORE, not from the card: a panel that stops rendering a key it
     * still holds is the failure this checks for. The launcher is the second half of the same fact —
     * with no key and no membership, nothing can answer, so the entry point must not exist.
     */
    stubMembership({ membership: NO_MEMBERSHIP })
    visitWith(GUTTERTOKEN_KEY_URL, { provider: 'guttertoken', key: RAW_KEY })

    cy.get('[data-attention="guttertoken-key"]', { timeout: 40000 }).should('have.attr', 'data-open', 'true')
    cy.get('[data-testid="guttertoken-key-value"]').should('contain.text', REDACTED_KEY)
    // A key IS a rail, even for a non-member: the launcher exists on the strength of it alone.
    cy.get('[data-testid="assistant-launcher"]', { timeout: 40000 }).should('be.visible')

    cy.get('[data-testid="guttertoken-key-remove"]').scrollIntoView().click()
    // Removal is confirmed, and the confirmation says what it does NOT touch.
    cy.get('[data-testid="guttertoken-key-confirm"]')
      .should('be.visible')
      .and('contain.text', 'GutterToken account and balance are untouched')
    cy.get('[data-testid="guttertoken-key-remove-confirm"]').click()

    cy.get('[data-testid="guttertoken-key-value"]').should('contain.text', 'None')
    cy.get('[data-testid="assistant-launcher"]').should('not.exist')
    cy.window({ log: false }).then((win) => {
      expect(
        win.localStorage.getItem(GUTTERTOKEN_KEY_STORAGE),
        'the key is gone from this device, not merely from the card'
      ).to.equal(null)
    })
  })

  it('[GT-03] byok.non-member-chat — a non-member is answered on their own credits, and the FairWins chat route receives nothing', () => {
    /*
     * SC-001, and it is an ABSENCE: the assertion that matters is `@gwChat.all` at length zero.
     * FairWins not being in the path is the entire premise of this rail — if the browser quietly
     * routed through the gateway, every sentence the app says about privacy and cost would be false
     * while the screen looked identical.
     */
    stubMembership({ membership: NO_MEMBERSHIP })
    stubFairWinsChat()
    stubGutterTokenTurns([gtText('Wagers are peer-to-peer. Nothing was signed to tell you that.')])
    visitWith(ASSISTANT_TAB, { provider: 'guttertoken', key: RAW_KEY })

    openPanel()
    cy.get('[data-testid="assistant-provider-badge"]').should(
      'contain.text',
      'Answered by GutterToken on your credits'
    )
    // No membership, so no offer of a read grant: there is nothing of the member's to read.
    cy.get('[data-testid="assistant-grant-offer"]').should('not.exist')

    ask('what is a wager')

    cy.wait('@gtMessages').then(({ request }) => {
      // The credential rides in a HEADER, never in the URL or the body. Only the prefix is compared,
      // so no assertion in this suite can print the key even when it fails.
      const auth = String(request.headers.authorization || '')
      expect(auth.slice(0, 10), 'the key is sent as a bearer token').to.equal('Bearer sk-')
      expect(request.body.messages, 'the member turn is what is sent').to.have.length(1)
    })

    cy.get('.assistant-panel__message--assistant', { timeout: 20000 }).should(
      'contain.text',
      'Wagers are peer-to-peer'
    )
    // The disclaimer rides under the reply on this rail too.
    cy.get('.assistant-panel__disclaimer').should('contain.text', 'never signs or submits')

    cy.get('@gwChat.all').should('have.length', 0)
  })

  it('[GT-04] byok.honest-failures — an empty balance and a rate limit are different sentences with different actions, and neither is an answer', () => {
    /*
     * SC-002. Both failures are the member's own account at a third party, so both must name the
     * third party and hand back the one control that helps: billing for an empty balance, a retry
     * for a rate limit. And through both, `.assistant-panel__message--assistant` must not exist —
     * an assistant that answers when its provider did not is indistinguishable from one that did.
     */
    stubMembership({ membership: NO_MEMBERSHIP })
    stubGutterTokenTurns([{ statusCode: 403, body: { error: { type: 'insufficient_quota' } } }])
    visitWith(ASSISTANT_TAB, { provider: 'guttertoken', key: RAW_KEY })

    openPanel()
    ask('what do I owe')
    cy.wait('@gtMessages')

    cy.get('[data-testid="assistant-error"]', { timeout: 20000 })
      .should('be.visible')
      .and('have.attr', 'role', 'alert')
      .and('contain.text', 'GutterToken balance is empty')
    cy.get('[data-testid="assistant-error-top-up"]')
      .should('have.attr', 'href', GT_BILLING_URL)
      .and('have.attr', 'rel')
      .and('contain', 'noopener')
    cy.get('.assistant-panel__message--assistant').should('not.exist')
    // The member's own turn survives the failure — it was not swallowed with it.
    cy.get('.assistant-panel__message--user').should('contain.text', 'what do I owe')

    // Now GutterToken rate-limits the network the member is on, and says for how long.
    stubGutterTokenTurns([
      { statusCode: 429, headers: { 'Retry-After': '30' }, body: { error: { type: 'rate_limit_error' } } },
    ])
    cy.get('.assistant-panel__error-actions').contains('button', 'Try again').click()

    cy.get('[data-testid="assistant-error"]', { timeout: 20000 })
      .should('contain.text', 'rate-limiting requests from your network')
      .and('contain.text', 'Try again in about 30 seconds')
    cy.get('[data-testid="assistant-error-top-up"]').should('not.exist')
    cy.get('.assistant-panel__message--assistant').should('not.exist')
  })

  it('[GT-05] provider.choice — a paid member picks the rail, and the badge and the transport agree about which one answered', () => {
    /*
     * The badge is a claim about where the member's words went and who paid for the answer, so it is
     * checked against the REQUEST COUNTERS rather than against itself. Both rails are exercised in
     * one test because the interesting failure is a switch that changes the label and not the
     * transport — which no single-rail test can see.
     *
     * Memory retention is off here so the second opening starts a clean thread; retention has its
     * own coverage in 38-assistant.cy.js [AS-03].
     */
    stubMembership()
    stubFairWinsChat('Membership lives on one chain per environment.')
    stubGutterTokenTurns([gtText('Answered from your own GutterToken credits.')])
    visitWith(ASSISTANT_PREFS_URL, { provider: 'fairwins', key: RAW_KEY })

    cy.get('[data-attention="assistant-prefs"]', { timeout: 40000 }).should('have.attr', 'data-open', 'true')
    // A paid member with a key has two live options and neither carries a blocking reason.
    cy.get('[data-testid="assistant-provider-fairwins"]').should('have.attr', 'aria-checked', 'true').and('not.be.disabled')
    cy.get('[data-testid="assistant-provider-guttertoken"]').should('have.attr', 'aria-checked', 'false').and('not.be.disabled')

    // ── Rail one: the membership. It still opens on the signature step, unchanged by spec 104.
    openPanel()
    cy.get('[data-testid="assistant-provider-badge"]').should('contain.text', 'Answered by FairWins')
    cy.get('[data-testid="assistant-authorize"]')
      .should('be.visible')
      .and('contain.text', 'no transaction, no fee, nothing moves')
    cy.get('[data-testid="assistant-authorize-button"]').click()
    cy.get('[data-testid="assistant-thread"]', { timeout: 20000 }).should('be.visible')

    ask('where is my membership')
    cy.wait('@gwChat')
    cy.get('.assistant-panel__message--assistant', { timeout: 20000 }).should('contain.text', 'Membership lives on one chain')
    cy.get('@gtMessages.all').should('have.length', 0)

    cy.get('.assistant-sheet .action-sheet__close').click()
    cy.get('.assistant-sheet[role="dialog"]').should('not.exist')

    // ── The switch. The card names the rail that will actually answer, not merely the one selected.
    cy.get('[data-testid="assistant-provider-guttertoken"]').scrollIntoView().click()
    cy.get('[data-testid="assistant-provider-guttertoken"]').should('have.attr', 'aria-checked', 'true')
    cy.get('[data-testid="assistant-provider-effective"]').should('contain.text', 'answered by GutterToken')

    // ── Rail two: the member's own credits.
    openPanel()
    cy.get('[data-testid="assistant-provider-badge"]').should('contain.text', 'Answered by GutterToken on your credits')
    ask('and now')
    cy.wait('@gtMessages')
    cy.get('.assistant-panel__message--assistant', { timeout: 20000 }).should('contain.text', 'your own GutterToken credits')

    // The gateway heard the first question and only the first: switching rails moved the traffic.
    cy.get('@gwChat.all').should('have.length', 1)
    cy.get('@gtMessages.all').should('have.length', 1)
  })

  it('[GT-06] tools.honest-progress — a tool round shows what is being read, and a read that failed says so rather than reporting nothing found', () => {
    /*
     * Two reads in one round, one of which fails. The failing one is the assertion: a member API
     * that would not answer must render as "could not be read", NEVER as an empty result — "you have
     * no wagers" and "your wagers could not be read" are different facts, and only one of them is
     * safe to act on.
     *
     * The second model response is delayed so the live progress rows can be read before the turn
     * completes and the panel collapses them into the Sources line. Both are asserted: the row while
     * it runs, the chip after it finished.
     */
    stubMembership()
    stubGutterTokenTurns([
      {
        statusCode: 200,
        body: {
          content: [
            { type: 'tool_use', id: 'toolu_wagers', name: 'get_wagers', input: {} },
            { type: 'tool_use', id: 'toolu_status', name: 'get_gateway_status', input: {} },
          ],
          stop_reason: 'tool_use',
          model: 'claude-opus-5',
          usage: { input_tokens: 200, output_tokens: 40 },
        },
      },
      { ...gtText('Your wagers could not be read just now; the service itself is up.'), delay: 4000 },
    ])
    // The member-data read fails the way an indexer fails, with the gateway's own error envelope.
    cy.intercept('GET', '**/v1/member/wagers*', {
      statusCode: 503,
      body: { error: { code: 'indexer_unreadable', reason: 'the Polygon indexer did not answer' } },
    }).as('wagersRead')
    // The public read succeeds, so the two states sit side by side in one round.
    cy.intercept('GET', '**/status', { statusCode: 200, body: { status: 'ok', modules: { memberApi: true } } }).as('statusRead')

    visitWith(ASSISTANT_TAB, { provider: 'guttertoken', key: RAW_KEY })

    openPanel()
    // A member on this rail is OFFERED the read grant; it is optional, and it is asked for in words.
    cy.get('[data-testid="assistant-grant-offer"]', { timeout: 20000 })
      .should('be.visible')
      .and('contain.text', 'no transaction, no fee, nothing moves')
    cy.get('[data-testid="assistant-grant-offer-sign"]').click()
    cy.get('[data-testid="assistant-grant-offer"]').should('not.exist')

    ask('do I have any open wagers')

    // While the reads run, each one is named on screen.
    cy.get('[data-testid="assistant-tool-progress-row"]', { timeout: 20000 }).should('have.length', 2)
    cy.get('[data-testid="assistant-tool-progress"]').should('contain.text', 'your wagers')

    // And when they are done, the failed read is reported as unread rather than as nothing found.
    cy.get('[data-testid="assistant-tool-result"]', { timeout: 30000 })
      .should('be.visible')
      .and('contain.text', 'your wagers')
      .and('contain.text', 'could not be read')
      .and('contain.text', 'the service status')
    cy.get('[data-testid="assistant-tool-result"] .assistant-panel__chip--unreadable').should('have.length', 1)
    cy.get('[data-testid="assistant-tool-result"] .assistant-panel__chip--read').should('have.length', 1)
    cy.get('[data-testid="assistant-tool-result"]').should('not.contain.text', 'no wagers')

    // The reply is the SECOND model call's text — the loop returned the results and asked again.
    cy.get('.assistant-panel__message--assistant').should('contain.text', 'could not be read just now')
    cy.get('@gtMessages.all').should('have.length', 2)
  })

  it('[GT-07] controls.moved-to-tools — the agent controls live on Tools ▸ Assistant, Settings carries neither card, and the old Settings hashes redirect', () => {
    /*
     * SC-005, in both directions. A tab that renders the cards while Settings still renders them is
     * two homes for one control — a member could turn the assistant on in one place and read it as
     * off in the other — so the absence is asserted as explicitly as the presence.
     *
     * Each visit below changes the query string, never only the hash: `cy.visit` treats a hash-only
     * change as a no-op, which would leave the previous page's state on screen and pass for the
     * wrong reason (the failure 39-api-access.cy.js [API-05] hit on its first CI run).
     */
    stubMembership()

    // 1. Settings no longer carries either card — and it is the real Settings tab, not an empty one.
    visitWith('/wallet?tab=settings', {})
    cy.get('[data-attention="markets"]', { timeout: 40000 }).should('exist')
    cy.get('[data-attention="assistant-prefs"]').should('not.exist')
    cy.get('[data-attention="api-access"]').should('not.exist')

    // 2. The Tools tab carries all three, plus the disclosure that has to be read as a whole.
    cy.visit(ASSISTANT_TAB)
    cy.get('[data-testid="assistant-tools-panel"]', { timeout: 40000 }).should('exist')
    cy.get('[data-attention="assistant-prefs"]').should('exist')
    cy.get('[data-attention="guttertoken-key"]').should('exist')
    cy.get('[data-attention="api-access"]').should('exist')
    cy.get('[data-testid="assistant-disclosure"]')
      .should('contain.text', 'While the assistant is off, nothing is sent.')
      .and('contain.text', 'directly')

    // 3. The old Settings deep link resolves to the new tab with the card OPEN.
    cy.visit('/wallet?tab=settings#assistant-prefs')
    cy.location('search', { timeout: 20000 }).should('include', 'tab=assistant')
    cy.location('hash').should('equal', '#assistant-prefs')
    cy.get('[data-attention="assistant-prefs"]', { timeout: 40000 }).should('have.attr', 'data-open', 'true')

    // 4. And so does the other one — the redirect is the index's, not a second hash map.
    cy.visit('/wallet?tab=settings#api-access')
    cy.location('search', { timeout: 20000 }).should('include', 'tab=assistant')
    cy.get('[data-attention="api-access"]', { timeout: 40000 }).should('have.attr', 'data-open', 'true')
  })
})
