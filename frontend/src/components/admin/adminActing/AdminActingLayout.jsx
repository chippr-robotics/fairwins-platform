/**
 * The /admin layout route: ONE acting-identity provider shared by the Control Room and every admin
 * app (so the Safe queue and role sweep are not re-read on each navigation), with the acting bar
 * above whatever the route renders — including the access gate's refusal screens.
 */
import { Outlet } from 'react-router-dom'
import { useWeb3 } from '../../../hooks/useWeb3'
import AdminActingProvider from './AdminActingProvider'
import AdminActingBar from './AdminActingBar'
import { useAdminActing } from './useAdminWeb3'

function BarSlot() {
  const { account } = useWeb3()
  const acting = useAdminActing()
  // Nothing to choose until someone is signed in: saved devices live under the member's account.
  if (!account || !acting) return null
  return <AdminActingBar acting={acting} />
}

export default function AdminActingLayout() {
  return (
    <AdminActingProvider>
      <BarSlot />
      <Outlet />
    </AdminActingProvider>
  )
}
