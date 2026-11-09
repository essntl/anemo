// Runs in Anemo's own tabs only (registered for the Anemo address): passes the panel's
// music commands to Anemo's page, and what is playing back to the extension.
// Anemo's side: frontend/src/features/music/extensionBridge.ts.
import { cleanState } from '@/shared/music'
import { whileAlive } from '../alive'

const flag = window as unknown as { __anemoBridge?: boolean }
if (!flag.__anemoBridge) {
  flag.__anemoBridge = true

  /** To the extension; once it is gone (reloaded or switched off), this script stops. */
  const send = (message: Record<string, unknown>) => {
    if (!whileAlive(() => void chrome.runtime.sendMessage(message).catch(() => undefined))) window.removeEventListener('message', onPageMessage)
  }

  const onPageMessage = (e: MessageEvent) => {
    // Only the page itself (not the players embedded in it, or other windows).
    if (e.source !== window || e.origin !== location.origin) return
    const d = e.data as { source?: unknown; type?: unknown; state?: unknown; id?: unknown; ok?: unknown; error?: unknown; count?: unknown } | null
    if (!d || d.source !== 'anemo-player') return
    if (d.type === 'state') {
      const state = cleanState(d.state)
      if (state) send({ type: 'music.state', state })
    } else if (d.type === 'added' && typeof d.id === 'string') {
      const error = typeof d.error === 'string' ? d.error.slice(0, 300) : null
      send({ type: 'music.added', id: d.id.slice(0, 60), ok: d.ok === true, error, count: typeof d.count === 'number' ? d.count : 0 })
    }
  }
  window.addEventListener('message', onPageMessage)

  chrome.runtime.onMessage.addListener((message: { type?: unknown; command?: unknown }, sender) => {
    // From the extension's own pages only (the panel), never from a tab.
    if (sender.id !== chrome.runtime.id || sender.tab || message?.type !== 'music.command') return
    window.postMessage({ source: 'anemo-companion', command: message.command }, location.origin)
  })

  window.postMessage({ source: 'anemo-companion', command: { type: 'hello' } }, location.origin)
}
