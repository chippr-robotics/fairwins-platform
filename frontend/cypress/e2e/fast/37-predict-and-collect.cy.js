// =============================================================================
// 37-predict-and-collect.cy.js
// Fast-tier E2E for Predict and Collect (specs 057 / 055 / 056 / 013).
//
// Issue #1239. Both features are a frontend section plus a relay-gateway proxy —
// NO contract changes, no custody, the member's wallet is the only order signer.
// So everything short of the signature is answerable at the gateway boundary and
// belongs in the no-chain tier.
//
// Both gate on the SAME variable, `VITE_RELAYER_URL`: unset, their tabs hide
// entirely and none of this is reachable. The tier's dev server (`dev:fast`)
// points it at a port nothing serves, so a spec that wants these surfaces stubs
// the gateway itself and a spec that does not sees the honest unreachable state.
//
// The divergence worth remembering: Collect's OpenSea referral costs the member
// NOTHING, while Predict's builder fee is ADDITIVE — a real taker cost — and must
// be disclosed as its own line, never hidden and never called free.
//
// Spec 114 slice 5 gave Predict TWO order surfaces, and this spec covers BOTH on purpose:
//   · a gateway with live readings  → the amount-first ticket           (PR-02, PR-04)
//   · a gateway with no books route → the fixed-price confirm, reached by the ticket's own fallback
//                                                                       (PR-02b, PR-04b)
//   · a gateway that predates /events → the market sheet, then the fixed-price confirm (PR-05)
// The same two assertions hold on every one: the builder fee is its OWN line before any signature, and a
// restricted region is refused before any fee or signature. `gw` below is what the stub answers for books and
// events; each test sets it before it visits.
// =============================================================================

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
/*
 * Matched on the full URL, not `hostname`: Cypress's `hostname` is the host WITHOUT the port, so a
 * pattern like /localhost:8899$/ matches nothing and the intercept silently never fires — the
 * request goes to the dead port and the surface renders its unreachable state instead.
 */
const GATEWAY_URL = /localhost:8899\/v1\/polymarket/
const RPC_HOSTS = /publicnode\.com$|rivet\.link$|etcdesktop\.com$|polygon\.technology$/

function chainWorld() {
  cy.intercept({ method: 'POST', hostname: RPC_HOSTS }, (req) => {
    const one = ({ method, id }) => {
      const reply = (result) => ({ jsonrpc: '2.0', id, result })
      if (method === 'eth_chainId') return reply('0x89')
      if (method === 'eth_blockNumber') return reply('0x4000000')
      if (method === 'eth_getBalance') return reply('0x0')
      return reply('0x')
    }
    const body = req.body
    req.reply({ statusCode: 200, body: Array.isArray(body) ? body.map(one) : one(body || {}) })
  })
}

/*
 * THE GATEWAY'S DTO, which is what the client consumes — not Gamma's wire shape.
 *
 * `services/relay-gateway/src/polymarket/normalize.js` does the Gamma parsing server-side and
 * emits `outcomes: [{ name, tokenId, price }]`. Two fixture mistakes each render as a broken app
 * rather than a wrong stub: calling the field `outcome` instead of `name` leaves the detail sheet
 * with unnamed rows, and a token id that fails `isTokenId` makes the gateway DROP the outcome, so
 * the sheet has no Buy button at all and `tradable` goes false.
 */
const TOKEN_YES = '71321045679252212594626385532706912750332728571942532289631379312455583992563'
const TOKEN_NO = '52114319501245915516055106046884209969926127482827954674443846427813813222426'

const MARKETS = [
  {
    conditionId: '0xaaa1',
    question: 'Will it rain in London tomorrow?',
    category: 'Weather',
    slug: 'rain-london',
    endDate: '2030-01-01T00:00:00Z',
    tradable: true,
    outcomes: [
      { name: 'Yes', tokenId: TOKEN_YES, price: '0.62' },
      { name: 'No', tokenId: TOKEN_NO, price: '0.38' },
    ],
  },
  {
    conditionId: '0xbbb2',
    question: 'Will the harbour freeze this winter?',
    category: 'Weather',
    slug: 'harbour-freeze',
    endDate: '2030-01-01T00:00:00Z',
    tradable: true,
    outcomes: [
      { name: 'Yes', tokenId: TOKEN_YES, price: '0.10' },
      { name: 'No', tokenId: TOKEN_NO, price: '0.90' },
    ],
  },
]

