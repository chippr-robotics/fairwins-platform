import { useState } from 'react'
import { Navigate, useSearchParams } from 'react-router-dom'
import TransferForm from './TransferForm'
import BridgeView from './BridgeView'
import BridgeStatusList from './BridgeStatusList'
import BridgeUnavailableNotice from './BridgeUnavailableNotice'
import Dashboard from '../fairwins/Dashboard'
import { BRIDGE_UNAVAILABLE_REASON } from '../../hooks/useBridgeAvailability'
import { bridgeGatewayUrl } from '../../lib/bridge/acrossQuotes'
import { WAGERS_VIEW, TRADE_WRAP_PATH, isNavItemEnabledForTenant } from '../../config/appNav'
import './PayTransfer.css'

/*
 * Wagers sits with the other ways money moves in this section — the tabs are all actions.
 *
 * It is TENANT-GATED, unlike its neighbours. Transfer and Bridge are core platform surfaces
 * every tenant gets; wagers is an optional manifest feature (spec 072), so on a tenant without it
 * the tab is ABSENT rather than present-and-broken — and because `?view=` only accepts ids that are
 * in this list, a saved `?view=wagers` link for that tenant falls back to Transfer on its own.
 */
const WAGERS_ENABLED = isNavItemEnabledForTenant(WAGERS_VIEW.id)

const TABS = [
  { id: 'transfer', label: 'Transfer' },
  { id: 'bridge', label: 'Bridge' },
  ...(WAGERS_ENABLED ? [{ id: WAGERS_VIEW.view, label: WAGERS_VIEW.label }] : []),
]

const TAB_IDS = TABS.map((t) => t.id)

/**
 * Transfer — the section where money moves. Send the active chain's stablecoin (gasless) or native
 * coin to any address, wrap that coin into its ERC-20 form and back, move value across networks, or
 * stake it against a counterparty.
 *
 * The section is named "Transfer" to members (spec 067 FR-001); its tab id stays `paytransfer` and the
 * component keeps its filename so existing deep links and imports resolve unchanged (FR-002).
 *
 * Spec 067 FR-004 added Bridge BESIDE Send — the same-chain send flow is untouched and stays the
 * default tab. The active tab is derived from `?view=` (the EarnPanel idiom) so
 * `/wallet?tab=paytransfer&view=bridge` is a direct link and back/forward keep working.
 *
 * Wagers joined the same row (spec 073): it was its own `/wagers` destination, and it is now another
 * way money leaves this section. `/wagers` redirects here so every saved link keeps working.
 *
 * Wrap USED to sit second in this row; it now lives in Trade beside Swap (release 1.14.0) — it is
 * what a member needs immediately before a DEX, and that is where they look for it. The old
 * `?view=wrap` deep link redirects there (see the Navigate below) rather than dying.
 *
 * Activity is NOT a tab here. Transfer history is the activity ledger's (spec 051), and My Account ▸
 * Activity renders it in full for every class of entry — a second, transfer-only copy of the same
 * feed inside this section only made two places to look for one answer. The `?view=activity` id is
 * gone with it, so a saved link falls back to Transfer rather than opening an empty panel.
 *
 * Transfer is still the default view, so a member who came to send money sees the send form exactly
 * as before.
 */
