// Spec 049 (US2, FR-006) — vault-list badge: 'managed' renders the shield badge + summary,
// 'foreign' renders the unrecognized-policy marker, 'none'/'unsupported' render nothing.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { axe } from 'vitest-axe'
import PolicyBadge from '../../components/custody/PolicyBadge'
import VaultCardList from '../../components/custody/VaultCardList'

// Spec 102 — the card's pending badge is a cross-chain read; this suite is about the POLICY badge.
vi.mock('../../hooks/useVaultQueueAcrossChains', () => ({
  useVaultQueueAcrossChains: () => ({ pending: 0, missing: [], loading: false }),
}))

vi.mock('../../components/ui/BlockiesAvatar', () => ({
  default: () => <div data-testid="blockies" />,
}))

const A = '0x1111111111111111111111111111111111111111'

describe('PolicyBadge', () => {
  it('renders the policy summary for a managed vault', () => {
    render(<PolicyBadge status="managed" summary="limits on 1 asset · 2-address allowlist" />)
    expect(screen.getByText(/limits on 1 asset · 2-address allowlist/i)).toBeInTheDocument()
    expect(screen.getByText(/policy-governed vault/i)).toBeInTheDocument()
  })

  it('falls back to a generic label when a managed vault has no summary', () => {
    render(<PolicyBadge status="managed" summary="" />)
    expect(screen.getByText(/policy active/i)).toBeInTheDocument()
  })

  it('marks a foreign guard as an unrecognized policy', () => {
    render(<PolicyBadge status="foreign" />)
    expect(screen.getByText(/unrecognized policy/i)).toBeInTheDocument()
  })

  it('renders nothing for none, unsupported, and unknown statuses', () => {
    for (const status of ['none', 'unsupported', undefined]) {
      const { container, unmount } = render(<PolicyBadge status={status} summary="ignored" />)
      expect(container).toBeEmptyDOMElement()
      unmount()
    }
  })

  // Spec 102 — the list is one compact card per vault (VaultCardList); the badge rides the card's
  // meta line, fed from the group's first readable instance carrying policy data.
  it('appears on a vault card when the group carries policy data', () => {
    const groups = [
      {
        key: A,
        address: A,
        label: 'Treasury',
        instances: [],
        chainIds: [1337],
        readable: [{ chainId: 1337 }],
        unreachable: [],
        unreadable: [],
        networkLine: 'Chain 1337',
        threshold: { value: 1, of: 1 },
        thresholdVaries: false,
        owners: [A],
        policyStatus: 'managed',
        policySummary: '1-hour delay',
      },
    ]
    render(<VaultCardList groups={groups} actingAddress={null} onOpen={vi.fn()} />)
    expect(screen.getByText(/1-hour delay/i)).toBeInTheDocument()
  })

  it('has no axe violations in all rendering states', async () => {
    const { container } = render(
      <ul>
        <li>
          <PolicyBadge status="managed" summary="limits on 2 assets" />
        </li>
        <li>
          <PolicyBadge status="foreign" />
        </li>
      </ul>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
