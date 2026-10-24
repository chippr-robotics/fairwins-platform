/**
 * ApiAccessPanel (spec 095) — the "API access" card of the Settings tab.
 *
 * A member with an active membership can mint PRIVATE API KEYS: member-signed EIP-712 capability
 * tokens that let their own tools and AI agents read their FairWins data and prepare unsigned
 * transactions. Four things about this surface are load-bearing:
 *
 * 1. **The token is shown ONCE and never stored.** Signing happens here, the assembled `fw1.…`
 *    string lives in component state until the member dismisses it, and what persists is metadata
 *    (`lib/apiAccess/apiKeys.js`): key id, label, scopes, window. There is no "show it again".
 *
 * 2. **Creation does not need the gateway.** The signature is local, so a key can be minted while
 *    the relay gateway is unreachable or absent from this build. Only introspection and REGISTERING
 *    a revocation need the network, and the panel says exactly that instead of disabling the button
 *    and leaving the member to guess.
 *
 * 3. **Revocation is honest about what it is.** The gateway holds revocations in process memory: it
 *    is stateless by design (there is no member table to revoke against). So "revoked" here means
 *    "the live gateway is refusing this key now", and the panel always states the grant's own expiry
 *    beside it — that is the part that survives a restart. Claiming a durable revocation would be
 *    the one lie a security control cannot afford.
 *
 * 4. **Membership gating has three states, never two** (the CallsignPanel idiom): checking, an
 *    upgrade route, or the console. An UNREADABLE membership is its own state and never renders as
 *    "you are not a member" — `readable: false` means the reference chain would not answer.
 */

import { useCallback, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useWallet } from '../../hooks/useWalletManagement'
import useRoleDetails from '../../hooks/useRoleDetails'
import AccordionSection from './AccordionSection'
import NavIcon from '../nav/NavIcon'
import { relayerBaseUrl } from '../../lib/relay/intentClient'
import {
  API_SCOPES,
  EXPIRY_CHOICES_DAYS,
  buildGrant,
  buildRevocation,
  forgetApiKey,
  grantTypedData,
  keyState,
  keyStateLabel,
  listKeyRecords,
  markApiKeyRevoked,
  recordApiKey,
  revocationRequestBody,
  revocationTypedData,
  shortKeyId,
} from '../../lib/apiAccess/apiKeys'
import { encodeToken } from '../../lib/apiAccess/tokenCodec'
import { resolveGrantSigner } from '../../lib/apiAccess/grantSigner'
import {
  captureApiKeyCreated,
  captureApiKeyRevoked,
} from '../../data/ledger/sources/accessLedgerSource'
import './ApiAccessPanel.css'

const REVOKE_TIMEOUT_MS = 15000

/** Placeholder used in the MCP snippet — the real token is never written into example config. */
const TOKEN_PLACEHOLDER = 'PASTE_YOUR_FW1_TOKEN_HERE'

/** Shown when this build has no gateway configured, so the snippet still reads as instructions. */
const EXAMPLE_BASE_URL = 'https://relay.fairwins.app'

function formatDate(seconds) {
  if (!seconds) return ''
  try {
    return new Date(Number(seconds) * 1000).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return ''
  }
}

function defaultScopeSelection() {
  const out = {}
  for (const scope of API_SCOPES) out[scope.id] = scope.defaultOn === true
  return out
}

