// Spec 102 (T005, D6, FR-014) — a vault-mode submit whose wallet is on another chain SWITCHES FIRST
// and creates the proposal with the SETTLED signer, never the one captured at tap time. A refused
// switch is a stated error naming both chains and nothing is signed. On the vault's own chain the
// path is byte-for-byte the spec-043 one.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'

const POLYGON_SIGNER = { id: 'signer-137' }
const BASE_SIGNER = { id: 'signer-8453' }
const POLYGON_PROVIDER = { id: 'provider-137' }
const BASE_PROVIDER = { id: 'provider-8453' }

let wallet = { chainId: 137, signer: POLYGON_SIGNER, provider: POLYGON_PROVIDER, loginMethod: 'eoa' }
const switchNetwork = vi.fn()
vi.mock('../../hooks', () => ({ useWallet: () => ({ address: '0xowner' }) }))
vi.mock('../../hooks/useWalletManagement', () => ({
  useWallet: () => ({ ...wallet, switchNetwork }),
}))

const submitSpy = vi.fn(async () => ({ kind: 'proposed', safeTxHash: '0xhash' }))
vi.mock('../../lib/custody/submitAsActiveAccount', () => ({
  submitAsActiveAccount: (...args) => submitSpy(...args),
}))
vi.mock('../../config/contracts', () => ({ getContractAddressForChain: (name, id) => `${name}@${id}` }))
vi.mock('../../config/safeContracts', () => ({ getSafeContracts: (id) => ({ chainId: id }) }))

import { CustodyContext } from '../../contexts/CustodyContext'
import { useActiveAccount } from '../../hooks/useActiveAccount'

function Probe() {
  const { submit, canActAsVault, actingVaultChainName } = useActiveAccount()
  return (
    <div>
      <span data-testid="can">{canActAsVault ? 'yes' : 'no'}</span>
      <span data-testid="chain-name">{actingVaultChainName || ''}</span>
      <button
        onClick={() =>
          submit({ to: '0xdead', value: 1n })
            .then(() => { document.title = 'SENT' })
            .catch((e) => { document.title = e.message })
        }
      >
        submit
      </button>
    </div>
  )
}

const active = { mode: 'vault', vaultAddress: '0xVault', chainIds: [8453], chainId: 8453, label: 'Treasury' }

function renderAs(identity) {
  // A FRESH element each time: re-rendering the same element object is a React bail-out, and the
  // point of the re-render is to let the mocked wallet snapshot reach the hook.
  const tree = () => (
    <CustodyContext.Provider value={{ active: identity, legacySigner: null, hardwareSigner: null }}>
      <Probe />
    </CustodyContext.Provider>
  )
  const r = render(tree())
  return { ...r, rerenderSame: () => r.rerender(tree()) }
}

beforeEach(() => {
  submitSpy.mockClear()
  switchNetwork.mockReset()
  document.title = ''
  wallet = { chainId: 137, signer: POLYGON_SIGNER, provider: POLYGON_PROVIDER, loginMethod: 'eoa' }
})

describe('useActiveAccount — vault submit switches the wallet first (spec 102)', () => {
  it('switches to the vault chain, waits for the wallet to settle, then proposes with the SETTLED signer', async () => {
    const { rerenderSame } = renderAs(active)
    expect(screen.getByTestId('can')).toHaveTextContent('yes') // a switch is possible
    expect(screen.getByTestId('chain-name')).toHaveTextContent('Base')

    switchNetwork.mockImplementation(async (target) => {
      expect(target).toBe(8453)
      // The wallet agrees; the app's snapshot lands on the new chain a moment later.
      wallet = { chainId: 8453, signer: BASE_SIGNER, provider: BASE_PROVIDER, loginMethod: 'eoa' }
      return true
    })
    fireEvent.click(screen.getByText('submit'))
    await waitFor(() => expect(switchNetwork).toHaveBeenCalledWith(8453))
    // Nothing is signed until the snapshot has settled on Base.
    expect(submitSpy).not.toHaveBeenCalled()
    await act(async () => rerenderSame())

    await waitFor(() => expect(submitSpy).toHaveBeenCalled())
    const [, ctx] = submitSpy.mock.calls[0]
    expect(ctx).toMatchObject({ mode: 'vault', vaultAddress: '0xVault', chainId: 8453, hubAddress: 'safeProposalHub@8453' })
    expect(ctx.signer).toBe(BASE_SIGNER) // the rebuilt, chain-scoped signer
    expect(ctx.provider).toBe(BASE_PROVIDER)
    expect(ctx.signer).not.toBe(POLYGON_SIGNER)
    await waitFor(() => expect(document.title).toBe('SENT'))
  })

  it('a refused switch is a stated error naming both chains, and nothing is signed', async () => {
    renderAs(active)
    switchNetwork.mockRejectedValue(new Error('User rejected the request'))
    fireEvent.click(screen.getByText('submit'))

    await waitFor(() => expect(document.title).not.toBe(''))
    expect(document.title).toBe('This proposal goes to Base, but the wallet stayed on Polygon, so nothing has been signed.')
    expect(submitSpy).not.toHaveBeenCalled()
  })

  it('on the vault chain already: no switch, the current signer/provider, unchanged spec-043 path', async () => {
    wallet = { chainId: 8453, signer: BASE_SIGNER, provider: BASE_PROVIDER, loginMethod: 'eoa' }
    renderAs(active)
    expect(screen.getByTestId('can')).toHaveTextContent('yes')
    fireEvent.click(screen.getByText('submit'))
    await waitFor(() => expect(submitSpy).toHaveBeenCalled())
    expect(switchNetwork).not.toHaveBeenCalled()
    expect(submitSpy.mock.calls[0][1]).toMatchObject({ mode: 'vault', chainId: 8453, signer: BASE_SIGNER, provider: BASE_PROVIDER })
  })

  it('names an unknown chain honestly rather than as the default network', async () => {
    renderAs({ ...active, chainIds: [424242], chainId: 424242 })
    expect(screen.getByTestId('chain-name')).toHaveTextContent('Chain 424242')
    switchNetwork.mockRejectedValue(new Error('nope'))
    fireEvent.click(screen.getByText('submit'))
    await waitFor(() => expect(document.title).toMatch(/goes to Chain 424242, but the wallet stayed on Polygon/))
    expect(submitSpy).not.toHaveBeenCalled()
  })

  it('keeps the spec-088 no-fall-through: an unhandled acting kind is still refused, never switched or sent', async () => {
    renderAs({ mode: 'derived', address: '0xDerived', chainId: 8453 })
    expect(screen.getByTestId('can')).toHaveTextContent('no')
    fireEvent.click(screen.getByText('submit'))
    await waitFor(() => expect(document.title).toMatch(/nothing has been signed/i))
    expect(switchNetwork).not.toHaveBeenCalled()
    expect(submitSpy).not.toHaveBeenCalled()
  })
})
