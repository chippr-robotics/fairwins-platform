// =============================================================================
// 52-predict-live.cy.js
// Fast-tier E2E for Predict "browse by event" (spec 114, User Story 1).
//
// The list reads the relay-gateway's `/events` route, so everything short of a
// signature is answerable at the gateway boundary and belongs in the no-chain tier
// (e2e-testing-policy: a flow validatable without a chain must not live on-chain).
// The gateway is stubbed here the way 37-predict-and-collect stubs it, and the
// stub MIRRORS the real route's rules — `q` ignores category and sort, a cursor
// pages — so a test can only pass if the app asks the right question, not merely
// if it renders whatever it is given.
//
// Slice 4 adds the event page (`event=<slug>`): the stub also answers `/events/:slug`, `/books` and
// `/prices-history`, and how FRESH its books are is a knob (`world.books`) a test turns while the page is
// open — that is how PL-08 watches a price lose its trust state without waiting out the clock.
//
// Slice 5 adds the amount-first ticket (PL-09..PL-12, and the ticket half of PL-08). Everything up to and
// including the review step is answerable at the gateway boundary, so it lives here. The signature itself is
// the one thing this tier cannot reach: the order goes client-direct to the venue's CLOB, which has no local
// stand-in (the matrix names that gap on `predict.place-order`). What the spec CAN prove is the half that
// protects the member: no signature is requested until Sign is pressed — and to keep "none was requested"
// from being vacuous, the same spy is shown to SEE the signature once Sign is pressed.
//
// Slice 6 adds order progress (PL-13..PL-15). The order itself cannot be PLACED in this tier (the CLOB has no
// local stand-in), so these start from an order already on the device — exactly the state a member is in after
// signing and reloading — and stub the venue's `GET /data/order/<id>` answer, which the tracker reads with the
// member's cached session. That is an honest model of FR-023..FR-025 (progress without a refresh, survival of a
// reload, an unconfirmed order that is never resubmitted); what it cannot show is the POST whose answer never
// arrives — that leg (and the hand-off of the order to the tracker) is covered in Vitest
// (usePredictPlanTrade.test, clobSession.market.test, orderHash.test).
//
// The legacy half (a gateway with no books route / no event route → the fixed-price sheet and confirm) is
// covered in 37-predict-and-collect (PR-02b, PR-04b, PR-05).
// =============================================================================

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const GATEWAY_URL = /localhost:8899\/v1\/polymarket/
const RPC_HOSTS = /publicnode\.com$|rivet\.link$|etcdesktop\.com$|polygon\.technology$/
const PAGE_SIZE = 3

// Token ids must be long digit strings or the real gateway would drop the outcome.
const TOKEN_YES = '71321045679252212594626385532706912750332728571942532289631379312455583992563'
const TOKEN_NO = '52114319501245915516055106046884209969926127482827954674443846427813813222426'

const row = (conditionId, label, displayPrice, volume = '9348387.921928', volume24h = '41200.5') => ({
  conditionId,
  label,
  tradable: true,
  negRisk: false,
  outcomes: [
    { name: 'Yes', tokenId: TOKEN_YES, price: displayPrice },
    { name: 'No', tokenId: TOKEN_NO, price: String(1 - Number(displayPrice)) },
  ],
  bestBid: null,
  bestAsk: null,
  lastTradePrice: null,
  // Per-market traded volume (T025a): decimal strings; both outcomes of a market share it.
  volume,
  volume24h,
  displayPrice,
  tickSize: '0.01',
  minOrderSize: '5',
})

const event = (slug, title, category, markets, over = {}) => ({
  slug,
  title,
  category,
  volume: '61605847.12',
  volume24h: '1820443.90',
  endDate: '2030-12-10T12:00:00Z',
  mutuallyExclusive: markets.length > 1,
  marketCount: markets.length,
  markets,
  ...over,
})

// Order matters: the default view is the FIRST page only (three events); "rain" lives on page two,
// so finding it takes a search — the point of PL-02.
const EVENTS = [
  event('fed-decision-in-december', 'Fed Decision in December?', 'economy', [
    row('0xf1', '25 bps increase', '0.935'),
    row('0xf2', 'No change', '0.05', '812.4', '0'),
    row('0xf3', '50+ bps decrease', '0.004', null, null),
    row('0xf4', '25 bps decrease', '0.003'),
  ], { marketCount: 6 }),
  event('bitcoin-above-200k', 'Bitcoin above $200k this year?', 'crypto', [row('0xb1', 'Bitcoin above $200k', '0.31')]),
  event('next-election', 'Who wins the next election?', 'politics', [row('0xe1', 'Incumbent party', '0.48')]),
  event('rain-london', 'Will it rain in London tomorrow?', 'world', [row('0xa1', 'Rain in London', '0.62')], { volume: null }),
]

// What the venue says is active now. Mutable on purpose: a test sets it BEFORE it visits, and the
// intercept reads it at request time, so one registration serves every case.
const TOPICS = [
  { slug: 'bitcoin', label: 'Bitcoin', events: 1, volume24h: '1000.5' },
  { slug: 'elections', label: 'Elections', events: 1, volume24h: '900' },
]
const TOPIC_EVENTS = { bitcoin: ['bitcoin-above-200k'], elections: ['next-election'] }
const IN_PLAY = { score: '91-101', period: 'Q4', elapsed: '06:47' }
const world = { liveSlugs: [], books: 'fresh', depth: 'deep' }

// How old the gateway says its books are (ms behind `serverNow`), or 'fail' for an outage. The app derives
// a price's state from THIS age on the gateway's clock plus time since receipt — never the device clock.
const BOOK_AGE_MS = { fresh: 0, 'aged-12': 12_000, 'aged-90': 90_000 }

// Every outcome of the event page gets its own token (the list stub shares two, which is fine for cards but
// would make four chart series one line).
const tokenFor = (i, side) => `${(side === 'yes' ? TOKEN_YES : TOKEN_NO).slice(0, -2)}${String(i).padStart(2, '0')}`
const withOwnTokens = (rows, offset = 0) =>
  rows.map((r, n) => ({
    ...r,
    outcomes: [
      { ...r.outcomes[0], tokenId: tokenFor(offset + n, 'yes') },
      { ...r.outcomes[1], tokenId: tokenFor(offset + n, 'no') },
    ],
  }))

