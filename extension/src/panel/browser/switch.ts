import { storage } from '@/shared/storage'

/** Browser control on (for now: 10 minutes without a command switch it off) or off. */
export async function setBrowserControl(on: boolean): Promise<void> {
  const now = Date.now()
  await storage.set('session', 'browserActive', on ? { on: true, since: now, lastCommandAt: now } : null)
}
