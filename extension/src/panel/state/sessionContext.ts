import { createContext } from 'react'
import type { Api } from '@/shared/api'
import type { Connection } from '@/shared/connection'

export interface Session {
  api: Api
  connection: Connection & { token: string }
}

export const SessionContext = createContext<Session | null>(null)
