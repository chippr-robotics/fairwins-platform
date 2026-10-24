/**
 * TradeSection (spec 082 + release 1.14.0) — the Trade tab's view switcher: Swap (the existing
 * TradePanel, untouched and still the default) | Wrap (the existing WrapView, moved here from
 * Transfer) | Perps (the cross-venue perpetual-futures view).
 *
 * The active view derives from `?view=` (the PayTransferPanel/EarnPanel idiom) so
 * `/wallet?tab=trade&view=perps` and `/wallet?tab=trade&view=wrap` are direct links and
 * back/forward keep working. Wrap is unconditional — it needs no gateway, only the connected
 * network's wrapped-native config, which WrapView resolves and explains itself. The Perps tab
 * renders only when the surface can exist at all (gateway configured — `perpsGatewayUrl()`);
 * cohort honesty (testnet ⇒ mainnet-only notice) is handled INSIDE PerpsView so a testnet member
 * gets an explanation, not a vanished tab. An unknown `?view=` falls back to Swap on its own.
 *
 * Wrap's old home was Transfer (`?tab=paytransfer&view=wrap`); PayTransferPanel redirects that
 * saved link to TRADE_WRAP_PATH so nothing bookmarked goes dead.
 */
import { useSearchParams } from 'react-router-dom'
import TradePanel from './TradePanel'
import PerpsView from '../perps/PerpsView'
import WrapView from '../wallet/WrapView'
import { perpsGatewayUrl } from '../../config/perps'

export default function TradeSection() {
  const [searchParams, setSearchParams] = useSearchParams()
  const perpsPossible = perpsGatewayUrl() !== ''

  const TABS = [
    { id: 'swap', label: 'Swap' },
    { id: 'wrap', label: 'Wrap' },
    ...(perpsPossible ? [{ id: 'perps', label: 'Perps' }] : []),
  ]
  const requested = searchParams.get('view')
  const view = TABS.some((t) => t.id === requested) ? requested : 'swap'

  const setView = (next) => {
    const params = new URLSearchParams(searchParams)
    if (next === 'swap') params.delete('view')
    else params.set('view', next)
    setSearchParams(params, { replace: true })
  }

  return (
    <div className="trade-section-root">
      <div className="trade-section-tabs" role="tablist" aria-label="Trade sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={view === t.id}
            className={`trade-section-tab ${view === t.id ? 'active' : ''}`}
            onClick={() => setView(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {view === 'swap' && (
        <div role="tabpanel" aria-label="Swap" data-attention="trade-swap">
          <TradePanel />
        </div>
      )}
      {view === 'wrap' && (
        <div role="tabpanel" aria-label="Wrap" data-attention="trade-wrap">
          <WrapView />
        </div>
      )}
      {view === 'perps' && (
        <div role="tabpanel" aria-label="Perps" data-attention="trade-perps">
          <PerpsView />
        </div>
      )}
    </div>
  )
}
