/**
 * Device-local record of the funding pools an account organized or contributed to (spec 103, FR-023).
 * Addresses + role only — the summaries are always re-read from chain. Same pattern as
 * `recordJoinedPool` (spec 037): a pool the member touched on this device is always findable even where
 * no indexer exists for the network.
 */
const key = (account) => `fairwins_funding_pools_v1_${String(account || '').toLowerCase()}`

/** @returns {{ address: string, role: 'organizer'|'contributor' }[]} */
export function readFundingPools(account) {
  if (!account) return []
  try {
    const raw = localStorage.getItem(key(account))
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((e) => e && typeof e.address === 'string') : []
  } catch {
    return []
  }
}

/** Record (idempotently) a pool for this account. A contributor who is also the organizer keeps 'organizer'. */
export function recordFundingPool(account, address, role = 'contributor') {
  if (!account || !address) return
  try {
    const cur = readFundingPools(account)
    const addr = String(address).toLowerCase()
    const existing = cur.find((e) => e.address === addr)
    if (existing) {
      if (role === 'organizer' && existing.role !== 'organizer') {
        existing.role = 'organizer'
        localStorage.setItem(key(account), JSON.stringify(cur))
      }
      return
    }
    localStorage.setItem(key(account), JSON.stringify([...cur, { address: addr, role }]))
  } catch {
    /* private browsing / quota — degrade to session-only */
  }
}

export function forgetFundingPool(account, address) {
  if (!account || !address) return
  try {
    const addr = String(address).toLowerCase()
    localStorage.setItem(key(account), JSON.stringify(readFundingPools(account).filter((e) => e.address !== addr)))
  } catch {
    /* ignore */
  }
}
