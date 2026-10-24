/**
 * E2E Tests: the API Access developer console, as a served package (spec 095 / 073, Full-tier)
 *
 * Issue #1285. The console is not host code. It is a spec-073 registry package — third-party-shaped
 * bytes, published to a gateway, committed on chain by `keccak256(manifest.json)`, and executed only
 * after the host re-hashes what it was served. Everything this file asserts about the console is
 * therefore also an assertion about that pipeline: nothing here renders unless the chain and the
 * bytes agree.
 *
 *   API-06  api-access.console  the console is listed, launched and rendered from VERIFIED bytes,
 *                               and the package holds no permission that could sign
 *   API-07  api-access.console  the OpenAPI explorer renders the gateway's own description — and
 *                               renders NO roster when it could not be read
 *   API-08  api-access.console  `/v1/member/me` introspection: the token rides in a header, is
 *                               never persisted, and an unreadable membership stays unreadable
 *   API-09  api-access.console  the try-it panel sends a real GET, and an error is a RESULT
 *   API-10  api-access.console  the key ceremony deep-links to the HOST — a package cannot sign
 *
 * ── WHY THIS NEEDS THE ON-CHAIN TIER ──────────────────────────────────────────────────────────
 * The no-chain tier stubs the registry read and publishes no package bytes, so `/apps/api-access`
 * there is a refusal, not a console. Reaching the real surface needs a registry that can be written
 * to (submit → approve → `launchable`) and a package staged on a gateway the loader can fetch —
 * which is exactly what `npm run setup:e2e` arranges: `publish:local:miniapps` builds and stages
 * token-mint, clearpath AND api-access through the same `scripts/miniapps/publish.js` pipeline that
 * pins a released package, and `deploy:local:miniapps` puts the registry on the local node.
 *
 * The matrix row `api-access.console` was `partial` for this reason: only the HOST card (the
 * Settings card that mints keys) had coverage, because the console itself could not be launched in
 * the tier its flow was filed under.
 *
 * ── WHAT IS STUBBED, AND WHAT THAT DOES NOT WEAKEN ────────────────────────────────────────────
 * TWO transports, both HTTP, neither of them the trust boundary:
 *
 *  1. THE IPFS GATEWAY. There is no IPFS on this machine, so `cy.intercept` answers the
 *     `/ipfs/<cid>/<path>` fetches the LOADER issues, with the bytes `publish:local:miniapps`
 *     staged. The verification stays entirely real — the loader still takes keccak256 of the
 *     manifest bytes it received and compares it to the hash THE CHAIN holds, then sha256 of the
 *     entry and every declared stylesheet against that authenticated manifest. Stubbing the
 *     transport changes who hands over the bytes, not whether they are allowed to run.
 *
 *  2. THE MEMBER API. The relay-gateway's member API module is not running in this tier (the full
 *     tier's dev server starts a chain, not a gateway), and the console reaches a gateway the
 *     MEMBER types rather than one the build configures — `envPrefix` makes every `import.meta.env`
 *     read `undefined` inside a package, which is why the address is an input and not a constant.
 *     So the console is pointed at `http://localhost:8787` and every response is intercepted. The
 *     bodies are copied from the PRODUCER (`services/relay-gateway/src/memberApi/openapi.js`,
 *     `routes.js#me`, `auth.js`'s three-state membership) rather than invented here: a stub written
 *     to match the test would only prove the spec agrees with itself.
 *
 * What is NOT stubbed: the registry reads, the manifest and file hashing, the host object the
 * package is handed, its store, its toast, and its one navigation into the host.
 */

const MEMBER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' // #0 — deployer, curator, and vendor

/** Folds to the `api-access` id the package's manifest claims (registryClient#appSlug). */
const APP = 'api-access'
const APP_NAME = 'API Access'

/** Must match VITE_MINIAPP_GATEWAY in frontend/package.json's dev:e2e. */
const IPFS_GATEWAY = 'http://localhost:8090'

/**
 * The console's own default (`apiClient.js#DEFAULT_BASE_URL`), which it uses until the member saves
 * something else. Intercepted so the "nothing answered" arm is deterministic rather than a function
 * of whether the CI runner can reach the public internet.
 */
