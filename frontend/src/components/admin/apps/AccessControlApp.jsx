/**
 * Access Control admin mini-app (spec 093) — the monolithic AdminPanel's
 * `admin-roles` view, extracted verbatim.
 *
 * ── ROLE GRANTS ARE PER CONTRACT *PER CHAIN* (spec 071 T064/FR-017) ──
 * GUARDIAN_ROLE on Polygon's registry is not GUARDIAN_ROLE on Base's. The
 * view is scoped and named so an operator can see which network they are
 * handing authority on. Each grantable role lives on a specific contract;
 * grants are sent to the contract that defines the role, never blanket-sent
 * to the registry.
 *
 * The dashboard shows where each role target actually exists on the scoped
 * network — deployment is config (the address book), not a chain read, so
 * the table is exact and needs no three-state hedging.
 */
import { useEffect, useMemo, useState } from 'react'
import { encodeFunctionData, keccak256, stringToHex, zeroHash } from 'viem'
import { normalizeAbi } from '../../../lib/chains/readContract'
import { getAddress } from '../../../lib/evm/address'
import AdminAppShell from '../AdminAppShell'
import { NetworkScopeCard } from '../scopeControls'
import { useScopedChain, contractAuthorityGate } from '../scopeGate'
import { adminAppById } from '../adminApps'
import { useAdminAccess } from '../useAdminAccess'
import { useAdminTx } from '../useAdminTx'
import { useWeb3 } from '../../../hooks/useWeb3'
import { useNotification } from '../../../hooks/useUI'
import { useEnsResolution } from '../../../hooks/useEnsResolution'
import { isValidEthereumAddress } from '../../../utils/validation'
import { getContractAddressForChain } from '../../../config/contracts'
import { membershipChainId } from '../../../config/networks'
import { getProvider } from '../../../utils/blockchainService'
import {
  networkName,
  estateNetworks,
  readAuthority,
  readProviderFor,
} from '../../../lib/chains/estate'

const APP = adminAppById('access-control')

/** `keccak256(utf8(name))` — byte-identical to the `ethers.keccak256(ethers.toUtf8Bytes(...))`
 *  this replaced, checked against it for all eight role names before the swap. These hashes ARE
 *  the roles on chain, so a wrong byte grants nothing and revokes nothing while reporting success. */
const roleId = (name) => keccak256(stringToHex(name))

const ROLE_HASHES = {
  GUARDIAN: roleId('GUARDIAN_ROLE'),
  ACCOUNT_MODERATOR: roleId('ACCOUNT_MODERATOR_ROLE'),
  ROLE_MANAGER: roleId('ROLE_MANAGER_ROLE'),
  SANCTIONS_ADMIN: roleId('SANCTIONS_ADMIN_ROLE'),
  TOKEN_ISSUER: roleId('TOKEN_ISSUER_ROLE'),
  STAKING_ADMIN: roleId('STAKING_ADMIN_ROLE'),
  // LIQUIDITY_ADMIN_ROLE (spec 067) is the same role id on two separate
  // AccessControl contracts — the BridgeRouter and the LiquidityRouter — so it
  // is granted/revoked once per router. The picker offers the two targets
  // explicitly instead of one option that would quietly authorize only half
  // of what the operator asked for.
  LIQUIDITY_ADMIN_BRIDGE: roleId('LIQUIDITY_ADMIN_ROLE'),
  LIQUIDITY_ADMIN_LIQUIDITY: roleId('LIQUIDITY_ADMIN_ROLE'),
  // GUARDIAN_ROLE is per-contract for the same reason, and the spec-067 routers
  // were unreachable: the bare `GUARDIAN` option grants on the WagerRegistry, so
  // there was NO in-app way to give anyone the routers' killswitch.
  GUARDIAN_BRIDGE: roleId('GUARDIAN_ROLE'),
  GUARDIAN_LIQUIDITY: roleId('GUARDIAN_ROLE'),
  // FEE_ADMIN_ROLE (spec 060) lives on the FeeRouter — the same defect-class as
  // the router guardians above: the role gates the whole Fees tab, so leaving it
  // out of this picker meant there was NO in-app way to hand anyone fee-rate
  // authority. Hash matches contracts/fees/FeeRouter.sol.
  FEE_ADMIN: roleId('FEE_ADMIN_ROLE'),
  DEFAULT_ADMIN: zeroHash,
}