const FED_DETAIL = {
  ...EVENTS[0],
  marketCount: 4,
  markets: withOwnTokens(EVENTS[0].markets),
  description: 'Resolves to the FOMC target range announced on the decision date.\nA change of at least 25 bps counts.',
  resolutionSource: 'https://www.federalreserve.gov/monetarypolicy.htm',
  status: 'open',
  live: null,
}
// Offset so no token is shared with the Fed event: the books stub prices a book by its token.
const RESOLVED_ROWS = withOwnTokens(
  [
    { ...row('0xe1', 'Rates held', '1'), winner: 'Yes' },
    { ...row('0xe2', 'Rates cut', '0'), winner: 'No' },
  ],
  10,
)
const RESOLVED_DETAIL = {
  ...event('ecb-decision-march', 'ECB decision in March?', 'economy', RESOLVED_ROWS),
  description: 'Resolved on the ECB press release.',
  resolutionSource: 'ECB press release',
  status: 'resolved',
  live: null,
}
const DETAILS = { [FED_DETAIL.slug]: FED_DETAIL, [RESOLVED_DETAIL.slug]: RESOLVED_DETAIL }

const PRICE_BY_TOKEN = {}
for (const detail of [FED_DETAIL, RESOLVED_DETAIL]) {
  for (const r of detail.markets) {
    PRICE_BY_TOKEN[r.outcomes[0].tokenId] = Number(r.outcomes[0].price)
    PRICE_BY_TOKEN[r.outcomes[1].tokenId] = Number(r.outcomes[1].price)
  }
}

/** A book for a token, centred on the price the listing gave it (so the page's live number is the row's own). */
const bookFor = (tokenId, venueTime) => {
  const mid = PRICE_BY_TOKEN[tokenId] ?? 0.5
  const half = Math.min(0.005, mid / 2, (1 - mid) / 2)
  const level = (price, size) => [price.toFixed(3), size]
  // 'thin' makes the whole ask side worth about $85 at the Fed row's 94¢ — an order of $200 outruns it.
  const thin = world.depth === 'thin'
  const bids = [level(mid - half, thin ? '40' : '284698.76'), level(mid - half - 0.01, thin ? '30' : '5120.00'), level(mid - half - 0.02, thin ? '20' : '40')].filter((l) => Number(l[0]) > 0)
  const asks = [level(mid + half, thin ? '40' : '220072.89'), level(mid + half + 0.01, thin ? '30' : '1200'), level(mid + half + 0.02, thin ? '20' : '12.5')].filter((l) => Number(l[0]) < 1)
  return {
    tokenId,
    bids,
    asks,
    tickSize: '0.001',
    minOrderSize: '5',
    lastTradePrice: mid.toFixed(3),
    venueTime,
    venueHash: `hash-${tokenId.slice(-4)}`,
  }
}

const withLive = (e) => ({ ...e, live: world.liveSlugs.includes(e.slug) ? IN_PLAY : null })

/** The gateway's `/events` and `/discover` rules, in miniature. */
function predictGateway() {
  cy.intercept({ method: 'GET', url: GATEWAY_URL }, (req) => {
    const now = new Date().toISOString()
    if (/\/discover(\?|$)/.test(req.url)) {
      return req.reply({
        statusCode: 200,
        body: {
          live: { count: world.liveSlugs.length, events: [] },
          topics: TOPICS,
          confirmedAt: now,
          serverNow: now,
          stale: false,
        },
      })
    }
    // The builder-fee schedule the ticket must confirm before it will quote: 50 bps taker / 0 maker (spec 057).
    if (/\/fee-rate(\?|$)/.test(req.url)) {
      req.alias = 'feeRate'
      return req.reply({
        statusCode: 200,
        body: { builderTakerFeeBps: 50, builderMakerFeeBps: 0, polymarketTakerFeeBps: 0, fetchedAt: Date.now() },
      })
    }
    const detail = /\/events\/([a-z0-9-]+)(\?|$)/.exec(req.url)
    if (detail) {
      req.alias = 'event'
      const found = DETAILS[detail[1]]
      return found
        ? req.reply({ statusCode: 200, body: { ...found, confirmedAt: now, serverNow: now, stale: false } })
        : req.reply({ statusCode: 404, body: { error: { code: 'not_found', reason: 'the marketplace does not know this event' } } })
    }
    if (/\/books(\?|$)/.test(req.url)) {
      req.alias = 'books'
      if (world.books === 'fail') {
        return req.reply({ statusCode: 503, body: { error: { code: 'upstream_unavailable', reason: 'books unreachable' } } })
      }
      const ids = (new URL(req.url).searchParams.get('token_ids') || '').split(',').filter(Boolean)
      const confirmedAt = new Date(Date.parse(now) - BOOK_AGE_MS[world.books]).toISOString()
      return req.reply({
        statusCode: 200,
        body: { books: ids.map((id) => bookFor(id, confirmedAt)), unreadable: [], confirmedAt, serverNow: now, stale: false },
      })
    }
    if (/\/prices-history(\?|$)/.test(req.url)) {
      req.alias = 'history'
      const p = new URL(req.url).searchParams
      const nowSec = Math.floor(Date.parse(now) / 1000)
      // 40 points five minutes apart, a gentle wave per token — enough for a line that can be seen.
      const base = 0.2 + (Number(String(p.get('token_id')).slice(-2)) % 5) * 0.15
      const points = Array.from({ length: 40 }, (_, i) => ({
        t: nowSec - (39 - i) * 300,
        p: (base + 0.05 * Math.sin(i / 4)).toFixed(3),
      }))
      return req.reply({ statusCode: 200, body: { tokenId: p.get('token_id'), range: p.get('range'), points, confirmedAt: now, serverNow: now, stale: false } })
    }
    if (!/\/events(\?|$)/.test(req.url)) return req.continue()
    const p = new URL(req.url).searchParams
    const q = (p.get('q') || '').toLowerCase()
    const category = p.get('category') || ''
    const topic = p.get('topic') || ''
    const live = p.get('live') === '1'
    const offset = Number(p.get('next') || 0)
    // The real route refuses more than one of category/topic/live; so does this, so a test can only pass
    // if the app sends one.
    if (!q && [category, topic, live ? '1' : ''].filter(Boolean).length > 1) {
      return req.reply({ statusCode: 400, body: { error: { code: 'invalid_filter', reason: 'one filter at a time' } } })
    }
    // `q` wins: the venue's search ignores category, topic, live and sort.
    const all = q
      ? EVENTS.filter((e) => e.title.toLowerCase().includes(q))
      : live
        ? EVENTS.filter((e) => world.liveSlugs.includes(e.slug))
        : topic
          ? EVENTS.filter((e) => (TOPIC_EVENTS[topic] || []).includes(e.slug))
          : category
            ? EVENTS.filter((e) => e.category === category)
            : EVENTS
    const events = all.slice(offset, offset + PAGE_SIZE).map(withLive)
    const next = offset + PAGE_SIZE < all.length ? String(offset + PAGE_SIZE) : null
    req.reply({ statusCode: 200, body: { events, next, confirmedAt: now, serverNow: now, stale: false } })
  }).as('events')
}

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