const DEFAULT_GATEWAY = 'https://relay.fairwins.app'

/** Where this file points the console. Nothing serves it, so every request below is intercepted. */
const LOCAL_GATEWAY = 'http://localhost:8787'

const CATALOG_URL = '/wallet?tab=apps'

/** A token SHAPE, not a credential: the gateway is stubbed, so nothing here is ever verified. */
const FAKE_TOKEN = 'fw1.eyJ2IjoxLCJhY2NvdW50IjoiMHhmMzkifQ.c2lnbmF0dXJlLXBsYWNlaG9sZGVy'

/**
 * The gateway's OpenAPI document, shaped as `memberApi/openapi.js` builds it.
 *
 * Trimmed to five operations, but every field this console reads is present and carries the
 * producer's own values: `x-fairwins-scope` beside the standard `security` requirement (the
 * document states the scope twice, and `openapiModel#scopeForOperation` prefers the extension),
 * editorial `tags` order, and a POST — which the try-it picker must refuse to offer.
 */
const OPENAPI_DOC = {
  openapi: '3.1.0',
  info: {
    title: 'FairWins Member API',
    version: '1.0.0',
    summary:
      'Custody-free, member-signed programmatic access to a FairWins member’s own data and safe platform operations.',
  },
  tags: [
    { name: 'discovery', description: 'Read the specification before deciding anything else.' },
    { name: 'identity', description: 'The token, and what stands behind it.' },
    { name: 'reads', description: 'The token account’s own data.' },
    { name: 'build', description: 'Unsigned typed data the member still has to sign.' },
  ],
  paths: {
    '/v1/member/openapi.json': {
      get: {
        tags: ['discovery'],
        operationId: 'openapi',
        summary: 'The OpenAPI 3.1 description of this API',
        security: [],
      },
    },
    '/v1/member/me': {
      get: {
        tags: ['identity'],
        operationId: 'me',
        summary: 'Introspect the presented token',
        security: [{ memberToken: ['read:profile'] }],
        'x-fairwins-scope': 'read:profile',
      },
    },
    '/v1/member/membership': {
      get: {
        tags: ['reads'],
        operationId: 'membership',
        summary: 'Membership tier on the reference chain',
        security: [{ memberToken: ['read:membership'] }],
        'x-fairwins-scope': 'read:membership',
      },
    },
    '/v1/member/wagers': {
      get: {
        tags: ['reads'],
        operationId: 'wagers',
        summary: 'The token account’s wagers, per chain',
        security: [{ memberToken: ['read:wagers'] }],
        'x-fairwins-scope': 'read:wagers',
        parameters: [{ name: 'chainId', in: 'query', required: false, schema: { type: 'integer' } }],
      },
    },
    '/v1/member/intents/build': {
      post: {
        tags: ['build'],
        operationId: 'buildIntent',
        summary: 'Build unsigned EIP-712 typed data for a platform action',
        security: [{ memberToken: ['build:intents'] }],
        'x-fairwins-scope': 'build:intents',
      },
    },
  },
}

/**
 * `GET /v1/member/me`, as `routes.js#me` answers it. `membership` is the object the AUTHENTICATOR
 * already read (`auth.js` step 4), so its three-state shape is the gateway's, not this file's.
 */
const ME_READ = {
  account: MEMBER,
  keyId: `0x${'11'.repeat(32)}`,
  label: 'e2e console key',
  scopes: ['read:membership', 'read:profile'],
  issuedAt: 1750000000,
  expiresAt: 4102444800,
  membership: {
    state: 'read',
    chainId: 80002,
    role: 'WAGER_PARTICIPANT_ROLE',
    tier: 3,
    tierName: 'Gold',
    active: true,
    expiresAt: 4102444800,
  },
  revocation: { revoked: false, durable: false },
}

/** The same answer with the membership read UNREADABLE — `auth.js`'s own wording for it. */
const ME_UNREADABLE = {
  ...ME_READ,
  membership: {
    state: 'unreadable',
    chainId: 80002,
    role: 'WAGER_PARTICIPANT_ROLE',
    reason: 'the membership contract could not be read; try again',
  },
}

