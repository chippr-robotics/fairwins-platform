/**
 * claimPayout and the account switcher (spec 088 FR-002).
 *
 * `MyMarketsModal.handleClaimPayout` branched on the vault identity and nothing else, so a member
 * acting as a recovered or hardware account claimed with the CONNECTED wallet. This one is not
 * merely a mis-attributed signature: `WagerRegistry` pays the winner it recorded, so the claim
 * reverted `NotWinner` and the member was told the payout was not theirs — while the switcher was
 * showing the account that had in fact won it.
 *
 * The claim is a SINGLE call, so the assertion is about the seam rather than a batch: it goes to
 * `submitAsActive` as `{ to: registry, data: claimPayout(id) }`, and neither the relayed intent nor
 * the passkey UserOp — the two connected-wallet rails — is touched.
 *
 * The modal is heavy, so its children and data hooks are stubbed down to the one thing under test:
 * a claim control that hands a market to the handler. What is NOT stubbed is the handler itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const CONNECTED = '0x1111111111111111111111111111111111111111'
const ACTING = '0x2222222222222222222222222222222222222222'
const CREATOR = '0x3333333333333333333333333333333333333333'
const REGISTRY = '0x4444444444444444444444444444444444444444'

// ---- the acting identity, driven per test -------------------------------------------
let activeAccount
const submitAsActive = vi.fn(async () => ({ kind: 'sent', txHash: '0xACTING' }))
const personal = () => ({
  identity: { mode: 'personal' },
  isVault: false, isLegacy: false, isHardware: false,
  canActAsVault: false, canActAsLegacy: false, canActAsHardware: false,
  submit: submitAsActive,
})
const actingAs = (mode) => ({
  identity: { mode, address: ACTING, label: 'Acting account' },
  isVault: false,
  isLegacy: mode === 'legacy',
  isHardware: mode === 'hardware',
  canActAsVault: false, canActAsLegacy: mode === 'legacy', canActAsHardware: mode === 'hardware',
  submit: submitAsActive,
})
vi.mock('../../hooks/useActiveAccount', () => ({
  useActiveAccount: () => activeAccount,
  default: () => activeAccount,
}))

// ---- the connected wallet's rails, each a spy the tests assert was never used --------
const sendCalls = vi.fn(async () => ({ txHash: '0xUSEROP' }))
const gaslessRun = vi.fn(async () => ({ txHash: '0xRELAYED' }))
vi.mock('../../lib/relay/useGaslessWrite', () => ({
  useGaslessWrite: () => ({ run: (...a) => gaslessRun(...a), status: 'idle' }),
}))

vi.mock('../../hooks', () => ({
  useWallet: () => ({ isConnected: true, account: CONNECTED, address: CONNECTED, chainId: 137 }),
  useWeb3: () => ({
    signer: { id: 'connected-signer' },
    isCorrectNetwork: true,
    switchNetwork: vi.fn(),
    sendCalls,
    loginMethod: 'injected',
    chainId: 137,
  }),
}))

/*
 * `useWagerChain` (spec 110 T040) imports `useWeb3` from its own module, not from the barrel the
 * modal uses — so the barrel mock above does not cover it. A fake has to cover what the code
 * under test actually imports, and the two paths are different modules.
 */
vi.mock('../../hooks/useWeb3', () => ({
  useWeb3: () => ({
    signer: { id: 'connected-signer' },
    provider: null,
    switchNetwork: vi.fn(),
    sendCalls,
    loginMethod: 'injected',
    chainId: 137,
  }),
}))