/**
 * Spec 114: the Predict list reads the gateway's `/events` route. Each fixture market above is served
 * as a one-market event (the shape the list renders), so PR-01..04 keep asserting what they always did.
 */
const asEvent = (m) => ({
  slug: m.slug,
  title: m.question,
  category: null,
  volume: null,
  volume24h: null,
  endDate: m.endDate,
  mutuallyExclusive: false,
  marketCount: 1,
  markets: [
    {
      conditionId: m.conditionId,
      label: m.question,
      tradable: m.tradable,
      negRisk: Boolean(m.negRisk),
      outcomes: m.outcomes,
      bestBid: null,
      bestAsk: null,
      lastTradePrice: null,
      displayPrice: m.outcomes[0].price,
      tickSize: '0.01',
      minOrderSize: '5',
    },
  ],
})

/** What the stubbed gateway has rolled out. 'missing' answers 404 — the route does not exist on that gateway. */
const gw = { events: 'served', books: 'live' }

/** A liquid book for any token: the market's own Yes price is 0.62, so bids 0.61 / asks 0.63. */
const bookFor = (tokenId, confirmedAt) => ({
  tokenId,
  bids: [['0.61', '5000'], ['0.60', '5000']],
  asks: [['0.63', '5000'], ['0.64', '5000']],
  tickSize: '0.01',
  minOrderSize: '5',
  lastTradePrice: '0.62',
  venueTime: confirmedAt,
  venueHash: `hash-${tokenId.slice(-4)}`,
})

const NOT_FOUND = { statusCode: 404, body: { error: { code: 'not_found', reason: 'no such route' } } }

/** Answer the Predict half of the gateway. `q` filters, mirroring the proxy. */
function predictGateway({ events = 'served', books = 'live' } = {}) {
  cy.then(() => {
    gw.events = events
    gw.books = books
  })
  cy.intercept({ method: 'GET', url: GATEWAY_URL }, (req) => {
    // The quick-filter row is optional: a gateway without `/discover` answers 404 and the row is simply absent.
    if (/\/discover(\?|$)/.test(req.url)) return req.reply(NOT_FOUND)
    const now = new Date().toISOString()
    // The books route (spec 114): the ticket's only source of a price. A gateway that predates it answers 404.
    if (/\/books(\?|$)/.test(req.url)) {
      if (gw.books === 'missing') return req.reply(NOT_FOUND)
      const ids = (new URL(req.url).searchParams.get('token_ids') || '').split(',').filter(Boolean)
      return req.reply({ statusCode: 200, body: { books: ids.map((id) => bookFor(id, now)), unreadable: [], confirmedAt: now, serverNow: now, stale: false } })
    }
    // The older spec-057 list route, which a gateway that predates /events still serves.
    if (/\/markets(\?|$)/.test(req.url)) {
      const q = (new URL(req.url).searchParams.get('q') || '').toLowerCase()
      const found = q ? MARKETS.filter((m) => m.question.toLowerCase().includes(q)) : MARKETS
      return req.reply({ statusCode: 200, body: { markets: found, next: null, fetchedAt: now, stale: false } })
    }
    if (!/\/events(\?|$)/.test(req.url)) return req.continue()
    if (gw.events === 'missing') return req.reply(NOT_FOUND)
    const q = (new URL(req.url).searchParams.get('q') || '').toLowerCase()
    const found = q ? MARKETS.filter((m) => m.question.toLowerCase().includes(q)) : MARKETS
    req.reply({
      statusCode: 200,
      body: { events: found.map(asEvent), next: null, confirmedAt: now, serverNow: now, stale: false },
    })
  }).as('events')

  cy.intercept({ method: 'GET', url: /localhost:8899\/v1\/polymarket\/\d+\/fee-rate/ }, {
    statusCode: 200,
    // 50 bps taker / 0 maker — spec 057's documented default, well inside the 100/50 cap.
    body: { builderTakerFeeBps: 50, builderMakerFeeBps: 0, polymarketTakerFeeBps: 0, fetchedAt: Date.now() },
  }).as('feeRate')
}

