import { useContext } from 'react'
import { SessionContext, type Session } from './sessionContext'

export function useSession(): Session {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession outside SessionProvider')
  return session
}
