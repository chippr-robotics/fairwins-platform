/**
 * `WalletContext.sendCalls` — the app's unified write abstraction — and the chain it lands on
 * (spec 110 T028).
 *
 * The `chainId` option pins a passkey batch to a named chain. On the CLASSIC rail it used to be
 * ignored, with the module comment stating that as intended: "Classic wallets ignore it: an
 * injected signer is bound to whatever chain the wallet is on." The consequence is not that the
 * option does nothing — it is that a caller naming a chain gets its batch broadcast on a DIFFERENT
 * one, with no prompt and no error. That is the same defect T026 closed in
 * `submitAsActiveAccount`'s personal branch, still live in the function every money-moving surface
 * routes through.
 *
 * Nothing passes `chainId` on the classic path today (both callers that pass it are on the passkey
 * rail), so this is a no-op now and a stated refusal later. These tests pin all three cases,
 * including the one that must NOT change: no `chainId` still sends, exactly as before.
 *
 * The guard fires before any RPC, so the signer only has to exist — the transport stub below is
 * never called.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'

const POLYGON = 137
const BASE = 8453
const ACCOUNT = '0x1234567890123456789012345678901234567890'

const h = vi.hoisted(() => ({ walletChainId: 137 }))

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: ACCOUNT, isConnected: true, connector: { id: 'injected' }, status: 'connected' }),
  useConnect: () => ({ connect: vi.fn(), connectAsync: vi.fn(), connectors: [{ id: 'injected' }] }),
  useDisconnect: () => ({ disconnect: vi.fn(), disconnectAsync: vi.fn() }),
  useSwitchChain: () => ({ switchChain: vi.fn(), switchChainAsync: vi.fn() }),
  useWalletClient: () => ({
    data: {
      account: { address: ACCOUNT },
      chain: { id: h.walletChainId, name: 'Polygon' },
      // EIP-1193-shaped, and deliberately inert: a refusal must happen before any RPC.
      transport: { request: vi.fn(async () => { throw new Error('the transport must not be reached') }) },
    },
  }),
}))
vi.mock('../../hooks/useWalletChainId', () => ({ useWalletChainId: () => h.walletChainId }))
vi.mock('../../utils/blockchainService', () => ({ hasRoleOnChain: vi.fn(async () => false) }))
vi.mock('../../components/wallet/ConnectModal', () => ({ default: () => null }))

import { WalletProvider } from '../../contexts/WalletContext.jsx'
import { useWallet } from '../../hooks/useWalletManagement'

/** Hand the live context out to the test without rendering any product surface. */
function Probe({ onReady }) {
  const wallet = useWallet()
  if (wallet?.sendCalls && wallet?.signer) onReady(wallet)
  return null
}

async function connectedWallet() {
  let captured = null
  render(
    <WalletProvider>
      <Probe onReady={(w) => { captured = w }} />
    </WalletProvider>,
  )
  await waitFor(() => expect(captured?.signer).toBeTruthy())
  return captured
}

const CALLS = [{ target: '0x' + 'aa'.repeat(20), data: '0x01', value: 0n }]

beforeEach(() => {
  h.walletChainId = POLYGON
})

describe('sendCalls — a classic wallet cannot be pinned to another chain, so it refuses', () => {
  it('REFUSES a batch named for a chain the wallet is not on, naming both chains', async () => {
    const wallet = await connectedWallet()
    const err = await wallet.sendCalls(CALLS, { chainId: BASE }).catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/Base/)
    expect(err.message).toMatch(/Polygon/)
    expect(err.message).toMatch(/nothing has been sent/i)
    // Both chains are on the error itself, so a surface can render its own sentence.
    expect(err).toMatchObject({ from: POLYGON, to: BASE })
  })

  it('sends nothing on that refusal — the transport is never reached', async () => {
    const wallet = await connectedWallet()
    const send = vi.spyOn(wallet.signer, 'sendTransaction')
    await wallet.sendCalls(CALLS, { chainId: BASE }).catch(() => {})
    expect(send).not.toHaveBeenCalled()
  })

  it('does NOT refuse when the named chain is the one the wallet is on', async () => {
    const wallet = await connectedWallet()
    const send = vi
      .spyOn(wallet.signer, 'sendTransaction')
      .mockResolvedValue({ hash: '0xsent', wait: async () => ({ hash: '0xsent' }) })
    const out = await wallet.sendCalls(CALLS, { chainId: POLYGON })
    expect(send).toHaveBeenCalledTimes(1)
    expect(out.txHash).toBe('0xsent')
  })

  it('is byte-compatible for every caller that names no chain at all', async () => {
    // The overwhelming majority. Passing no chainId must behave exactly as it did before.
    const wallet = await connectedWallet()
    const send = vi
      .spyOn(wallet.signer, 'sendTransaction')
      .mockResolvedValue({ hash: '0xsent', wait: async () => ({ hash: '0xsent' }) })
    const out = await wallet.sendCalls(CALLS)
    expect(send).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ route: 'direct', txHash: '0xsent' })
  })
})
