import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { type BrowserView, browserKey } from './api'

interface Handlers {
  /** Each JPEG (base64) as it arrives. Meant to update the <img> directly: going
   *  through React state would re-render the panel for every frame. */
  onFrame: (jpeg: string) => void
  /** The stream stopped giving frames (dropped, the session closed, the tab hidden). */
  onStop: (reason: 'closed' | 'error' | 'stopped') => void
}

/**
 * The live picture of a conversation's browser: Server-Sent Events from
 * /browser/stream while `enabled` (a page is open and the panel is shown) and the tab
 * is visible. The browser sends a frame whenever the page changes, so scrolling and
 * typing look smooth, and a still page costs nothing. The address and title (sent
 * every second) go into the view's cached data.
 */
export function useBrowserStream(conversationId: string, enabled: boolean, width: number, handlers: Handlers) {
  const qc = useQueryClient()
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  })

  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  useEffect(() => {
    if (!enabled || !visible) return
    const source = new EventSource(`/api/conversations/${conversationId}/browser/stream?width=${width}`)
    const end = () => {
      source.close()
      latest.current.onStop('closed')
      void qc.invalidateQueries({ queryKey: browserKey(conversationId) })
    }
    source.addEventListener('frame', (e) => latest.current.onFrame((e as MessageEvent<string>).data))
    source.addEventListener('meta', (e) => {
      const { url, title } = JSON.parse((e as MessageEvent<string>).data) as { url: string; title: string }
      qc.setQueryData<BrowserView>(browserKey(conversationId), (old) => (old ? { ...old, url, title } : old))
    })
    source.addEventListener('closed', end) // the session was closed
    source.addEventListener('unavailable', end) // the browser stopped
    // The connection dropped: EventSource reconnects by itself; meanwhile the view is polled.
    source.onerror = () => latest.current.onStop('error')
    return () => {
      source.close()
      latest.current.onStop('stopped')
    }
  }, [conversationId, enabled, visible, width, qc])
}