// ---- data hooks the modal mounts, reduced to the empty/no-op shapes ------------------
const refreshFriendMarkets = vi.fn()
vi.mock('../../contexts/FriendMarketsContext.js', () => ({
  useFriendMarkets: () => ({
    dismissedIds: new Set(),
    dismissMarket: vi.fn(),
    dismissMarkets: vi.fn(),
    refresh: refreshFriendMarkets,
  }),
}))
vi.mock('../../hooks/useIpfs', () => ({ useLazyIpfsEnvelope: (m) => ({ markets: m, fetchEnvelope: vi.fn() }) }))
vi.mock('../../hooks/useEncryption', () => ({
  useLazyMarketDecryption: (m) => ({
    markets: m,
    decryptMarket: vi.fn(),
    setDecryptedMetadata: vi.fn(),
    isMarketDecrypting: () => false,
  }),
  useEncryption: () => ({ canUserDecrypt: () => false, isInitialized: false, isInitializing: false, initializeKeys: vi.fn(), decryptMetadata: vi.fn() }),
}))
vi.mock('../../hooks/useWagerActivity', () => ({ useWagerActivityOptional: () => ({ markWagerRead: vi.fn() }) }))
vi.mock('../../hooks/useOpenChallengeCodeVault', () => ({
  useOpenChallengeCodeVault: () => ({ canUse: false, hasBackup: false, recoverCodes: vi.fn(), saveCode: vi.fn() }),
}))
vi.mock('../../hooks/useOpponentName', () => ({ useOpponentName: () => ({ displayName: null }) }))
vi.mock('../../data/notifications/drawProposalScan', () => ({ fetchDrawProposals: async () => [] }))
vi.mock('../../config/contracts', () => ({
  getContractAddress: () => REGISTRY,
  getContractAddressForChain: () => REGISTRY,
}))
vi.mock('../../utils/feeOverrides', () => ({ getFeeOverrides: async () => ({}) }))

// ---- children, stubbed to the one control under test --------------------------------
vi.mock('../../components/fairwins/WagerTable', () => ({
  default: ({ markets = [], onClaim }) => (
    <div>
      {markets.map((m) => (
        <button key={m.id} onClick={() => onClaim?.(m)}>{`claim-${m.id}`}</button>
      ))}
    </div>
  ),
}))
vi.mock('../../components/fairwins/MyPoolsSection', () => ({ default: () => null }))
vi.mock('../../components/fairwins/MarketAcceptanceModal', () => ({ default: () => null }))
vi.mock('../../components/fairwins/OpenChallengeDecryptModal', () => ({ default: () => null }))
vi.mock('../../components/fairwins/ResolveButtonWithCountdown', () => ({ default: () => null }))
vi.mock('../../components/fairwins/OpponentName', () => ({ default: () => null }))

import MyMarketsModal from '../../components/fairwins/MyMarketsModal'

// A wager the connected member is a participant (not creator) in, still active, on the active
// chain — which is what puts it in the default "participating" list the stub renders.
const market = {
  id: 'w-1',
  wagerId: '7',
  chainId: 137,
  creator: CREATOR,
  opponent: CONNECTED,
  participants: [CREATOR, CONNECTED],
  status: 'active',
  endDate: new Date(Date.now() + 86_400_000).toISOString(),
  acceptanceDeadline: Date.now() + 43_200_000,
  stakeTokenSymbol: 'USDC',
  description: 'A wager with a payout to claim',
}

const claim = async () => {
  const user = userEvent.setup()
  render(<MyMarketsModal isOpen onClose={vi.fn()} friendMarkets={[market]} />)
  await user.click(await screen.findByRole('button', { name: 'claim-w-1' }))
}

beforeEach(() => {
  activeAccount = personal()
  submitAsActive.mockClear()
  sendCalls.mockClear()
  gaslessRun.mockClear()
})

describe('claimPayout while acting as a recovered / hardware account (spec 088 FR-002)', () => {
  it.each(['legacy', 'hardware'])('claims through the acting seam, addressed to the registry (%s)', async (mode) => {
    activeAccount = actingAs(mode)
    await claim()

    await waitFor(() => expect(submitAsActive).toHaveBeenCalledTimes(1))
    const [payload] = submitAsActive.mock.calls[0]
    expect(payload.to).toBe(REGISTRY)
    expect(payload.batch).toBeUndefined() // a claim is one call, not a batch
    expect(payload.data).toMatch(/^0x/)
  })

  it.each(['legacy', 'hardware'])('never claims on the connected wallet’s rails (%s)', async (mode) => {
    activeAccount = actingAs(mode)
    await claim()

    await waitFor(() => expect(submitAsActive).toHaveBeenCalled())
    expect(gaslessRun).not.toHaveBeenCalled()
    expect(sendCalls).not.toHaveBeenCalled()
  })

  it('leaves the personal member on the gasless rail, unchanged', async () => {
    activeAccount = personal()
    await claim()

    await waitFor(() => expect(gaslessRun).toHaveBeenCalledTimes(1))
    expect(submitAsActive).not.toHaveBeenCalled()
  })
})
