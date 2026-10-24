import { useCallback, useEffect, useRef, useState } from 'react'

import { apiUrl, requestJson } from './apiClient'
import { daysUntil, formatUnixSeconds, shortHex } from './format'

const ME_PATH = '/v1/member/me'

/**
 * Token introspection — what the gateway says about the token the member pasted (spec 095).
 *
 * The interesting part is MEMBERSHIP, which is a three-state read on the reference chain and must
 * be rendered as three. `read` carries a tier; `not-configured` means the question cannot be asked
 * on this deployment; `unreadable` means it was asked and the chain did not answer. Neither of the
 * last two is "no membership", and neither may be rendered as tier 0 — so the gateway's own
 * `reason` is shown VERBATIM rather than translated into a verdict this console cannot support.
 */
export default function IntrospectionPanel({ baseUrl, token }) {
  const [state, setState] = useState({ status: 'idle' })
  const abortRef = useRef(null)

  /*
   * A token change invalidates any answer on screen: showing the previous key's scopes next to a
   * new key's box is the one mistake that would make this panel actively misleading.
   *
   * Invalidation is DERIVED, never scheduled. Every answer records the token and base URL it was
   * asked about, and the render below shows it only while both still match — so a stale answer is
   * gone in the same frame the input changes, with no window where the old key's scopes sit next
   * to the new key's box. The previous shape (an effect resetting state on [token, baseUrl])
   * additionally scheduled one update per keystroke; typed in a single synchronous burst (Cypress
   * `delay: 0`, a paste-then-fix), those updates trip React's nested-update limit and crash the
   * whole console — reproduced and pinned in __tests__/ApiAccessConsole.test.jsx.
   */
  const view = state.status !== 'idle' && (state.forToken !== token || state.forBaseUrl !== baseUrl)
    ? { status: 'idle' }
    : state

  useEffect(() => () => abortRef.current?.abort(), [])

  const check = useCallback(async () => {
    if (!baseUrl || !token) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    // Every state carries what it was asked about, so the derived view above can retire it the
    // moment either input changes.
    const asked = { forToken: token, forBaseUrl: baseUrl }
    setState({ status: 'loading', ...asked })
    try {
      const result = await requestJson(apiUrl(baseUrl, ME_PATH), { token, signal: controller.signal })
      if (controller.signal.aborted) return
      if (result.state === 'ok') setState({ status: 'read', me: result.body, ...asked })
      else if (result.state === 'error') setState({ status: 'unavailable', error: result.error, httpStatus: result.status, ...asked })
      else setState({ status: 'unavailable', reason: result.reason, ...asked })
    } catch (err) {
      if (err && err.name === 'AbortError') return
      setState({ status: 'unavailable', reason: String((err && err.message) || err), ...asked })
    }
  }, [baseUrl, token])

  return (
    <section className="aa-card">
      <h2 className="aa-card-title">This token</h2>
      <p className="aa-help">
        Asks <code>GET {ME_PATH}</code> what the gateway makes of the token above — who signed it,
        what it may do, when it stops working, and whether the account behind it still holds a paid
        membership.
      </p>

      <button type="button" className="aa-btn aa-btn-primary" onClick={check} disabled={!baseUrl || !token || view.status === 'loading'}>
        {view.status === 'loading' ? 'Checking…' : 'Check this token'}
      </button>

      {!token && (
        <p className="aa-notice" role="status">
          Paste a token in the connection card above to introspect it.
        </p>
      )}

      {view.status === 'unavailable' && (
        <div className="aa-error" role="alert">
          {view.error ? (
            <p>
              The gateway answered <code>{view.httpStatus}</code> <code>{view.error.code}</code>
              {view.error.reason ? ` — ${view.error.reason}` : ''}
            </p>
          ) : (
            <p>{view.reason}</p>
          )}
        </div>
      )}

      {view.status === 'read' && <MeView me={view.me} />}
    </section>
  )
}

function MeView({ me }) {
  const scopes = Array.isArray(me?.scopes) ? me.scopes : []
  const remaining = daysUntil(me?.expiresAt)

  return (
    <dl className="aa-kv-list">
      <div className="aa-kv">
        <dt>Account</dt>
        <dd><code className="aa-mono">{me?.account || '—'}</code></dd>
      </div>
      <div className="aa-kv">
        <dt>Key id</dt>
        <dd><code className="aa-mono" title={me?.keyId || ''}>{me?.keyId ? shortHex(me.keyId) : '—'}</code></dd>
      </div>
      {me?.label ? (
        <div className="aa-kv">
          <dt>Label</dt>
          {/* Display-only and NOT covered by the signature — say so where it is shown. */}
          <dd>{me.label} <span className="aa-help">(display only — not signed)</span></dd>
        </div>
      ) : null}
      <div className="aa-kv">
        <dt>Scopes</dt>
        <dd>
          {scopes.length === 0 ? (
            <span>none</span>
          ) : (
            <ul className="aa-scope-list">
              {scopes.map((scope) => <li key={scope}><code>{scope}</code></li>)}
            </ul>
          )}
        </dd>
      </div>
      <div className="aa-kv">
        <dt>Issued</dt>
        <dd>{formatUnixSeconds(me?.issuedAt)}</dd>
      </div>
      <div className="aa-kv">
        <dt>Expires</dt>
        <dd>
          {formatUnixSeconds(me?.expiresAt)}
          {remaining != null && <span className="aa-help"> ({remaining} day{remaining === 1 ? '' : 's'} left)</span>}
        </dd>
      </div>
      <div className="aa-kv">
        <dt>Membership</dt>
        <dd><MembershipValue membership={me?.membership} /></dd>
      </div>
      <div className="aa-kv">
        <dt>Revocation</dt>
        <dd><RevocationValue revocation={me?.revocation} /></dd>
      </div>
    </dl>
  )
}

/** The three-state read, rendered as three. Never `?? 0`, never "no membership" for a failed read. */
function MembershipValue({ membership }) {
  if (!membership || typeof membership !== 'object') {
    return <span>The gateway did not report a membership state.</span>
  }
  if (membership.state === 'read') {
    return (
      <span>
        {membership.active ? 'Active' : 'Not active'}
        {membership.tierName ? ` — ${membership.tierName}` : ''}
        {typeof membership.tier === 'number' ? ` (tier ${membership.tier})` : ''}
        {membership.expiresAt ? ` · expires ${formatUnixSeconds(membership.expiresAt)}` : ''}
        {membership.chainId != null ? ` · read on chain ${membership.chainId}` : ''}
      </span>
    )
  }
  const label = membership.state === 'not-configured'
    ? 'Not configured on this gateway'
    : 'Could not be read'
  return (
    <span className="aa-unknown">
      {label}
      {/* The gateway's own sentence, verbatim — this console does not have a better one, and a
          paraphrase of an unreadable state is where "unreadable" quietly becomes "none". */}
      {membership.reason ? ` — ${membership.reason}` : ''}
      {' '}
      <span className="aa-help">This is not a statement that the account has no membership.</span>
    </span>
  )
}

function RevocationValue({ revocation }) {
  if (!revocation || typeof revocation !== 'object') {
    return <span>The gateway did not report a revocation state.</span>
  }
  return (
    <span>
      {revocation.revoked ? 'Revoked on this gateway' : 'Not revoked on this gateway'}
      {revocation.durable === false && (
        <span className="aa-help">
          {' '}— revocations are held in the gateway process and do not survive a restart. What
          bounds a leaked key is its own expiry.
        </span>
      )}
    </span>
  )
}
