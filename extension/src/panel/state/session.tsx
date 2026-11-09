import type { ReactNode } from 'react'
import { SessionContext, type Session } from './sessionContext'

/** The connected server and its API client, for everything below the setup screen. */
export function SessionProvider({ value, children }: { value: Session; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}
