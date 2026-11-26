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
// Trading is untouched by this slice and stays covered by 37 (PR-02 / PR-04).
// =============================================================================

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const GATEWAY_URL = /localhost:8899\/v1\/polymarket/
const RPC_HOSTS = /publicnode\.com$|rivet\.link$|etcdesktop\.com$|polygon\.technology$/
const PAGE_SIZE = 3

// Token ids must be long digit strings or the real gateway would drop the outcome.
const TOKEN_YES = '71321045679252212594626385532706912750332728571942532289631379312455583992563'
const TOKEN_NO = '52114319501245915516055106046884209969926127482827954674443846427813813222426'

const row = (conditionId, label, displayPrice) => ({
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
    row('0xf2', 'No change', '0.05'),
    row('0xf3', '50+ bps decrease', '0.004'),
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
const world = { liveSlugs: [], books: 'fresh' }

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
  const bids = [level(mid - half, '284698.76'), level(mid - half - 0.01, '5120.00'), level(mid - half - 0.02, '40')].filter((l) => Number(l[0]) > 0)
  const asks = [level(mid + half, '220072.89'), level(mid + half + 0.01, '1200'), level(mid + half + 0.02, '12.5')].filter((l) => Number(l[0]) < 1)
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

function openPredict(search = '', { liveSlugs = [], books = 'fresh' } = {}) {
  cy.then(() => {
    world.liveSlugs = liveSlugs
    world.books = books
  })
  chainWorld()
  predictGateway()
  connect()
  cy.visit('/wallet?tab=predict' + search)
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
