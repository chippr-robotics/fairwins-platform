/**
 * Nav search index — the hierarchical, keyword-tagged map of what actually lives inside each
 * section, so the drawer's filter can answer for the whole app instead of only for the twelve
 * words printed on the menu.
 *
 * The problem it solves: "morpho" is the protocol behind Earn ▸ Lend, but the word "Morpho"
 * appears nowhere in the menu, so a label-only filter reports no matches for the one term a
 * member is most likely to type. Same for opensea (Collect), polymarket (Predict), safe/multisig
 * (Protect), bip39 (Recovery), rpc (Network). This file is where a surface declares the protocols,
 * services and synonyms it answers to.
 *
 * THREE KINDS OF ENTRY, one shape of data:
 *   - `NAV_ITEM_TERMS` — extra terms for a nav ITEM that has no sub-surfaces of its own
 *     (Collect is one screen; it just needs to answer to "nft" and "opensea").
 *   - `NAV_DESTINATIONS` — a sub-surface INSIDE a section: a `?view=`, a subsection, or a
 *     preference card. Each is a direct shortcut the drawer can offer under its parent item.
 *   - `OFF_MENU_ITEMS` — Settings / Network / Membership / My Account. These deliberately live on
 *     the account button rather than in the drawer (config/appNav.js), and they STAY out of the
 *     resting menu — but a member typing "rpc" or "notifications" is asking a question, not
 *     browsing, so they join the results while a filter is active and leave again when it clears.
 *
 * Rules for entries:
 *   - `navId` MUST be a real nav item id or WalletPage tab id — `test/nav/navSearchIndex.test.js`
 *     checks every one against config/appNav.js + the tab list, so a renamed tab cannot leave a
 *     shortcut pointing at nothing.
 *   - `id` is ALSO the attention-flash target (`data-attention="<id>"`, see lib/nav/attention.js).
 *     A destination whose surface carries no marker still navigates correctly — the flash simply
 *     finds nothing and gives up quietly. Never the reverse: never point `path` somewhere the
 *     member cannot get to just because a marker exists.
 *   - `section` marks a destination that is an AccordionSection card (Settings / Recovery). Its
 *     `id` is the card's accordion id, which is what makes `#<id>` open it rather than merely
 *     scroll past a collapsed heading.
 *   - Keywords are lowercase and may be multi-word. They are matched by token prefix, so "morph"
 *     finds "morpho" and "multi" finds "multisig" — do not add stems by hand.
 *
 * This index is descriptive, not authoritative: it names where things are, and the sections
 * themselves remain the source of truth for whether they exist on this chain/tenant. Chain- and
 * tenant-hidden items are filtered out BEFORE their destinations are ever consulted (the drawer
 * attaches destinations to the items it is already rendering), so an index entry can never
 * resurrect a surface the app has decided not to offer.
 */

/** Terms a nav ITEM answers to beyond its own label. */
export const NAV_ITEM_TERMS = {
  // 'home' and 'portfolio' are the items' FORMER labels ("Payments" and "Accounts" now). They stay
  // as terms because members who learned the old names — and anyone following an older screenshot,
  // doc, or support answer — must still land on the same destination by typing them.
  home: ['home', 'dashboard', 'start', 'overview'],
  portfolio: ['portfolio', 'balances', 'holdings', 'assets', 'net worth', 'tokens', 'nfts', 'value'],
  earn: ['defi', 'yield', 'passive income', 'interest', 'apy'],
  trade: ['swap', 'exchange', 'dex', 'convert', 'buy', 'sell'],
  collectibles: ['nft', 'nfts', 'opensea', 'collectibles', 'gallery', 'art', 'erc-721'],
  predict: [
    'polymarket',
    'prediction market',
    'prediction markets',
    'odds',
    'forecast',
    'politics',
    'sports',
    'election',
    'builder fee',
  ],
  paytransfer: ['send', 'pay', 'receive', 'money', 'payment'],
  custody: ['safe', 'gnosis safe', 'multisig', 'vault', 'vaults', 'guard', 'policy', 'policies'],
  addressbook: ['contacts', 'recipients', 'nicknames', 'saved addresses', 'callsign', 'ens'],
  security: ['recovery', 'restore', 'passkey', 'keys', 'access'],
  reports: ['tax', 'taxes', 'csv', 'export', 'capital gains', 'cost basis', 'statement', 'accounting'],
  apps: ['mini-apps', 'miniapps', 'catalog', 'store', 'token mint', 'clearpath', 'ipfs'],
  // Spec 104. The tab is the AGENT controls — a member typing "guttertoken" or "api key" is
  // asking where the assistant's rail and their own tools' keys are configured.
  assistant: ['ai', 'chat', 'bot', 'agent', 'guttertoken', 'byok', 'credits', 'own key', 'provider', 'api key', 'mcp'],
  settings: ['preferences', 'options', 'configuration'],
  network: [
    'rpc',
    'endpoint',
    'endpoints',
    'node',
    'provider',
    'chain',
    'chains',
    'failover',
    'infura',
    'alchemy',
    'bring your own node',
  ],
  membership: ['tier', 'tiers', 'gold', 'silver', 'bronze', 'subscription', 'renew', 'upgrade', 'premium'],
  account: ['profile', 'my account', 'wallet', 'stats'],
}

