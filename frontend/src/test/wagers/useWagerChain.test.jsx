/**
 * `useWagerChain` — the action goes to the WAGER's chain (spec 110 Phase 4, T040 — issue #1595,
 * acceptance scenarios 1 and 2).
 *
 * The harness re-renders when the mock wallet changes chain, because that is what the real app
 * does and what the settle loop is written against: `settleWalletOn` polls a ref that an effect
 * refreshes on every render, precisely so it reads the POST-switch signer rather than the one
 * captured when the button was pressed. A harness that never re-rendered would hang on the real
 * loop and prove nothing about it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useState } from 'react'

let web3 = {}
let forceRender = () => {}
vi.mock('../../hooks/useWeb3', () => ({ useWeb3: () => web3 }))

import { useWagerChain } from '../../hooks/useWagerChain'

const AMOY = 80002
const MORDOR = 63

/** A wallet whose chain follows whatever `switchNetwork` was last asked for. */
function wallet({ chainId = AMOY, loginMethod = 'injected', reject = false } = {}) {
  const state = { chainId, signer: { id: 'signer' }, provider: null, loginMethod }
  state.switchNetwork = vi.fn(async (target) => {
    if (reject) throw new Error('user rejected')
    web3 = { ...state, chainId: Number(target) }
    // No nested `act` here: this runs INSIDE the caller's async act, and nesting them deadlocks
    // the settle loop that is the subject of the test.
    forceRender()
    return true
  })
  return state
}

function renderWagerChain() {
  return renderHook(() => {
    const [, tick] = useState(0)
    forceRender = () => tick((n) => n + 1)
    return useWagerChain()
  })
}

beforeEach(() => {
  web3 = wallet()
  forceRender = () => {}
})

describe('chainOf', () => {
  it('is the wager’s chain, and the wallet’s only for an untagged legacy entry', () => {
    const { result } = renderWagerChain()
    expect(result.current.chainOf({ chainId: MORDOR })).toBe(MORDOR)
    expect(result.current.chainOf({})).toBe(AMOY)
  })
})

describe('settleOnWagerChain', () => {
  it('does not move a wallet already on the wager’s chain', async () => {
    const w = wallet({ chainId: MORDOR })
    web3 = w
    const { result } = renderWagerChain()
    await expect(result.current.settleOnWagerChain({ chainId: MORDOR })).resolves.toBe(MORDOR)
    expect(w.switchNetwork).not.toHaveBeenCalled()
  })

  /*
   * THE DEFECT THIS REPLACES. The old guard called `switchNetwork()` with NO argument, and its
   * default is PRIMARY_CHAIN_ID — so every cross-chain action moved the member to Polygon,
   * whatever chain the wager was actually on. The target has to be passed, and this says so.
   */
  it('asks for the WAGER’s chain by id, and settles there', async () => {
    const w = wallet({ chainId: AMOY })
    web3 = w
    const { result } = renderWagerChain()

    /*
     * Deliberately NOT wrapped in `act`: the settle loop waits for a re-render, and `act` waits
     * for the settle — wrapping it deadlocks the very thing under test. The re-render arrives
     * through `forceRender` from inside the mock's `switchNetwork`, which is what a connector's
     * `chainChanged` does in the real app.
     */
    await expect(result.current.settleOnWagerChain({ chainId: MORDOR })).resolves.toBe(MORDOR)
    expect(w.switchNetwork).toHaveBeenCalledWith(MORDOR)
  })

  it('a refusal names BOTH chains and reports that nothing was signed', async () => {
    web3 = wallet({ chainId: AMOY, reject: true })
    const { result } = renderWagerChain()

    const raised = await result.current
      .settleOnWagerChain({ chainId: MORDOR }, 'This claim')
      .then(() => null, (e) => e)

    expect(raised, 'a refused switch must reject, never resolve').not.toBeNull()
    expect(raised.message).toContain('Ethereum Classic Mordor')
    expect(raised.message).toContain('Polygon Amoy')
    expect(raised.message).toContain('nothing has been signed')
    // The noun is the caller's, so a claim does not announce itself as "This transaction".
    expect(raised.message).toMatch(/^This claim/)
  })

  /*
   * A passkey UserOp addresses the TARGET chain's bundler directly (`submitOn`'s rail rules), so
   * moving the member's wallet would be a prompt they never had to be asked for.
   */
  it('never switches a passkey session — it just names the target', async () => {
    const w = wallet({ chainId: AMOY, loginMethod: 'passkey' })
    web3 = w
    const { result } = renderWagerChain()
    await expect(result.current.settleOnWagerChain({ chainId: MORDOR })).resolves.toBe(MORDOR)
    expect(w.switchNetwork).not.toHaveBeenCalled()
  })
})