export default function ApiAccessPanel() {
  const { address: account, signer, loginMethod, chainId, isConnected } = useWallet()
  const navigate = useNavigate()

  const { getRoleDetails, refresh } = useRoleDetails()
  const membership = getRoleDetails('WAGER_PARTICIPANT')
  // `membership === null` only until the hook's first read resolves — that is the third state, and
  // it is not the same as `readable === false` (the chain would not answer).
  const tierPending = isConnected && Boolean(account) && membership == null
  const membershipUnreadable = Boolean(membership) && membership.readable === false
  const isMember = Boolean(membership && membership.isActive)

  const gatewayBase = relayerBaseUrl()
  const gatewayConfigured = gatewayBase !== ''

  // The key store is plain synchronous storage, so a write is reflected by re-reading it — the same
  // `forceRender` idiom the sibling preference panels use, with the counter in the memo's deps.
  const [revision, setRevision] = useState(0)
  const rerender = useCallback(() => setRevision((n) => n + 1), [])

  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState(null) // { kind: 'error'|'success'|'info', text }
  const [label, setLabel] = useState('')
  const [scopeSelection, setScopeSelection] = useState(defaultScopeSelection)
  const [ttlDays, setTtlDays] = useState(EXPIRY_CHOICES_DAYS[1])
  // The one-time reveal. Held here and nowhere else; dismissing it destroys the only copy.
  const [revealed, setRevealed] = useState(null) // { token, keyId, label, expiresAt }
  // null = not attempted, true = on the clipboard, false = the browser refused. The third state is
  // why this is not a boolean: a fallback hint shown before anyone pressed anything reads as a fault.
  const [copied, setCopied] = useState(null)
  const [showSnippet, setShowSnippet] = useState(false)

  const keys = useMemo(() => (account ? listKeyRecords(account) : []), [account, revision])
  const activeKeyCount = keys.filter((k) => keyState(k) === 'active').length

  const selectedScopes = useMemo(
    () => API_SCOPES.filter((s) => scopeSelection[s.id]).map((s) => s.id),
    [scopeSelection]
  )

  const grantSigner = useMemo(
    () => resolveGrantSigner({ loginMethod, signer, address: account }),
    [loginMethod, signer, account]
  )

  const copy = useCallback(async (text) => {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return false
    }
  }, [])

  // ------------------------------------------------------------------ create
  const createKey = useCallback(async () => {
    setNotice(null)
    if (selectedScopes.length === 0) {
      setNotice({ kind: 'error', text: 'Choose at least one thing this key may do.' })
      return
    }
    if (!grantSigner.canSign) {
      setNotice({ kind: 'error', text: grantSigner.reason || 'This account cannot sign a key.' })
      return
    }
    setBusy(true)
    try {
      const grant = buildGrant({ account, scopes: selectedScopes, ttlDays, label: label.trim() })
      const { domain, types, message } = grantTypedData(grant)
      const signature = await grantSigner.sign(domain, types, message)
      const token = encodeToken(grant, signature)

      // Metadata first, so a member who closes the tab still sees the key they just minted listed —
      // and can revoke it — even though the token itself is gone.
      recordApiKey(account, grant)
      captureApiKeyCreated(account, chainId, {
        keyId: grant.keyId,
        label: grant.label,
        scopes: grant.scopes,
        expiresAt: grant.expiresAt,
      })

      setRevealed({ token, keyId: grant.keyId, label: grant.label, expiresAt: grant.expiresAt })
      setCopied(null)
      setLabel('')
      rerender()
    } catch (e) {
      const rejected =
        e?.code === 'ACTION_REJECTED' ||
        e?.name === 'CeremonyCancelled' ||
        /reject|denied|cancel/i.test(e?.message || '')
      setNotice({
        kind: 'error',
        text: rejected ? 'Signature was cancelled — no key was created.' : e?.shortMessage || e?.message || 'The key could not be created.',
      })
    } finally {
      setBusy(false)
    }
  }, [account, chainId, grantSigner, label, rerender, selectedScopes, ttlDays])

  // ------------------------------------------------------------------ revoke
  const revokeKey = useCallback(
    async (record) => {
      setNotice(null)
      if (!grantSigner.canSign) {
        setNotice({ kind: 'error', text: grantSigner.reason || 'This account cannot sign a revocation.' })
        return
      }
      setBusy(true)
      try {
        const revocation = buildRevocation({ account, keyId: record.keyId })
        const { domain, types, message } = revocationTypedData(revocation)
        const signature = await grantSigner.sign(domain, types, message)

        let registered = false
        let durable = false
        let failureReason = null

        if (gatewayConfigured) {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), REVOKE_TIMEOUT_MS)
          try {
            const res = await fetch(`${gatewayBase}/v1/member/keys/revoke`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(revocationRequestBody(revocation, signature)),
              signal: controller.signal,
            })
            let body = null
            try {
              body = await res.json()
            } catch {
              body = null
            }
            if (res.ok && body?.revoked === true) {
              registered = true
              durable = body.durable === true
            } else {
              failureReason = body?.error?.reason || `the gateway answered HTTP ${res.status}`
            }
          } catch (e) {
            failureReason = e?.name === 'AbortError' ? 'the gateway did not answer in time' : 'the gateway could not be reached'
          } finally {
            clearTimeout(timer)
          }
        } else {
          failureReason = 'this build has no gateway configured'
        }

        // The local note is written either way: the member decided to withdraw this key, and the
        // list must reflect that decision even when the registration could not be delivered. The
        // `delivered` flag keeps the chip honest — an undelivered revocation reads
        // "revocation signed — not delivered", never a plain "revoked" the gateway may not agree with.
        markApiKeyRevoked(account, record.keyId, revocation.revokedAt, { delivered: registered })
        captureApiKeyRevoked(account, chainId, { keyId: record.keyId, label: record.label, durable })
        rerender()

        const expiryLine = `It also expires on its own on ${formatDate(record.expiresAt)}.`
        setNotice(
          registered
            ? {
                kind: 'success',
                text: durable
                  ? `Revocation registered. ${expiryLine}`
                  : `Revocation registered on the live gateway. It is held in that process and does NOT survive a gateway restart — re-submit it after one, or let the grant expire. ${expiryLine}`,
              }
            : {
                kind: 'error',
                text: `The revocation was signed and noted here, but NOT registered — ${failureReason}. The key still works until it is registered or expires. ${expiryLine}`,
              }
        )
      } catch (e) {
        const rejected =
          e?.code === 'ACTION_REJECTED' ||
          e?.name === 'CeremonyCancelled' ||
          /reject|denied|cancel/i.test(e?.message || '')
        setNotice({
          kind: 'error',
          text: rejected ? 'Signature was cancelled — nothing was revoked.' : e?.shortMessage || e?.message || 'The key could not be revoked.',
        })
      } finally {
        setBusy(false)
      }
    },
    [account, chainId, gatewayBase, gatewayConfigured, grantSigner, rerender]
  )

  // ------------------------------------------------------------------ snippet
  const mcpSnippet = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            fairwins: {
              command: 'node',
              args: ['/path/to/fairwins-platform/services/mcp-server/src/server.js'],
              env: {
                FAIRWINS_API_URL: gatewayConfigured ? gatewayBase : EXAMPLE_BASE_URL,
                FAIRWINS_API_TOKEN: TOKEN_PLACEHOLDER,
              },
            },
          },
        },
        null,
        2
      ),
    [gatewayBase, gatewayConfigured]
  )

  // --------------------------------------------------------------- summary
  let summary
  if (!isConnected || !account) summary = 'Connect a wallet'
  else if (tierPending) summary = 'Checking your membership…'
  else if (membershipUnreadable) summary = 'Membership could not be checked'
  else if (!isMember) summary = 'Members only'
  else if (keys.length === 0) summary = 'No API keys'
  else summary = `${keys.length} key${keys.length === 1 ? '' : 's'} · ${activeKeyCount} active`

  // --------------------------------------------------------------- body
  let body
  if (!isConnected || !account) {
    body = <p role="note">Connect your wallet to create API keys.</p>
  } else if (tierPending) {
    body = <p role="status">Checking your membership…</p>
  } else if (membershipUnreadable) {
    // Unreadable is NOT "no membership". Offer the retry, never a denial.
    body = (
      <div className="api-access__gate" role="note" data-testid="api-access-unreadable">
        <p>
          We could not read your membership just now, so we cannot tell whether API keys are available
          to you. This is a network problem, not an answer about your account.
        </p>
        <button type="button" className="btn" onClick={() => refresh?.()}>
          Try again
        </button>
      </div>
    )
  } else if (!isMember) {
    body = (
      <div className="api-access__gate" role="note" data-testid="api-access-upgrade">
        <p>
          API keys are a <strong>membership</strong> feature. They let your own tools and AI agents
          read your FairWins data and prepare transactions for you to sign — they never move funds.
        </p>
        <button type="button" className="btn btn-primary" onClick={() => navigate('/wallet?tab=membership')}>
          Go to Membership
        </button>
      </div>
    )
  } else {
    body = (
      <div className="api-access__console" data-testid="api-access-console">
        <p className="api-access__lead">
          An API key is a token <strong>you sign</strong>. It lets whoever holds it read this
          account&rsquo;s data and prepare unsigned transactions. It can never move funds, and it can
          never sign for you.
        </p>

        {!gatewayConfigured && (
          <p className="api-access__notice api-access__notice--info" role="note" data-testid="api-access-no-gateway">
            This build has no FairWins API gateway configured. You can still create a key here —
            signing happens on this device — but this app cannot check a key against a gateway or
            register a revocation with one.
          </p>
        )}

        <p className="api-access__hint">
          This screen cannot check a key for you even when a gateway is configured: it does not keep
          your token, so it has nothing to present. To introspect one, paste it into the{' '}
          <Link to="/apps">API Access app</Link> in Apps.
        </p>

        {revealed ? (
          <div className="api-access__reveal" role="group" aria-label="Your new API key" data-testid="api-access-reveal">
            <h4>Copy your key now</h4>
            <p className="api-access__warn">
              This is the only time it is shown. It is <strong>not saved</strong> anywhere — not on
              this device, not in your backup, not on our servers. If you lose it, revoke the key and
              create another.
            </p>
            <code className="api-access__token" data-testid="api-access-token">
              {revealed.token}
            </code>
            <div className="api-access__actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={async () => setCopied(await copy(revealed.token))}
              >
                {copied ? 'Copied' : 'Copy key'}
              </button>
              <button type="button" className="btn" onClick={() => setRevealed(null)}>
                I have stored it
              </button>
            </div>
            {copied === false && (
              <p className="api-access__hint">If copying does not work, select the key above and copy it by hand.</p>
            )}
          </div>
        ) : (
          <div className="api-access__create" data-testid="api-access-create">
            <h4>Create a key</h4>

            <label htmlFor="api-access-label">Name (only you see this)</label>
            <input
              id="api-access-label"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value.slice(0, 120))}
              placeholder="my research agent"
              autoComplete="off"
              spellCheck="false"
              disabled={busy}
            />

            <fieldset className="api-access__scopes" disabled={busy}>
              <legend>What this key may do</legend>
              {API_SCOPES.map((scope) => (
                <label key={scope.id} className="api-access__scope">
                  <input
                    type="checkbox"
                    checked={scopeSelection[scope.id] === true}
                    onChange={(e) =>
                      setScopeSelection((prev) => ({ ...prev, [scope.id]: e.target.checked }))
                    }
                  />
                  <span className="api-access__scope-text">
                    <span className="api-access__scope-label">{scope.label}</span>
                    <span className="api-access__scope-desc">{scope.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            <label htmlFor="api-access-expiry">Expires after</label>
            <select
              id="api-access-expiry"
              value={ttlDays}
              onChange={(e) => setTtlDays(Number(e.target.value))}
              disabled={busy}
            >
              {EXPIRY_CHOICES_DAYS.map((days) => (
                <option key={days} value={days}>
                  {days} days
                </option>
              ))}
            </select>

            <button
              type="button"
              className="btn btn-primary"
              onClick={createKey}
              disabled={busy || selectedScopes.length === 0}
            >
              {busy ? 'Waiting for your signature…' : 'Create key'}
            </button>
          </div>
        )}

        <div className="api-access__keys">
          <h4>Your keys</h4>
          {keys.length === 0 ? (
            <p className="api-access__empty">You have not created any API keys on this device.</p>
          ) : (
            <ul className="api-access__key-list">
              {keys.map((record) => {
                const state = keyState(record)
                return (
                  <li key={record.keyId} className="api-access__key" data-testid="api-access-key">
                    <div className="api-access__key-head">
                      <span className="api-access__key-label">{record.label || 'Unnamed key'}</span>
                      <span className={`api-access__chip api-access__chip--${state}`} data-testid="api-access-key-state">
                        {keyStateLabel(state)}
                      </span>
                    </div>
                    <code className="api-access__key-id">{shortKeyId(record.keyId)}</code>
                    <p className="api-access__key-meta">
                      {record.scopes.join(', ')}
                      {' · '}
                      {state === 'expired' ? 'expired' : 'expires'} {formatDate(record.expiresAt)}
                    </p>
                    <div className="api-access__actions">
                      {state === 'active' ? (
                        <button
                          type="button"
                          className="btn btn-danger"
                          onClick={() => revokeKey(record)}
                          disabled={busy}
                        >
                          Revoke
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            forgetApiKey(account, record.keyId)
                            rerender()
                          }}
                          disabled={busy}
                        >
                          Remove from list
                        </button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <div className="api-access__mcp">
          <h4>Connect an AI agent</h4>
          <p>
            The FairWins MCP server lets an MCP-capable assistant use this key. It reads and quotes
            only — it cannot sign, and its tool descriptions say so.
          </p>
          <button
            type="button"
            className="btn"
            onClick={() => setShowSnippet((v) => !v)}
            aria-expanded={showSnippet}
          >
            {showSnippet ? 'Hide setup snippet' : 'Show setup snippet'}
          </button>
          {showSnippet && (
            <>
              <pre className="api-access__snippet" data-testid="api-access-snippet">
                {mcpSnippet}
              </pre>
              <p className="api-access__hint">
                Replace <code>{TOKEN_PLACEHOLDER}</code> with the key you copied. Treat it like a
                password: anything holding it can read this account&rsquo;s data.
              </p>
              <button type="button" className="btn" onClick={() => copy(mcpSnippet)}>
                Copy snippet
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <AccordionSection
      id="api-access"
      title="API access"
      summary={summary}
      icon={<NavIcon name="key" size={18} />}
      className="api-access-panel"
      data-testid="api-access-panel"
    >
      {body}
      {notice ? (
        <p
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={`api-access__notice api-access__notice--${notice.kind}`}
        >
          {notice.text}
        </p>
      ) : null}
    </AccordionSection>
  )
}
