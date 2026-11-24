import { createContext } from 'react'

/**
 * The console's acting identity (see AdminActingProvider). `null` when no provider is mounted —
 * every consumer then behaves exactly as it did before acting-as existed, which is what keeps
 * isolated component tests and any surface outside /admin unchanged.
 */
export const AdminActingContext = createContext(null)
