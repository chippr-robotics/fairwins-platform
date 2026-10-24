import { useState, useMemo, useEffect } from 'react'
import { encodeFunctionData, stringToHex } from 'viem'
import { readContract, normalizeAbi } from '../../lib/chains/readContract'
import { getAddress, isAddress as isAddressSeam } from '../../lib/evm/address'
import { getContractAddressForChain } from '../../config/contracts'
import { estateNetworks, networkName, readProviderFor } from '../../lib/chains/estate'
import { NetworkScopeCard } from './scopeControls'
import { useScopedChain } from './scopeGate'

// Minimal admin-only ABI fragments. The full ABIs live under
// frontend/src/abis/{ChainlinkDataFeedOracleAdapter,ChainlinkFunctionsOracleAdapter,UMAOptimisticOracleV3Adapter}.js
// but pulling them in here would balloon the bundle; the handful of admin
// functions + owner() read fit in <30 lines.

const COMMON_READS = [
  'function owner() view returns (address)',
]

const CHAINLINK_DATA_FEED_ADMIN_ABI = [
  ...COMMON_READS,
  'function setFeedAllowed(address feed, bool allowed)',
  'function registerCondition(bytes32 conditionId, address feed, int256 threshold, uint8 op, uint64 deadline)',
  'function linkMarket(uint256 friendMarketId, bytes32 conditionId)',
  'function allowedFeeds(address) view returns (bool)',
]

const CHAINLINK_FUNCTIONS_ADMIN_ABI = [
  ...COMMON_READS,
  'function registerCondition(bytes32 conditionId, bytes encodedRequest, bytes32 sourceHash, uint64 subscriptionId, uint32 gasLimit, bytes32 donId)',
  'function linkMarket(uint256 friendMarketId, bytes32 conditionId)',
]

const UMA_ADMIN_ABI = [
  ...COMMON_READS,
  'function registerCondition(bytes32 conditionId, bytes claim, address bondCurrency, uint256 bondAmount, uint64 liveness)',
  'function linkMarket(uint256 friendMarketId, bytes32 conditionId)',
]

// Chainlink Data Feed adapter's comparison operators (mirrors the contract's
// `enum Comparison`). Frontend dropdown values match these ordinals.
const COMPARISON_OPS = [
  { value: 0, label: 'GT  (price > threshold)' },
  { value: 1, label: 'GTE (price >= threshold)' },
  { value: 2, label: 'LT  (price < threshold)' },
  { value: 3, label: 'LTE (price <= threshold)' },
  { value: 4, label: 'EQ  (price == threshold)' },
]

const ADAPTERS = [
  { key: 'chainlinkDataFeed',  label: 'Chainlink Data Feed', addressKey: 'chainlinkDataFeedAdapter',  abi: CHAINLINK_DATA_FEED_ADMIN_ABI },
  { key: 'chainlinkFunctions', label: 'Chainlink Functions', addressKey: 'chainlinkFunctionsAdapter', abi: CHAINLINK_FUNCTIONS_ADMIN_ABI },
  { key: 'uma',                label: 'UMA Optimistic Oracle', addressKey: 'umaAdapter',              abi: UMA_ADMIN_ABI },
]

function isBytes32Hex(s) {
  return /^0x[a-fA-F0-9]{64}$/.test((s || '').trim())
}

function isAddress(s) {
  try { return isAddressSeam((s || '').trim()) } catch { return false }
}

function shortAddr(a) {
  if (!a || !isAddressSeam(a)) return a || '—'
  return a.slice(0, 6) + '…' + a.slice(-4)
}

/**
 * OracleAdaptersTab
 *
 * Admin UI for the three oracle adapters wired into WagerRegistry as of v2:
 *  - ChainlinkDataFeedOracleAdapter
 *  - ChainlinkFunctionsOracleAdapter
 *  - UMAOptimisticOracleV3Adapter
 *
 * Each adapter exposes admin-only `setFeedAllowed` (DataFeed only),
 * `registerCondition`, and `linkMarket` functions. This tab lets the
 * deployer EOA (the adapters' `owner()`) drive those calls from the UI
 * instead of hand-rolling them in a script.
 *
 * Out of scope (separate PR): listing pre-registered conditions back to the
 * user-facing create-wager flow. That needs event indexing; this tab is
 * write-only for now.
 *
 * Spec 071 US4 — the adapters are per network and most of the cohort has none.
 * This tab used to take the build's single `contracts` record, so it showed one
 * network's adapters whatever the operator wanted to see, and an owner() read
 * that failed was indistinguishable from an adapter that isn't there. Now the
 * network is picked, addresses resolve from the pick, and "not deployed" is
 * stated as the honest answer it is for most networks rather than rendered as
 * an empty form.
 */
