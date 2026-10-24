// Spec 105 — shared (non-component) model helpers for the guided creation flow, split out so the
// component files export only components (react-refresh rule).

import { suggestedThreshold } from '../../../lib/custody/safeVault'
import { CUSTODY_SUPPORTED_CHAIN_IDS } from '../../../config/safeContracts'
import { cohortChainIds } from '../../../config/networks'
import { DEPLOY_STATUS, RULES_STATUS } from '../../../lib/custody/vaultDeployment'

export const PRESETS = [
  {
    id: 'joint',
    title: 'Joint account',
    blurb: '1 of 2 — either of you can move funds. Best for couples or shared bills.',
  },
  {
    id: 'controlled',
    title: 'Controlled',
    blurb: 'Everyone must approve. n of n — nothing moves unless all owners sign.',
  },
  {
    id: 'complex',
    title: 'Complex',
    blurb: 'Custom votes. Pick any m of n threshold yourself.',
  },
]

/** Resolve the preset + member inputs to the vault arrangement. */
export function resolveArrangement({ presetType, owners, chosenThreshold }) {
  const cleaned = owners.map((o) => o.trim()).filter(Boolean)
  if (presetType === 'joint') return { owners: cleaned, threshold: 1 }
  if (presetType === 'controlled') return { owners: cleaned, threshold: cleaned.length }
  const threshold = chosenThreshold != null ? Number(chosenThreshold) : suggestedThreshold(cleaned.length)
  return { owners: cleaned, threshold }
}

/** Custody networks offered at creation: the custody set within the build cohort (spec 071). */
export function creationChainIds() {
  const cohort = new Set(cohortChainIds().map(Number))
  return CUSTODY_SUPPORTED_CHAIN_IDS.filter((id) => cohort.has(Number(id)))
}

const STATUS_LABEL = {
  [DEPLOY_STATUS.QUEUED]: 'Queued',
  [DEPLOY_STATUS.AWAITING_SIGNATURE]: 'Awaiting signature',
  [DEPLOY_STATUS.DEPLOYING]: 'Deploying',
  [DEPLOY_STATUS.CONFIRMING]: 'Confirming',
  [DEPLOY_STATUS.LIVE]: 'Live',
  [DEPLOY_STATUS.ALREADY_LIVE]: 'Already live',
  [DEPLOY_STATUS.FAILED]: 'Failed',
  [DEPLOY_STATUS.UNREADABLE]: 'Could not be read',
}

/** Member-facing status line for one network row, rules sub-state folded in honestly. */
export function statusLabelFor(entry) {
  if (!entry) return 'Not selected'
  const base = STATUS_LABEL[entry.status] || entry.status
  if (entry.status === DEPLOY_STATUS.LIVE || entry.status === DEPLOY_STATUS.ALREADY_LIVE) {
    if (entry.rulesStatus === RULES_STATUS.AWAITING_APPROVAL) return `${base} · rules awaiting approval`
    if (entry.rulesStatus === RULES_STATUS.INSTALL_FAILED) return `${base} · rules not installed`
    if (entry.rulesStatus === RULES_STATUS.INSTALLING) return `${base} · installing rules`
  }
  return base
}