/**
 * Sections that are reachable from the account button rather than the drawer. Shape-compatible
 * with a nav group so the drawer can splice them in unchanged while a filter is active.
 */
export const OFF_MENU_GROUP_LABEL = 'Settings & Account'

export const OFF_MENU_ITEMS = [
  { id: 'settings', label: 'Settings', icon: 'settings' },
  { id: 'network', label: 'Network', icon: 'globe' },
  { id: 'membership', label: 'Membership', icon: 'ticket' },
  { id: 'account', label: 'My Account', icon: 'user' },
]

/**
 * Sub-surfaces, in the order they appear inside their section. `path` is the destination's own
 * deep link; `hash` (cards only) names the accordion card so it lands OPEN.
 */
export const NAV_DESTINATIONS = [
  // ─── Payments ▸ Request ▸ Pool (spec 103) ───────────────────────────────────────────────
  {
    id: 'home-request-pool',
    navId: 'home',
    label: 'Pool money',
    summary: 'Collect money from a group toward a goal, then collect or refund it.',
    path: '/app?kind=pool',
    keywords: ['pool', 'pools', 'funding pool', 'fundraiser', 'collect', 'chip in', 'group gift', 'split', 'contribute', 'contributions', 'goal', 'my pools'],
  },
  // ─── Finance ▸ Earn (spec 050 / 065 / 067) ────────────────────────────────────────────────
  {
    id: 'earn-lend',
    navId: 'earn',
    label: 'Lend',
    summary: 'Deposit into a Morpho vault and earn interest.',
    path: '/wallet?tab=earn&view=lend',
    keywords: ['morpho', 'lend', 'lending', 'vault', 'vaults', 'erc-4626', 'apy', 'apr', 'yield', 'interest', 'savings', 'deposit', 'withdraw'],
  },
  {
    id: 'earn-rewards',
    navId: 'earn',
    label: 'Rewards',
    summary: 'Claim bonus tokens your deposits have earned.',
    path: '/wallet?tab=earn&view=rewards',
    keywords: ['merkl', 'rewards', 'claim', 'bonus', 'incentives', 'airdrop', 'distribution'],
  },
  {
    id: 'earn-stake',
    navId: 'earn',
    label: 'Stake',
    summary: 'Stake with a validator and earn staking rewards.',
    path: '/wallet?tab=earn&view=stake',
    keywords: ['lido', 'steth', 'spol', 'liquid staking', 'staking', 'stake', 'validator', 'validators', 'polygon pos', 'kiln', 'figment', 'everstake', 'chorus one', 'delegate'],
  },
  {
    id: 'earn-supply',
    navId: 'earn',
    label: 'Supply',
    summary: 'Supply liquidity to a Uniswap pool or the Across bridge pool.',
    path: '/wallet?tab=earn&view=supply',
    keywords: ['uniswap', 'across', 'liquidity', 'lp', 'supply', 'pools', 'market making', 'fees', 'position', 'positions'],
  },

  // ─── Finance ▸ Trade (spec 082) ───────────────────────────────────────────────────────────
  {
    id: 'trade-swap',
    navId: 'trade',
    label: 'Swap',
    summary: 'Exchange one token for another.',
    path: '/wallet?tab=trade&view=swap',
    keywords: ['uniswap', 'etcswap', 'dex', 'swap', 'exchange', 'convert', 'slippage', 'quote', 'router'],
  },
  {
    // Wrap moved here from Transfer (release 1.14.0) — the id doubles as the tabpanel's
    // `data-attention` marker, so it moved with the surface (`transfer-wrap` → `trade-wrap`).
    id: 'trade-wrap',
    navId: 'trade',
    label: 'Wrap',
    summary: 'Wrap the network coin into its ERC-20 form, or unwrap it back.',
    path: '/wallet?tab=trade&view=wrap',
    keywords: ['wrap', 'unwrap', 'wrapped', 'weth', 'wmatic', 'wpol', 'wetc', 'deposit', 'withdraw', 'erc-20', 'erc20', 'native'],
  },
  {
    id: 'trade-perps',
    navId: 'trade',
    label: 'Perps',
    summary: 'Perpetual futures market data from Gains, GMX and Hyperliquid.',
    path: '/wallet?tab=trade&view=perps',
    keywords: ['perps', 'perpetuals', 'futures', 'leverage', 'funding rate', 'open interest', 'gains network', 'gmx', 'hyperliquid', 'long', 'short'],
  },

  // ─── Finance ▸ Transfer (spec 067 / 073) ──────────────────────────────────────────────────
  {
    id: 'transfer-send',
    navId: 'paytransfer',
    label: 'Send',
    summary: 'Send tokens to any address on the same network.',
    path: '/wallet?tab=paytransfer&view=transfer',
    keywords: ['send', 'pay', 'usdc', 'stablecoin', 'gasless', 'recipient', 'bitcoin', 'btc'],
  },
  {
    id: 'transfer-bridge',
    navId: 'paytransfer',
    label: 'Bridge',
    summary: 'Move funds between networks.',
    path: '/wallet?tab=paytransfer&view=bridge',
    keywords: ['bridge', 'across', 'cross-chain', 'l2', 'move funds', 'relay'],
  },
  {
    id: 'transfer-wagers',
    navId: 'paytransfer',
    label: 'Wagers',
    summary: 'Create or accept a peer-to-peer wager.',
    path: '/wallet?tab=paytransfer&view=wagers',
    keywords: ['wager', 'wagers', 'bet', 'bets', 'challenge', 'p2p', 'escrow', 'stake against', 'oracle'],
  },

  // ─── Tools ▸ Protect (specs 043 / 068 / 084 / 085) — AccordionSection cards ───────────────
  {
    id: 'custody-onchain',
    navId: 'custody',
    section: true,
    label: 'Vaults & policies',
    summary: 'Safe multisig vaults, owners, and spending rules.',
    path: '/wallet?tab=custody',
    hash: '#custody-onchain',
    keywords: ['safe', 'gnosis safe', 'multisig', 'vault', 'vaults', 'guard', 'policy', 'policies', 'rules', 'approvers', 'owners', 'threshold', 'proposals', 'co-signer'],
  },
  {
    id: 'custody-verify',
    navId: 'custody',
    section: true,
    label: 'Verify',
    summary: 'Sign a message, or check somebody else’s signature.',
    path: '/wallet?tab=custody',
    hash: '#custody-verify',
    keywords: ['verify', 'sign message', 'signed message', 'signature', 'proof of ownership', 'erc-1271', 'personal_sign'],
  },
  {
    id: 'custody-offchain',
    navId: 'custody',
    section: true,
    label: 'Hardware wallets',
    summary: 'Cold storage: add and use Ledger or Trezor accounts.',
    path: '/wallet?tab=custody',
    hash: '#custody-offchain',
    keywords: ['hardware wallet', 'ledger', 'trezor', 'sigil', 'floppy', 'mpc', 'cold signer', 'cold storage', 'offline', 'off chain', 'device', 'usb wallet'],
  },

  // ─── Tools ▸ Recovery (specs 032 / 045 / 062) — AccordionSection cards ────────────────────
  {
    id: 'backup',
    navId: 'security',
    section: true,
    label: 'Data backup',
    summary: 'Encrypted backup and restore of this device’s data.',
    path: '/wallet?tab=security',
    hash: '#backup',
    keywords: ['backup', 'restore', 'export data', 'encrypted backup', 'sync', 'migrate device'],
  },
  {
    id: 'controllers',
    navId: 'security',
    section: true,
    label: 'Account controllers',
    summary: 'Add a passkey or link a wallet that can recover this account.',
    path: '/wallet?tab=security',
    hash: '#controllers',
    keywords: ['passkey', 'passkeys', 'controller', 'controllers', 'linked wallet', 'add device', 'access'],
  },
  {
    id: 'recover-account',
    navId: 'security',
    section: true,
    label: 'Recover access',
    summary: 'Regain access with a linked wallet.',
    path: '/wallet?tab=security',
    hash: '#recover-account',
    keywords: ['recover', 'regain access', 'lost passkey', 'locked out'],
  },
  {
    id: 'legacy-recovery',
    navId: 'security',
    section: true,
    label: 'Legacy account recovery',
    summary: 'Import an old private key or word list and move its funds.',
    path: '/wallet?tab=security',
    hash: '#legacy-recovery',
    keywords: ['private key', 'seed phrase', 'word list', 'mnemonic', 'bip39', 'bip-39', 'import wallet', 'old wallet', 'sweep', 'metamask'],
  },
  {
    id: 'encryption-key',
    navId: 'security',
    section: true,
    label: 'Encryption key',
    summary: 'The key that encrypts your wagers, and its on-chain registration.',
    path: '/wallet?tab=security',
    hash: '#encryption-key',
    keywords: ['encryption', 'encryption key', 'key registry', 'register key', 'decrypt'],
  },
  {
    id: 'recovery-codes',
    navId: 'security',
    section: true,
    label: 'Recovery codes',
    summary: 'One-time codes that restore access.',
    path: '/wallet?tab=security',
    hash: '#recovery-codes',
    keywords: ['recovery codes', 'backup codes', 'one-time codes'],
  },

  // ─── My Account views (spec 074) ──────────────────────────────────────────────────────────
  {
    id: 'account-activity',
    navId: 'account',
    label: 'Activity',
    summary: 'Everything this account has done.',
    path: '/wallet?tab=account&view=activity',
    keywords: ['activity', 'history', 'feed', 'timeline'],
  },
  {
    id: 'account-stats',
    navId: 'account',
    label: 'Stats',
    summary: 'Win rate, volume, and other account statistics.',
    path: '/wallet?tab=account&view=stats',
    keywords: ['stats', 'statistics', 'win rate', 'volume', 'performance', 'record'],
  },

  // ─── Settings cards (the preference menus) ────────────────────────────────────────────────
  {
    id: 'home-screen',
    navId: 'settings',
    section: true,
    label: 'Home screen',
    summary: 'What the app opens on.',
    path: '/wallet?tab=settings',
    hash: '#home-screen',
    keywords: ['home screen', 'landing', 'default view', 'start page', 'layout'],
  },
  {
    id: 'menu-density',
    navId: 'settings',
    section: true,
    label: 'Menu & navigation',
    summary: 'Row density and which menu sections start open.',
    path: '/wallet?tab=settings',
    hash: '#menu-density',
    keywords: ['menu', 'navigation', 'nav', 'density', 'compact', 'drawer', 'sidebar', 'sections', 'pinned apps'],
  },
  {
    id: 'wallet-display',
    navId: 'settings',
    section: true,
    label: 'Wallet display',
    summary: 'How your address and avatar are shown.',
    path: '/wallet?tab=settings',
    hash: '#wallet-display',
    keywords: ['wallet display', 'address format', 'avatar', 'blockies', 'identicon', 'ens name'],
  },
  {
    id: 'portfolio-prefs',
    navId: 'settings',
    section: true,
    label: 'Portfolio display',
    summary: 'Currency, hidden balances, and which tokens are listed.',
    path: '/wallet?tab=settings',
    hash: '#portfolio-prefs',
    keywords: ['portfolio', 'currency', 'fiat', 'hide small balances', 'dust', 'spam tokens'],
  },
  {
    id: 'privacy-prefs',
    navId: 'settings',
    section: true,
    label: 'Privacy',
    summary: 'What this app records and shares.',
    path: '/wallet?tab=settings',
    hash: '#privacy-prefs',
    keywords: ['privacy', 'analytics', 'telemetry', 'tracking', 'data sharing'],
  },
  {
    id: 'notifications',
    navId: 'settings',
    section: true,
    label: 'Notifications',
    summary: 'Alert profiles and what you are told about.',
    path: '/wallet?tab=settings',
    hash: '#notification-profiles',
    keywords: ['notifications', 'alerts', 'push', 'profiles', 'quiet hours', 'reminders'],
  },
  // Spec 095 / 104. These cards live on the ASSISTANT tab (Tools) since spec 104 — the `id` of a
  // destination IS the AccordionSection's card id, which is what `accordionSectionForHash` returns
  // and what `data-attention` matches, so they are named after the cards, not after the tab. The
  // ids did not change when the cards moved: WalletPage redirects `?tab=settings#assistant-prefs`
  // and `#api-access` here by asking THIS index whether the assistant tab owns the hash.
  {
    id: 'assistant-prefs',
    navId: 'assistant',
    section: true,
    label: 'Assistant',
    summary: 'The AI assistant, who answers it, what it sends, and what this device remembers.',
    path: '/wallet?tab=assistant',
    hash: '#assistant-prefs',
    keywords: ['ai', 'assistant', 'chat', 'agent', 'memory', 'privacy', 'bot', 'help', 'guttertoken', 'byok', 'credits', 'own key', 'provider', 'answered by'],
  },
  {
    id: 'guttertoken-key',
    navId: 'assistant',
    section: true,
    label: 'GutterToken key',
    summary: 'Your own GutterToken key, so the assistant runs on your prepaid credits.',
    path: '/wallet?tab=assistant',
    hash: '#guttertoken-key',
    keywords: ['guttertoken', 'gutter token', 'byok', 'bring your own key', 'own key', 'credits', 'prepaid', 'api key', 'model', 'provider', 'top up'],
  },
  {
    id: 'api-access',
    navId: 'assistant',
    section: true,
    label: 'API access',
    summary: 'Private API keys for your own tools and AI agents.',
    path: '/wallet?tab=assistant',
    hash: '#api-access',
    keywords: ['api', 'key', 'api key', 'token', 'mcp', 'agent', 'programmatic', 'developer', 'openapi', 'integration', 'byok', 'provider'],
  },
  // Spec 041 amendment. Members look for this by what it does ("lock", "screen lock", "idle
  // timeout"), not by its card name — and "auto lock" is what every other app calls it.
  {
    id: 'app-lock',
    navId: 'settings',
    section: true,
    label: 'App lock',
    summary: 'Cover the screen when idle; your passkey unlocks it.',
    path: '/wallet?tab=settings',
    hash: '#app-lock',
    keywords: ['app lock', 'lock', 'auto lock', 'screen lock', 'idle', 'timeout', 'unlock', 'biometric'],
  },
  {
    id: 'markets',
    navId: 'settings',
    section: true,
    label: 'Markets',
    summary: 'Which market categories appear on your home screen.',
    path: '/wallet?tab=settings',
    hash: '#markets',
    keywords: ['markets', 'categories', 'topics', 'polymarket categories', 'feed'],
  },
  {
    id: 'install-app',
    navId: 'settings',
    section: true,
    label: 'Install app',
    summary: 'Add this app to your home screen.',
    path: '/wallet?tab=settings',
    hash: '#install-app',
    keywords: ['install', 'pwa', 'add to home screen', 'standalone', 'app icon'],
  },
  {
    id: 'pwa-update',
    navId: 'settings',
    section: true,
    label: 'App update',
    summary: 'Check for and apply a new version.',
    path: '/wallet?tab=settings',
    hash: '#pwa-update',
    keywords: ['update', 'version', 'new version', 'refresh app', 'service worker'],
  },
  {
    id: 'legal-policies',
    navId: 'settings',
    section: true,
    label: 'Legal & policies',
    summary: 'Terms, risk disclosure, privacy policy, and moderation.',
    path: '/wallet?tab=settings',
    hash: '#legal-policies',
    keywords: ['legal', 'terms', 'terms of service', 'risk', 'privacy policy', 'moderation', 'compliance'],
  },
]

