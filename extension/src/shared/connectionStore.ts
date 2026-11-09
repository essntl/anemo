/** Changes to the saved connection that both the panel and the worker make. */
import { storage } from './storage'

/** The token stopped working (a 401, or the event stream closed with 4401): forget it,
 *  keep the address, and say why on the setup screen. */
export async function markTokenLost(): Promise<void> {
  const current = await storage.get('local', 'connection')
  if (!current?.token) return
  await storage.set('local', 'connection', { ...current, token: null, lostReason: 'revoked' })
}