export default function PayTransferPanel() {
  const [searchParams, setSearchParams] = useSearchParams()
  const requested = searchParams.get('view')

  // Wrap moved into Trade (release 1.14.0). The old `?tab=paytransfer&view=wrap` link is on saved
  // bookmarks and in muscle memory, so it redirects to the new location instead of silently
  // falling back to the send form — the same reasoning as App.jsx's `/wagers` → WAGERS_PATH
  // redirect (spec 073 FR-030): a redirect costs nothing where a dead link costs a member the
  // surface. The tab guard stops a re-render at the target URL from redirecting again.
  if (requested === 'wrap' && searchParams.get('tab') !== 'trade') {
    return <Navigate to={TRADE_WRAP_PATH} replace />
  }

  const tab = TAB_IDS.includes(requested) ? requested : 'transfer'

  const setTab = (next) => {
    const params = new URLSearchParams(searchParams)
    if (next === 'transfer') params.delete('view')
    else params.set('view', next)
    setSearchParams(params, { replace: true })
  }

  return (
    <div className="pt-root">
      {/* The send tab carries no blurb: the form states its own asset, its own fee and its own
          gasless badge, all of which are read from the chain and stay true when the copy would
          not. The tabs that DO carry one say something the form cannot show — what a bridge or a
          wager does to your money — rather than describing the controls underneath them. */}
      <div className="pt-tabs" role="tablist" aria-label="Transfer sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`pt-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'transfer' && (
        <div role="tabpanel" aria-label="Transfer" data-attention="transfer-send">
          {/* Nothing to redirect to on success any more: the send reports its own outcome through
              the notification, and the full history lives in My Account ▸ Activity. Staying put
              also leaves the member where they can send again. */}
          <TransferForm />
        </div>
      )}
      {tab === 'bridge' && (
        <div role="tabpanel" aria-label="Bridge" data-attention="transfer-bridge">
          <BridgeTab />
        </div>
      )}
      {tab === WAGERS_VIEW.view && WAGERS_ENABLED && (
        /* `pt-wagers` neutralises the page-level chrome Dashboard carries for its old absolute
           route (its own padding + a full-height scroll region) — the same thing HomeScreen.css
           does for the home surface. The component itself is untouched. */
        <div role="tabpanel" aria-label="Wagers" className="pt-wagers" data-attention="transfer-wagers">
          {/* One line, and only because it says the thing that makes this tab different from its
              neighbours: a send leaves the wallet and is gone, a wager is ESCROWED and comes back
              if nothing happens. The rest of what this paragraph used to explain — who settles,
              what each wager type does — is on the cards directly below it. */}
          <p className="pt-intro">
            Your stake is escrowed by the contract, not sent to the other party, and refunded if the
            wager is never accepted or resolved.
          </p>
          <Dashboard />
        </div>
      )}
    </div>
  )
}

/**
 * The Bridge tab (spec 067, US1).
 *
 * ── WHY THIS TAB DOES NOT GATE ON THE WALLET'S ACTIVE CHAIN ──────────────────────────────────
 * It used to. That was wrong, and it broke the premise of the whole surface: a bridge originates
 * on the SOURCE asset's network, not on whichever network the wallet happens to be sitting on, and
 * FR-059/FR-061 exist precisely so a member never has to switch networks to find or select an
 * asset. Gating here meant a member on Ethereum Classic holding USDC on Polygon was told to "pick
 * an asset on one of those networks" with no asset selector rendered to pick from — an instruction
 * that could not be followed inside the surface.
 *
 * So the only thing checked at this level is the one precondition that is genuinely GLOBAL: without
 * a quoting gateway no honest price can be produced for any network (research R10), and a bridge
 * price cannot be derived client-side. Everything else — no protocol on this network, router
 * undeployed, router unreachable, route paused — is a property of the SELECTED SOURCE, and
 * BridgeView resolves and explains each of those per source (FR-051/FR-052).
 *
 * The in-flight list renders UNDERNEATH in every case, including the unavailable ones: a paused
 * route or an unreachable gateway must never hide a transfer that is already moving (FR-053).
 */
function BridgeTab() {
  const gatewayReady = bridgeGatewayUrl() !== ''
  // Bumped when a bridge is recorded, so the in-flight list below reloads immediately. Without it a
  // transfer the member just made is invisible on the very screen that reported it.
  const [recordedAt, setRecordedAt] = useState(0)

  return (
    <div className="bridge-tab">
      {/* The blurb is gone; the tip that was pinned to it is not. What it described — that you see
          the exact arriving amount and every cost before signing — the quote states as FIGURES a
          few rows down, and a promise of a disclosure above a screen that makes it is one sentence
          doing no work. The InfoTip rides the field where a member first needs it instead. */}
      {gatewayReady ? (
        <BridgeView onRecorded={() => setRecordedAt(Date.now())} />
      ) : (
        <BridgeUnavailableNotice reason={BRIDGE_UNAVAILABLE_REASON.GATEWAY} />
      )}
      <BridgeStatusList refreshKey={recordedAt} />
    </div>
  )
}
