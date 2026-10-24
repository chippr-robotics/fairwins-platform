/**
 * One row per chain, in one of the three states a chain read can be in (spec 071 FR-014).
 *
 * Shared so no view invents its own rendering of the three, because the whole point is that
 * they stay distinguishable everywhere:
 *
 *   read          → the value, in its own unit
 *   not deployed  → said explicitly. A FACT, not a gap — there is nothing here to have a value
 *   unreadable    → said explicitly, WITH the reason, plus a retry. Never a zero, never blank
 *
 * The last one is the reason this component exists. An operator auditing a control surface reads
 * a silent `0` as a fact, so an unreachable chain must never be able to look like an answer.
 *
 * Status is carried by TEXT, not colour alone (constitution V).
 */
import { formatUnits } from '../../lib/evm/units'
import { networkName } from '../../lib/chains/estate'
import { isRead, isNotDeployed, partialLabel, formatUnitAmount } from '../../lib/chains/chainReadResult'
import './ChainStateTable.css'

export default function ChainStateTable({ results = [], caption, totals = null, onRetry = null }) {
  return (
    <div className="chain-state">
      {caption && <h4 className="chain-state-caption">{caption}</h4>}
      <table className="chain-state-table">
        <caption className="sr-only">{caption || 'Per-network state'}</caption>
        <thead>
          <tr>
            <th scope="col">Network</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.chainId} className={`chain-state-row is-${r.status}`}>
              <th scope="row">{networkName(r.chainId)}</th>
              <td>
                {isRead(r) && <span className="chain-state-value">{formatUnitAmount(r, formatUnits)}</span>}
                {isNotDeployed(r) && (
                  <span className="chain-state-absent">Not deployed on this network</span>
                )}
                {!isRead(r) && !isNotDeployed(r) && (
                  <span className="chain-state-unreadable">
                    Could not be read — {r.reason}
                    {onRetry && (
                      <button type="button" className="chain-state-retry" onClick={onRetry}>
                        Retry
                      </button>
                    )}
                  </span>
                )}
              </td>
            </tr>
          ))}
          {results.length === 0 && (
            <tr>
              <td colSpan={2}>No networks in this build&rsquo;s cohort carry this contract.</td>
            </tr>
          )}
        </tbody>
      </table>

      {totals && (
        <div className="chain-state-totals">
          {Object.entries(totals.subtotals).length === 0 && (
            <p className="chain-state-total">No balances to total.</p>
          )}
          {/* Per unit. There is deliberately no single figure across units — different chains
              hold different tokens, and one number across them would be invented. */}
          {Object.entries(totals.subtotals).map(([symbol, amount]) => {
            const decimals =
              results.find((r) => r.unit?.symbol === symbol)?.unit?.decimals ?? 0
            return (
              <p key={symbol} className="chain-state-total">
                <strong>{formatUnits(amount, decimals)} {symbol}</strong>
                <span className="chain-state-total-scope"> across {symbol} networks</span>
              </p>
            )
          })}
          {totals.partial && (
            <p className="chain-state-partial" role="status">
              {partialLabel(totals, networkName)}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
