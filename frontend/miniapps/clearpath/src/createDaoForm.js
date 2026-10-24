import { ethers } from 'ethers'

// Spec 030 pillar A — form-level logic for CreateStandardDao, in its own module so the
// component file exports only components (react-refresh/only-export-components) and a
// test can assert the validation + params mapping without rendering anything.

export const MAX_TIMELOCK_HOURS = 720 // MAX_TIMELOCK_DELAY on the contract, 30 days, expressed in hours

/** Field-level validation (FR-024). Returns a message, or null when the field is fine. */
export function validateCreateForm(form) {
  if (!form.name.trim()) return 'Give the DAO a name.'
  if (form.tokenMode === 'new') {
    if (!form.tokenName.trim()) return 'Give the governance token a name.'
    if (!form.tokenSymbol.trim()) return 'Give the governance token a symbol.'
    if (!/^\d+$/.test(form.initialSupply.trim()) || BigInt(form.initialSupply.trim()) === 0n) {
      return 'The initial supply must be a whole number greater than zero.'
    }
  } else if (!ethers.isAddress(form.votesToken.trim())) {
    return 'Enter the address of an existing votes token (ERC20Votes or a membership NFT).'
  }
  if (!/^\d+$/.test(form.votingPeriod.trim()) || Number(form.votingPeriod) <= 0) {
    return 'The voting period must be at least one block.'
  }
  if (!/^\d+$/.test(form.votingDelay.trim())) return 'The voting delay must be a whole number of blocks.'
  const quorum = Number(form.quorumPercent)
  if (!Number.isInteger(quorum) || quorum < 1 || quorum > 100) return 'Quorum must be between 1% and 100%.'
  const hours = Number(form.timelockHours)
  if (!Number.isFinite(hours) || hours < 0 || hours > MAX_TIMELOCK_HOURS) {
    return `The timelock delay must be between 0 and ${MAX_TIMELOCK_HOURS} hours (30 days).`
  }
  return null
}

/** Form values → the contract's DAOParams. Kept separate so a test can assert the mapping alone. */
export function toParams(form) {
  const newToken = form.tokenMode === 'new'
  return {
    name: form.name.trim(),
    purpose: form.purpose.trim(),
    votesToken: newToken ? ethers.ZeroAddress : form.votesToken.trim(),
    tokenName: newToken ? form.tokenName.trim() : '',
    tokenSymbol: newToken ? form.tokenSymbol.trim() : '',
    // 18 decimals, matching StandardDAOToken. The member types whole tokens; the chain wants base units.
    initialSupply: newToken ? ethers.parseUnits(form.initialSupply.trim(), 18) : 0n,
    votingDelay: Number(form.votingDelay),
    votingPeriod: Number(form.votingPeriod),
    proposalThreshold: ethers.parseUnits(String(form.proposalThreshold || '0').trim(), newToken ? 18 : 0),
    quorumPercent: Number(form.quorumPercent),
    timelockDelay: BigInt(Math.round(Number(form.timelockHours) * 3600)),
  }
}
