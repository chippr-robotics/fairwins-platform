// Spec 043 — Custody surface. Lives under Tools → Protect with two sub-sections: "On chain"
// (Safe multisig) and "Off chain" (reserved, disabled). Gated by Safe availability: on a network without a
// configured Safe deployment, vault CREATION shows an honest "unavailable on this network" state (FR-030).
//
// Spec 068 (US1) — the vault LIST is no longer gated by the connected chain: a member's vaults on
// every chain are always listed with their chain identity (FR-003), and only creation/load are
// restricted to networks where custody is deployed (FR-005). Actions on a vault whose chain is not
// the connected one are withheld behind a switch prompt (FR-004).
//
// Spec 102 — ONE card per vault ADDRESS (VaultCardList over `groups`), and every per-vault action
// behind the VaultSheet (Queue / Style / Details). `?vault=<address>` deep-links to a vault's sheet
// (FR-017) — address only, never a chain; the param is removed again when the sheet closes.

import { useCallback, useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import { useSearchParams } from 'react-router-dom'
import { useWallet } from '../../hooks'
import { useCustody } from '../../hooks/useCustody'
import { useCustodyVaults } from '../../hooks/useCustodyVaults'
import { useVaultProposals } from '../../hooks/useVaultProposals'
import { isCustodySupported, CUSTODY_SUPPORTED_CHAIN_IDS } from '../../config/safeContracts'
import { NETWORKS } from '../../config/networks'
import VaultCardList from './VaultCardList'
import VaultSheet from './VaultSheet'
import VaultActionSheet from './VaultActionSheet'
import VerifySection from './VerifySection'
import HardwareWalletSection from './HardwareWalletSection'
import AccordionGroup from '../account/AccordionGroup'
import AccordionSection from '../account/AccordionSection'
import { useHardwareAccounts } from '../../hooks/useHardwareAccounts'
import './Custody.css'

function OnChainSection() {
  const { address, chainId } = useWallet()
  const { active } = useCustody()
  const {
    groups,
    activeVault,
    selectVault,
    loading,
    error,
    refresh,
    loadByAddress,
  } = useCustodyVaults()
  // Release 1.14.0 — the four vault actions live in one bottom sheet (VaultActionSheet) instead of
  // two inline toggles plus two flows buried inside the open vault's card. `sheet` is null when
  // closed; `{ action }` names the view it should land on (null ⇒ the chooser).
  const [sheet, setSheet] = useState(null)
  // Spec 102 — the per-vault sheet: `{ address, view }` or null.
  const [vaultSheet, setVaultSheet] = useState(null)
  // Spec 049 — one shared proposal-queue instance for the active vault, so policy-change proposals
  // (VaultDetail → PolicyPanel) land in the same queue the VaultProposalsPanel renders.
  const proposals = useVaultProposals(activeVault)
  const canCreateHere = isCustodySupported(chainId)
  const [searchParams, setSearchParams] = useSearchParams()

  const openVault = useCallback(
    (vaultAddress, view = 'queue') => {
      // VaultActionSheet's propose/approve read `activeVault`, so selecting a card also selects it.
      selectVault?.(vaultAddress)
      setVaultSheet({ address: vaultAddress, view })
    },
    [selectVault],
  )

  const closeVault = useCallback(() => {
    setVaultSheet(null)
    if (searchParams.has('vault')) {
      const next = new URLSearchParams(searchParams)
      next.delete('vault')
      setSearchParams(next, { replace: true })
    }
  }, [searchParams, setSearchParams])

  // FR-017 — `?vault=<address>` opens that vault's sheet on Queue once the list knows it.
  const requestedVault = searchParams.get('vault')
  const groupList = groups || []
  const requestedGroup = requestedVault
    ? groupList.find((g) => String(g.address).toLowerCase() === String(requestedVault).toLowerCase())
    : null
  const requestedAddress = requestedGroup?.address ?? null
  useEffect(() => {
    if (!requestedAddress) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- URL → UI sync: the param is the request
    setVaultSheet((prev) => (prev?.address === requestedAddress ? prev : { address: requestedAddress, view: 'queue' }))
    selectVault?.(requestedAddress)
  }, [requestedAddress, selectVault])

  return (
    <div className="custody-onchain" role="region" aria-label="On-chain vaults">
      {/* One door. The sheet itself decides which of the four actions can be taken right now and
          says why for the rest — a control that is closed is still shown, because a control that
          has vanished reads as a broken app rather than as an unavailable network. */}
      <div className="custody-actions">
        <button type="button" data-testid="custody-open-vault-actions" onClick={() => setSheet({ action: null })}>
          Vault actions
        </button>
      </div>

      <VaultActionSheet
        open={Boolean(sheet)}
        onClose={() => setSheet(null)}
        initialAction={sheet?.action ?? null}
        chainId={chainId}
        connectedAddress={address}
        canCreateHere={canCreateHere}
        onCreated={async (createdAddress) => {
          // Spec 105 — the guided flow deployed (or found) the vault itself; refresh the list and
          // land the member on its card once the Done sheet closes.
          await refresh?.()
          if (createdAddress) selectVault?.(createdAddress)
        }}
        onLoad={loadByAddress}
        vault={activeVault}
        proposals={proposals}
      />

      {loading && <p className="custody-hint">Loading vaults…</p>}
      {error && (
        <p className="custody-error" role="alert">
          {error}
        </p>
      )}

      {/* Spec 102 — one compact card per vault; the card and its "⋯" open the vault sheet. */}
      <VaultCardList
        groups={groupList}
        actingAddress={active?.mode === 'vault' ? active.vaultAddress : null}
        onOpen={openVault}
      />

      <VaultSheet
        open={Boolean(vaultSheet)}
        address={vaultSheet?.address}
        initialView={vaultSheet?.view ?? 'queue'}
        onClose={closeVault}
        onVaultsChanged={refresh}
      />
    </div>
  )
}

export default function CustodyPanel({ openSection = null }) {
  // Cheap store read (public metadata only) — powers the collapsed Off chain summary so the
  // member sees their cold-storage state without opening the section.
  const hardwareAccounts = useHardwareAccounts()

  return (
    <div className="custody-panel">
      <h2 className="custody-heading">Protect</h2>

      {/* Spec 085 — the three areas are collapsible sections in the shared accordion (one open at
          a time, the same pattern as the Recovery and Settings tabs), so the tab reads as three
          headings instead of three full surfaces. Longform explanation lives in the docs, not
          here (FR-009/FR-010). Section ids double as the drawer-search attention/deep-link ids
          (navSearchIndex; AccordionSection stamps data-attention itself), and `openSection` is
          the hash-driven card the page asks us to land open. */}
      <AccordionGroup defaultOpenId="custody-onchain" openId={openSection} className="custody-accordion">
        {/* Always rendered: the vault list spans chains, so it must survive an unsupported
            connected network (FR-003/FR-005). OnChainSection itself gates creation. */}
        <AccordionSection
          id="custody-onchain"
          title="On chain"
          summary="Multisig vaults you co-control"
          data-testid="custody-acc-onchain"
        >
          <OnChainSection />
        </AccordionSection>

        {/* Verify — sign an arbitrary message to prove control of an account, and check somebody
            else's proof. It belongs in Protect rather than under an account surface because it is
            the only place a member does something to establish who controls what WITHOUT moving
            value; and unlike the vault sections it needs no deployment on any chain, so it is
            never gated by the connected network. */}
        <AccordionSection
          id="custody-verify"
          title="Verify"
          summary="Sign and check account proofs"
          data-testid="custody-acc-verify"
        >
          <VerifySection />
        </AccordionSection>

        {/* Off chain — cold storage with hardware wallets (spec 085). */}
        <AccordionSection
          id="custody-offchain"
          title="Off chain"
          summary={
            hardwareAccounts.length > 0
              ? `${hardwareAccounts.length} hardware ${hardwareAccounts.length === 1 ? 'account' : 'accounts'}`
              : 'Cold storage with a hardware wallet'
          }
          data-testid="custody-acc-offchain"
        >
          <HardwareWalletSection />
        </AccordionSection>
      </AccordionGroup>
    </div>
  )
}

CustodyPanel.propTypes = {
  /** Accordion card to land open (hash-driven deep link from WalletPage / drawer search). */
  openSection: PropTypes.string,
}

export { CUSTODY_SUPPORTED_CHAIN_IDS }