/** The platform error envelope: every gateway error is `{ error: { code, reason } }`. */
const gatewayError = (code, reason) => ({ error: { code, reason } })

const realPackage = (app) =>
  cy.task('miniappRealPackage', { app }).then((r) => {
    expect(r.ok, `miniappRealPackage ${app}: ${r.error || 'no error message returned'}`).to.equal(true)
    return r
  })

const registry = (action, args = {}) =>
  cy.task('miniappFixture', { action, args }).then((r) => {
    expect(r.ok, `miniappFixture ${action}: ${r.error || 'no error message returned'}`).to.equal(true)
    return r
  })

/**
 * Answer the loader's own gateway fetches with `files`, a { path: text } map.
 *
 * Serves BYTES rather than a parsed body on purpose: the manifest is hashed before it is parsed
 * (FR-011), so a stub replying with an object would skip the very step that admits the package.
 */
const serveFiles = ({ cid, files }) => {
  for (const [path, text] of Object.entries(files)) {
    cy.intercept('GET', `${IPFS_GATEWAY}/ipfs/${cid}/${path}`, (req) => {
      req.reply({ statusCode: 200, body: text, headers: { 'content-type': 'text/plain' } })
    })
  }
}

/**
 * Put the REAL api-access package on the chain and on the gateway.
 *
 * The listing NAME is load-bearing: `registryClient#appSlug(record.name)` is handed to the loader as
 * the id it expects, and the loader compares it to the `id` inside the AUTHENTICATED manifest. So
 * the name comes from the built package rather than being chosen here — "API Access" folds to
 * `api-access`, which is what the package claims to be.
 */
const publishConsole = () =>
  realPackage(APP).then((pkg) => {
    serveFiles(pkg)
    return registry('ensureServing', {
      name: pkg.name,
      cid: pkg.cid,
      manifestHash: pkg.manifestHash,
    }).then((record) => {
      expect(record.launchable, `${pkg.name} is serving`).to.equal(true)
      expect(record.approved.manifestHash, 'and it is the package just built').to.equal(pkg.manifestHash)
      return { ...pkg, record }
    })
  })

/** The default gateway answers, so the console's first read has a determinate outcome. */
const stubDefaultGateway = () =>
  cy.intercept('GET', `${DEFAULT_GATEWAY}/**`, {
    statusCode: 503,
    body: gatewayError('member_api_unconfigured', 'The member API is not enabled on this gateway.'),
  }).as('defaultGateway')

/** Publish, launch, and wait for the package's own DOM inside the host workspace. */
const launchConsole = () =>
  publishConsole().then((pkg) => {
    cy.mockWeb3Provider({ account: MEMBER, preAuthorized: true, realBalances: true })
    cy.visit(`/apps/${APP}`)
    cy.get('.miniapp-workspace-root', { timeout: 60000 }).should('exist')
    cy.get('.miniapp-workspace-refusal').should('not.exist')
    cy.get('.miniapp-workspace-root .api-access', { timeout: 30000 }).should('exist')
    return cy.wrap(pkg, { log: false })
  })

/** Type the local gateway into the connection card and save it. */
const useLocalGateway = () => {
  cy.get('#aa-base-url').clear().type(LOCAL_GATEWAY)
  cy.contains('.aa-card', 'Connection').contains('button', 'Save').click()
  // The store write is the app's, through the host's `store` capability — the toast reports which
  // of the two things happened, so asserting the SAVED wording also asserts the write succeeded.
  cy.contains('.notification-message', /Gateway address saved/i, { timeout: 20000 }).should('be.visible')
}

/** Paste a token into the connection card. Held in React state only — see API-08. */
const pasteToken = () => cy.get('#aa-token').clear().type(FAKE_TOKEN, { delay: 0, log: false })

