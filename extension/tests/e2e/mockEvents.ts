/**
 * The event stream for the mock Anemo: the extension's WebSocket (/api/extension/ws) with
 * the real protocol (hello with the token, welcome, events, ping/pong, close 4401).
 */
import { WebSocketServer, type WebSocket } from 'ws'
import type { MockAnemo } from './mockAnemo'

export interface MockEvents {
  /** Publish an event to every connected extension; returns its id. */
  publish: (event: string, data: Record<string, unknown>) => string
  /** Events kept for replay (like Valkey's global stream). */
  history: { id: string; event: string; data: Record<string, unknown> }[]
  /** Hello messages received. */
  hellos: Record<string, unknown>[]
  presence: Record<string, unknown>[]
  sockets: Set<WebSocket>
  /** Close every connection with this code (4401: token revoked). */
  closeAll: (code: number) => void
}

export function addEvents(anemo: MockAnemo & { server: import('node:http').Server }): MockEvents {
  const wss = new WebSocketServer({ noServer: true })
  const sockets = new Set<WebSocket>()
  const history: MockEvents['history'] = []
  const hellos: Record<string, unknown>[] = []
  const presence: Record<string, unknown>[] = []
  let seq = Date.now()

  anemo.server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/api/extension/ws')) return socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (req.headers.origin !== 'chrome-extension://jpmimgldkledmklijfmfnbaaimmfjaaf') return ws.close(4403)
      let ready = false
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as Record<string, unknown>
        if (!ready) {
          hellos.push(msg)
          if (msg.type !== 'hello' || !anemo.tokens.has(String(msg.token))) return ws.close(4401)
          ready = true
          const lastId = typeof msg.last_id === 'string' ? msg.last_id : null
          ws.send(JSON.stringify({ type: 'welcome', missed: false, cursor: lastId ?? history.at(-1)?.id ?? '0-0' }))
          sockets.add(ws)
          if (lastId) for (const e of history.filter((h) => h.id > lastId)) ws.send(JSON.stringify({ type: 'event', ...e }))
          return
        }
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }))
        if (msg.type === 'presence') presence.push(msg)
      })
      ws.on('close', () => sockets.delete(ws))
    })
  })

  // Upgraded sockets aren't closed by the HTTP server's close: end them first.
  const closeServer = anemo.close
  anemo.close = async () => {
    for (const ws of wss.clients) ws.terminate()
    wss.close()
    await closeServer()
  }

  return {
    publish(event, data) {
      const id = `${seq++}-0`
      history.push({ id, event, data })
      for (const ws of sockets) ws.send(JSON.stringify({ type: 'event', id, event, data }))
      return id
    },
    history,
    hellos,
    presence,
    sockets,
    closeAll(code) {
      for (const ws of sockets) ws.close(code)
    },
  }
}
