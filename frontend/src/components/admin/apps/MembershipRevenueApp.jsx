/**
 * Membership & Revenue admin mini-app (spec 093) — the monolithic AdminPanel's
 * `tiers`, `members` and `treasury` views extracted verbatim, plus the
 * re-hosted FeesTab and PerpsFeesPanel.
 *
 * ── MEMBERSHIP ADMIN IS PINNED TO THE REFERENCE CHAIN, NOT SCOPED (spec 071
 * FR-003/FR-006) ── Tiers and Members are the one place a scope PICKER would
 * be wrong. Membership is read from exactly one chain, so a tier ladder
 * configured anywhere else is one no purchase consults, and a membership
 * granted anywhere else is one the app never sees. Same rule as purchases:
 * one home, named, with the wallet required to be there.
 *
 * The dashboard is the monolith Overview's membership/treasury content in its
 * new home: MembershipTreasuryOverview (stats, revenue sparkline, breakdown
 * bars) and the two estate fee tables — accrued (undrawn) and treasury
 * (received), never combined (spec 071 FR-021…FR-023).
 */
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { encodeFunctionData, keccak256, stringToHex } from 'viem'
import { formatUnits, parseUnits } from '../../../lib/evm/units'
import { readContract, normalizeAbi } from '../../../lib/chains/readContract'
import { getAddress } from '../../../lib/evm/address'
import AdminAppShell from '../AdminAppShell'
import MembershipTreasuryOverview from '../MembershipTreasuryOverview'
import ChainStateTable from '../ChainStateTable'
import FeesTab from '../FeesTab'
import PerpsFeesPanel from '../PerpsFeesPanel'
import { adminAppById, adminViewPath } from '../adminApps'
import { useAdminAccess } from '../useAdminAccess'
import { useAdminTx } from '../useAdminTx'
import { useWeb3 } from '../../../hooks/useWeb3'
import { useNotification } from '../../../hooks/useUI'
import { useEnsResolution } from '../../../hooks/useEnsResolution'
import { useFeeEstate } from '../../../hooks/useFeeEstate'
import { isValidEthereumAddress } from '../../../utils/validation'
import { getContractAddressForChain } from '../../../config/contracts'
import { membershipChainId } from '../../../config/networks'
import { getProvider } from '../../../utils/blockchainService'
import { networkName, readProviderFor, scanProviderFor, readAuthority } from '../../../lib/chains/estate'
import { isRead, isNotDeployed, formatUnitAmount } from '../../../lib/chains/chainReadResult'
import { contractAuthorityGate } from '../scopeGate'

const APP = adminAppById('membership-revenue')

/** `keccak256(utf8(name))` — byte-compared against `ethers.keccak256(ethers.toUtf8Bytes(...))`
 *  before the swap. These hashes ARE the roles the contract stores memberships under. */
const roleId = (name) => keccak256(stringToHex(name))

const TIER_NAMES = { 1: 'Bronze', 2: 'Silver', 3: 'Gold', 4: 'Platinum' }
const USDC_DECIMALS = 6
const WAGER_PARTICIPANT_ROLE = roleId('WAGER_PARTICIPANT_ROLE')
// The MembershipManager is role-keyed, and pools (spec 034) gate on their own
// role: WagerPoolFactory's checkCanCreate(account, POOL_PARTICIPANT_ROLE) is
// NOT satisfied by a Wager Participant membership. Each form therefore carries
// a role selector, defaulting to Wager Participant so existing behaviour (and
// anything driving these forms without touching the selector) is unchanged.
const POOL_PARTICIPANT_ROLE = roleId('POOL_PARTICIPANT_ROLE')
const MEMBERSHIP_ROLES = {
  WAGER_PARTICIPANT: { hash: WAGER_PARTICIPANT_ROLE, label: 'Wager Participant' },
  POOL_PARTICIPANT: { hash: POOL_PARTICIPANT_ROLE, label: 'Pool Participant' },
}
const membershipRole = (key) => MEMBERSHIP_ROLES[key] || MEMBERSHIP_ROLES.WAGER_PARTICIPANT

