/**
 * Anemo's music page for the mock: a stand-in player speaking the same protocol as
 * Anemo's features/music/extensionBridge.ts (commands in, state out, window messages).
 */
import type { MockAnemo } from './mockAnemo'

const PAGE = `<!doctype html><html><head><title>Music · Anemo</title></head><body><h1>Anemo music</h1><ol id="queue"></ol>
<script>
  const queue = []
  let index = 0
  let status = 'unstarted'
  const log = (window.musicLog = [])
  const state = () => ({ status, title: queue[index]?.title ?? null, artist: queue[index] ? 'Some band' : null, url: queue[index]?.url ?? null, index, queueLength: queue.length, adding: false, error: null })
  const report = () => window.postMessage({ source: 'anemo-player', type: 'state', state: state() }, location.origin)
  const show = () => (document.getElementById('queue').innerHTML = queue.map((t) => '<li>' + t.title + '</li>').join(''))
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'anemo-companion') return
    const c = e.data.command
    log.push(c.type)
    if (c.type === 'toggle') status = status === 'playing' ? 'paused' : 'playing'
    if (c.type === 'next') index = Math.min(index + 1, queue.length - 1)
    if (c.type === 'prev') index = Math.max(index - 1, 0)
    if (c.type === 'add') {
      if (c.url.includes('nothing-here')) {
        window.postMessage({ source: 'anemo-player', type: 'added', id: c.id, ok: false, error: 'Nothing playable at that link.' }, location.origin)
        return
      }
      queue.push({ url: c.url, title: 'Track ' + (queue.length + 1) })
      if (status === 'unstarted') status = 'playing'
      show()
      window.postMessage({ source: 'anemo-player', type: 'added', id: c.id, ok: true, count: 1 }, location.origin)
    }
    report()
  })
</script></body></html>`

export function addMusic(anemo: MockAnemo) {
  anemo.routes.set('GET /music', (_req, _b, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
}