const ACCESS_CONTROL_ABI = [
  'function grantRole(bytes32 role, address account)',
  'function revokeRole(bytes32 role, address account)',
]

/** The contract each grantable role is defined on — named in every refusal (FR-019). */
const ROLE_HOME_LABELS = {
  ROLE_MANAGER: 'MembershipManager',
  SANCTIONS_ADMIN: 'SanctionsGuard',
  TOKEN_ISSUER: 'TokenFactory',
  STAKING_ADMIN: 'StakingRouter',
  LIQUIDITY_ADMIN_BRIDGE: 'BridgeRouter',
  GUARDIAN_BRIDGE: 'BridgeRouter',
  LIQUIDITY_ADMIN_LIQUIDITY: 'LiquidityRouter',
  GUARDIAN_LIQUIDITY: 'LiquidityRouter',
  FEE_ADMIN: 'FeeRouter',
}

function shortAddr(address) {
  return address ? `${address.substring(0, 6)}...${address.substring(address.length - 4)}` : ''
}

export default function AccessControlApp() {
  const access = useAdminAccess()
  const { account, signer, provider, chainId } = useWeb3()
  const { showNotification } = useNotification()
  const { runTx, pendingTx } = useAdminTx()

  const roleNetworks = useMemo(() => estateNetworks(), [])
  const { scopeChainId: roleChainId, setScopeChainId: setRoleChainId } =
    useScopedChain(roleNetworks, chainId)

  // ROLE_MANAGER lives on the MembershipManager, which is reference-chain
  // pinned like the membership it manages — deliberately NOT scope-following.
  const membershipManagerAddr = getContractAddressForChain('membershipManager', membershipChainId())
  const sanctionsGuardAddr = getContractAddressForChain('sanctionsGuard', roleChainId)
  const tokenFactoryAddr = getContractAddressForChain('tokenFactory', roleChainId)
  const stakingRouterAddr = getContractAddressForChain('stakingRouter', roleChainId)
  const bridgeRouterAddr = getContractAddressForChain('bridgeRouter', roleChainId)
  const liquidityRouterAddr = getContractAddressForChain('liquidityRouter', roleChainId)
  const feeRouterAddr = getContractAddressForChain('feeRouter', roleChainId)
  const roleRegistryAddr = getContractAddressForChain('wagerRegistry', roleChainId)

  const roleHomeContract = (role) => {
    if (role === 'ROLE_MANAGER') return membershipManagerAddr
    if (role === 'SANCTIONS_ADMIN') return sanctionsGuardAddr
    if (role === 'TOKEN_ISSUER') return tokenFactoryAddr
    if (role === 'STAKING_ADMIN') return stakingRouterAddr
    if (role === 'LIQUIDITY_ADMIN_BRIDGE' || role === 'GUARDIAN_BRIDGE') return bridgeRouterAddr
    if (role === 'LIQUIDITY_ADMIN_LIQUIDITY' || role === 'GUARDIAN_LIQUIDITY') return liquidityRouterAddr
    if (role === 'FEE_ADMIN') return feeRouterAddr
    return roleRegistryAddr
  }

  // The name of that contract, for the refusal messages below: "you do not hold
  // DEFAULT_ADMIN_ROLE" means nothing without saying *where*.
  const roleHomeLabel = (role) => ROLE_HOME_LABELS[role] || 'WagerRegistry'

  // The chain a role grant is SIGNED on. Every role follows the scope picker
  // except ROLE_MANAGER, whose home contract is reference-chain pinned (above):
  // signing that grant on the scoped chain would send a transaction to the
  // membership chain's ADDRESS on a chain where it holds no code — which
  // "succeeds" as a no-op and reports a grant that never happened.
  const roleWriteChainId = (role) =>
    role === 'ROLE_MANAGER' ? Number(membershipChainId()) : Number(roleChainId)

  // Re-checked at call time as well as in the disabled button, so a stale
  // render can never sign on the wrong network (the sibling membership app's
  // requireMembershipChain pattern, spec 071 FR-017/FR-018).
  const requireRoleWriteChain = (role) => {
    const wantChainId = roleWriteChainId(role)
    if (Number(chainId) === wantChainId) return true
    showNotification(
      role === 'ROLE_MANAGER'
        ? `Role Manager lives on the MembershipManager on ${networkName(wantChainId)}. Switch your wallet there first.`
        : `This grant is signed on ${networkName(wantChainId)}. Switch your wallet there first.`,
      'error',
    )
    return false
  }

  const [adminRoleForm, setAdminRoleForm] = useState({ address: '', role: 'GUARDIAN' })
  const adminRoleEns = useEnsResolution(adminRoleForm.address || '')

  // The chain the SELECTED role's grant signs on — ROLE_MANAGER pins to the
  // membership chain, everything else follows the scope picker.
  const selectedWriteChainId = roleWriteChainId(adminRoleForm.role)
  const onSelectedWriteChain = Number(chainId) === Number(selectedWriteChainId)

  // ── AUTHORITY IS READ FROM THE CONTRACT THAT WILL ENFORCE IT (spec 071 FR-019) ──
  // OpenZeppelin's `grantRole`/`revokeRole` are gated on the role's ADMIN role,
  // which is `DEFAULT_ADMIN_ROLE` on every contract this picker targets (no
  // `_setRoleAdmin` call exists on any of them). So that is what is asked of the
  // SELECTED role's home contract, on the chain that grant actually signs on —
  // for ROLE_MANAGER the membership reference chain, for everything else the
  // scoped one. `access.flags.isAdmin` cannot answer this: it is true when
  // DEFAULT_ADMIN_ROLE is held on ANY cohort chain, on a candidate list that
  // need not include this contract at all, so it would offer an enabled Grant
  // button for a transaction the contract then reverts.
  const selectedRoleContract = roleHomeContract(adminRoleForm.role)
  const authorityProvider =
    readProviderFor(selectedWriteChainId, chainId, provider) || getProvider(selectedWriteChainId)
  const [roleAdminAuthority, setRoleAdminAuthority] = useState(null)
  useEffect(() => {
    let cancelled = false
    setRoleAdminAuthority(null)
    readAuthority({
      chainId: selectedWriteChainId,
      provider: authorityProvider,
      address: selectedRoleContract,
      account,
      roles: ['admin'],
    }).then((a) => {
      if (!cancelled) setRoleAdminAuthority(a)
    })
    return () => {
      cancelled = true
    }
  }, [authorityProvider, selectedRoleContract, account, selectedWriteChainId])

  const roleAdminGate = contractAuthorityGate({
    authority: roleAdminAuthority,
    roles: ['admin'],
    // Stands in for one round-trip only, so an operator who does hold it is not
    // shown a dead button while the read is in flight.
    fallback: access.flags.isAdmin,
    chainId: selectedWriteChainId,
    contractLabel: roleHomeLabel(adminRoleForm.role),
    roleLabel: 'DEFAULT_ADMIN_ROLE',
    accountLabel: account ? shortAddr(account) : 'This account',
  })

  // Re-checked at the call site as well as in the disabled button: only a
  // DEFINITE "not held" refuses, so an unconfirmed read still sends and lets the
  // contract be the gate.
  const requireRoleAdminAuthority = () => {
    if (roleAdminGate.allowed) return true
    showNotification(roleAdminGate.reason || 'You do not hold DEFAULT_ADMIN_ROLE here.', 'error')
    return false
  }

  /**
   * Grant or revoke a role on one contract.
   *
   * `getAddress` is not decoration (spec 110 divergence 16). `isValidEthereumAddress` is a bare
   * regex — it accepts an ALL-UPPERCASE address, and it tests `address.trim()` while handing the
   * caller the UNTRIMMED value. viem's encoder refuses both, so without normalising here an
   * operator pasting an upper-cased address, or one with a trailing space, would pass validation
   * and then get a raw encoder error from under a button that grants GUARDIAN_ROLE.
   */
  const writeRole = (addr, functionName, roleHash, target) =>
    signer.sendTransaction({
      to: addr,
      data: encodeFunctionData({
        abi: normalizeAbi(ACCESS_CONTROL_ABI),
        functionName,
        args: [roleHash, getAddress(String(target).trim())],
      }),
    })

  const handleGrantAdminRole = () => {
    const target = adminRoleEns.resolvedAddress || adminRoleForm.address
    if (!isValidEthereumAddress(target)) return showNotification('Invalid address', 'error')
    if (!requireRoleWriteChain(adminRoleForm.role)) return false
    const roleHash = ROLE_HASHES[adminRoleForm.role]
    const addr = roleHomeContract(adminRoleForm.role)
    if (!addr) return showNotification('Role contract not deployed on this network', 'error')
    if (!requireRoleAdminAuthority()) return false
    return runTx(
      () => writeRole(addr, 'grantRole', roleHash, target),
      `Granted ${adminRoleForm.role} to ${shortAddr(target)} on ${networkName(roleWriteChainId(adminRoleForm.role))}`,
    )
  }

  const handleRevokeAdminRole = () => {
    const target = adminRoleEns.resolvedAddress || adminRoleForm.address
    if (!isValidEthereumAddress(target)) return showNotification('Invalid address', 'error')
    if (!requireRoleWriteChain(adminRoleForm.role)) return false
    const roleHash = ROLE_HASHES[adminRoleForm.role]
    const addr = roleHomeContract(adminRoleForm.role)
    if (!addr) return showNotification('Role contract not deployed on this network', 'error')
    if (!requireRoleAdminAuthority()) return false
    return runTx(
      () => writeRole(addr, 'revokeRole', roleHash, target),
      `Revoked ${adminRoleForm.role} from ${shortAddr(target)} on ${networkName(roleWriteChainId(adminRoleForm.role))}`,
    )
  }

  // Dashboard: where each grantable role's home contract exists on the scoped
  // network. Deployment comes from the address book (config), so this table
  // is definite — the write view still refuses per contract at grant time.
  const roleTargets = [
    { role: 'GUARDIAN', label: 'Guardian (WagerRegistry)', addr: roleRegistryAddr },
    { role: 'ACCOUNT_MODERATOR', label: 'Account Moderator (WagerRegistry)', addr: roleRegistryAddr },
    { role: 'ROLE_MANAGER', label: `Role Manager (MembershipManager, ${networkName(membershipChainId())})`, addr: membershipManagerAddr },
    { role: 'SANCTIONS_ADMIN', label: 'Compliance Officer (SanctionsGuard)', addr: sanctionsGuardAddr },
    { role: 'TOKEN_ISSUER', label: 'Token Issuer (TokenFactory)', addr: tokenFactoryAddr },
    { role: 'STAKING_ADMIN', label: 'Staking Administrator (StakingRouter)', addr: stakingRouterAddr },
    { role: 'LIQUIDITY_ADMIN_BRIDGE', label: 'Liquidity Administrator (BridgeRouter)', addr: bridgeRouterAddr },
    { role: 'LIQUIDITY_ADMIN_LIQUIDITY', label: 'Liquidity Administrator (LiquidityRouter)', addr: liquidityRouterAddr },
    { role: 'GUARDIAN_BRIDGE', label: 'Guardian (BridgeRouter)', addr: bridgeRouterAddr },
    { role: 'GUARDIAN_LIQUIDITY', label: 'Guardian (LiquidityRouter)', addr: liquidityRouterAddr },
    { role: 'FEE_ADMIN', label: 'Fee Administrator (FeeRouter)', addr: feeRouterAddr },
    { role: 'DEFAULT_ADMIN', label: 'Default Admin (WagerRegistry)', addr: roleRegistryAddr },
  ]
  const deployedCount = roleTargets.filter((t) => Boolean(t.addr)).length

  const dashboard = (
    <div className="overview-grid">
      <div className="admin-card full-width">
        <div className="admin-card-header"><h3>Role targets on {networkName(roleChainId)}</h3></div>
        <p className="card-info">
          {deployedCount} of {roleTargets.length} role home contracts exist on{' '}
          {networkName(roleChainId)}. A role can only be granted where its contract exists —
          and a grant here gives no authority anywhere else.
        </p>
        <div className="admin-table-scroll">
          <table className="admin-table">
            <caption className="sr-only">Grantable roles and their home contracts on the scoped network</caption>
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">Home contract</th>
              </tr>
            </thead>
            <tbody>
              {roleTargets.map((t) => (
                <tr key={t.role}>
                  <td>{t.label}</td>
                  <td>
                    {t.addr ? (
                      <code title={t.addr}>{shortAddr(t.addr)}</code>
                    ) : (
                      <span className="admin-table-absent">not deployed here</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )

  const renderView = (viewId) => {
    if (viewId !== 'admin-roles') return null
    return (
      <div className="admin-tab-content" role="tabpanel">
        <NetworkScopeCard
          title="Admin Roles"
          description="Roles are granted per contract per network. A grant on one network gives no authority on another, so pick the network you mean."
          networks={roleNetworks}
          scopeChainId={roleChainId}
          onScopeChange={setRoleChainId}
          isDeployed={(id) => Boolean(getContractAddressForChain('wagerRegistry', id))}
          walletChainId={chainId}
          onRefresh={() => {}}
          lastReadAt={null}
          notDeployedLabel="no wager registry"
        />
        <div className="admin-card">
          {/* The header names the chain the SELECTED role's transaction actually
              signs on — for ROLE_MANAGER that is the membership reference chain,
              whatever network the view is scoped to. */}
          <h3>Grant / Revoke Admin Roles on {networkName(selectedWriteChainId)}</h3>
          {Number(selectedWriteChainId) !== Number(roleChainId) && (
            <p className="card-info">
              This view is scoped to {networkName(roleChainId)}, but Role Manager&apos;s home
              contract is the MembershipManager on {networkName(selectedWriteChainId)} — the grant
              signs there, and a grant there is the only one membership ever reads.
            </p>
          )}
          {!onSelectedWriteChain && (
            <p className="card-info warning-text" role="status">
              {adminRoleForm.role === 'ROLE_MANAGER' ? (
                <>
                  Role Manager lives on the MembershipManager on{' '}
                  {networkName(selectedWriteChainId)} — whatever network is scoped above. Your
                  wallet is on {networkName(chainId)} — switch it to{' '}
                  {networkName(selectedWriteChainId)} to grant or revoke.
                </>
              ) : (
                <>
                  This grant is signed on {networkName(selectedWriteChainId)}. Your wallet is on{' '}
                  {networkName(chainId)} — switch it there to grant or revoke.
                </>
              )}
            </p>
          )}
          <p>
            Only the holder of <code>DEFAULT_ADMIN_ROLE</code> can grant other admin roles.
            Grant sparingly: each role is a distinct privilege and a foothold.
          </p>
          <p>
            <strong>Liquidity Administrator is per-router.</strong> The bridge and
            liquidity routers each carry their own <code>LIQUIDITY_ADMIN_ROLE</code>;
            granting one does not grant the other. Grant both if the operator is meant
            to curate bridge routes <em>and</em> supplied pools.
          </p>
          <p>
            <strong>So is Guardian.</strong> The plain “Guardian” option above grants on the
            WagerRegistry and does <em>not</em> carry to the bridge or liquidity routers — those
            check their own role registry, so an on-call operator needs the router-specific
            Guardian grant to reach the Bridge or Supply killswitch. Note also that the routers
            keep protocol-wiring changes (SpokePool, position manager, FeeRouter, sanctions guard)
            at <code>DEFAULT_ADMIN_ROLE</code>: those addresses decide where member funds go, so
            curating routes and pools does not carry the power to redirect them.
          </p>
          <div className="admin-form">
            <label>
              Account (address or ENS)
              <input type="text" value={adminRoleForm.address}
                placeholder="0x… or name.eth"
                onChange={(e) => setAdminRoleForm({ ...adminRoleForm, address: e.target.value })} />
              {adminRoleEns.resolvedAddress && adminRoleEns.isEns && (
                <span className="hint">→ {shortAddr(adminRoleEns.resolvedAddress)}</span>
              )}
            </label>
            <label>
              Role
              <select value={adminRoleForm.role}
                onChange={(e) => setAdminRoleForm({ ...adminRoleForm, role: e.target.value })}>
                <option value="GUARDIAN">Guardian — pause/unpause (WagerRegistry)</option>
                <option value="ACCOUNT_MODERATOR">Account Moderator — freeze/unfreeze</option>
                <option value="ROLE_MANAGER">Role Manager — grant/revoke memberships</option>
                <option value="SANCTIONS_ADMIN">Compliance Officer — deny-list (SanctionsGuard)</option>
                <option value="TOKEN_ISSUER">Token Issuer — token creation (TokenFactory)</option>
                <option value="STAKING_ADMIN">Staking Administrator — provider addrs + validator allowlist (StakingRouter)</option>
                <option value="LIQUIDITY_ADMIN_BRIDGE">Liquidity Administrator — bridge routes + limits (BridgeRouter only)</option>
                <option value="LIQUIDITY_ADMIN_LIQUIDITY">Liquidity Administrator — curated pools + caps (LiquidityRouter only)</option>
                <option value="GUARDIAN_BRIDGE">Guardian — pause new bridges (BridgeRouter only)</option>
                <option value="GUARDIAN_LIQUIDITY">Guardian — pause new Uniswap supplies (LiquidityRouter only)</option>
                <option value="FEE_ADMIN">Fee Administrator — service fee rates (FeeRouter)</option>
                <option value="DEFAULT_ADMIN">Default Admin — full control (rare)</option>
              </select>
            </label>
            <div className="emergency-actions">
              <button
                className="confirm-btn primary"
                onClick={handleGrantAdminRole}
                disabled={pendingTx || !onSelectedWriteChain || !roleAdminGate.allowed}
              >
                {pendingTx
                  ? 'Processing...'
                  : onSelectedWriteChain
                    ? 'Grant Role'
                    : `Switch to ${networkName(selectedWriteChainId)} to grant`}
              </button>
              <button
                className="confirm-btn danger"
                onClick={handleRevokeAdminRole}
                disabled={pendingTx || !onSelectedWriteChain || !roleAdminGate.allowed}
              >
                {pendingTx
                  ? 'Processing...'
                  : onSelectedWriteChain
                    ? 'Revoke Role'
                    : `Switch to ${networkName(selectedWriteChainId)} to revoke`}
              </button>
            </div>
            {/* One reason at a time, and the actionable one: while the wallet is on
                the wrong network the notice above already says what to do, and the
                authority verdict there would be about a chain nobody is signing on. */}
            {onSelectedWriteChain && roleAdminGate.reason && (
              <p className="card-info warning-text" role="status">
                {roleAdminGate.reason}
              </p>
            )}
          </div>
        </div>
      </div>
    )
  }

  return <AdminAppShell app={APP} access={access} dashboard={dashboard} renderView={renderView} />
}