const BY_ID = new Map(NAV_DESTINATIONS.map((d) => [d.id, d]))

const BY_NAV_ID = NAV_DESTINATIONS.reduce((acc, d) => {
  ;(acc[d.navId] ||= []).push(d)
  return acc
}, {})

/** Every destination that lives inside `navId`, in index order. */
export function destinationsForNavItem(navId) {
  return BY_NAV_ID[navId] || []
}

/** A destination by its id, or null. Ids are also `data-attention` targets. */
export function destinationById(id) {
  return BY_ID.get(id) || null
}

/**
 * The URL a destination shortcut navigates to: its own deep link, carrying `focus=<id>` so the
 * surface it lands on can flash itself into view, and its `#card` hash last so an accordion card
 * lands open rather than collapsed.
 */
export function pathForDestination(destination) {
  const dest = typeof destination === 'string' ? destinationById(destination) : destination
  if (!dest) return null
  const separator = dest.path.includes('?') ? '&' : '?'
  return `${dest.path}${separator}focus=${encodeURIComponent(dest.id)}${dest.hash || ''}`
}

/**
 * The accordion card a `#hash` names on `tab`, or null. Lets a deep link land on an OPEN card
 * instead of a collapsed heading the member then has to hunt for — the mechanism Settings already
 * had, now derived from the index so Recovery gets it too and neither can drift from the other.
 */
export function accordionSectionForHash(tab, hash) {
  if (!tab || !hash) return null
  const match = NAV_DESTINATIONS.find((d) => d.section && d.navId === tab && d.hash === hash)
  return match ? match.id : null
}
