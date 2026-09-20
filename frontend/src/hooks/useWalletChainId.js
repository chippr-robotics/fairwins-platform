import { useAccount } from 'wagmi'
import { getCurrentChainId } from '../config/networks'

/**
 * The chain the WALLET is actually on — the one answer to "where is the wallet?" (spec 110
 * Phase 3, issue #1594).
 *
 * ── WHY wagmi's `useChainId()` IS BANNED (issue #1030) ─────────────────────────────────────────
 * It reads `config.state.chainId`, and wagmi only ever writes a CONFIGURED chain there.
 * `createConfig`'s sync subscription is explicit about it:
 *
 *     // If chain is not configured, then don't switch over to it.
 *     if (!isChainConfigured) return
 *
 * So with the member's wallet on a chain absent from `chains` (src/wagmi.js), it keeps reporting
 * the PREVIOUS configured chain — measured with the wallet on BNB (0x38): the app displayed
 * "Polygon", raised no warning, and pointed every read at Polygon.
 *
 * The connection's own chainId is not filtered that way: `getConnection()` returns
 * `connections.get(current).chainId`, which the connector's `chainChanged` handler writes
 * verbatim. `useAccount()` is an alias of `useConnection()` in wagmi 3 and tracks the keys you
 * read, so destructuring `chainId` subscribes to it and re-renders on a real chain change.
 *
 * ── THE FALLBACK IS THE BUILD'S, NOT wagmi's, AND THAT IS A FIX ────────────────────────────────
 * This hook used to fall back to `useChainId()` when there was no connection. That looked
 * equivalent and is not: wagmi's default is `chains[0]`, which is **Polygon** — first in the list
 * so it is the default for a mainnet build — while `getCurrentChainId()` is the build's own
 * answer (`VITE_NETWORK_ID`, else `PRIMARY_CHAIN_ID`). In a TESTNET build those disagree, and
 * wagmi's is a MAINNET chain: a disconnected member on a testnet build was answered "Polygon",
 * which is the cohort-crossing read constitution III forbids.
 *
 * It also explains something that looked deliberate and never worked. Nine call sites wrote
 * `useChainId() || getCurrentChainId()` — an explicit fallback to the build's chain that could
 * NEVER fire, because `useChainId()` always returns something. They were asking for exactly what
 * this hook now does, and silently getting Polygon instead.
 *
 * `undefined` is deliberately NOT returned when disconnected: ~14 call sites read this to pick a
 * chain to READ from, and a chain-less read is not more honest than the build's own default — it
 * is a blank surface. Where the distinction matters (is a WALLET actually there?), callers ask
 * `useAccount().isConnected`, which is a different question with its own honest answer.
 */
export function useWalletChainId() {
  const { chainId } = useAccount()
  return chainId ?? getCurrentChainId()
}

export default useWalletChainId