function connect() {
  cy.mockWeb3Provider({ account: ACCOUNT, preAuthorized: true, networkId: 137, rpcUrl: 'https://polygon-bor-rpc.publicnode.com' })
}

/** Polymarket's own geoblock endpoint (a direct browser call): an allowed region unless a test says otherwise. */
function geoblock(blocked = false) {
  cy.intercept({ method: 'GET', url: /polymarket\.com\/api\/geoblock/ }, { statusCode: 200, body: blocked ? { blocked: true, country: 'US', region: 'US' } : { blocked: false } })
}

/** The venue's CLOB has no stand-in here: anything that reaches it fails at once and offline. */
function clobDown() {
  cy.intercept({ url: /clob\.polymarket\.com/ }, { statusCode: 503, body: { error: 'the venue is not reachable from the no-chain tier' } })
}

const SIGNING = ['personal_sign', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v4', 'eth_signTransaction', 'eth_sendTransaction', 'eth_sendRawTransaction']
/**
 * Record every method the page asks the wallet for. It must wrap `request` BEFORE the app's scripts run: wagmi's
 * transport binds `provider.request` once, when it connects, so a wrap installed after load would see nothing and
 * every "no signature was requested" below would pass without measuring anything. A `window:before:load` handler
 * registered AFTER the mock provider's own (hence inside a `cy.then`, once `connect()` has run) runs after it, on
 * the same window, and before any app code.
 */
function spyOnWallet() {
  cy.then(() => {
    cy.on('window:before:load', (win) => {
      const eth = win.ethereum
      if (!eth || eth.__plSpy) return
      const original = eth.request
      eth.__plSpy = []
      eth.request = function request(args) {
        eth.__plSpy.push(args?.method)
        return original.call(this, args)
      }
    })
  })
}
/** Start counting from here: signatures asked since the ticket opened (the page's own load-time calls are not the point). */
const markWallet = () =>
  cy.window({ log: false }).then((win) => {
    expect(win.ethereum.__plSpy, 'the wallet spy is installed (else "no signature" would be vacuous)').to.be.an('array')
    win.ethereum.__plMark = win.ethereum.__plSpy.length
  })
/** Retries until the assertion holds, so a late request is still seen. */
const signaturesSinceMark = (check) =>
  cy.window({ log: false }).should((win) => {
    const asked = win.ethereum.__plSpy.slice(win.ethereum.__plMark || 0).filter((m) => SIGNING.includes(m))
    check(asked.length)
  })
const noSignature = () => signaturesSinceMark((n) => expect(n, 'the wallet has been asked for no signature').to.equal(0))

function openPredict(search = '', { liveSlugs = [], books = 'fresh', depth = 'deep', onBeforeLoad, clob = clobDown } = {}) {
  cy.then(() => {
    world.liveSlugs = liveSlugs
    world.books = books
    world.depth = depth
  })
  chainWorld()
  predictGateway()
  geoblock(false)
  clob()
  connect()
  spyOnWallet()
  cy.visit('/wallet?tab=predict' + search, onBeforeLoad ? { onBeforeLoad } : undefined)
  cy.get('[aria-label="Wallet Account"]', { timeout: 40000 }).should('exist')
  cy.get('[aria-label="Predict"]', { timeout: 40000 }).should('exist')
}

describe('Predict — browse by event (spec 114)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[PL-01] predict.browse-by-event — a category narrows the list, is in the address, and survives a reload', () => {
    openPredict()
    cy.get('.event-card', { timeout: 20000 }).should('have.length', PAGE_SIZE)

    cy.get('[role="group"][aria-label="Category"]').contains('button', 'Crypto').click()
    cy.get('.event-card', { timeout: 20000 }).should('have.length', 1)
    cy.get('.event-card').should('contain.text', 'Bitcoin above $200k')
    cy.get('.event-card').should('not.contain.text', 'Fed Decision')
    cy.get('[role="group"][aria-label="Category"]').contains('button', 'Crypto').should('have.attr', 'aria-pressed', 'true')
    cy.location('search').should('include', 'tab=predict').and('include', 'cat=crypto')

    // The address IS the view: loading it again, from nothing, lands on the same list.
    cy.location('search').then((search) => {
      openPredict(search.replace(/^\?tab=predict/, ''))
      cy.get('.event-card', { timeout: 20000 }).should('have.length', 1)
      cy.get('.event-card').should('contain.text', 'Bitcoin above $200k')
      cy.get('[role="group"][aria-label="Category"]').contains('button', 'Crypto').should('have.attr', 'aria-pressed', 'true')
    })
  })

  it('[PL-02] predict.browse-by-event — a search finds an event off the first page and says it ignores categories', () => {
    openPredict()
    cy.get('.event-card', { timeout: 20000 }).should('have.length', PAGE_SIZE)
    cy.contains('.event-card', 'rain in London').should('not.exist')

    cy.get('[aria-label="Search markets"]').type('rain')
    cy.get('.event-card', { timeout: 20000 }).should('have.length', 1)
    cy.get('.event-card').should('contain.text', 'Will it rain in London tomorrow?')
    cy.contains(/Searching all categories/i).should('be.visible')
    cy.get('[role="group"][aria-label="Category"] button').first().should('be.disabled')
    cy.location('search').should('include', 'q=rain')
  })

  it('[PL-03] predict.browse-by-event — an event with several markets is ONE card with its rows', () => {
    openPredict()
    cy.get('.event-card', { timeout: 20000 }).should('have.length', PAGE_SIZE)
    cy.get('.event-card').filter(':contains("Fed Decision in December?")').should('have.length', 1).within(() => {
      cy.get('.event-card-row').should('have.length', 4)
      cy.contains('25 bps increase').should('exist')
      cy.contains('+2 more').should('exist')
      // 0.935 is 94%; a 0.4% row is "<1%", never a rounded-to-nothing "0%".
      cy.get('.event-card-row').first().should('contain.text', '94%')
      cy.get('.event-card-row').eq(2).should('contain.text', '<1%')
      cy.contains('$61.6M traded').should('exist')
    })
    // The list says what it is: delayed, never live.
    cy.get('.predict-trust-chip').should('contain.text', 'Delayed').and('not.contain.text', 'Live')
  })

  it('[PL-04] predict.browse-by-event — the browse view has no serious or critical accessibility violations', () => {
    openPredict()
    cy.get('.event-card', { timeout: 20000 }).should('have.length', PAGE_SIZE)
    cy.a11yScan({ context: '.predict-panel', label: 'predict browse view' })
  })

  it('[PL-04b] predict.browse-by-event — a topic chip narrows the list, sets topic= and clears cat=', () => {
    openPredict('&cat=crypto')
    cy.get('.event-card', { timeout: 20000 }).should('have.length', 1)
    cy.get('.event-card').should('contain.text', 'Bitcoin above $200k')

    cy.get('[role="group"][aria-label="Active now"]', { timeout: 20000 }).contains('button', 'Elections').click()
    cy.get('.event-card', { timeout: 20000 }).should('have.length', 1)
    cy.get('.event-card').should('contain.text', 'Who wins the next election?').and('not.contain.text', 'Bitcoin above')
    cy.get('[role="group"][aria-label="Active now"]').contains('button', 'Elections').should('have.attr', 'aria-pressed', 'true')
    cy.location('search').should('include', 'topic=elections').and('not.include', 'cat=')

    // Choosing a category takes the topic back out of the address.
    cy.get('[role="group"][aria-label="Category"]').contains('button', 'Crypto').click()
    cy.location('search').should('include', 'cat=crypto').and('not.include', 'topic=')
    cy.get('.event-card', { timeout: 20000 }).should('have.length', 1).and('contain.text', 'Bitcoin above')

    // Pressing a pressed topic again clears it.
    cy.get('[role="group"][aria-label="Active now"]').contains('button', 'Bitcoin').click()
    cy.location('search').should('include', 'topic=bitcoin')
    cy.get('[role="group"][aria-label="Active now"]').contains('button', 'Bitcoin').click()
    cy.location('search').should('not.include', 'topic=')
    cy.get('.event-card', { timeout: 20000 }).should('have.length', PAGE_SIZE)
  })

  it('[PL-04c] predict.browse-by-event — the In play chip is absent when nothing is in play, and shows its count when something is', () => {
    openPredict('', { liveSlugs: [] })
    cy.get('.event-card', { timeout: 20000 }).should('have.length', PAGE_SIZE)
    // The topics are there, so the row is — and it names nothing in play.
    cy.get('[role="group"][aria-label="Active now"]', { timeout: 20000 }).contains('button', 'Bitcoin').should('exist')
    cy.get('[role="group"][aria-label="Active now"]').contains('button', /In play/).should('not.exist')
    cy.get('.event-card-live').should('not.exist')

    openPredict('', { liveSlugs: ['next-election'] })
    cy.get('[role="group"][aria-label="Active now"]', { timeout: 20000 }).contains('button', 'In play · 1').click()
    cy.location('search').should('include', 'live=1')
    cy.get('.event-card', { timeout: 20000 }).should('have.length', 1)
    // The venue's own words, as text — and nothing urgent beyond them.
    cy.get('.event-card-live').should('have.text', 'In play · 91-101 · Q4')
    cy.get('.event-card').should('not.contain.text', '06:47')
  })
})