describe('API Access console, served as a mini-app package (specs 095 / 073)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
    stubDefaultGateway()
  })

  it('[API-06] api-access.console — the console is listed, launched from the registry, and runs only because the served bytes matched the chain', () => {
    /*
     * The whole launch path, in one flow: a record the chain reports `launchable`, bytes fetched
     * over a gateway, keccak256(manifest) checked against what the registry holds, sha256 of the
     * entry and the stylesheet checked against that authenticated manifest — and only then a
     * console. Nothing here is a smoke test of a component: if any link in that chain were skipped
     * the surface would be a refusal instead.
     */
    publishConsole().then((pkg) => {
      // What the package is ALLOWED to do, read from the manifest whose hash the chain committed.
      // This is the spec-095 rule stated as a fact about the bytes rather than as a comment: the
      // console holds no `wallet:submit`, so there is no rail it could reach even if it tried, and
      // it declares no contracts, so `host.contracts(name)` throws for every name it could ask for.
      expect(pkg.permissions, 'the console asks for no write rail').to.not.include('wallet:submit')
      expect(pkg.permissions, 'only the three capabilities it needs').to.have.members([
        'navigate',
        'store',
        'toast',
      ])
      expect(pkg.contracts, 'and it resolves no contract at all').to.deep.equal([])

      cy.mockWeb3Provider({ account: MEMBER, preAuthorized: true, realBalances: true })
      cy.visit(CATALOG_URL)
      cy.get('.miniapp-catalog', { timeout: 40000 }).should('exist')

      // Listed because the CHAIN says it is serving, reached through the catalog the member uses.
      cy.contains('.miniapp-row', APP_NAME, { timeout: 30000 }).find('.miniapp-row-tap').click()
      cy.get('.miniapp-sheet[role="dialog"]', { timeout: 20000 }).should('be.visible')
      cy.get('.miniapp-sheet-open').should('have.attr', 'href', `/apps/${APP}`).click()

      cy.get('.miniapp-workspace-root', { timeout: 60000 }).should('exist')
      cy.get('.miniapp-workspace-refusal').should('not.exist')

      // The header names the app and its version from the AUTHENTICATED manifest — the same bytes
      // whose hash the chain holds — so this is the host agreeing with the registry, not the
      // package describing itself.
      const version = JSON.parse(pkg.files['manifest.json']).version
      cy.get('.miniapp-workspace-header')
        .should('contain.text', APP_NAME)
        .and('contain.text', `Version ${version}`)

      // The package's own DOM, scoped inside the host's workspace region.
      cy.get('.miniapp-workspace-root .api-access', { timeout: 30000 }).should('exist')
      cy.contains('.miniapp-workspace-root .aa-card-title', 'Connection').should('be.visible')
      cy.contains('.miniapp-workspace-root .aa-card-title', 'This token').should('be.visible')
      cy.contains('.miniapp-workspace-root .aa-card-title', 'Endpoints').should('be.visible')
      cy.contains('.miniapp-workspace-root .aa-card-title', 'Try a read').should('be.visible')
      cy.contains('.miniapp-workspace-root .aa-card-title', 'Create or revoke keys').should('be.visible')
    })
  })

  it('[API-07] api-access.console — the endpoint roster is the gateway’s own description, and a description that could not be read lists nothing', () => {
    /*
     * THE FAILING ARM FIRST, because it is the one a comfortable implementation gets wrong. The
     * console opens on its default gateway, which here answers `503 member_api_unconfigured`. An
     * empty table there would tell the member their gateway serves no endpoints — a fabricated
     * fact. The rule is that nothing is listed and the reason is named.
     */
    launchConsole()

    cy.wait('@defaultGateway')
    cy.get('.aa-card')
      .contains('.aa-error-title', /The API description could not be loaded/i, { timeout: 30000 })
      .should('be.visible')
    // The gateway's own code and status, not a paraphrase — and the sentence that says an
    // unreadable roster is not an empty API.
    cy.contains('.aa-error', 'member_api_unconfigured').should('be.visible')
    cy.contains('.aa-error', '503').should('be.visible')
    cy.contains('.aa-error', /Nothing is listed below because nothing was read/i).should('be.visible')
    cy.get('.aa-op').should('not.exist')

    // Now a gateway that answers. The document is fetched once and shared, so what appears below is
    // also what the try-it picker in [API-09] is built from.
    cy.intercept('GET', `${LOCAL_GATEWAY}/v1/member/openapi.json`, {
      statusCode: 200,
      body: OPENAPI_DOC,
    }).as('openapi')
    useLocalGateway()
    cy.wait('@openapi')

    cy.contains('.aa-spec-title', 'FairWins Member API', { timeout: 30000 }).should('be.visible')
    cy.get('.aa-error-title').should('not.exist')

    // Tag order is the DOCUMENT's, because that ordering is editorial and re-sorting it would throw
    // away the only curation the API author supplied.
    cy.get('.aa-tag-name').then(($names) => {
      const order = [...$names].map((n) => n.textContent.trim())
      expect(order, 'the roster follows the document’s own tag order').to.deep.equal([
        'discovery',
        'identity',
        'reads',
        'build',
      ])
    })

    // Every operation the document declares — the POST included, because the EXPLORER lists what
    // the API serves. (What the try-it panel will SEND is a narrower question; see [API-09].)
    cy.get('.aa-op').should('have.length', 5)

    // Scoped to the GROUP rather than matched on the path text: `/v1/member/me` is a prefix of
    // `/v1/member/membership`, so a `contains` on the path would be one rename away from silently
    // asserting against the wrong row.
    cy.contains('.aa-tag-group', 'identity').within(() => {
      cy.get('.aa-op').should('have.length', 1)
      cy.get('.aa-op-path').should('have.text', '/v1/member/me')
      cy.get('.aa-method').should('have.text', 'GET')
      // The scope is read from `x-fairwins-scope`, which the gateway states beside the standard
      // `security` requirement precisely so a reader does not have to decode the latter.
      cy.get('.aa-op-scope').should('contain.text', 'read:profile')
    })
    cy.contains('.aa-tag-group', 'discovery').within(() => {
      cy.get('.aa-op-path').should('have.text', '/v1/member/openapi.json')
      cy.get('.aa-op-scope').should('contain.text', 'No scope required')
    })
    // The POST is DESCRIBED here — the explorer lists what the API serves. Whether the console will
    // send it is a narrower question, and [API-09] asks it.
    cy.contains('.aa-tag-group', 'build').within(() => {
      cy.get('.aa-method').should('have.text', 'POST')
    })
  })

  it('[API-08] api-access.console — introspection sends the token in a header, keeps it out of storage, and renders an unreadable membership as unreadable', () => {
    cy.intercept('GET', `${LOCAL_GATEWAY}/v1/member/openapi.json`, { statusCode: 200, body: OPENAPI_DOC })

    let meBody = ME_READ
    cy.intercept('GET', `${LOCAL_GATEWAY}/v1/member/me`, (req) => {
      req.reply({ statusCode: 200, body: meBody })
    }).as('me')

    launchConsole().then((pkg) => {
      useLocalGateway()
      pasteToken()

      cy.contains('.aa-card', 'This token').contains('button', 'Check this token').click()

      cy.wait('@me').then(({ request }) => {
        // THE CREDENTIAL RIDES IN A HEADER. Never a query parameter, never a path segment — the
        // one place it could leak into a log, a referrer or a copied link.
        expect(request.headers.authorization, 'the bearer token is a header').to.equal(
          `Bearer ${FAKE_TOKEN}`,
        )
        expect(request.url, 'and never appears in the URL').to.not.include('fw1.')
      })

      // What the gateway said about the key, rendered as the gateway said it.
      cy.get('.aa-kv-list', { timeout: 20000 }).should('be.visible')
      cy.contains('.aa-kv', 'Account').should('contain.text', MEMBER)
      cy.contains('.aa-kv', 'Scopes').should('contain.text', 'read:profile')
      cy.contains('.aa-kv', 'Membership').should('contain.text', 'Gold')
      // `durable: false` is not a footnote at the gateway and must not become one here.
      cy.contains('.aa-kv', 'Revocation').should('contain.text', 'do not survive a restart')

      /*
       * THE TOKEN HAS NO HOME IN THE STORE, and the store is where it would land if anyone ever
       * "helpfully" persisted it: the mini-app store rides the member's encrypted backup, so a
       * token written there would become a bearer secret inside a backup blob.
       *
       * Read from the raw namespace localStorage key rather than from the app's own state — the
       * key is `fw_user_<account>_miniapp_<namespaceKey>_v1` (lib/miniapps/store.js), and the
       * namespace is `app-<chainId>-<registryId>` (registryClient#appNamespaceKey).
       */
      const storeKey = `fw_user_${MEMBER.toLowerCase()}_miniapp_app-80002-${pkg.record.id}_v1`
      cy.window({ log: false }).then((win) => {
        const raw = win.localStorage.getItem(storeKey) || ''
        expect(raw, 'the console persisted the gateway address it was told to remember').to.include(
          LOCAL_GATEWAY,
        )
        expect(raw, 'and did not persist the credential').to.not.include('fw1.')
      })
    })

    /*
     * ── The membership read that could not be made ────────────────────────────────────────────
     * `unreadable` is not tier 0 and must never render as "no membership". The gateway's own
     * sentence is shown verbatim, alongside the statement that this is not a claim about the
     * account — because a paraphrase is exactly where "unreadable" quietly becomes "none".
     */
    cy.then(() => {
      meBody = ME_UNREADABLE
    })
    cy.contains('.aa-card', 'This token').contains('button', 'Check this token').click()
    cy.wait('@me')

    cy.contains('.aa-kv', 'Membership', { timeout: 20000 }).within(() => {
      cy.get('.aa-unknown').should('contain.text', 'Could not be read')
      cy.get('.aa-unknown').should('contain.text', 'the membership contract could not be read')
      cy.get('.aa-unknown').should(
        'contain.text',
        'This is not a statement that the account has no membership',
      )
      cy.get('.aa-unknown').should('not.contain.text', 'Not active')
    })
  })

  it('[API-09] api-access.console — the try-it panel sends a real GET, offers no endpoint it cannot call, and reports a refusal as a result', () => {
    cy.intercept('GET', `${LOCAL_GATEWAY}/v1/member/openapi.json`, { statusCode: 200, body: OPENAPI_DOC })
    cy.intercept('GET', `${LOCAL_GATEWAY}/v1/member/membership*`, {
      statusCode: 403,
      body: gatewayError(
        'insufficient_scope',
        'this key does not carry the "read:membership" scope; mint a key that includes it',
      ),
    }).as('membership')
    cy.intercept('GET', `${LOCAL_GATEWAY}/v1/member/wagers*`, (req) => {
      req.reply({
        statusCode: 200,
        body: { account: MEMBER, chains: [{ chainId: 80002, state: 'read', wagers: [] }] },
      })
    }).as('wagers')

    launchConsole()
    useLocalGateway()
    // A token, because both arms below are about what a WORKING key can and cannot reach: a `403
    // insufficient_scope` is a statement about a valid key, not about a missing one.
    pasteToken()

    // The picker is built from the loaded document, so it can never offer an endpoint this gateway
    // does not serve — and it is GET-only, because a POST from here would be the console acting for
    // the member. The one POST worth having needs a signature no package can produce.
    cy.get('#aa-tryit-op', { timeout: 30000 }).find('option').should('have.length', 4)
    cy.get('#aa-tryit-op').find('option').then(($opts) => {
      const keys = [...$opts].map((o) => o.value)
      expect(keys, 'every offered operation is a GET').to.deep.equal([
        'GET /v1/member/openapi.json',
        'GET /v1/member/me',
        'GET /v1/member/membership',
        'GET /v1/member/wagers',
      ])
      expect(keys, 'the POST the document declares is not on offer').to.not.include(
        'POST /v1/member/intents/build',
      )
    })

    // ── A read that succeeds, with the member's own query string. ──────────────────────────────
    cy.get('#aa-tryit-op').select('GET /v1/member/wagers')
    // The hint comes from the operation's declared parameters, not from a list in the package.
    cy.contains('#aa-tryit-query-help', 'chainId').should('be.visible')
    cy.get('#aa-tryit-query').clear().type('chainId=80002')
    cy.contains('.aa-card', 'Try a read').contains('button', 'Send').click()

    cy.wait('@wagers').then(({ request }) => {
      expect(request.url, 'the query the member typed is what was sent').to.include('chainId=80002')
      // The same header rule as introspection: one network layer, one place a credential may ride.
      expect(request.headers.authorization, 'and the token travels as a header').to.equal(
        `Bearer ${FAKE_TOKEN}`,
      )
      expect(request.url, 'never as a query parameter').to.not.include('fw1.')
    })
    cy.get('.aa-response-status', { timeout: 20000 }).should('contain.text', '200')
    // The raw body, not a summary of it: this panel exists so a developer can see what came back.
    cy.get('.aa-json').should('contain.text', '"chainId": 80002')

    /*
     * ── A refusal, which is an ANSWER ──────────────────────────────────────────────────────────
     * `403 insufficient_scope` tells the member something precise and actionable: the key works and
     * lacks a scope. Collapsing that into "request failed" would throw away the only useful part of
     * the response — so the status, the gateway's code and its own reason are all shown.
     */
    cy.get('#aa-tryit-op').select('GET /v1/member/membership')
    cy.contains('.aa-card', 'Try a read').contains('button', 'Send').click()
    cy.wait('@membership')

    cy.get('.aa-response .aa-error', { timeout: 20000 })
      .should('have.attr', 'role', 'alert')
      .and('contain.text', '403')
      .and('contain.text', 'insufficient_scope')
      .and('contain.text', 'mint a key that includes it')
    // Emphatically NOT the "no answer" state — the gateway answered, and said something.
    cy.contains('.aa-error-title', /No answer/i).should('not.exist')
  })

  it('[API-10] api-access.console — creating a key is a door into the HOST, because a package structurally cannot sign', () => {
    /*
     * A FairWins API key is a member-signed EIP-712 grant, and the host object carries no signer:
     * no `signMessage`, no `signTypedData`, and the only write rail is a transaction. So this
     * console cannot mint one and must not present a form that implies otherwise — it explains why
     * and sends the member to the host card that can.
     *
     * The deep link is asserted at its DESTINATION rather than at the click: `host.navigate` is a
     * wrapper that refuses anything leaving the host, and what matters to the member is that they
     * arrive on the open api-access card, not that a function was called.
     */
    launchConsole()

    cy.contains('.aa-card', 'Create or revoke keys')
      .should('contain.text', 'Settings → API access')
      .and('contain.text', 'deliberately given no way to sign anything')

    // No credential-minting control anywhere in the package's surface.
    cy.get('.miniapp-workspace-root').within(() => {
      cy.contains('button', /^Create key$/i).should('not.exist')
    })

    cy.contains('.aa-card', 'Create or revoke keys')
      .contains('button', 'Open API access settings')
      .click()

    // The HOST surface, with the card the link names OPEN rather than a closed heading.
    cy.location('pathname', { timeout: 30000 }).should('equal', '/wallet')
    /*
     * `tab=assistant`, not `tab=settings`. The package's deep link still says Settings — its bytes
     * are keccak-committed on-chain (spec 073), so it is not edited for a host reorganisation — and
     * spec 104 moved the card to Tools ▸ Assistant, keeping the card id and redirecting the old
     * hash. The member's destination is what this asserts, so it asserts where they LAND.
     */
    cy.location('search', { timeout: 20000 }).should('include', 'tab=assistant')
    cy.location('hash').should('equal', '#api-access')
    cy.get('[data-attention="api-access"]', { timeout: 40000 }).should('have.attr', 'data-open', 'true')

    // And the package is gone: the ceremony happens in host code, on the member's own signer.
    cy.get('.miniapp-workspace-root').should('not.exist')
    cy.get('[data-testid="api-access-console"]', { timeout: 40000 }).should('exist')
    cy.get('[data-testid="api-access-create"]').contains('button', 'Create key').should('exist')
  })
})
