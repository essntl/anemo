/**
 * The saved connection and the API client built from it.
 *
 * A 401 from any request means the token is gone (revoked in Anemo, or mistyped): the
 * token is forgotten, the address kept, and the panel shows the setup screen with the
 * reason. The worker sees the same storage change and closes its event stream.
 */
import { useMemo } from 'react'
import { createApi, type Api } from '@/shared/api'
import type { Connection } from '@/shared/connection'
import { markTokenLost } from '@/shared/connectionStore'
import { storage } from '@/shared/storage'
import { useStored } from './useStored'

export { markTokenLost }

export async function saveConnection(serverUrl: string, token: string, username: string): Promise<void> {
  const connection: Connection = { serverUrl, token, username, lostReason: null, connectedAt: new Date().toISOString() }
  await storage.set('local', 'connection', connection)
}

/** Forget the token (and stop using the server); the address stays for the setup screen. */
export async function forgetToken(): Promise<void> {
  const current = await storage.get('local', 'connection')
  if (current) await storage.set('local', 'connection', { ...current, token: null, lostReason: null })
}

export function apiFor(connection: Connection): Api {
  return createApi({ serverUrl: connection.serverUrl, token: connection.token, onUnauthorized: () => void markTokenLost() })
}

export function useConnection(): { connection: Connection | null | undefined; loaded: boolean; api: Api | null } {
  const { value, loaded } = useStored('local', 'connection')
  const connection = value ?? null
  const api = useMemo(() => (connection?.token ? apiFor(connection) : null), [connection])
  return { connection: loaded ? connection : undefined, loaded, api }
}