describe('Predict — the event page (spec 114, slice 4)', () => {
  const FED = 'fed-decision-in-december'
  const chipText = ($c) => $c.text()
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[PL-05] predict.market-page — an event opens by its address in a fresh session: outcomes, chart ranges, depth and the resolution source', () => {
    openPredict(`&event=${FED}`)
    // No list was visited or loaded: the address alone is enough.
    cy.get('.event-page h2', { timeout: 20000 }).should('have.text', 'Fed Decision in December?')
    cy.get('.event-card').should('not.exist')
    cy.get('.event-page').should('contain.text', '$61.6M traded').and('contain.text', 'closes Dec 10, 2030')

    // Outcomes, most likely first, each with its probability and its own Yes/No.
    cy.get('.event-page-row').should('have.length', 4)
    cy.get('.event-page-row').first().should('contain.text', '25 bps increase').and('contain.text', '94%')
    cy.get('.event-page-row').eq(2).should('contain.text', '<1%')
    cy.get('.event-page-row-actions').first().contains('button', /^Yes 94¢/).should('be.visible')
    // Per-market volume (FR-005) beside each outcome: compact, a stated figure; an unstated one prints nothing, never $0.
    cy.get('.event-page-row').first().find('.event-page-row-volume').should('have.text', '$9.3M traded')
    cy.get('.event-page-row').eq(1).find('.event-page-row-volume').should('have.text', '$812 traded')
    cy.get('.event-page-row').eq(2).find('.event-page-row-volume').should('not.exist')

    // The chart: five ranges, 1D by default, a request per range, and a line that is really drawn.
    cy.get('[role="group"][aria-label="Chart range"] button').should('have.length', 5)
    cy.get('[role="group"][aria-label="Chart range"] button[aria-pressed="true"]').should('have.text', '1D')
    cy.get('.event-chart-plot path.recharts-line-curve', { timeout: 20000 }).should('have.length.at.least', 1)
    cy.get('.event-chart-plot path.recharts-line-curve').first().invoke('attr', 'd').should('match', /^M/)
    cy.get('.event-chart-legend li').should('have.length', 4)
    cy.get('[role="group"][aria-label="Chart range"]').contains('button', '1W').click()
    cy.get('[role="group"][aria-label="Chart range"] button[aria-pressed="true"]').should('have.text', '1W')
    cy.wait('@history')
    cy.get('@history.all').then((calls) => {
      expect(calls.some((c) => /range=1w/.test(c.request.url)), 'a 1W range was requested').to.equal(true)
    })

    // Depth for the selected outcome, as a real table, asks above bids.
    cy.get('.event-depth-table', { timeout: 20000 }).should('exist')
    cy.get('.event-depth-table caption').should('contain.text', 'Depth for 25 bps increase')
    cy.get('.event-depth-table tbody tr').first().should('contain.text', 'Ask')
    cy.get('.event-depth-table tbody tr').last().should('contain.text', 'Bid')

    // How this resolves: text, and an https source as a link that cannot reach back into the app.
    cy.contains('h3', 'How this resolves').should('exist')
    cy.get('.event-page-description').should('contain.text', 'FOMC target range')
    cy.get('.event-page-source a[href="https://www.federalreserve.gov/monetarypolicy.htm"]')
      .should('have.attr', 'rel', 'noopener noreferrer')
      .and('have.attr', 'target', '_blank')

    // Selecting another outcome drives the depth heading.
    cy.get('.event-page-select').eq(1).click()
    cy.get('.event-page-select').eq(1).should('have.attr', 'aria-pressed', 'true')
    cy.contains('h3', /^Depth — No change/).should('exist')
  })

  it('[PL-05] predict.market-page — opening from the list pushes the address, and Back returns to the list with its filter', () => {
    openPredict('&cat=economy')
    cy.get('.event-card', { timeout: 20000 }).should('have.length', 1)
    cy.get('.event-card-title').click()
    cy.location('search').should('include', `event=${FED}`).and('include', 'cat=economy')
    cy.get('.event-page h2', { timeout: 20000 }).should('have.text', 'Fed Decision in December?')
    cy.go('back')
    cy.get('.event-card', { timeout: 20000 }).should('have.length', 1)
    cy.location('search').should('not.include', 'event=').and('include', 'cat=economy')
    cy.get('.event-card-title').click()
    cy.contains('button', 'Back to markets').click()
    cy.get('.event-card', { timeout: 20000 }).should('have.length', 1)
    cy.location('search').should('not.include', 'event=')
  })

  it('[PL-06] predict.market-page — a resolved event says so, names the winner, and offers no order control', () => {
    openPredict('&event=ecb-decision-march')
    cy.get('.event-page h2', { timeout: 20000 }).should('have.text', 'ECB decision in March?')
    cy.get('.event-page-status').should('contain.text', 'This market has resolved')
    cy.get('.event-page-row').should('have.length', 2)
    cy.get('.event-page-row').first().should('contain.text', 'Resolved: Yes')
    cy.get('.event-page-row').eq(1).should('contain.text', 'Resolved: No')
    // No Yes/No, no Buy, no ticket entry — and nothing claiming a live price.
    cy.get('.event-page-side').should('not.exist')
    cy.get('.event-page-row-actions').should('not.exist')
    cy.get('.event-page button').filter((_, b) => /^(Yes|No|Buy|Sell)\b/.test(b.textContent.trim())).should('have.length', 0)
    cy.get('.predict-trust-chip').should('not.exist')
    cy.get('.event-depth').should('not.exist')
    // A source that is not an https URL is text.
    cy.get('.event-page-source').first().should('contain.text', 'ECB press release')
    cy.get('.event-page-source a').first().should('not.have.attr', 'href', 'ECB press release')
  })

  it('[PL-06] predict.market-page — an event the venue does not know says so, with a way back', () => {
    openPredict('&event=no-such-event')
    cy.contains(/could not find this event/i, { timeout: 20000 }).should('be.visible')
    cy.contains('button', 'Back to markets').click()
    cy.get('.event-card', { timeout: 20000 }).should('have.length.at.least', 1)
  })

  it('[PL-07] predict.market-page — the event page has no serious or critical accessibility violations', () => {
    openPredict(`&event=${FED}`)
    cy.get('.event-page h2', { timeout: 20000 }).should('have.text', 'Fed Decision in December?')
    cy.get('.event-chart-plot path.recharts-line-curve', { timeout: 20000 }).should('have.length.at.least', 1)
    cy.get('.event-depth-table', { timeout: 20000 }).should('exist')
    cy.a11yScan({ context: '.predict-panel', label: 'predict event page' })
  })

  it('[PL-08] predict.price-trust-state — a price that stops being confirmed leaves Live for Delayed, then Last known, and recovers', () => {
    openPredict(`&event=${FED}`, { books: 'fresh' })
    // The seam polls every 2 s; confirmed this second, the chip says so — and "Live" is a word it has to earn.
    cy.get('.event-page .predict-trust-chip', { timeout: 30000 }).should(($c) => {
      expect(chipText($c)).to.match(/Live/)
    })
    cy.get('.event-page-select').first().should('not.contain.text', 'Delayed').and('not.contain.text', 'Last known')

    // The gateway keeps answering, but its copy was last confirmed with the venue 12 s ago: delayed,
    // with an age, and the ladder says "as of" in words instead of merely dimming.
    cy.then(() => {
      world.books = 'aged-12'
    })
    cy.get('.event-page .predict-trust-chip', { timeout: 20000 }).should(($c) => {
      expect(chipText($c)).to.match(/Delayed · \d+ s/)
      expect(chipText($c)).not.to.match(/Live/)
    })
    cy.get('.event-depth-note').should('contain.text', 'as of').and('contain.text', 'not live')
    cy.get('.event-page-select').first().should('contain.text', 'Delayed')

    // Older again: last known — and still never Live.
    cy.then(() => {
      world.books = 'aged-90'
    })
    cy.get('.event-page .predict-trust-chip', { timeout: 20000 }).should(($c) => {
      expect(chipText($c)).to.match(/Last known · /)
      expect(chipText($c)).not.to.match(/Live|Delayed/)
    })
    cy.get('.event-depth-note').should('contain.text', 'Last known')

    // Confirmed again: back to Live with no reload.
    cy.then(() => {
      world.books = 'fresh'
    })
    cy.get('.event-page .predict-trust-chip', { timeout: 20000 }).should(($c) => {
      expect(chipText($c)).to.match(/Live/)
    })

    // And when the books stop answering altogether the last readings are KEPT and simply age: a failed
    // read is never drawn as a price that is still live. (The seam measures age on performance.now(),
    // which cy.clock does not move, so this phase waits out the real 5 s live bound.)
    cy.then(() => {
      world.books = 'fail'
    })
    cy.get('.event-page .predict-trust-chip', { timeout: 30000 }).should(($c) => {
      expect(chipText($c)).to.match(/Delayed · \d+ s/)
      expect(chipText($c)).not.to.match(/Live/)
    })
    // The probabilities are still there, marked — not blanked, and not zero.
    cy.get('.event-page-select').first().should('contain.text', '94%').and('contain.text', 'Delayed')
  })
})

