import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

import { tenantBrand } from '../../config/tenant'
import { subscribeDeepLinks } from '../../lib/native/deepLinks'

/**
 * Mounts the spec-102 deep-link seam inside the router. Renders nothing; on
 * web the subscription is inert. The destination survives the sign-in/lock
 * gate because the overlay covers rather than redirects (see
 * lib/native/deepLinks.js).
 */
export default function NativeDeepLinks() {
  const navigate = useNavigate()

  useEffect(
    () => subscribeDeepLinks((path) => navigate(path), { appOrigin: tenantBrand().appUrl }),
    [navigate]
  )

  return null
}
