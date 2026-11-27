// =============================================================================
// 53-predict-game-view.cy.js
// Fast-tier E2E for the live game view on the Predict event page (spec 115, slices 1-2).
//
// The game view reads ONE gateway route (`GET /v1/sports/games/:id`) and nothing else, so everything it does is
// answerable at the gateway boundary and belongs in the no-chain tier. The gateway is stubbed with
// `cy.intercept`, answering as contracts/gateway-sports-api.md says it does; a module that is off answers 503
// `sports_unconfigured`. The Polymarket routes the event page needs are stubbed minimally (the books route is
// absent, which the page handles by design — this spec is about the game view, not prices).
//
//   PG-01 a live game: score, period, clock, a Live chip; field + plays with their sentences
//   PG-02 the module off: the page is exactly what it was — no game view, no placeholder, one request only
//   PG-03 a source that stops answering: last known, never Live; play detail unreadable is named, no plays
//   PG-04 the event page with a game view has no serious or critical accessibility violations
// =============================================================================

const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const POLYMARKET = /localhost:8899\/v1\/polymarket/
const SPORTS = /localhost:8899\/v1\/sports\//
const RPC_HOSTS = /publicnode\.com$|rivet\.link$|etcdesktop\.com$|polygon\.technology$/
const TOKEN_YES = '71321045679252212594626385532706912750332728571942532289631379312455583992563'
const TOKEN_NO = '52114319501245915516055106046884209969926127482827954674443846427813813222426'
const SLUG = 'eagles-vs-cowboys'

const GAME = {
  gameId: 19618,
  league: 'nfl',
  startTime: '2026-11-26T21:30:00Z',
  home: { name: 'Cowboys', code: 'DAL' },
  away: { name: 'Eagles', code: 'PHI' },
}
const EVENT = {
  slug: SLUG,
  title: 'Eagles vs. Cowboys',
  category: 'sports',
  volume: '2400000.5',
  volume24h: '120000',
  endDate: '2030-12-10T12:00:00Z',
  mutuallyExclusive: true,
  marketCount: 1,
  description: 'Resolves to the winner of the game.',
  resolutionSource: 'NFL',
  status: 'open',
  live: null,
  game: GAME,
  markets: [
    {
      conditionId: '0xg1',
      label: 'Cowboys win',
      tradable: true,
      negRisk: false,
      outcomes: [
        { name: 'Yes', tokenId: TOKEN_YES, price: '0.80' },
        { name: 'No', tokenId: TOKEN_NO, price: '0.20' },
      ],
      bestBid: null,
      bestAsk: null,
      lastTradePrice: null,
      volume: '1000',
      volume24h: '10',
      displayPrice: '0.80',
      tickSize: '0.01',
      minOrderSize: '5',
    },
  ],
}

// The game answer is a knob a test turns BEFORE it visits; the intercept reads it at request time.
// `ageMs` is how far behind the gateway's own `serverNow` the newest confirmation is — the app derives its
// state from THAT, never from the device clock.
const world = { game: 'live', ageMs: 2000 }

function playDetail(state = 'read') {
  const serverNow = Date.now()
  if (state === 'unreadable') return { state: 'unreadable', confirmedAt: null, situation: null, plays: [], behindVenue: false }
  return {
    state: 'read',
    confirmedAt: serverNow - 3000,
    situation: {
      possession: 'home',
      yardLine: 37,
      yardLineText: 'DAL 37',
      down: 4,
      distance: 18,
      downDistanceText: '4th & 18 at DAL 37',
      lineToGain: 55,
      redZone: false,
    },
    plays: [
      { id: 'p3', period: 'Q3', clock: '10:44', text: 'Pass incomplete to CeeDee Lamb.', scoring: false, side: 'home' },
      { id: 'p2', period: 'Q3', clock: '11:20', text: 'Jake Elliott 42 yard field goal is GOOD.', scoring: true, side: 'away' },
    ],
    behindVenue: false,
  }
}

function gateways() {
  cy.intercept({ method: 'GET', url: POLYMARKET }, (req) => {
    const now = new Date().toISOString()
    const json = (body, statusCode = 200) => req.reply({ statusCode, body })
    if (/\/discover(\?|$)/.test(req.url)) return json({ live: { count: 0, events: [] }, topics: [], confirmedAt: now, serverNow: now, stale: false })
    if (/\/fee-rate(\?|$)/.test(req.url)) return json({ builderTakerFeeBps: 50, builderMakerFeeBps: 0, polymarketTakerFeeBps: 0, fetchedAt: Date.now() })
    if (/\/events\/[a-z0-9-]+(\?|$)/.test(req.url)) return json({ ...EVENT, confirmedAt: now, serverNow: now, stale: false })
    if (/\/prices-history(\?|$)/.test(req.url)) {
      const nowSec = Math.floor(Date.now() / 1000)
      const points = Array.from({ length: 20 }, (_, i) => ({ t: nowSec - (19 - i) * 300, p: (0.7 + 0.01 * i).toFixed(3) }))
      return json({ tokenId: TOKEN_YES, range: '1d', points, confirmedAt: now, serverNow: now, stale: false })
    }
    return json({ error: { code: 'not_found' } }, 404)
  })

  cy.intercept({ method: 'GET', url: SPORTS }, (req) => {
    if (world.game === 'off') return req.reply({ statusCode: 503, body: { error: 'sports_unconfigured' } })
    const serverNow = Date.now()
    const row = {
      gameId: 19618,
      league: 'nfl',
      status: 'in-progress',
      score: { home: 28, away: 10 },
      period: 'Q3',
      clock: '10:39',
      possession: 'home',
      confirmedAt: serverNow - world.ageMs,
      confirmedBy: 'venue',
      agree: true,
      detail: playDetail(world.game === 'plays-unreadable' ? 'unreadable' : 'read'),
    }
    req.reply({
      statusCode: 200,
      body: {
        serverNow,
        sources: { venue: { state: 'read' }, plays: { state: world.game === 'plays-unreadable' ? 'unreadable' : 'read' } },
        games: [row],
      },
    })
  }).as('game')
}