describe('Predict — the ticket on a price that is not live (spec 114, T025b)', () => {
  const FED = 'fed-decision-in-december'
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[PL-08] predict.price-trust-state — the ticket refuses to quote on a price that is not live: it waits, shows no figure, closes a review, and recovers without a reload', () => {
    openPredict(`&event=${FED}`, { books: 'fresh' })
    cy.get('.event-page .predict-trust-chip', { timeout: 30000 }).should(($c) => expect($c.text()).to.match(/Live/))
    markWallet()
    cy.get('.event-page-row').first().find('.event-page-side--yes').click()
    cy.get('.order-ticket', { timeout: 20000 }).contains('label', /Amount to spend/).find('input').type('50')
    cy.get('.order-ticket [data-testid="figure-average"]', { timeout: 20000 }).should('exist')

    // The gateway keeps answering, but its copy was last confirmed 12 s ago: the ticket WAITS and draws nothing.
    cy.then(() => {
      world.books = 'aged-12'
    })
    cy.get('.order-ticket', { timeout: 20000 }).should('contain.text', 'Waiting for a current price…')
    cy.get('.order-ticket [data-testid="figure-average"]').should('not.exist')
    cy.get('.order-ticket [data-testid="figure-shares"]').should('not.exist')
    cy.get('.order-ticket [data-testid="figure-payout"]').should('not.exist')
    cy.get('.order-ticket [data-testid="figure-max-loss"]').should('not.exist')
    cy.get('.order-ticket').contains('button', 'Review order').should('be.disabled')
    // Never stranded: the venue itself is one tap away while the price is not current.
    cy.get('.order-ticket a[href^="https://polymarket.com"]').should('exist')

    // Confirmed again: figures return with no reload.
    cy.then(() => {
      world.books = 'fresh'
    })
    cy.get('.order-ticket [data-testid="figure-average"]', { timeout: 20000 }).should('exist')
    cy.get('.order-ticket').contains('button', 'Review order').should('be.enabled').click()
    cy.get('.order-ticket').contains('h4', 'Review your order').should('be.visible')

    // The price stops being current WHILE the member is reviewing: the review is closed by the app itself,
    // with a sentence, and nothing was signed.
    cy.then(() => {
      world.books = 'aged-12'
    })
    cy.get('.order-ticket', { timeout: 20000 }).should('contain.text', 'The price stopped being current, so the review was closed and nothing was signed.')
    cy.get('.order-ticket h4').filter(':contains("Review your order")').should('not.exist')
    cy.get('.order-ticket [data-testid="review-pay"]').should('not.exist')
    noSignature()
  })
})

