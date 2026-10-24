import { nativeCapability } from '../../lib/native/runtime'

import './NativeNotice.css'

/**
 * Honest in-place disclosure for a native capability gap (spec 102, FR-002).
 *
 * Renders NOTHING when the capability is available — the surface it sits in
 * simply works. When the runtime seam reports `unavailable`, the seam's own
 * member-renderable reason is shown where the capability would have been:
 * never a silent hide, never a dead control, never a blank box.
 */
export default function NativeCapabilityNotice({ capability, className = '' }) {
  const result = nativeCapability(capability)
  if (result.state === 'available') return null
  return (
    <p className={`native-capability-notice ${className}`.trim()} role="status">
      {result.reason}
    </p>
  )
}