function OracleAdaptersTab({ signer, account, contracts, chainId, runTx, pendingTx }) {
  const [activeAdapter, setActiveAdapter] = useState('chainlinkDataFeed')
  const [adapterOwners, setAdapterOwners] = useState({})

  const adapterNetworks = useMemo(() => estateNetworks(), [])
  const { scopeChainId, setScopeChainId } = useScopedChain(adapterNetworks, chainId)
  const onScopeNetwork = Number(scopeChainId) === Number(chainId)

  // Resolve adapter addresses from the SCOPED chain, falling back to the build's synced record
  // only when the scope is the wallet's own network (where the two agree by construction).
  const adapterAddresses = useMemo(() => {
    const at = (key) =>
      getContractAddressForChain(key, scopeChainId) ||
      (Number(scopeChainId) === Number(chainId) ? contracts?.[key] : '') ||
      ''
    return {
      chainlinkDataFeedAdapter: at('chainlinkDataFeedAdapter'),
      chainlinkFunctionsAdapter: at('chainlinkFunctionsAdapter'),
      umaAdapter: at('umaAdapter'),
    }
  }, [scopeChainId, chainId, contracts])

  const readProvider = useMemo(
    () => readProviderFor(scopeChainId, chainId, signer?.provider || null),
    [scopeChainId, chainId, signer],
  )

  // Read each adapter's owner() so the UI can warn the user if they're not
  // the actual owner (in which case all writes will revert with onlyOwner).
  // Three states, not two: `undefined` = not deployed here, `null` = deployed but the owner could
  // not be read. Collapsing the second into the first would tell an operator there is no adapter
  // when there is one they simply could not reach.
  useEffect(() => {
    let cancelled = false
    if (!readProvider) return
    ;(async () => {
      const next = {}
      for (const a of ADAPTERS) {
        const addr = adapterAddresses[a.addressKey]
        if (!addr || !isAddressSeam(addr)) {
          next[a.key] = undefined
          continue
        }
        try {
          next[a.key] = await readContract(scopeChainId, {
            address: addr,
            abi: COMMON_READS,
            functionName: 'owner',
          })
        } catch {
          next[a.key] = null
        }
      }
      if (!cancelled) setAdapterOwners(next)
    })()
    return () => { cancelled = true }
  }, [readProvider, adapterAddresses, scopeChainId])

  // ── DataFeed forms ────────────────────────────────────────────────────────
  const [dfFeed, setDfFeed]               = useState({ address: '', allow: true })
  const [dfCondition, setDfCondition]     = useState({ conditionId: '', feed: '', threshold: '', op: 0, deadline: '' })
  const [dfLink, setDfLink]               = useState({ friendMarketId: '', conditionId: '' })

  // ── Functions forms ──────────────────────────────────────────────────────
  const [fnCondition, setFnCondition]     = useState({ conditionId: '', encodedRequest: '0x', sourceHash: '', subscriptionId: '', gasLimit: '300000', donId: '' })
  const [fnLink, setFnLink]               = useState({ friendMarketId: '', conditionId: '' })

  // ── UMA forms ────────────────────────────────────────────────────────────
  const [umaCondition, setUmaCondition]   = useState({ conditionId: '', claim: '', bondCurrency: '', bondAmount: '', liveness: '7200' })
  const [umaLink, setUmaLink]             = useState({ friendMarketId: '', conditionId: '' })

  // The single choke point every write handler already goes through — so the wallet-chain check
  // lives here once rather than being repeated (and eventually forgotten) in seven handlers.
  function writer(addressKey, abi) {
    const addr = adapterAddresses[addressKey]
    if (!addr || !isAddressSeam(addr) || !signer) return null
    if (!onScopeNetwork) return null
    return (functionName, args) =>
      signer.sendTransaction({
        to: addr,
        data: encodeFunctionData({ abi: normalizeAbi(abi), functionName, args }),
      })
  }

  /** Why a write is unavailable right now, in words — the alerts below all use this. */
  function writeBlockedReason(addressKey, label) {
    const addr = adapterAddresses[addressKey]
    if (!addr || !isAddressSeam(addr)) return `${label} is not deployed on ${networkName(scopeChainId)}`
    if (!signer) return 'Connect your wallet to make changes here'
    if (!onScopeNetwork) return `Switch your wallet to ${networkName(scopeChainId)} to make this change`
    return `${label} is unavailable`
  }

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleSetFeedAllowed = () => {
    if (!isAddress(dfFeed.address)) return alert('Enter a valid feed address')
    const c = writer('chainlinkDataFeedAdapter', CHAINLINK_DATA_FEED_ADMIN_ABI)
    if (!c) return alert(writeBlockedReason('chainlinkDataFeedAdapter', 'ChainlinkDataFeedOracleAdapter'))
    runTx(
      () => c('setFeedAllowed', [getAddress(dfFeed.address.trim()), Boolean(dfFeed.allow)]),
      `ChainlinkDataFeed: feed ${shortAddr(dfFeed.address)} ${dfFeed.allow ? 'allowlisted' : 'removed'} on ${networkName(scopeChainId)}`,
    )
  }

  const handleDataFeedRegisterCondition = () => {
    const f = dfCondition
    if (!isBytes32Hex(f.conditionId)) return alert('conditionId must be a 0x-prefixed 32-byte hex string')
    if (!isAddress(f.feed)) return alert('Feed address invalid')
    if (!f.threshold || !/^-?\d+$/.test(String(f.threshold).trim())) return alert('Threshold must be an integer (raw feed units; e.g. 8-decimal scaled)')
    if (!f.deadline) return alert('Pick a deadline (date/time)')
    const deadlineSeconds = Math.floor(new Date(f.deadline).getTime() / 1000)
    if (!Number.isFinite(deadlineSeconds) || deadlineSeconds <= Math.floor(Date.now() / 1000)) {
      return alert('Deadline must be in the future')
    }
    const c = writer('chainlinkDataFeedAdapter', CHAINLINK_DATA_FEED_ADMIN_ABI)
    if (!c) return alert(writeBlockedReason('chainlinkDataFeedAdapter', 'ChainlinkDataFeedOracleAdapter'))
    runTx(
      () =>
        c('registerCondition', [
          f.conditionId.trim(),
          getAddress(f.feed.trim()),
          BigInt(String(f.threshold).trim()),
          Number(f.op),
          BigInt(deadlineSeconds),
        ]),
      `ChainlinkDataFeed: condition ${f.conditionId.slice(0, 10)}… registered on ${networkName(scopeChainId)}`,
    )
  }

  const handleDataFeedLink = () => {
    if (!isBytes32Hex(dfLink.conditionId)) return alert('conditionId must be a 0x-prefixed 32-byte hex string')
    if (!/^\d+$/.test((dfLink.friendMarketId || '').trim())) return alert('friendMarketId must be a non-negative integer')
    const c = writer('chainlinkDataFeedAdapter', CHAINLINK_DATA_FEED_ADMIN_ABI)
    if (!c) return alert(writeBlockedReason('chainlinkDataFeedAdapter', 'ChainlinkDataFeedOracleAdapter'))
    runTx(
      () => c('linkMarket', [BigInt(dfLink.friendMarketId.trim()), dfLink.conditionId.trim()]),
      `ChainlinkDataFeed: wager #${dfLink.friendMarketId} linked on ${networkName(scopeChainId)}`,
    )
  }

  const handleFunctionsRegisterCondition = () => {
    const f = fnCondition
    if (!isBytes32Hex(f.conditionId)) return alert('conditionId must be 0x + 64 hex')
    if (!/^0x[a-fA-F0-9]*$/.test((f.encodedRequest || '').trim())) return alert('encodedRequest must be 0x-prefixed hex')
    if (!isBytes32Hex(f.sourceHash)) return alert('sourceHash must be 0x + 64 hex')
    if (!/^\d+$/.test((f.subscriptionId || '').trim())) return alert('subscriptionId must be a non-negative integer')
    if (!/^\d+$/.test((f.gasLimit || '').trim())) return alert('gasLimit must be a non-negative integer')
    if (!isBytes32Hex(f.donId)) return alert('donId must be 0x + 64 hex (right-pad if shorter)')
    const c = writer('chainlinkFunctionsAdapter', CHAINLINK_FUNCTIONS_ADMIN_ABI)
    if (!c) return alert(writeBlockedReason('chainlinkFunctionsAdapter', 'ChainlinkFunctionsOracleAdapter'))
    runTx(
      () =>
        c('registerCondition', [
          f.conditionId.trim(),
          f.encodedRequest.trim(),
          f.sourceHash.trim(),
          BigInt(f.subscriptionId.trim()),
          Number(f.gasLimit.trim()),
          f.donId.trim(),
        ]),
      `ChainlinkFunctions: condition ${f.conditionId.slice(0, 10)}… registered on ${networkName(scopeChainId)}`,
    )
  }

  const handleFunctionsLink = () => {
    if (!isBytes32Hex(fnLink.conditionId)) return alert('conditionId invalid')
    if (!/^\d+$/.test((fnLink.friendMarketId || '').trim())) return alert('friendMarketId must be a non-negative integer')
    const c = writer('chainlinkFunctionsAdapter', CHAINLINK_FUNCTIONS_ADMIN_ABI)
    if (!c) return alert(writeBlockedReason('chainlinkFunctionsAdapter', 'ChainlinkFunctionsOracleAdapter'))
    runTx(
      () => c('linkMarket', [BigInt(fnLink.friendMarketId.trim()), fnLink.conditionId.trim()]),
      `ChainlinkFunctions: wager #${fnLink.friendMarketId} linked on ${networkName(scopeChainId)}`,
    )
  }

  const handleUmaRegisterCondition = () => {
    const f = umaCondition
    if (!isBytes32Hex(f.conditionId)) return alert('conditionId must be 0x + 64 hex')
    if (!(f.claim || '').trim()) return alert('claim is required (plain text — encoded as UTF-8 bytes)')
    if (!isAddress(f.bondCurrency)) return alert('bondCurrency must be a valid ERC-20 address')
    if (!/^\d+$/.test((f.bondAmount || '').trim())) return alert('bondAmount must be a non-negative integer (raw units; e.g. 6-dec USDC)')
    if (!/^\d+$/.test((f.liveness || '').trim())) return alert('liveness must be a non-negative integer (seconds)')
    const c = writer('umaAdapter', UMA_ADMIN_ABI)
    if (!c) return alert(writeBlockedReason('umaAdapter', 'UMAOptimisticOracleV3Adapter'))
    runTx(
      () =>
        c('registerCondition', [
          f.conditionId.trim(),
          // `stringToHex`, NOT `stringToBytes` (spec 110 divergence 19). viem's encoder REFUSES a
          // `Uint8Array` for a `bytes` parameter and wants hex — so the obvious name-match for
          // ethers' `toUtf8Bytes` is the one that throws. `stringToHex` is byte-identical to it,
          // checked over unicode, emoji, quotes and a hex-looking claim.
          stringToHex(f.claim.trim()),
          getAddress(f.bondCurrency.trim()),
          BigInt(f.bondAmount.trim()),
          BigInt(f.liveness.trim()),
        ]),
      `UMA: condition ${f.conditionId.slice(0, 10)}… registered on ${networkName(scopeChainId)}`,
    )
  }

  const handleUmaLink = () => {
    if (!isBytes32Hex(umaLink.conditionId)) return alert('conditionId invalid')
    if (!/^\d+$/.test((umaLink.friendMarketId || '').trim())) return alert('friendMarketId must be a non-negative integer')
    const c = writer('umaAdapter', UMA_ADMIN_ABI)
    if (!c) return alert(writeBlockedReason('umaAdapter', 'UMAOptimisticOracleV3Adapter'))
    runTx(
      () => c('linkMarket', [BigInt(umaLink.friendMarketId.trim()), umaLink.conditionId.trim()]),
      `UMA: wager #${umaLink.friendMarketId} linked on ${networkName(scopeChainId)}`,
    )
  }

  // ── Owner-check banner ────────────────────────────────────────────────────
  const activeMeta = ADAPTERS.find(a => a.key === activeAdapter)
  const activeAddr = adapterAddresses[activeMeta.addressKey]
  const activeOwner = adapterOwners[activeAdapter]
  const activeDeployed = Boolean(activeAddr && isAddressSeam(activeAddr))
  const isActualOwner = activeOwner && account &&
    String(activeOwner).toLowerCase() === String(account).toLowerCase()

  // Not deployed, deployed-but-unread, and read-and-not-you are three different situations and
  // call for three different operator responses. A single em dash for all three said nothing.
  const ownerText = () => {
    if (!activeDeployed) return 'Not deployed on this network'
    if (activeOwner === null) return 'Could not be read — retry; this is not "no owner"'
    if (!activeOwner) return 'Reading…'
    return `${shortAddr(activeOwner)} ${isActualOwner ? '(you)' : '(NOT you — writes will revert)'}`
  }

  return (
    <div className="admin-tab-content" role="tabpanel">
      <div className="admin-card">
        <div className="admin-card-header">
          <h3>Oracle adapter administration</h3>
          <p className="admin-hint">
            Register and link conditions on the three v2 oracle adapters.
            All writes require the adapter&apos;s <code>onlyOwner</code> — the deployer EOA.
            Tip: condition IDs are arbitrary 32-byte identifiers; conventionally
            <code> keccak256(question + bytes32 salt) </code> works well.
          </p>
        </div>

        <NetworkScopeCard
          title="Adapter network"
          description="Adapters are deployed per network, and most networks have none. Reading any network works from anywhere; registering or linking on one needs your wallet there."
          networks={adapterNetworks}
          scopeChainId={scopeChainId}
          onScopeChange={setScopeChainId}
          isDeployed={(id) =>
            Boolean(
              getContractAddressForChain('chainlinkDataFeedAdapter', id) ||
              getContractAddressForChain('chainlinkFunctionsAdapter', id) ||
              getContractAddressForChain('umaAdapter', id),
            )
          }
          walletChainId={chainId}
          onRefresh={() => {}}
          lastReadAt={null}
          notDeployedLabel="no adapters"
        />
        {!onScopeNetwork && (
          <p className="card-info warning-text" role="status">
            You are reading {networkName(scopeChainId)} while your wallet is on {networkName(chainId)}.
            Switch to {networkName(scopeChainId)} before registering or linking anything here.
          </p>
        )}

        <nav className="oracle-adapters-subtabs" role="tablist" data-testid="oracle-adapters-subtabs">
          {ADAPTERS.map(a => (
            <button
              key={a.key}
              type="button"
              role="tab"
              aria-selected={activeAdapter === a.key}
              className={`admin-panel-tab ${activeAdapter === a.key ? 'active' : ''}`}
              onClick={() => setActiveAdapter(a.key)}
            >
              {a.label}
            </button>
          ))}
        </nav>

        <div className="oracle-adapter-meta">
          <div className="status-row">
            <span className="status-label">Adapter</span>
            <span className="status-value">
              {activeDeployed ? shortAddr(activeAddr) : `Not deployed on ${networkName(scopeChainId)}`}
            </span>
          </div>
          <div className="status-row">
            <span className="status-label">Owner</span>
            <span className={`status-value ${isActualOwner ? 'active' : 'paused'}`}>{ownerText()}</span>
          </div>
        </div>

        {/* ── Chainlink Data Feed ─────────────────────────────────────── */}
        {activeAdapter === 'chainlinkDataFeed' && (
          <>
            <section className="admin-form-section">
              <h4>Allowlist a Chainlink price feed</h4>
              <p className="admin-hint">
                Feeds must be allowlisted before they can back a condition. On Amoy the
                ETH/USD feed at <code>0xF0d5…D8e7</code> was allowlisted at deploy time.
              </p>
              <div className="admin-form-row">
                <label>
                  Feed address
                  <input
                    type="text"
                    placeholder="0x... (Chainlink AggregatorV3)"
                    value={dfFeed.address}
                    onChange={e => setDfFeed({ ...dfFeed, address: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
                <label>
                  Allowed?
                  <select
                    value={dfFeed.allow ? '1' : '0'}
                    onChange={e => setDfFeed({ ...dfFeed, allow: e.target.value === '1' })}
                    disabled={pendingTx}
                  >
                    <option value="1">Yes (allow)</option>
                    <option value="0">No (remove)</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="admin-btn primary"
                  onClick={handleSetFeedAllowed}
                  disabled={pendingTx}
                >setFeedAllowed</button>
              </div>
            </section>

            <section className="admin-form-section">
              <h4>Register condition</h4>
              <p className="admin-hint">
                A condition is the predicate a wager auto-resolves on
                (e.g. &ldquo;ETH/USD &gt; 3000 by Jan 31&rdquo;). The threshold is in the feed&apos;s
                raw scaled units — ETH/USD on Chainlink is 8-decimal, so $3000 = <code>300000000000</code>.
              </p>
              <div className="admin-form-row">
                <label>
                  conditionId (bytes32)
                  <input
                    type="text"
                    placeholder="0x + 64 hex chars"
                    value={dfCondition.conditionId}
                    onChange={e => setDfCondition({ ...dfCondition, conditionId: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
                <label>
                  Feed
                  <input
                    type="text"
                    placeholder="0x... (must be allowlisted)"
                    value={dfCondition.feed}
                    onChange={e => setDfCondition({ ...dfCondition, feed: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
              </div>
              <div className="admin-form-row">
                <label>
                  Threshold (int256, raw feed units)
                  <input
                    type="text"
                    placeholder="e.g. 300000000000 ($3000 in 8-dec)"
                    value={dfCondition.threshold}
                    onChange={e => setDfCondition({ ...dfCondition, threshold: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
                <label>
                  Comparison
                  <select
                    value={dfCondition.op}
                    onChange={e => setDfCondition({ ...dfCondition, op: Number(e.target.value) })}
                    disabled={pendingTx}
                  >
                    {COMPARISON_OPS.map(o => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Deadline
                  <input
                    type="datetime-local"
                    value={dfCondition.deadline}
                    onChange={e => setDfCondition({ ...dfCondition, deadline: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
                <button
                  type="button"
                  className="admin-btn primary"
                  onClick={handleDataFeedRegisterCondition}
                  disabled={pendingTx}
                >registerCondition</button>
              </div>
            </section>

            <section className="admin-form-section">
              <h4>Link wager → condition</h4>
              <p className="admin-hint">
                Bind an existing on-chain wager (by id) to a registered condition so
                <code> autoResolveFromOracle </code>can settle it.
              </p>
              <div className="admin-form-row">
                <label>
                  Wager id
                  <input
                    type="number"
                    min="0"
                    value={dfLink.friendMarketId}
                    onChange={e => setDfLink({ ...dfLink, friendMarketId: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
                <label>
                  conditionId (bytes32)
                  <input
                    type="text"
                    placeholder="0x + 64 hex chars"
                    value={dfLink.conditionId}
                    onChange={e => setDfLink({ ...dfLink, conditionId: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
                <button
                  type="button"
                  className="admin-btn primary"
                  onClick={handleDataFeedLink}
                  disabled={pendingTx}
                >linkMarket</button>
              </div>
            </section>
          </>
        )}

        {/* ── Chainlink Functions ─────────────────────────────────────── */}
        {activeAdapter === 'chainlinkFunctions' && (
          <>
            <section className="admin-form-section">
              <h4>Register condition</h4>
              <p className="admin-hint">
                Chainlink Functions runs a JS source you supply on a DON.
                <code>encodedRequest</code> is the CBOR-encoded request bytes produced by
                <code> @chainlink/functions-toolkit</code>; <code>sourceHash</code> is the
                <code> keccak256</code> of the JS source. The adapter must be added as a consumer
                on your LINK subscription before the request will settle.
              </p>
              <div className="admin-form-row">
                <label>
                  conditionId (bytes32)
                  <input
                    type="text" placeholder="0x + 64 hex chars"
                    value={fnCondition.conditionId}
                    onChange={e => setFnCondition({ ...fnCondition, conditionId: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
                <label>
                  sourceHash (bytes32)
                  <input
                    type="text" placeholder="keccak256 of JS source"
                    value={fnCondition.sourceHash}
                    onChange={e => setFnCondition({ ...fnCondition, sourceHash: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
              </div>
              <div className="admin-form-row">
                <label>
                  subscriptionId (LINK)
                  <input
                    type="number" min="0"
                    value={fnCondition.subscriptionId}
                    onChange={e => setFnCondition({ ...fnCondition, subscriptionId: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
                <label>
                  gasLimit
                  <input
                    type="number" min="0"
                    value={fnCondition.gasLimit}
                    onChange={e => setFnCondition({ ...fnCondition, gasLimit: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
                <label>
                  donId (bytes32)
                  <input
                    type="text" placeholder="e.g. 0x66756e2d706f6c79676f6e2d616d6f792d310000000000000000000000000000"
                    value={fnCondition.donId}
                    onChange={e => setFnCondition({ ...fnCondition, donId: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
              </div>
              <div className="admin-form-row">
                <label className="admin-form-full">
                  encodedRequest (CBOR bytes)
                  <textarea
                    rows={3}
                    placeholder="0x... (CBOR-encoded Functions request bytes)"
                    value={fnCondition.encodedRequest}
                    onChange={e => setFnCondition({ ...fnCondition, encodedRequest: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
                <button
                  type="button"
                  className="admin-btn primary"
                  onClick={handleFunctionsRegisterCondition}
                  disabled={pendingTx}
                >registerCondition</button>
              </div>
            </section>

            <section className="admin-form-section">
              <h4>Link wager → condition</h4>
              <div className="admin-form-row">
                <label>
                  Wager id
                  <input
                    type="number" min="0"
                    value={fnLink.friendMarketId}
                    onChange={e => setFnLink({ ...fnLink, friendMarketId: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
                <label>
                  conditionId (bytes32)
                  <input
                    type="text" placeholder="0x + 64 hex chars"
                    value={fnLink.conditionId}
                    onChange={e => setFnLink({ ...fnLink, conditionId: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
                <button
                  type="button"
                  className="admin-btn primary"
                  onClick={handleFunctionsLink}
                  disabled={pendingTx}
                >linkMarket</button>
              </div>
            </section>
          </>
        )}

        {/* ── UMA Optimistic Oracle V3 ────────────────────────────────── */}
        {activeAdapter === 'uma' && (
          <>
            <section className="admin-form-section">
              <h4>Register condition</h4>
              <p className="admin-hint">
                UMA OOv3 lets anyone assert a claim under a bond. The adapter escrows
                the bond, calls OOv3, and waits out the liveness window. Bond and
                liveness are per-condition — set them generously enough that disputing
                bad claims is economically worthwhile.
              </p>
              <div className="admin-form-row">
                <label>
                  conditionId (bytes32)
                  <input
                    type="text" placeholder="0x + 64 hex chars"
                    value={umaCondition.conditionId}
                    onChange={e => setUmaCondition({ ...umaCondition, conditionId: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
                <label>
                  Bond currency (ERC-20 address)
                  <input
                    type="text" placeholder="0x... (e.g. USDC)"
                    value={umaCondition.bondCurrency}
                    onChange={e => setUmaCondition({ ...umaCondition, bondCurrency: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
              </div>
              <div className="admin-form-row">
                <label>
                  Bond amount (raw units)
                  <input
                    type="number" min="0"
                    value={umaCondition.bondAmount}
                    onChange={e => setUmaCondition({ ...umaCondition, bondAmount: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
                <label>
                  Liveness (seconds, &gt;= 7200)
                  <input
                    type="number" min="7200"
                    value={umaCondition.liveness}
                    onChange={e => setUmaCondition({ ...umaCondition, liveness: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
              </div>
              <div className="admin-form-row">
                <label className="admin-form-full">
                  Claim text
                  <textarea
                    rows={3}
                    placeholder="Plain-English claim — e.g. 'ETH/USD closes above 3000 on 2026-12-31 at 23:59 UTC'"
                    value={umaCondition.claim}
                    onChange={e => setUmaCondition({ ...umaCondition, claim: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
                <button
                  type="button"
                  className="admin-btn primary"
                  onClick={handleUmaRegisterCondition}
                  disabled={pendingTx}
                >registerCondition</button>
              </div>
            </section>

            <section className="admin-form-section">
              <h4>Link wager → condition</h4>
              <div className="admin-form-row">
                <label>
                  Wager id
                  <input
                    type="number" min="0"
                    value={umaLink.friendMarketId}
                    onChange={e => setUmaLink({ ...umaLink, friendMarketId: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
                <label>
                  conditionId (bytes32)
                  <input
                    type="text" placeholder="0x + 64 hex chars"
                    value={umaLink.conditionId}
                    onChange={e => setUmaLink({ ...umaLink, conditionId: e.target.value })}
                    disabled={pendingTx}
                  />
                </label>
                <button
                  type="button"
                  className="admin-btn primary"
                  onClick={handleUmaLink}
                  disabled={pendingTx}
                >linkMarket</button>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}

export default OracleAdaptersTab