describe('Predict — the amount-first order ticket (spec 114, slice 5)', () => {
  const FED = 'fed-decision-in-december'
  const ticket = () => cy.get('.order-ticket', { timeout: 20000 })
  const amount = () => ticket().contains('label', /Amount to spend/).find('input')
  const figure = (id) => cy.get(`.order-ticket [data-testid="${id}"]`)
  const reviewButton = () => ticket().contains('button', 'Review order')

  /** Open the event page, wait until its price is LIVE, and press Yes on the most likely row. */
  function openYes(opts) {
    openPredict(`&event=${FED}`, opts)
    cy.get('.event-page h2', { timeout: 20000 }).should('have.text', 'Fed Decision in December?')
    cy.get('.event-page .predict-trust-chip', { timeout: 30000 }).should(($c) => expect($c.text()).to.match(/Live/))
    markWallet()
    cy.get('.event-page-row').first().find('.event-page-side--yes').click()
    ticket().should('be.visible')
  }

  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[PL-09] predict.amount-first-ticket — the ticket opens EMPTY, and typing an amount shows average price, shares, payout and the most you can lose, which follow the amount', () => {
    openYes()
    ticket().contains('h3', 'Buy Yes — Fed Decision in December? — 25 bps increase').should('exist')
    // Responsible-use defaults: nothing typed, no quick amount chosen, no figure drawn from nothing.
    amount().should('have.value', '')
    cy.get('.order-ticket [role="group"][aria-label="Quick amounts"] button[aria-pressed="true"]').should('not.exist')
    figure('figure-average').should('not.exist')
    reviewButton().should('be.disabled')

    amount().type('50')
    figure('figure-average').should('have.text', '94¢')
    figure('figure-shares').should('contain.text', '53.19')
    figure('figure-payout').should('have.text', '$53.19 USDC')
    figure('figure-max-loss').should('have.text', '$50.25 USDC')
    // 94¢ is near certainty: dollars at risk beside dollars to gain, in plain currency.
    ticket().should('contain.text', 'You put $50.25 USDC at risk to gain $2.94 USDC.')
    reviewButton().should('be.enabled')

    // The figures FOLLOW the amount.
    amount().clear().type('25')
    figure('figure-payout').should('have.text', '$26.59 USDC')
    figure('figure-max-loss').should('have.text', '$25.13 USDC')
    // A quick amount is a deliberate press, and it is the same arithmetic.
    ticket().contains('button', '$100').click()
    amount().should('have.value', '100')
    figure('figure-payout').should('have.text', '$106.38 USDC')
  })

  it('[PL-10] predict.amount-first-ticket — an amount beyond the visible depth says how much can be filled, and an amount below the minimum says so at entry', () => {
    openYes({ depth: 'thin' })
    amount().type('200')
    ticket().should('contain.text', 'Only $85.30 USDC of this can be filled at the prices shown.')
    ticket().should('contain.text', 'This takes about 100% of what is on offer at these prices.')
    reviewButton().should('be.enabled')
    // The order that would be signed is for what can be filled, and the review says it is smaller than what was typed.
    reviewButton().click()
    ticket().contains('h4', 'Review your order').should('be.visible')
    ticket().should('contain.text', 'This order is for $85.30')
    figure('review-pay').should('have.text', '$85.30 USDC')
    ticket().contains('button', 'Edit').click()

    // Below the venue's minimum (5 shares): stated at entry, with the sentence a member can act on, never a code.
    amount().clear().type('1')
    ticket().should('contain.text', 'The smallest order here is 5 shares (about $4.70 USDC).')
    figure('figure-average').should('not.exist')
    reviewButton().should('be.disabled')
    ticket().should('not.contain.text', 'below-minimum')
  })

  it('[PL-11] predict.amount-first-ticket — every fee is its own line, the review names the price limit, and NO signature is requested until Sign', () => {
    openYes()
    amount().type('50')
    // The builder fee is its OWN line, a real cost, disclosed before anything is signed.
    ticket().find('.order-ticket-fee-line').should('have.length', 1).and('contain.text', 'FairWins builder fee').and('contain.text', '+$0.25 USDC')
    // The column adds up, in USDC: what is paid at most, plus the fee line, is the most that can be lost.
    figure('figure-pay').should('have.text', '$50.00 USDC')
    figure('figure-max-loss').should('have.text', '$50.25 USDC')
    ticket().should(($t) => {
      const text = $t.text()
      expect(text, 'the rate').to.match(/0\.50% builder fee/)
      expect(text, 'where the fee sits').to.match(/included above/i)
      expect(text, 'the venue fee is a separate charge').to.match(/Polymarket also charges its own taker fee/)
      expect(text, 'the order itself is gasless').to.match(/Signing this order costs no network fee\./)
      expect(text, 'an additive cost is never "free"').to.not.match(/builder[^.]{0,40}\bfree\b/i)
    })
    noSignature()

    // Review: the limit the signature will carry, in cents, and what it guarantees.
    reviewButton().click()
    ticket().contains('h4', 'Review your order').should('be.visible')
    ticket().should('contain.text', 'Nothing has been signed yet.')
    figure('review-pay').should('have.text', '$50.00 USDC')
    figure('review-max-loss').should('have.text', '$50.25 USDC')
    ticket().find('.order-ticket-fee-line').should('contain.text', 'FairWins builder fee')
    ticket().should('contain.text', 'Price limit: 94.1¢.')
    ticket().should('contain.text', 'cannot fill above 94.1¢ a share')
    ticket().should('contain.text', 'Whatever is not filled is cancelled and not charged.')
    ticket().should('contain.text', 'FairWins never holds your funds or your key. The order goes to Polymarket; the outcome is decided there.')
    ticket().should('contain.text', 'If you are wrong').and('contain.text', '$0.00')
    // Up to and including the review step the wallet has been asked for NO signature.
    noSignature()
    // Edit goes back with the amount kept, and still nothing is signed.
    ticket().contains('button', 'Edit').click()
    amount().should('have.value', '50')
    noSignature()

    // The spy is not blind: pressing Sign is what finally asks the wallet (the first prompt is the one-time,
    // gasless credential signature). The venue is unreachable in this tier, so the order itself fails — honestly.
    reviewButton().click()
    ticket().contains('button', 'Sign buy (no gas)').click()
    signaturesSinceMark((n) => expect(n, 'Sign is what asks the wallet').to.be.at.least(1))
  })

  it('[PL-12] predict.amount-first-ticket — the open ticket and its review have no serious or critical accessibility violations', () => {
    openYes()
    amount().type('50')
    figure('figure-average').should('exist')
    cy.a11yScan({ context: '.order-ticket', label: 'predict order ticket' })
    reviewButton().click()
    ticket().contains('h4', 'Review your order').should('be.visible')
    cy.a11yScan({ context: '.order-ticket', label: 'predict order review' })
  })

  it('[PL-12] predict.amount-first-ticket — the ticket is a modal dialog: named, focused on open, closed by Escape', () => {
    openYes()
    cy.get('.order-ticket[role="dialog"][aria-modal="true"]').should('have.attr', 'aria-labelledby')
    cy.focused().should('have.class', 'order-ticket')
    cy.get('body').type('{esc}')
    cy.get('.order-ticket').should('not.exist')
  })
})

