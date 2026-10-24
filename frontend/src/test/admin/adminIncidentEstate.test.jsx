/**
 * Spec 071 US4 (T066–T069) — the incident-response views span the estate, and act on ONE chain.
 *
 * These convert LAST on purpose (research R8): the killswitch should be the least-experimental
 * conversion in the feature, not the first. By the time it lands, the same scope pattern has
 * been proven on Maintenance and Wiring & Tokens.
 *
 * T067 asserts an ABSENCE — no control pauses or freezes across several chains at once
 * (FR-020). A feature that makes every view span the estate is exactly where an implicit
 * multi-chain killswitch would seem like a natural convenience, and a killswitch that fans out
 * is one an operator can fire without knowing what they hit. Prose cannot verify an absence, so
 * this checks the source.
 */
import { describe, it, expect } from 'vitest'
// Spec 093: the incident views live in their own admin mini-app now; the
// invariants are unchanged and keep being asserted against the source.
import adminPanelSource from '../../components/admin/apps/IncidentResponseApp.jsx?raw'

describe('the pause acts on one named chain (T066, FR-017/FR-018)', () => {
  it('writes to the SCOPED registry, not the wallet chain\'s', () => {
    expect(adminPanelSource).toMatch(
      /getContractAddressForChain\('wagerRegistry', incidentChainId\)/,
    )
    // Spec 110: writes are `encodeFunctionData` + `sendTransaction` now. What this asserts is
    // what it always meant to — the transaction's `to` is the SCOPED registry address, which is
    // the only thing standing between "pause Polygon" and pausing whatever the wallet is on.
    expect(adminPanelSource).toMatch(/const incidentWrite = \(functionName, args = \[\]\) =>/)
    expect(adminPanelSource).toMatch(/to: incidentRegistryAddr,/)
  })

  it('names the chain in the pause and unpause confirmations', () => {
    expect(adminPanelSource).toMatch(/WagerRegistry paused on \$\{networkName\(incidentChainId\)\}/)
    expect(adminPanelSource).toMatch(/WagerRegistry unpaused on \$\{networkName\(incidentChainId\)\}/)
  })

  it('names the chain on the buttons, so the operator reads it before clicking', () => {
    expect(adminPanelSource).toMatch(/`Pause on \$\{networkName\(incidentChainId\)\}`/)
    expect(adminPanelSource).toMatch(/`Unpause on \$\{networkName\(incidentChainId\)\}`/)
  })

  it('refuses at the call site as well as in the disabled button', () => {
    // A stale render must not be able to pause the wrong network.
    expect(adminPanelSource).toMatch(/const requireIncidentChain = \(\) => \{/)
    expect(adminPanelSource).toMatch(/handlePause = \(\) => requireIncidentChain\(\) && runTx/)
    expect(adminPanelSource).toMatch(/handleUnpause = \(\) => requireIncidentChain\(\) && runTx/)
    expect(adminPanelSource).toMatch(/disabled=\{pendingTx \|\| !onIncidentChain\}/)
  })
})

describe('a freeze applies to one named chain (T068)', () => {
  it('writes to the scoped registry and names the chain', () => {
    expect(adminPanelSource).toMatch(/incidentWrite\('freezeAccount'/)
    expect(adminPanelSource).toMatch(/incidentWrite\('unfreezeAccount'/)
    expect(adminPanelSource).toMatch(/frozen on \$\{networkName\(incidentChainId\)\}/)
    expect(adminPanelSource).toMatch(/unfrozen on \$\{networkName\(incidentChainId\)\}/)
  })

  it('checks the chain before sending, not only in the button', () => {
    expect(adminPanelSource).toMatch(/if \(!requireIncidentChain\(\)\) return false/)
  })

  it('says a freeze on one network is not a freeze on another', () => {
    // The operator must not assume it fanned out — that assumption is the dangerous one.
    expect(adminPanelSource).toMatch(/does not freeze it on another/)
  })
})

// ── T067: THE ABSENCE ───────────────────────────────────────────────────────────────────────
describe('no control acts across several chains at once (FR-020)', () => {
  it('never loops a pause or freeze over a list of chains', () => {
    // Any of these shapes would be an implicit multi-chain killswitch.
    expect(adminPanelSource).not.toMatch(/cohortChainIds\(\)[\s\S]{0,200}?\.(pause|unpause)\(\)/)
    expect(adminPanelSource).not.toMatch(/\.map\([^)]*\)[\s\S]{0,120}?\.(pause|unpause)\(\)/)
    expect(adminPanelSource).not.toMatch(/for \(const[\s\S]{0,200}?\.(pause|unpause)\(\)/)
    expect(adminPanelSource).not.toMatch(/for \(const[\s\S]{0,200}?freezeAccount\(/)
  })

  it('offers no "pause everywhere" / "pause all" control', () => {
    expect(adminPanelSource).not.toMatch(/pause\s*(all|every)/i)
    expect(adminPanelSource).not.toMatch(/freeze\s*(all|every)/i)
    // `.pause()` / `.unpause()` with parens — NOT `paused()`, which is the per-chain READ the
    // overview legitimately batches.
    expect(adminPanelSource).not.toMatch(/Promise\.all\([\s\S]{0,200}?\.(pause|unpause)\(\)/)
  })

  it('states the rule where the next person will read it', () => {
    expect(adminPanelSource).toMatch(/no control that pauses several at once|NO control that acts\s*\n?\s*\/\/ on several chains/i)
  })
})

describe('the incident scope is chosen, not inherited (FR-016)', () => {
  it('uses the shared useScopedChain, which never re-derives from the wallet', () => {
    expect(adminPanelSource).toMatch(/useScopedChain\(registryNetworks, chainId\)/)
  })

  it('lists only networks that actually carry a registry', () => {
    expect(adminPanelSource).toMatch(
      /estateNetworks\(\)\.filter\(\(n\) => getContractAddressForChain\('wagerRegistry', n\.chainId\)\)/,
    )
  })
})