function chainWorld() {
  cy.intercept({ method: 'POST', hostname: RPC_HOSTS }, (req) => {
    const one = ({ method, id }) => ({ jsonrpc: '2.0', id, result: method === 'eth_chainId' ? '0x89' : method === 'eth_blockNumber' ? '0x4000000' : method === 'eth_getBalance' ? '0x0' : '0x' })
    const body = req.body
    req.reply({ statusCode: 200, body: Array.isArray(body) ? body.map(one) : one(body || {}) })
  })
  cy.intercept({ method: 'GET', url: /polymarket\.com\/api\/geoblock/ }, { statusCode: 200, body: { blocked: false } })
  cy.intercept({ url: /clob\.polymarket\.com/ }, { statusCode: 503, body: { error: 'the venue is not reachable from the no-chain tier' } })
}

function openEvent(game, ageMs = 2000) {
  cy.then(() => {
    world.game = game
    world.ageMs = ageMs
  })
  chainWorld()
  gateways()
  cy.mockWeb3Provider({ account: ACCOUNT, preAuthorized: true, networkId: 137, rpcUrl: 'https://polygon-bor-rpc.publicnode.com' })
  cy.visit(`/wallet?tab=predict&event=${SLUG}`)
  cy.get('[aria-label="Predict"]', { timeout: 40000 }).should('exist')
  cy.get('.event-page h2', { timeout: 20000 }).should('have.text', 'Eagles vs. Cowboys')
}

describe('Predict — the live game view (spec 115)', () => {
  beforeEach(() => {
    cy.clearLocalStorage()
    cy.clearCookies()
  })

  it('[PG-01] predict.game-scoreboard — a live game shows its score, period, clock and a Live chip, above the outcomes', () => {
    openEvent('live')
    cy.get('[data-testid="game-view"]', { timeout: 20000 }).within(() => {
      cy.contains('.game-team', 'Cowboys').should('contain.text', '28')
      cy.contains('.game-team', 'Eagles').should('contain.text', '10')
      cy.get('[data-testid="game-status"]').should('have.text', 'In progress · Q3 · 10:39')
      cy.get('[data-testid="game-trust-chip"]').should('contain.text', 'Game information is live')
    })
    // Above the markets list, not below it.
    cy.get('[data-testid="game-view"]').then(($g) => {
      cy.get('#event-page-outcomes').then(($o) => {
        expect($g[0].compareDocumentPosition($o[0]) & Node.DOCUMENT_POSITION_FOLLOWING).to.be.greaterThan(0)
      })
    })
  })

  it('[PG-01] predict.game-field-and-plays — the field, its text equivalent and the plays, with the behind-the-broadcast sentence', () => {
    openEvent('live')
    cy.get('[data-testid="game-field"]', { timeout: 20000 }).within(() => {
      cy.get('svg').should('have.attr', 'aria-hidden', 'true')
      cy.get('.game-field-ball').should('exist')
      cy.get('.game-field-gain').should('exist')
      cy.get('[data-testid="game-field-text"]')
        .should('contain.text', '4th & 18 at DAL 37')
        .and('contain.text', 'Cowboys have the ball')
    })
    cy.get('[data-testid="game-plays"] li').should('have.length', 2).first().should('contain.text', 'Q3 10:44')
    cy.get('[data-testid="game-plays"]').should('contain.text', 'Scored: Jake Elliott 42 yard field goal is GOOD.')
    cy.get('[data-testid="game-view"]').should('contain.text', 'can be behind the broadcast and behind the market')
  })

  it('[PG-02] predict.game-scoreboard — with the module off the page is exactly what it was: no game view, no placeholder, one request', () => {
    openEvent('off')
    cy.get('#event-page-outcomes', { timeout: 20000 }).should('exist')
    cy.get('@game.all').should('have.length', 1)
    cy.get('[data-testid="game-view"]').should('not.exist')
    cy.get('.game-view').should('not.exist')
    // It does not ask again on this page view.
    cy.wait(6500)
    cy.get('@game.all').should('have.length', 1)
  })

  it('[PG-03] predict.game-scoreboard — a game last confirmed two minutes ago is Last known, never Live, and keeps its score', () => {
    openEvent('live', 120_000)
    cy.get('[data-testid="game-trust-chip"]', { timeout: 20000 })
      .should('contain.text', 'Showing the last known game information')
      .and('not.contain.text', 'is live')
    cy.get('.game-view').should('contain.text', '28')
  })

  it('[PG-03] predict.game-field-and-plays — an unreadable play source is named, with no field and no plays; the scoreboard stays', () => {
    openEvent('plays-unreadable')
    cy.get('.game-view', { timeout: 20000 }).should('contain.text', 'play-by-play source (ESPN)')
    cy.get('[data-testid="game-field"]').should('not.exist')
    cy.get('[data-testid="game-plays"]').should('not.exist')
    cy.get('.game-view').should('contain.text', 'Cowboys').and('contain.text', '28')
  })

  it('[PG-04] predict.game-scoreboard — the event page with a game view has no serious or critical accessibility violations', () => {
    openEvent('live')
    cy.get('[data-testid="game-field"]', { timeout: 20000 }).should('exist')
    cy.a11yScan({ context: '.predict-panel', label: 'predict event page with game view' })
  })
})