describe('Predict — order progress (spec 114, slice 6)', () => {
  const ORDER_ID = `0x${'ab'.repeat(32)}`
  const venue = { status: 'LIVE', matched: '0', answer: 'order' } // mutable: the test moves the venue along
  const tracker = () => cy.get('.order-progress', { timeout: 30000 })

  const seed = (state, extra = {}) => (win) => {
    const now = Date.now()
    const record = {
      orderId: ORDER_ID, idKnown: true, tokenId: TOKEN_YES, side: 'BUY', kind: 'resting', size: '10', sizeUnit: 'shares',
      limitPrice: '0.4', label: 'Buy Yes — Fed Decision in December?', state, filledSize: '0', settledSize: null,
      averageFillPrice: null, createdAt: now, updatedAt: now, reason: null, absentSince: null, absentReads: 0, ...extra,
    }
    win.localStorage.setItem(`fw_user_${ACCOUNT.toLowerCase()}_predict_orders_v1`, JSON.stringify({ v: 1, orders: [record], idScheme: 'unknown' }))
    // The member's own CLOB session, as a trade earlier in the session would have left it (sessionStorage).
    win.sessionStorage.setItem(`predict.clob.creds.${ACCOUNT.toLowerCase()}`, JSON.stringify({ key: 'k', secret: 'c2VjcmV0c2VjcmV0', passphrase: 'p' }))
  }

  /** The venue's answer for the order, read at request time; anything that would PLACE an order is counted. */
  function venueStub() {
    cy.intercept({ method: 'GET', url: /clob\.polymarket\.com\/data\/order\// }, (req) => {
      if (venue.answer === 'missing') return req.reply({ statusCode: 404, body: { error: 'order not found' } })
      req.reply({ statusCode: 200, body: { id: ORDER_ID, status: venue.status, owner: 'k', maker_address: ACCOUNT, market: '0xf1', asset_id: TOKEN_YES, side: 'BUY', original_size: '10', size_matched: venue.matched, price: '0.4', associate_trades: [], outcome: 'Yes', created_at: 1, expiration: '0', order_type: 'GTC' } })
    }).as('venueOrder')
    cy.intercept({ method: 'GET', url: /clob\.polymarket\.com\/data\/trades/ }, { statusCode: 200, body: { data: [], next_cursor: 'LTE=', count: 0, limit: 100 } })
    cy.intercept({ method: 'POST', url: /clob\.polymarket\.com\/order/ }, { statusCode: 503, body: { error: 'down' } }).as('placed')
  }
  // `answer` is what the venue says about the order from the FIRST look (the tracker looks as soon as the page mounts).
  const open = (state, extra, answer = 'order') => {
    cy.then(() => Object.assign(venue, { status: 'LIVE', matched: '0', answer }))
    // The venue stub replaces the blanket 503 BEFORE the page loads: the tracker looks at once, on mount.
    openPredict('', {
      onBeforeLoad: seed(state, extra),
      clob: () => {
        clobDown()
        venueStub() // registered after the blanket, so it answers first
      },
    })
  }

  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[PL-13] predict.order-progress — a resting order advances to partly matched and matched WITHOUT the member doing anything, and no list has a Refresh button', () => {
    open('resting')
    tracker().contains('Your orders in progress').should('exist')
    tracker().should('contain.text', 'Waiting on Polymarket')
    tracker().find('[aria-current="step"]').should('contain.text', 'Waiting on the order book (current step)')
    cy.get('[aria-label="Predict"]').contains('button', /refresh/i).should('not.exist')
    cy.then(() => Object.assign(venue, { matched: '4' }))
    tracker().should('contain.text', 'Partly matched: 4 shares so far')
    tracker().find('[aria-current="step"]').should('contain.text', 'Partly matched (current step)')
    cy.then(() => Object.assign(venue, { status: 'MATCHED', matched: '10' }))
    tracker().should('contain.text', 'Matched by Polymarket: 10 shares')
    // "Matched" is the venue's word; settlement is the chain's, and this app does not claim it.
    tracker().should('contain.text', 'Settlement happens on the blockchain').and('not.contain.text', 'Settled on chain (')
    cy.a11yScan({ context: '.order-progress', label: 'predict order progress' })
    cy.get('@placed.all').should('have.length', 0)
  })

  it('[PL-14] predict.order-progress — the order is still there, with its state, after the app is reloaded', () => {
    open('resting')
    tracker().should('contain.text', 'Waiting on Polymarket')
    cy.reload()
    cy.get('[aria-label="Predict"]', { timeout: 40000 }).should('exist')
    tracker().should('contain.text', 'Buy Yes — Fed Decision in December?').and('contain.text', 'Waiting on Polymarket')
    // Device-only, and public facts only: no signature or credential is in the stored record.
    cy.window().then((win) => {
      const raw = win.localStorage.getItem(`fw_user_${ACCOUNT.toLowerCase()}_predict_orders_v1`)
      expect(raw).to.be.a('string')
      expect(raw).to.not.match(/signature|secret|passphrase/i)
    })
  })

  it('[PL-15] predict.order-progress — an order whose answer never arrived is "not confirmed", is not a failure, and offers no way to send it again', () => {
    open('unconfirmed', { reason: 'Polymarket did not confirm whether it received this order.', filledSize: null }, 'missing')
    tracker().should('contain.text', 'Not confirmed yet').and('contain.text', 'Do not send it again')
    tracker().should(($t) => expect($t.text()).to.not.match(/fail|error|refused/i))
    tracker().find('[role="alert"]').should('not.exist')
    // One control, and it is the member saying they have checked — never a way to send the order again.
    tracker().find('button').should('have.length', 1).and('have.text', 'I have checked on Polymarket — stop tracking this')
    tracker().contains('a', 'Check on Polymarket').should('have.attr', 'rel').and('contain', 'noopener')
    // Looked up, never posted: the stub has seen reads of the order and no attempt to place anything. With the
    // order not found and this device never having seen a venue id match, it stays unconfirmed — not guessed.
    cy.wait('@venueOrder')
    tracker().should('contain.text', 'Not confirmed yet')
    cy.get('@placed.all').should('have.length', 0)
  })

  it('[PL-15] predict.order-progress — an unconfirmed order the venue DOES hold is resolved by looking it up: it becomes a waiting order, and nothing is posted', () => {
    open('unconfirmed', { reason: 'Polymarket did not confirm whether it received this order.', filledSize: null }, 'order')
    tracker().should('contain.text', 'Waiting on Polymarket')
    tracker().should('not.contain.text', 'Not confirmed yet')
    cy.get('@placed.all').should('have.length', 0)
  })
})
