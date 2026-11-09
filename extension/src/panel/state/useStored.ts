import { useEffect, useState } from 'react'
import { storage, type LocalData, type SessionData } from '@/shared/storage'

/**
 * A value in chrome.storage, kept current when it changes anywhere (another panel, the
 * worker). `loaded` is false until the first read finished.
 */
export function useStored<K extends keyof LocalData>(area: 'local', key: K): { value: LocalData[K] | undefined; loaded: boolean }
export function useStored<K extends keyof SessionData>(area: 'session', key: K): { value: SessionData[K] | undefined; loaded: boolean }
export function useStored(area: 'local' | 'session', key: string): { value: unknown; loaded: boolean } {
  const [state, setState] = useState<{ value: unknown; loaded: boolean }>({ value: undefined, loaded: false })
  useEffect(() => {
    let alive = true
    const read = area === 'local' ? storage.get('local', key as keyof LocalData) : storage.get('session', key as keyof SessionData)
    void read.then((value) => alive && setState({ value, loaded: true }))
    const stop = area === 'local'
      ? storage.watch('local', key as keyof LocalData, (value) => setState({ value, loaded: true }))
      : storage.watch('session', key as keyof SessionData, (value) => setState({ value, loaded: true }))
    return () => {
      alive = false
      stop()
    }
  }, [area, key])
  return state
}
