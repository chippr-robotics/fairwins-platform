import { useState, useEffect, useCallback, useMemo } from 'react'
import { encodeFunctionData } from 'viem'
import { formatEther, parseEther } from '../../lib/evm/units'
import { readContract as readOnChain, normalizeAbi } from '../../lib/chains/readContract'
import { getAddress } from '../../lib/evm/address'
import { getContractAddressForChain } from '../../config/contracts'
import { NETWORKS } from '../../config/networks'
import { estateNetworks, networkName, readProviderFor } from '../../lib/chains/estate'
import { NetworkScopeCard, WriteGate } from './scopeControls'
import { useScopedChain } from './scopeGate'
import { isValidEthereumAddress } from '../../utils/validation'
import { useNotification } from '../../hooks/useUI'

// parseEther throws on strings a number input can still produce (scientific
// notation like "1e-6", trailing "."), and an uncaught throw would take down
// the whole control plane — normalize to null and let callers surface it.
function safeParseEther(value) {
  try {
    const parsed = parseEther(String(value || '0'))
    return parsed > 0n ? parsed : null
  } catch {
    return null
  }
}

/**
 * PaymasterOpsCard — FairWinsVerifyingPaymaster operations (spec 050).
 *
 * The EntryPoint deposit IS the sponsorship loss cap: monitoring and topping
 * it up is a routine operator duty (docs/runbooks/paymaster-operations.md).
 * `deposit()` is deliberately permissionless on-chain (anyone may top up);
 * `withdrawTo` / `setVerifyingSigner` are owner-only.
 *
 * Spec 071 US4 — the deposit is **per chain**, and this card used to read
 * whichever chain the wallet happened to be on. Two consequences of that were
 * wrong rather than merely inconvenient:
 *
 *   - An operator connected anywhere but Polygon saw "no verifying paymaster
 *     is deployed on this network" and had no way to reach the one that is.
 *   - The deposit was denominated in the **wallet's** native symbol. A figure
 *     read from one chain and labelled with another chain's currency is not a
 *     rounding error; it is a wrong number.
 *
 * So: the network is picked, reads follow the pick, the symbol comes from the
 * chain the figure was read on, and every write is gated on the wallet being
 * there and names the chain in its confirmation.
 */
const PAYMASTER_ABI = [
  'function getDeposit() view returns (uint256)',
  'function verifyingSigner() view returns (address)',
  'function owner() view returns (address)',
  'function deposit() payable',
  'function withdrawTo(address payable to, uint256 amount)',
  'function setVerifyingSigner(address newSigner)',
]

function shortAddr(a) {
  return a ? `${a.substring(0, 6)}...${a.substring(a.length - 4)}` : ''
}

const paymasterAt = (id) => getContractAddressForChain('verifyingPaymaster', id)