const MEMBERSHIP_ADMIN_ABI = [
  'function setTier(bytes32 role, uint8 tier, uint128 priceUSDC, uint32 durationDays, (uint32 monthlyMarketCreation,uint32 maxConcurrentMarkets) limits, bool active)',
  'function grantMembership(address user, bytes32 role, uint8 tier, uint32 durationDays)',
  'function revokeMembership(address user, bytes32 role)',
  'function withdrawFees(uint128 amount, address to)',
  'function accruedFees() view returns (uint128)',
  'function treasury() view returns (address)',
]

function shortAddr(address) {
  return address ? `${address.substring(0, 6)}...${address.substring(address.length - 4)}` : ''
}

export default function MembershipRevenueApp() {
  const access = useAdminAccess()
  const { flags } = access
  const navigate = useNavigate()
  const { account, signer, provider, chainId } = useWeb3()
  const { showNotification } = useNotification()

  const feeEstate = useFeeEstate({ walletChainId: chainId, walletProvider: provider })

  const membershipAdminChainId = membershipChainId()
  const onMembershipChain = Number(membershipAdminChainId) === Number(chainId)
  const membershipManagerAddr = getContractAddressForChain('membershipManager', membershipAdminChainId)
  const membershipProvider =
    readProviderFor(membershipAdminChainId, chainId, provider) || getProvider(membershipAdminChainId)
  // The statistics panel scans the MembershipManager's event log, which needs history the
  // browser wallet's RPC usually does not keep — see `scanProviderFor`. Point reads
  // (`accruedFees`, `treasury`) go through the chain seam bound to the membership chain; the
  // authority read below still takes `membershipProvider`, and only the scan needs this one.
  const membershipScanProvider = scanProviderFor(membershipAdminChainId) || membershipProvider

  // `accruedFees` is money. A failed read must not arrive as 0n: an operator
  // reading a zero accrued balance concludes the fees were already withdrawn.
  const [membershipState, setMembershipState] = useState({
    accruedFees: '0',
    accruedFeesReadable: null,
    treasury: '',
  })
  const fetchMembershipState = useCallback(async () => {
    if (!membershipManagerAddr) return
    // Bound to the MEMBERSHIP reference chain (spec 071), which is the point: membership is
    // readable from one place only because it is written in one place.
    //
    // No provider gate here, and there never was one: the old code built a Contract on
    // `membershipProvider` and, with a null provider, the CALLS rejected into the catch below as
    // "could not read". `readContract` raises `NoRpcEndpointError` into the same catch, so the
    // honest-degradation behaviour is unchanged — `accruedFees` is money, and a failed read still
    // reports `accruedFeesReadable: false` rather than arriving as 0.
    const ask = (functionName) =>
      readContract(membershipAdminChainId, {
        address: membershipManagerAddr,
        abi: MEMBERSHIP_ADMIN_ABI,
        functionName,
      })
    const [fees, treasury] = await Promise.all([
      ask('accruedFees').then((v) => ({ ok: true, v })).catch(() => ({ ok: false })),
      ask('treasury').catch(() => ''),
    ])
    setMembershipState({
      accruedFees: fees.ok ? formatUnits(fees.v, USDC_DECIMALS) : '0',
      accruedFeesReadable: fees.ok,
      treasury: treasury || '',
    })
  }, [membershipManagerAddr, membershipAdminChainId])

  useEffect(() => {
    fetchMembershipState()
    const interval = setInterval(fetchMembershipState, 30000)
    return () => clearInterval(interval)
  }, [fetchMembershipState])

  const { runTx, pendingTx } = useAdminTx({ onSuccess: fetchMembershipState })

  const requireMembershipChain = () => {
    if (onMembershipChain) return true
    showNotification(
      `Memberships live on ${networkName(membershipAdminChainId)}. Switch your wallet there first.`,
      'error',
    )
    return false
  }

  // ── AUTHORITY IS READ FROM THE MEMBERSHIPMANAGER ITSELF (spec 071 FR-019) ──
  // The two write families on this app answer to DIFFERENT roles, and OpenZeppelin
  // AccessControl has no hierarchy — DEFAULT_ADMIN_ROLE does not satisfy
  // `onlyRole(ROLE_MANAGER_ROLE)`. Verified against contracts/access/MembershipManager.sol:
  //
  //   grantMembership / revokeMembership  → onlyRole(ROLE_MANAGER_ROLE)   (:223, :237)
  //   setTier                             → onlyRole(DEFAULT_ADMIN_ROLE)  (:146)
  //   withdrawFees                        → onlyRole(DEFAULT_ADMIN_ROLE)  (:247)
  //
  // `flags.isAdmin` / `flags.isRoleManager` are estate-wide — true when held on ANY
  // cohort chain — so they were offering these writes to accounts the reference
  // chain's manager would reject. Both roles are asked of the one contract, in one
  // read, on the chain the transaction signs on.
  const accountLabel = account ? shortAddr(account) : 'This account'
  const [membershipAuthority, setMembershipAuthority] = useState(null)
  useEffect(() => {
    let cancelled = false
    setMembershipAuthority(null)
    readAuthority({
      chainId: membershipAdminChainId,
      provider: membershipProvider,
      address: membershipManagerAddr,
      account,
      roles: ['admin', 'roleManager'],
    }).then((a) => {
      if (!cancelled) setMembershipAuthority(a)
    })
    return () => {
      cancelled = true
    }
  }, [membershipProvider, membershipManagerAddr, account, membershipAdminChainId])

  const memberGate = contractAuthorityGate({
    authority: membershipAuthority,
    roles: ['roleManager'],
    fallback: flags.isRoleManager || flags.isAdmin,
    chainId: membershipAdminChainId,
    contractLabel: 'MembershipManager',
    roleLabel: 'ROLE_MANAGER_ROLE',
    accountLabel,
  })
  const tierGate = contractAuthorityGate({
    authority: membershipAuthority,
    roles: ['admin'],
    fallback: flags.isAdmin,
    chainId: membershipAdminChainId,
    contractLabel: 'MembershipManager',
    roleLabel: 'DEFAULT_ADMIN_ROLE',
    accountLabel,
  })

  // Re-checked at the call site as well as in the disabled button. Only a DEFINITE
  // "not held" refuses — an unconfirmed read still sends, and the contract decides.
  const requireAuthority = (gate) => {
    if (gate.allowed) return true
    showNotification(gate.reason || 'You do not hold the role this change requires.', 'error')
    return false
  }

  // ── Forms (state shapes carried over from the monolith) ──
  const [tierForm, setTierForm] = useState({
    role: 'WAGER_PARTICIPANT', tier: 1, price: '2', durationDays: 30, monthly: 15, concurrent: 5, active: true,
  })
  const [grantForm, setGrantForm] = useState({ address: '', role: 'WAGER_PARTICIPANT', tier: 1, durationDays: 30 })
  const grantEns = useEnsResolution(grantForm.address || '')
  const [revokeForm, setRevokeForm] = useState({ address: '', role: 'WAGER_PARTICIPANT' })
  const revokeEns = useEnsResolution(revokeForm.address || '')

  // A withdrawal targets ONE chain. Defaults to the wallet's chain when that
  // chain carries a MembershipManager, otherwise the first that does, and
  // does NOT follow the wallet afterwards (spec 071 FR-016).
  const [withdrawChainId, setWithdrawChainId] = useState(null)
  const withdrawScope = feeEstate.accrued.find((r) => Number(r.chainId) === Number(withdrawChainId))
  useEffect(() => {
    if (withdrawChainId != null || feeEstate.accrued.length === 0) return
    const onWallet = feeEstate.accrued.find((r) => Number(r.chainId) === Number(chainId) && isRead(r))
    const anyRead = feeEstate.accrued.find(isRead)
    setWithdrawChainId((onWallet || anyRead || feeEstate.accrued[0]).chainId)
  }, [feeEstate.accrued, chainId, withdrawChainId])

  // A withdrawal signs on the CHOSEN chain, not the reference chain, so its
  // authority is read from that chain's own MembershipManager. Reading the
  // reference chain's would answer a question nobody asked (FR-019: the contract
  // that will enforce it, on the chain in scope).
  const withdrawManagerAddr =
    withdrawChainId == null ? '' : getContractAddressForChain('membershipManager', withdrawChainId)
  const withdrawProvider =
    withdrawChainId == null
      ? null
      : readProviderFor(withdrawChainId, chainId, provider) || getProvider(withdrawChainId)
  const [withdrawAuthority, setWithdrawAuthority] = useState(null)
  useEffect(() => {
    let cancelled = false
    setWithdrawAuthority(null)
    if (withdrawChainId == null) return undefined
    readAuthority({
      chainId: withdrawChainId,
      provider: withdrawProvider,
      address: withdrawManagerAddr,
      account,
      roles: ['admin'],
    }).then((a) => {
      if (!cancelled) setWithdrawAuthority(a)
    })
    return () => {
      cancelled = true
    }
  }, [withdrawProvider, withdrawManagerAddr, account, withdrawChainId])

  const withdrawGate = contractAuthorityGate({
    authority: withdrawAuthority,
    roles: ['admin'],
    fallback: flags.isAdmin,
    chainId: withdrawChainId,
    contractLabel: 'MembershipManager',
    roleLabel: 'DEFAULT_ADMIN_ROLE',
    accountLabel,
  })

  const [withdrawForm, setWithdrawForm] = useState({ to: '', amount: '' })
  useEffect(() => {
    if (membershipState.treasury) {
      setWithdrawForm((f) => (f.to ? f : { ...f, to: membershipState.treasury }))
    }
  }, [membershipState.treasury])
  const withdrawEns = useEnsResolution(withdrawForm.to || '')

  /**
   * A membership write. `getAddress` on every member-typed target (spec 110 divergence 16):
   * `isValidEthereumAddress` is a bare regex that accepts an ALL-UPPERCASE address and tests
   * `address.trim()` while handing the caller the UNTRIMMED value — viem's encoder refuses both.
   * A withdrawal names where the money goes.
   */
  const writeMembership = (addr, functionName, args) =>
    signer.sendTransaction({
      to: addr,
      data: encodeFunctionData({
        abi: normalizeAbi(MEMBERSHIP_ADMIN_ABI),
        functionName,
        args,
      }),
    })

  // ── Handlers (verbatim from the monolith) ──
  const handleConfigureTier = () => {
    if (!requireMembershipChain()) return false
    if (!requireAuthority(tierGate)) return false
    const priceUSDC = parseUnits(String(tierForm.price), USDC_DECIMALS)
    return runTx(
      () =>
        writeMembership(membershipManagerAddr, 'setTier', [
          membershipRole(tierForm.role).hash,
          tierForm.tier,
          priceUSDC,
          tierForm.durationDays,
          { monthlyMarketCreation: tierForm.monthly, maxConcurrentMarkets: tierForm.concurrent },
          Boolean(tierForm.active),
        ]),
      `${membershipRole(tierForm.role).label} tier ${TIER_NAMES[tierForm.tier]} configured at $${tierForm.price} USDC on ${networkName(membershipAdminChainId)}`,
    )
  }

  const handleGrantMembership = () => {
    const target = grantEns.resolvedAddress || grantForm.address
    if (!isValidEthereumAddress(target)) return showNotification('Invalid address', 'error')
    if (!requireMembershipChain()) return false
    if (!requireAuthority(memberGate)) return false
    return runTx(
      () =>
        writeMembership(membershipManagerAddr, 'grantMembership', [
          getAddress(String(target).trim()),
          membershipRole(grantForm.role).hash,
          grantForm.tier,
          grantForm.durationDays,
        ]),
      `Granted ${TIER_NAMES[grantForm.tier]} ${membershipRole(grantForm.role).label} membership to ${shortAddr(target)} on ${networkName(membershipAdminChainId)}`,
    )
  }

  const handleRevokeMembership = () => {
    const target = revokeEns.resolvedAddress || revokeForm.address
    if (!isValidEthereumAddress(target)) return showNotification('Invalid address', 'error')
    if (!requireMembershipChain()) return false
    if (!requireAuthority(memberGate)) return false
    return runTx(
      () =>
        writeMembership(membershipManagerAddr, 'revokeMembership', [
          getAddress(String(target).trim()),
          membershipRole(revokeForm.role).hash,
        ]),
      `Revoked ${membershipRole(revokeForm.role).label} membership for ${shortAddr(target)} on ${networkName(membershipAdminChainId)}`,
    )
  }

  const handleWithdraw = () => {
    const target = withdrawEns.resolvedAddress || withdrawForm.to
    if (!isValidEthereumAddress(target)) return showNotification('Invalid address', 'error')
    // FR-017/FR-018: one named chain, wallet required to be there. Checked here
    // as well as in the disabled button so a stale render can never send to
    // the wrong network.
    if (Number(chainId) !== Number(withdrawChainId)) {
      return showNotification(
        `This withdrawal happens on ${networkName(withdrawChainId)}. Switch your wallet there first.`,
        'error',
      )
    }
    const addr = getContractAddressForChain('membershipManager', withdrawChainId)
    if (!addr) return showNotification(`No MembershipManager on ${networkName(withdrawChainId)}`, 'error')
    if (!requireAuthority(withdrawGate)) return false
    const decimals = withdrawScope?.unit?.decimals ?? USDC_DECIMALS
    const symbol = withdrawScope?.unit?.symbol ?? 'USDC'
    const amount = parseUnits(String(withdrawForm.amount || '0'), decimals)
    if (amount === 0n) return showNotification('Amount must be greater than 0', 'error')
    return runTx(
      () => writeMembership(addr, 'withdrawFees', [amount, getAddress(String(target).trim())]),
      `Withdrew ${withdrawForm.amount} ${symbol} to ${shortAddr(target)} on ${networkName(withdrawChainId)}`,
    ).then((ok) => {
      if (ok) feeEstate.refresh()
      return ok
    })
  }

  const membershipChainWarning = !onMembershipChain && (
    <p className="card-info warning-text" role="status">
      Memberships live on {networkName(membershipAdminChainId)} and are read from there everywhere.
      Switch your wallet to {networkName(membershipAdminChainId)} to make this change — doing it on
      another network would create state no member surface ever reads.
    </p>
  )

  const dashboard = (
    <div className="overview-grid">
      {/* Spec 071 T046: the address is the REFERENCE chain's MembershipManager, so the
          provider and the cache key must name that chain too. */}
      <MembershipTreasuryOverview
        provider={membershipScanProvider}
        chainId={membershipAdminChainId}
        address={membershipManagerAddr}
        accruedFees={membershipState.accruedFees}
        accruedFeesReadable={membershipState.accruedFeesReadable}
      />

      {/* Fees across the whole estate. Two SEPARATE figures, deliberately:
          accrued (undrawn) and treasury (received) are never added together. */}
      <div className="admin-card full-width">
        <div className="admin-card-header"><h3>Fees across the estate</h3></div>
        <ChainStateTable
          caption="Accrued (undrawn) — withdrawable from MembershipManager"
          results={feeEstate.accrued}
          totals={feeEstate.accruedTotals}
          onRetry={feeEstate.refresh}
        />
        <ChainStateTable
          caption="Treasury balance (received) — already delivered by the FeeRouter"
          results={feeEstate.received}
          totals={feeEstate.receivedTotals}
          onRetry={feeEstate.refresh}
        />
        <p className="card-info">
          These two are never combined: the first is undrawn and still withdrawable, the second has
          already been paid to the treasury. Totals are shown per token because networks hold
          different payment tokens, and any total computed while a network was unreadable says so
          and names it.
        </p>
      </div>
    </div>
  )

  const renderView = (viewId) => {
    if (viewId === 'tiers') {
      return (
        <div className="admin-tab-content" role="tabpanel">
          <div className="admin-card">
            <h3>Configure Tier: {membershipRole(tierForm.role).label} on {networkName(membershipAdminChainId)}</h3>
            {membershipChainWarning}
            <p>Set price (USDC), duration, monthly cap, and concurrent cap for each tier. 0 = unlimited.</p>
            <div className="admin-form">
              <label>
                Membership role
                <select value={tierForm.role} onChange={(e) => setTierForm({ ...tierForm, role: e.target.value })}>
                  {Object.entries(MEMBERSHIP_ROLES).map(([key, r]) => (
                    <option key={key} value={key}>{r.label}</option>
                  ))}
                </select>
              </label>
              <label>
                Tier
                <select value={tierForm.tier} onChange={(e) => setTierForm({ ...tierForm, tier: Number(e.target.value) })}>
                  {[1, 2, 3, 4].map((t) => <option key={t} value={t}>{TIER_NAMES[t]}</option>)}
                </select>
              </label>
              <label>
                Price (USDC)
                <input type="number" min="0" step="0.01" value={tierForm.price}
                  onChange={(e) => setTierForm({ ...tierForm, price: e.target.value })} />
              </label>
              <label>
                Duration (days)
                <input type="number" min="1" max="3650" value={tierForm.durationDays}
                  onChange={(e) => setTierForm({ ...tierForm, durationDays: Number(e.target.value) })} />
              </label>
              <label>
                Monthly cap (0 = unlimited)
                <input type="number" min="0" value={tierForm.monthly}
                  onChange={(e) => setTierForm({ ...tierForm, monthly: Number(e.target.value) })} />
              </label>
              <label>
                Concurrent cap (0 = unlimited)
                <input type="number" min="0" value={tierForm.concurrent}
                  onChange={(e) => setTierForm({ ...tierForm, concurrent: Number(e.target.value) })} />
              </label>
              <label className="admin-checkbox">
                <input type="checkbox" checked={tierForm.active}
                  onChange={(e) => setTierForm({ ...tierForm, active: e.target.checked })} />
                Active (available for purchase)
              </label>
              <button
                className="confirm-btn primary"
                onClick={handleConfigureTier}
                disabled={pendingTx || !onMembershipChain || !tierGate.allowed}
              >
                {pendingTx ? 'Saving...' : 'Save Tier Config'}
              </button>
              {onMembershipChain && tierGate.reason && (
                <p className="card-info warning-text" role="status">{tierGate.reason}</p>
              )}
            </div>
          </div>
        </div>
      )
    }

    if (viewId === 'members') {
      return (
        <div className="admin-tab-content" role="tabpanel">
          <div className="admin-card">
            <h3>Grant Membership on {networkName(membershipAdminChainId)}</h3>
            {membershipChainWarning}
            <p>
              Grant a {membershipRole(grantForm.role).label} membership directly, bypassing the
              purchase flow. Use for support, gifts, or dispute resolution. Wager and pool
              memberships are separate roles — one does not satisfy the other.
            </p>
            <div className="admin-form">
              <label>
                Membership role
                <select value={grantForm.role} onChange={(e) => setGrantForm({ ...grantForm, role: e.target.value })}>
                  {Object.entries(MEMBERSHIP_ROLES).map(([key, r]) => (
                    <option key={key} value={key}>{r.label}</option>
                  ))}
                </select>
              </label>
              <label>
                Recipient (address or ENS)
                <input type="text" value={grantForm.address}
                  placeholder="0x… or name.eth"
                  onChange={(e) => setGrantForm({ ...grantForm, address: e.target.value })} />
                {grantEns.isLoading && <span className="hint">Resolving…</span>}
                {grantEns.resolvedAddress && grantEns.isEns && (
                  <span className="hint">→ {shortAddr(grantEns.resolvedAddress)}</span>
                )}
              </label>
              <label>
                Tier
                <select value={grantForm.tier} onChange={(e) => setGrantForm({ ...grantForm, tier: Number(e.target.value) })}>
                  {[1, 2, 3, 4].map((t) => <option key={t} value={t}>{TIER_NAMES[t]}</option>)}
                </select>
              </label>
              <label>
                Duration (days)
                <input type="number" min="1" max="3650" value={grantForm.durationDays}
                  onChange={(e) => setGrantForm({ ...grantForm, durationDays: Number(e.target.value) })} />
              </label>
              <button
                className="confirm-btn primary"
                onClick={handleGrantMembership}
                disabled={pendingTx || !onMembershipChain || !memberGate.allowed}
              >
                {pendingTx ? 'Granting...' : 'Grant Membership'}
              </button>
              {onMembershipChain && memberGate.reason && (
                <p className="card-info warning-text" role="status">{memberGate.reason}</p>
              )}
            </div>
          </div>

          <div className="admin-card">
            <h3>Revoke Membership</h3>
            <p>Sets the user&apos;s {membershipRole(revokeForm.role).label} tier back to <code>None</code>. Does not refund any USDC.</p>
            <div className="admin-form">
              <label>
                Membership role
                <select value={revokeForm.role} onChange={(e) => setRevokeForm({ ...revokeForm, role: e.target.value })}>
                  {Object.entries(MEMBERSHIP_ROLES).map(([key, r]) => (
                    <option key={key} value={key}>{r.label}</option>
                  ))}
                </select>
              </label>
              <label>
                Account
                <input type="text" value={revokeForm.address}
                  placeholder="0x… or name.eth"
                  onChange={(e) => setRevokeForm({ ...revokeForm, address: e.target.value })} />
                {revokeEns.resolvedAddress && revokeEns.isEns && (
                  <span className="hint">→ {shortAddr(revokeEns.resolvedAddress)}</span>
                )}
              </label>
              <button
                className="confirm-btn danger"
                onClick={handleRevokeMembership}
                disabled={pendingTx || !onMembershipChain || !memberGate.allowed}
              >
                {pendingTx ? 'Revoking...' : 'Revoke Membership'}
              </button>
              {onMembershipChain && memberGate.reason && (
                <p className="card-info warning-text" role="status">{memberGate.reason}</p>
              )}
            </div>
          </div>
        </div>
      )
    }

    if (viewId === 'treasury') {
      return (
        <div className="admin-tab-content" role="tabpanel">
          <div className="admin-card">
            <h3>Treasury Withdrawal</h3>
            {/* A withdrawal is a WRITE: one chain, named, withheld unless the wallet is
                there. The balance shown is that chain's — never an estate total. */}
            <div className="admin-form">
              <label>
                Network to withdraw on
                <select
                  value={String(withdrawChainId)}
                  onChange={(e) => setWithdrawChainId(Number(e.target.value))}
                >
                  {feeEstate.accrued.map((r) => (
                    <option key={r.chainId} value={String(r.chainId)}>
                      {networkName(r.chainId)}
                      {isRead(r) ? ` — ${formatUnitAmount(r, formatUnits)} available` : ''}
                      {isNotDeployed(r) ? ' — not deployed' : ''}
                      {!isRead(r) && !isNotDeployed(r) ? ' — could not be read' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <p className="card-info">
                {withdrawScope && isRead(withdrawScope) ? (
                  <>
                    Withdrawing <strong>{formatUnitAmount(withdrawScope, formatUnits)}</strong>{' '}
                    of accrued tier fees on <strong>{networkName(withdrawChainId)}</strong>.
                  </>
                ) : withdrawScope && isNotDeployed(withdrawScope) ? (
                  <>No MembershipManager on {networkName(withdrawChainId)} — nothing to withdraw there.</>
                ) : (
                  <>
                    The balance on {networkName(withdrawChainId)} could not be read, so the
                    available amount is unknown.
                  </>
                )}
                {Number(chainId) !== Number(withdrawChainId) && (
                  <> Your wallet is on {networkName(chainId)} — switch it to{' '}
                  {networkName(withdrawChainId)} to sign this withdrawal.</>
                )}
              </p>
              <label>
                Recipient (address or ENS)
                <input type="text" value={withdrawForm.to}
                  placeholder="0x… or name.eth"
                  onChange={(e) => setWithdrawForm({ ...withdrawForm, to: e.target.value })} />
                {withdrawEns.resolvedAddress && withdrawEns.isEns && (
                  <span className="hint">→ {shortAddr(withdrawEns.resolvedAddress)}</span>
                )}
                {membershipState.treasury && withdrawForm.to &&
                  withdrawForm.to.toLowerCase() === membershipState.treasury.toLowerCase() && (
                  <span className="hint">Configured treasury</span>
                )}
              </label>
              <label>
                Amount ({withdrawScope?.unit?.symbol || 'tokens'})
                <input type="number" min="0" step="0.01" value={withdrawForm.amount}
                  onChange={(e) => setWithdrawForm({ ...withdrawForm, amount: e.target.value })} />
                {/* Max is the SCOPED chain's balance, offered only when that balance was
                    actually read — filling it from an unknown would be a guess. */}
                <button type="button" className="hint-btn"
                  disabled={!withdrawScope || !isRead(withdrawScope)}
                  onClick={() => setWithdrawForm({
                    ...withdrawForm,
                    amount: formatUnits(withdrawScope.value, withdrawScope.unit?.decimals ?? 6),
                  })}>
                  Max
                </button>
              </label>
              <button
                className="confirm-btn primary"
                onClick={handleWithdraw}
                disabled={pendingTx || Number(chainId) !== Number(withdrawChainId) || !withdrawGate.allowed}
              >
                {pendingTx
                  ? 'Withdrawing...'
                  : Number(chainId) !== Number(withdrawChainId)
                    ? `Switch to ${networkName(withdrawChainId)} to withdraw`
                    : `Withdraw on ${networkName(withdrawChainId)}`}
              </button>
              {Number(chainId) === Number(withdrawChainId) && withdrawGate.reason && (
                <p className="card-info warning-text" role="status">{withdrawGate.reason}</p>
              )}
            </div>
          </div>
        </div>
      )
    }

    if (viewId === 'fees') {
      return (
        <FeesTab
          signer={signer}
          account={account}
          chainId={chainId}
          provider={provider || getProvider(chainId)}
          runTx={runTx}
          pendingTx={pendingTx}
          isAdmin={flags.isAdmin}
          isFeeAdmin={flags.isFeeAdmin}
        />
      )
    }

    if (viewId === 'perps-fees') {
      return (
        <PerpsFeesPanel
          signer={signer}
          account={account}
          chainId={chainId}
          provider={provider || getProvider(chainId)}
          runTx={runTx}
          pendingTx={pendingTx}
          // Perps Fees and Fees share a gate, so anyone rendering this view may
          // open Fees — now a URL, not a sibling tab id.
          onOpenFees={() => navigate(adminViewPath('fees'))}
        />
      )
    }

    return null
  }

  return <AdminAppShell app={APP} access={access} dashboard={dashboard} renderView={renderView} />
}
