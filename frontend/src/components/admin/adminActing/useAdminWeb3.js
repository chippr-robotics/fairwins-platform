/**
 * `useWeb3()` as the operations console must see it: `account` is the account the console is
 * ACTING as (the admin Safe, or the owner key itself) and `signer` is what writes go through
 * (a Safe-proposing signer, a hardware signer, or the wallet's own). Everything else — `provider`,
 * `chainId`, `switchNetwork` — is the wallet's, unchanged, because writes still land on the
 * wallet's chain.
 *
 * Admin apps destructure `{ account, signer, provider, chainId }` from this exactly as they did
 * from `useWeb3()`, which is why acting-as needed no change to any individual write site. Outside
 * the console's provider it IS `useWeb3()`.
 */
import { useContext, useMemo } from 'react'
import { useWeb3 } from '../../../hooks/useWeb3'
import { AdminActingContext } from './AdminActingContext'

export function useAdminWeb3() {
  const web3 = useWeb3()
  const acting = useContext(AdminActingContext)
  return useMemo(() => {
    if (!acting) return web3
    return {
      ...web3,
      account: acting.actingAccount ?? web3.account,
      signer: acting.actingSigner ?? null,
      adminActing: acting,
    }
  }, [web3, acting])
}

export function useAdminActing() {
  return useContext(AdminActingContext)
}

export default useAdminWeb3