const SIGNING = ['personal_sign', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v4', 'eth_signTransaction', 'eth_sendTransaction', 'eth_sendRawTransaction']
/**
 * Record every method the page asks the wallet for, from before the app's scripts run: wagmi binds
 * `provider.request` once when it connects, so a wrap installed after load would measure nothing and every
 * "before any signature" below would pass vacuously. The handler is registered AFTER the mock provider's own
 * (inside a `cy.then`, once `connect()` has executed) so it runs after it on the same window.
 */
function spyOnWallet() {
  cy.then(() => {
    cy.on('window:before:load', (win) => {
      const eth = win.ethereum
      if (!eth || eth.__prSpy) return
      const original = eth.request
      eth.__prSpy = []
      eth.request = function request(args) {
        eth.__prSpy.push(args?.method)
        return original.call(this, args)
      }
    })
  })
}
/** Retries until true; fails if the spy was never installed (which would make "no signature" vacuous). */
const noSignatureYet = () =>
  cy.window({ log: false }).should((win) => {
    expect(win.ethereum.__prSpy, 'the wallet spy is installed').to.be.an('array')
    const asked = win.ethereum.__prSpy.filter((m) => SIGNING.includes(m))
    expect(asked, 'the wallet has been asked for no signature').to.have.length(0)
  })

/**
 * Polymarket's OWN geoblock endpoint, called directly from the browser (not through our gateway).
 *
 * Modelled rather than defeated: the block is Polymarket's policy and FairWins respects it, so the
 * tests drive both sides of it — a restricted member is refused with a link out, an allowed member
 * reaches the fee schedule.
 */
function geoblock(blocked) {
  cy.intercept({ method: 'GET', url: /polymarket\.com\/api\/geoblock/ }, {
    statusCode: 200,
    body: blocked ? { blocked: true, country: 'US', region: 'US' } : { blocked: false },
  }).as('geoblock')
}

function connect(networkId = 137, rpcUrl = 'https://polygon-bor-rpc.publicnode.com') {
  cy.mockWeb3Provider({ account: ACCOUNT, preAuthorized: true, networkId, rpcUrl })
}

const waitForAccount = () => cy.get('[aria-label="Wallet Account"]', { timeout: 40000 }).should('exist')

describe('Predict and Collect (specs 057 / 055 / 056 / 013)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[PR-01] predict.search-markets — markets list, and a search that matches nothing says so', () => {
    chainWorld()
    predictGateway()
    connect()
    cy.visit('/wallet?tab=predict')
    waitForAccount()

    cy.get('[aria-label="Predict"]', { timeout: 40000 }).should('exist')
    cy.get('.event-card', { timeout: 20000 }).should('have.length', MARKETS.length)
    cy.contains('Will it rain in London tomorrow?').should('exist')

    // Searching narrows to the gateway's own answer — the filter is served, not done locally.
    cy.get('[aria-label="Search markets"]').type('harbour')
    cy.get('.event-card', { timeout: 20000 }).should('have.length', 1)
    cy.contains('Will the harbour freeze this winter?').should('exist')

    /*
     * A search matching nothing must SAY so, and offer the way out. An empty grid is
     * indistinguishable from a gateway that failed — and the two call for different actions.
     */
    cy.get('[aria-label="Search markets"]').clear().type('zzzznothing')
    cy.contains('No markets found', { timeout: 20000 }).should('exist')
    cy.contains(/No markets match your search/i).should('exist')
  })

  // The two assertions every order surface must satisfy. `scope` is the surface's own root.
  const assertFeeDisclosed = (scope) =>
    cy.get(scope, { timeout: 20000 }).should(($c) => {
      const text = $c.text()
      expect(text, 'the builder fee is named, as its own line').to.match(/builder/i)
      // 50 bps rendered as a percentage — "0.50%", trailing zero and all.
      expect(text, 'the rate the member is being charged is shown').to.match(/0\.50\s*%|50\s*bps/i)
      // And it says the fee is INSIDE the number above it, so the total is not read as fee-free.
      expect(text, 'the member is told where the fee sits in the price').to.match(/included above/i)
      // Polymarket's own taker fee is named separately — two charges, two sentences.
      expect(text, "Polymarket's own fee is disclosed as a separate charge").to.match(/Polymarket also charges/i)
      expect(text, 'an additive cost must never be described as free').to.not.match(
        /builder[^.]{0,40}\bfree\b/i,
      )
    })
  const assertRegionRefused = (scope) =>
    cy.get(scope, { timeout: 20000 }).should(($c) => {
      const text = $c.text()
      expect(text, 'the refusal names whose restriction it is').to.match(/Polymarket sets this restriction/i)
      expect(text, 'and offers the way to trade it anyway, on the venue').to.match(/Trade on Polymarket/i)
      expect(text, 'no fee is quoted to someone who cannot trade').to.not.match(/builder/i)
    })

  it('[PR-02] predict.builder-fee-disclosed — the builder fee is its OWN line before any signature (amount-first ticket)', () => {
    /*
     * THE DIVERGENCE FROM COLLECT (spec 057). Collect's OpenSea referral costs the member
     * nothing; this fee is ADDITIVE — a real taker cost — so it must appear as its own labelled
     * line in the order UI before the member signs, never folded into a total and never
     * described as free. Since spec 114 slice 5 that UI is the amount-first ticket whenever the
     * gateway can serve live readings; PR-02b and PR-05 hold the same line on the older surfaces.
     */
    chainWorld()
    predictGateway()
    geoblock(false) // an allowed region, so the fee schedule is actually reached
    connect()
    spyOnWallet()
    cy.visit('/wallet?tab=predict')
    waitForAccount()

    // A row's Yes/No opens the ticket (the title opens the event page since spec 114 slice 4).
    cy.get('.event-card', { timeout: 40000 }).first().find('.event-card-side:not(:disabled)').first().click()
    cy.get('.order-ticket', { timeout: 20000 }).should('exist')
    assertFeeDisclosed('.order-ticket')

    // With an amount, the fee is a line of its own with a number on it — and nothing has been signed.
    cy.get('.order-ticket').contains('label', /Amount to spend/).find('input').type('50')
    cy.get('.order-ticket .order-ticket-fee-line', { timeout: 20000 })
      .should('have.length', 1)
      .and('contain.text', 'FairWins builder fee')
      .and('contain.text', '+$0.25')
    noSignatureYet()
  })

  it('[PR-02b] predict.builder-fee-disclosed — on a gateway with NO books route the fixed-price confirm discloses the same fee as its own line', () => {
    /*
     * A gateway that has /events but not /books can never make a price live, so the ticket would wait
     * forever. The ticket learns that from the first books answer (404) and hands the member the
     * fixed-price confirm for the same outcome — the old surface, unchanged. A member can always trade.
     */
    chainWorld()
    predictGateway({ books: 'missing' })
    geoblock(false)
    connect()
    spyOnWallet()
    cy.visit('/wallet?tab=predict')
    waitForAccount()

    cy.get('.event-card', { timeout: 40000 }).first().find('.event-card-side:not(:disabled)').first().click()
    cy.get('.trade-confirm', { timeout: 20000 }).should('exist')
    cy.get('.order-ticket').should('not.exist')
    assertFeeDisclosed('.trade-confirm')
    noSignatureYet()
  })

  it('[PR-05] predict.builder-fee-disclosed — on a gateway that predates /events the market sheet and then the fixed-price confirm disclose the fee', () => {
    chainWorld()
    predictGateway({ events: 'missing', books: 'missing' })
    geoblock(false)
    connect()
    spyOnWallet()
    cy.visit('/wallet?tab=predict')
    waitForAccount()

    // The list still renders (from the older /markets route) and a row's Yes/No opens the SHEET, as it always did.
    cy.get('.event-card', { timeout: 40000 }).should('have.length', MARKETS.length)
    cy.get('.event-card').first().find('.event-card-side:not(:disabled)').first().click()
    cy.get('.market-detail', { timeout: 20000 }).should('exist')
    cy.get('.order-ticket').should('not.exist')
    cy.get('.market-detail').contains('button', /^Buy$/).first().click({ force: true })
    cy.get('.trade-confirm', { timeout: 20000 }).should('exist')
    assertFeeDisclosed('.trade-confirm')
    noSignatureYet()
  })

  it('[PR-04] predict.builder-fee-disclosed — a restricted region is refused before any fee or signature (amount-first ticket)', () => {
    /*
     * The other side of the same gate, and the reason it is worth a test of its own: Polymarket
     * blocks order placement in some regions as a matter of THEIR policy. FairWins respects it and
     * never tries to bypass it — so the member gets an honest notice naming who sets the
     * restriction, and a link OUT to trade under Polymarket's own rules, instead of a dead button
     * or a submit that fails after they have committed to it.
     */
    chainWorld()
    predictGateway()
    geoblock(true)
    connect()
    spyOnWallet()
    cy.visit('/wallet?tab=predict')
    waitForAccount()

    cy.get('.event-card', { timeout: 40000 }).first().find('.event-card-side:not(:disabled)').first().click()
    cy.get('.order-ticket', { timeout: 20000 }).should('exist')
    assertRegionRefused('.order-ticket')
    cy.get('.order-ticket').find('input').should('not.exist') // nothing to type an amount into
    cy.get('@feeRate.all').should('have.length', 0) // the fee schedule was never even asked for
    noSignatureYet()
  })

  it('[PR-04b] predict.builder-fee-disclosed — a restricted region is refused on the fixed-price confirm too', () => {
    chainWorld()
    predictGateway({ books: 'missing' })
    geoblock(true)
    connect()
    spyOnWallet()
    cy.visit('/wallet?tab=predict')
    waitForAccount()

    cy.get('.event-card', { timeout: 40000 }).first().find('.event-card-side:not(:disabled)').first().click()
    cy.get('.trade-confirm', { timeout: 20000 }).should('exist')
    assertRegionRefused('.trade-confirm')
    noSignatureYet()
  })

  it('[PR-03] predict.hidden-off-polygon — the tab does not exist on a chain Polymarket does not serve', () => {
    /*
     * FR-018. Polymarket runs on Polygon and nowhere else, so on any other chain the tab HIDES
     * rather than rendering an empty or erroring surface. The gateway is configured here and
     * answering, so the only reason it can be absent is the chain — which is the claim.
     */
    chainWorld()
    predictGateway()
    connect(1, 'https://ethereum-rpc.publicnode.com')
    cy.visit('/fairwins?stay=1')
    waitForAccount()

    cy.visit('/wallet?tab=predict')
    // Asking for it by URL does not conjure it: an unavailable tab redirects rather than renders.
    /*
     * The PANEL is what must be absent. The URL keeps whatever was typed — an unavailable tab
     * resolves to Account internally rather than rewriting the address bar — so asserting on the
     * query string would be asserting a redirect the app does not perform.
     */
    cy.get('[aria-label="Predict"]').should('not.exist')

    // …and on Polygon, with the same gateway, it is there. Same build, same stub: only the chain
    // differs, which is what makes this a test of the chain gate.
    connect(137, 'https://polygon-bor-rpc.publicnode.com')
    cy.visit('/wallet?tab=predict')
    cy.get('[aria-label="Predict"]', { timeout: 40000 }).should('exist')
  })

  it('[CO-01] collect.browse-and-buy — an unreachable OpenSea gateway degrades honestly, never into "you own nothing"', () => {
    /*
     * Specs 055/056 FR-007 soft-fail. The Collect surface is READ-ONLY over OpenSea, and the
     * failure that matters is the same one as the portfolio's: a member whose gateway is down
     * must not be told their collection is empty.
     *
     * The gateway is deliberately NOT stubbed here — `dev:fast` points it at a dead port, which
     * is exactly the unreachable case.
     */
    chainWorld()
    connect()
    cy.visit('/wallet?tab=collectibles')
    waitForAccount()

    cy.get('.tab-content', { timeout: 40000 }).should('exist')
    cy.get('.tab-content').should(($c) => {
      const text = $c.text()
      const claimsEmptyAsFact = /you (do not|don.t) (own|have) any|no collectibles\b/i.test(text)
      const disclosesTheGap = /unavailable|could not|couldn.t|unreachable|try again|temporarily/i.test(text)
      expect(
        disclosesTheGap || !claimsEmptyAsFact,
        `an unreachable gateway must not be rendered as an empty collection. Rendered: ${text.slice(0, 400)}`,
      ).to.equal(true)
    })
  })

  it('[CO-02] collect.list-for-sale — every fee is itemised and the net proceeds shown BEFORE any signature', () => {
    /*
     * Spec 056 FR-002/FR-009/FR-014. Listing is the one Collect flow where the member gives
     * something up, and the number they actually care about is not the price — it is what lands in
     * their wallet after OpenSea's cut and the creator royalty. So the confirm step states both:
     * each required fee as its own line, and the resulting net.
     *
     * Two further claims are asserted because both are easy to get wrong in the honest direction:
     *
     *   - The FairWins referral reward is disclosed AND stated to cost the seller nothing. It
     *     genuinely does not — OpenSea pays it out of its own fee — and Collect is the surface
     *     where that is true. (Predict's builder fee is the opposite case and says so; the two
     *     sit side by side in this file precisely so neither drifts into the other's wording.)
     *   - A price that would not survive the fees is refused, not signed. Netting zero is not a
     *     listing, it is a donation with extra steps.
     */
    const ITEM = {
      chainId: 137,
      contract: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      identifier: '7',
      name: 'Test Collectible',
      collectionSlug: 'test-collection',
      imageUrl: null,
      standard: 'erc721',
      quantity: 1,
      isFlagged: false,
      openseaUrl: 'https://opensea.io/assets/matic/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/7',
    }
    const ENVELOPE = { fetchedAt: '2026-08-21T12:00:00.000Z', stale: false }

    cy.intercept('GET', '**/v1/opensea/137/account/**/nfts*', {
      statusCode: 200,
      body: { items: [ITEM], next: null, ...ENVELOPE },
    }).as('nfts')
    cy.intercept('GET', '**/v1/opensea/137/contract/**/nfts/**', {
      statusCode: 200,
      body: {
        item: ITEM,
        traits: [],
        collection: { slug: 'test-collection', name: 'Test Collection', floorPrice: null },
        bestOffer: null,
        bestOfferHash: null,
        listing: null,
        ...ENVELOPE,
      },
    }).as('detail')
    /*
     * 2.5% marketplace + 5% creator royalty, both REQUIRED. Two lines rather than one total,
     * because "fees: 7.5%" hides which of them a member could negotiate and which they cannot.
     */
    cy.intercept('GET', '**/v1/opensea/137/collections/test-collection/required-fees*', {
      statusCode: 200,
      body: {
        chainId: 137,
        collectionSlug: 'test-collection',
        marketplaceFee: { recipient: '0x0000a26b00c1F0DF003000390027140000fAa719', basisPoints: 250 },
        creatorRoyalty: { recipient: '0xcccccccccccccccccccccccccccccccccccccccc', basisPoints: 500, required: true },
        fees: [
          { recipient: '0x0000a26b00c1F0DF003000390027140000fAa719', basisPoints: 250, required: true },
          { recipient: '0xcccccccccccccccccccccccccccccccccccccccc', basisPoints: 500, required: true },
        ],
        totalRequiredBasisPoints: 750,
        protocolAddress: '0x0000000000000068F116a894984e2DB1123eB395',
        protocolVersion: '1.6',
        conduitKey: '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000',
        conduitAddress: '0x1E0049783F008A0085193E00003D00cd54003c71',
        ...ENVELOPE,
      },
    }).as('fees')

    chainWorld()
    connect(137, 'https://polygon-bor-rpc.publicnode.com')
    cy.visit('/wallet?tab=collectibles')
    waitForAccount()

    cy.contains('.collectible-card-button', 'Test Collectible', { timeout: 40000 }).click()
    cy.contains('button', /^Sell$/, { timeout: 20000 }).click()

    // Fees are CONFIRMED LIVE before the form is usable — a stale or guessed rate would be a
    // number the member relies on and we did not check (FR-009).
    cy.wait('@fees')
    cy.get('.sell-confirm', { timeout: 20000 }).should('be.visible')

    cy.get('input[aria-label="Listing price"]').clear().type('1')

    // Each required fee as its own line, and the net as its own row.
    cy.get('.sell-confirm-breakdown dt').should('have.length.at.least', 2)
    cy.get('[data-testid="sell-net"]').should('be.visible').should(($n) => {
      const text = $n.text()
      // 1.0 less 7.5% = 0.925. Asserted as a value, not merely as "something rendered": the whole
      // point of the row is that it is arithmetic the member can check.
      expect(text, `net proceeds were computed and shown. Rendered: ${text}`).to.contain('0.925')
    })

    // The referral is disclosed, and disclosed as free to the seller — which it is.
    cy.get('.sell-confirm-reward')
      .should('be.visible')
      .and('contain.text', 'referral')
      .and('contain.text', 'costs you nothing')

    // Signing is offered only once there is something to sign for.
    cy.get('.sell-confirm-submit').should('not.be.disabled')

    // A price the fees would swallow whole is refused rather than signed.
    cy.get('input[aria-label="Listing price"]').clear().type('0')
    cy.get('.sell-confirm-submit').should('be.disabled')
  })


  it('[CO-03] collect.browse-and-buy — a stocked collection browses, and market data that failed is not "no offers"', () => {
    /*
     * The other half of CO-01. That one proves an unreachable gateway is not rendered as an empty
     * collection; this one proves the collection renders when it IS reachable, and that the same
     * discipline holds one level down — inside an item, where the numbers are.
     *
     * "no offers yet" and "unavailable right now" are the two states a member could be shown for
     * the same blank space, and they mean opposite things: the first says the market looked and
     * found nobody, the second says we never got to ask. Someone deciding whether to sell acts on
     * that difference.
     */
    const ITEM = {
      chainId: 137,
      contract: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      identifier: '3',
      name: 'Browsable Collectible',
      collectionSlug: 'browse-collection',
      imageUrl: null,
      standard: 'erc721',
      quantity: 1,
      isFlagged: false,
      openseaUrl: 'https://opensea.io/assets/matic/0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/3',
    }
    const ENVELOPE = { fetchedAt: '2026-08-21T12:00:00.000Z', stale: false }

    cy.intercept('GET', '**/v1/opensea/137/account/**/nfts*', {
      statusCode: 200,
      body: { items: [ITEM], next: null, ...ENVELOPE },
    }).as('nfts')

    // A priced market: a floor AND a standing offer, both of which the sheet must show as numbers.
    cy.intercept('GET', '**/v1/opensea/137/contract/**/nfts/**', {
      statusCode: 200,
      body: {
        item: ITEM,
        traits: [{ traitType: 'Background', value: 'Teal' }],
        collection: { slug: 'browse-collection', name: 'Browse Collection', floorPrice: { amount: '1.25', currency: 'WETH' } },
        bestOffer: { amount: '0.9', currency: 'WETH' },
        bestOfferHash: '0x' + 'a'.repeat(64),
        listing: null,
        ...ENVELOPE,
      },
    }).as('detail')

    chainWorld()
    connect(137, 'https://polygon-bor-rpc.publicnode.com')
    cy.visit('/wallet?tab=collectibles')
    waitForAccount()

    // The grid is stocked, and the item is identified by name and collection.
    cy.contains('.collectible-card-name', 'Browsable Collectible', { timeout: 40000 }).should('be.visible')
    cy.contains('.collectible-card-button', 'Browsable Collectible').click()

    cy.wait('@detail')
    cy.get('.collectible-sheet-market', { timeout: 20000 })
      .should('contain.text', '1.25')
      .and('contain.text', '0.9')
    cy.get('.collectible-sheet-traits').should('contain.text', 'Background')

    /*
     * A standing offer is an amount someone will pay, so accepting it costs gas and deducts fees.
     * Both are disclosed on the confirm, before the member commits to anything.
     */
    cy.contains('button', /accept best offer/i).click()
    cy.get('[aria-label="Confirm accept offer"]')
      .should('contain.text', '0.9')
      .and('contain.text', 'you pay gas')
      // `.and('match', …)` on an element matches the SELECTOR, not the text — a trap worth not
      // stepping in twice. Text assertions go through contain.text.
      .and('contain.text', 'creator royalty')
    cy.contains('button', /not now/i).click()

    // Now the same item with the detail read REFUSED. The blank must read as unasked, not as empty.
    cy.intercept('GET', '**/v1/opensea/137/contract/**/nfts/**', {
      statusCode: 503,
      body: { error: { code: 'upstream_unavailable' } },
    }).as('detailDown')
    cy.reload()
    cy.contains('.collectible-card-button', 'Browsable Collectible', { timeout: 40000 }).click()
    cy.wait('@detailDown')

    cy.get('.collectible-sheet-market', { timeout: 20000 }).should(($m) => {
      const text = $m.text()
      expect(text, 'a market that could not be read says so').to.match(/unavailable right now/i)
      expect(text, 'and is never reported as a market with no offers').to.not.match(/no offers yet|no floor price yet/i)
    })
  })

})