function PaymasterOpsCard({ signer, account, provider, chainId, nativeSymbol, runTx, pendingTx }) {
  const paymasterNetworks = useMemo(() => estateNetworks(), [])
  // The networks that DO have a configured paymaster, derived from the same config the reads
  // use — never hardcoded ("Polygon-only" outlived the Amoy deployment record it contradicted).
  const sponsoredNetworkNames = useMemo(
    () =>
      paymasterNetworks
        .filter((net) => Boolean(paymasterAt(net.chainId)))
        .map((net) => networkName(net.chainId)),
    [paymasterNetworks],
  )
  const { scopeChainId, setScopeChainId } = useScopedChain(paymasterNetworks, chainId)
  const onScopeNetwork = Number(scopeChainId) === Number(chainId)
  const paymasterAddr = paymasterAt(scopeChainId)
  const { showNotification } = useNotification()

  // The symbol belongs to the chain the deposit was read on. Falling back to the wallet's symbol
  // is only correct when the scope IS the wallet's chain; otherwise say "native token" rather
  // than name the wrong currency.
  const scopeSymbol =
    NETWORKS[scopeChainId]?.nativeCurrency?.symbol || (onScopeNetwork ? nativeSymbol : 'native token')

  // `unreadable` is a third state, distinct from a zero deposit and from no deployment.
  const [info, setInfo] = useState({ chainId: null, deposit: null, verifyingSigner: '', owner: '', readable: null, reason: '' })
  const [depositAmount, setDepositAmount] = useState('')
  const [withdrawForm, setWithdrawForm] = useState({ to: '', amount: '' })
  const [newSigner, setNewSigner] = useState('')

  const readProvider = useMemo(
    () => readProviderFor(scopeChainId, chainId, provider),
    [scopeChainId, chainId, provider],
  )

  // Bound to the SCOPED chain. `readProvider` stays the availability gate.
  const readPaymaster = useMemo(() => {
    if (!paymasterAddr || !readProvider) return null
    return (functionName) =>
      readOnChain(scopeChainId, { address: paymasterAddr, abi: PAYMASTER_ABI, functionName })
  }, [paymasterAddr, readProvider, scopeChainId])

  const fetchInfo = useCallback(async () => {
    if (!readPaymaster) return
    const readChainId = scopeChainId
    try {
      const [deposit, vSigner, owner] = await Promise.all([
        readPaymaster('getDeposit'),
        readPaymaster('verifyingSigner'),
        readPaymaster('owner'),
      ])
      setInfo({ chainId: readChainId, deposit, verifyingSigner: vSigner, owner, readable: true, reason: '' })
    } catch (err) {
      console.warn('[PaymasterOpsCard] read failed:', err)
      setInfo({ chainId: readChainId, deposit: null, verifyingSigner: '', owner: '', readable: false, reason: err?.shortMessage || err?.message || 'read failed' })
    }
  }, [readPaymaster, scopeChainId])

  useEffect(() => {
    fetchInfo()
  }, [fetchInfo])

  // A result is only shown for the chain it was read on. Rendering the previous network's deposit
  // under the newly-picked network's heading is precisely the confusion this spec exists to end,
  // and it is also why "no read connection" is DERIVED rather than written into state: the effect
  // stays a pure fetch, so a scope change cannot leave a stale answer behind.
  const stale = info.chainId != null && Number(info.chainId) !== Number(scopeChainId)
  const current = stale
    ? { deposit: null, verifyingSigner: '', owner: '', readable: null, reason: '' }
    : info
  const state =
    paymasterAddr && !readProvider
      ? { deposit: null, verifyingSigner: '', owner: '', readable: false, reason: 'no read connection to this network' }
      : current

  // Owner authority is read from the paymaster that will enforce it, on the scoped chain — never
  // from an app-wide flag. An unconfirmed read keeps the owner-only controls offered and says so.
  const ownerKnown = state.readable === true && Boolean(state.owner)
  const isOwner = Boolean(ownerKnown && account && account.toLowerCase() === state.owner.toLowerCase())
  // Two gates, not one. `deposit()` is permissionless, so a failed owner read says nothing about
  // it — reporting "authority could not be confirmed" on a call that needs no authority is noise
  // dressed as a warning.
  const chainGate = { deployed: Boolean(paymasterAddr), onWalletChain: onScopeNetwork, scopeChainId }
  const ownerGate = { ...chainGate, readable: state.readable !== false }

  /**
   * One write. `value` carries the native amount for the PAYABLE `deposit()` — with an ethers
   * Contract that rode in an overrides object as the last argument; here it is a field on the
   * transaction itself, which is what it always was on the wire.
   */
  const write = (functionName, args = [], value) =>
    signer.sendTransaction({
      to: paymasterAddr,
      data: encodeFunctionData({ abi: normalizeAbi(PAYMASTER_ABI), functionName, args }),
      ...(value === undefined ? {} : { value }),
    })
  // Re-checked at the call site so a stale render cannot sign for the wrong network.
  const requireScopeChain = () => {
    if (!onScopeNetwork) {
      showNotification(`Switch your wallet to ${networkName(scopeChainId)} to make this change`, 'error')
      return false
    }
    return true
  }

  const handleDeposit = () => {
    if (!requireScopeChain()) return
    const value = safeParseEther(depositAmount)
    if (value == null) return showNotification(`Enter a valid ${scopeSymbol} amount`, 'error')
    runTx(
      () => write('deposit', [], value),
      `Deposited ${depositAmount} ${scopeSymbol} to the paymaster's EntryPoint balance on ${networkName(scopeChainId)}`
    ).then(fetchInfo)
  }

  const handleWithdraw = () => {
    if (!requireScopeChain()) return
    if (!isValidEthereumAddress(withdrawForm.to)) return showNotification('Invalid recipient address', 'error')
    const amount = safeParseEther(withdrawForm.amount)
    if (amount == null) return showNotification(`Enter a valid ${scopeSymbol} amount`, 'error')
    runTx(
      () => write('withdrawTo', [getAddress(withdrawForm.to.trim()), amount]),
      `Withdrew ${withdrawForm.amount} ${scopeSymbol} from the paymaster deposit on ${networkName(scopeChainId)}`
    ).then(fetchInfo)
  }

  const handleRotateSigner = () => {
    if (!requireScopeChain()) return
    if (!isValidEthereumAddress(newSigner)) return showNotification('Invalid signer address', 'error')
    runTx(
      () => write('setVerifyingSigner', [getAddress(newSigner.trim())]),
      `Verifying signer rotated to ${shortAddr(newSigner)} on ${networkName(scopeChainId)}`
    ).then(fetchInfo)
  }

  const depositText = () => {
    if (!paymasterAddr) return null
    if (state.readable === false) return `Could not be read — ${state.reason}`
    if (state.deposit == null) return 'Reading…'
    return `${formatEther(state.deposit)} ${scopeSymbol}`
  }

  return (
    <>
      <NetworkScopeCard
        title="Sponsored-Gas Paymaster"
        description="The verifying paymaster's deposit is per network — it is the sponsorship loss cap on that network alone. Reading any network works from anywhere; funding or rotating one needs your wallet on it."
        networks={paymasterNetworks}
        scopeChainId={scopeChainId}
        onScopeChange={setScopeChainId}
        isDeployed={(id) => Boolean(paymasterAt(id))}
        walletChainId={chainId}
        onRefresh={fetchInfo}
        lastReadAt={null}
        notDeployedLabel="no paymaster"
      />

      {!paymasterAddr ? (
        <div className="admin-card">
          <div className="admin-card-header"><h3>{networkName(scopeChainId)}</h3></div>
          <p className="card-info">
            No verifying paymaster is deployed on {networkName(scopeChainId)}.{' '}
            {sponsoredNetworkNames.length > 0
              ? `Sponsorship (spec 050) is configured on ${sponsoredNetworkNames.join(', ')}; the passkey path self-funds elsewhere.`
              : 'No network in this build has a configured paymaster; the passkey path self-funds everywhere.'}
          </p>
        </div>
      ) : (
        <div className="admin-card">
          <div className="admin-card-header">
            <h3>{networkName(scopeChainId)}</h3>
            <button type="button" className="refresh-btn" onClick={fetchInfo} aria-label="Refresh paymaster state">↻</button>
          </div>
          <div className="status-details">
            <div className="status-row">
              <span className="status-label">EntryPoint deposit (loss cap)</span>
              <span className={`status-value ${state.readable === false ? 'paused' : ''}`}>{depositText()}</span>
            </div>
            <div className="status-row">
              <span className="status-label">Verifying signer</span>
              <span className="status-value">
                <code>{state.readable === false ? 'unread' : shortAddr(state.verifyingSigner) || '—'}</code>
              </span>
            </div>
            <div className="status-row">
              <span className="status-label">Owner</span>
              <span className="status-value">
                <code>{state.readable === false ? 'unread' : shortAddr(state.owner) || '—'}</code>
                {isOwner ? ' (you)' : ''}
              </span>
            </div>
          </div>

          <WriteGate {...chainGate}>
            {({ allowed }) => (
              <div className="admin-form">
                <label>
                  Top up deposit ({scopeSymbol}) — permissionless, funds sponsorship runway on {networkName(scopeChainId)}
                  <input type="number" min="0" step="0.01" value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)} />
                </label>
                <button className="confirm-btn primary" onClick={handleDeposit}
                  disabled={pendingTx || !allowed || !signer || !depositAmount}>
                  {pendingTx ? 'Processing...' : `Deposit on ${networkName(scopeChainId)}`}
                </button>
              </div>
            )}
          </WriteGate>

          {/* Owner-only, so the gate carries `held` — but an UNCONFIRMED owner read leaves the
              control offered (writeAllowed), because the paymaster is the real gate. */}
          <WriteGate {...ownerGate} held={ownerKnown ? isOwner : undefined}>
            {({ allowed }) => (
              <>
                <div className="admin-form">
                  <label>
                    Withdraw to (owner only)
                    <input type="text" placeholder="0x…" value={withdrawForm.to}
                      onChange={(e) => setWithdrawForm({ ...withdrawForm, to: e.target.value })} />
                  </label>
                  <label>
                    Amount ({scopeSymbol})
                    <input type="number" min="0" step="0.01" value={withdrawForm.amount}
                      onChange={(e) => setWithdrawForm({ ...withdrawForm, amount: e.target.value })} />
                  </label>
                  <button className="confirm-btn danger" onClick={handleWithdraw}
                    disabled={pendingTx || !allowed || !signer || !withdrawForm.to || !withdrawForm.amount}>
                    {pendingTx ? 'Processing...' : `Withdraw Deposit on ${networkName(scopeChainId)}`}
                  </button>
                </div>

                <div className="admin-form">
                  <label>
                    Rotate verifying signer (owner only — incident response for a compromised KMS signer)
                    <input type="text" placeholder="0x… new signer" value={newSigner}
                      onChange={(e) => setNewSigner(e.target.value)} />
                  </label>
                  <button className="confirm-btn danger" onClick={handleRotateSigner}
                    disabled={pendingTx || !allowed || !signer || !newSigner}>
                    {pendingTx ? 'Processing...' : `Rotate Signer on ${networkName(scopeChainId)}`}
                  </button>
                </div>
              </>
            )}
          </WriteGate>

          <p className="card-info">
            A compromised verifying signer can only spend deposit on gas — it cannot withdraw.
            Full procedure: docs/runbooks/paymaster-operations.md.
          </p>
        </div>
      )}
    </>
  )
}

export default PaymasterOpsCard
