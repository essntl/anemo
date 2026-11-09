/**
 * A small stand-in for Anemo's API, enough for the extension's end-to-end tests. It checks
 * what the real server checks for the extension: the Bearer token, and the Origin on
 * changes (only Anemo Companion's id may make them).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export const EXTENSION_ID = 'jpmimgldkledmklijfmfnbaaimmfjaaf'

export const ARTICLE = `<!doctype html><html lang="en"><head><title>Photosynthesis explained</title></head><body>
<nav><a href="/">Home</a> <a href="/login">Log in</a></nav>
<article><h1>Photosynthesis explained</h1>
${Array.from({ length: 10 }, (_, i) => `<p>Paragraph ${i}: plants turn <strong>light</strong> into chemical energy stored in glucose, releasing oxygen.</p>`).join('\n')}
<p>Learn more on <a href="/wiki/Chlorophyll">chlorophyll</a>.</p></article>
<footer>Cookie settings</footer></body></html>`

type Handler = (req: IncomingMessage, body: unknown, res: ServerResponse) => void | Promise<void>

export interface MockAnemo {
  url: string
  server: import('node:http').Server
  tokens: Set<string>
  /** Requests seen, as "METHOD /path". */
  log: string[]
  routes: Map<string, Handler>
  close: () => Promise<void>
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function error(res: ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message, details: null } })
}

export async function startMockAnemo(): Promise<MockAnemo> {
  const tokens = new Set<string>(['anemo_good-token'])
  const log: string[] = []
  const routes = new Map<string, Handler>()

  routes.set('GET /api/health', (_req, _b, res) => send(res, 200, { status: 'ok' }))
  // A web page to read (any site would do; this one is on 127.0.0.1, which the test build may read).
  routes.set('GET /article', (_req, _b, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(ARTICLE)
  })
  routes.set('GET /api/auth/me', (_req, _b, res) => send(res, 200, { username: 'admin', session_id: 't1', recent_auth: false, via: 'token' }))
  routes.set('POST /api/permissions/preview', (_req, _b, res) => send(res, 200, {}))
  routes.set('GET /api/settings', (_req, _b, res) =>
    send(res, 200, {
      appearance: { accent: '#3478f6', mode: 'system', density: 'comfortable' },
      general: { default_chat_mode: 'chat', timezone: 'UTC' },
      models: { chat: 'm-echo' },
    }),
  )
  routes.set('DELETE /api/auth/tokens/current', (req, _b, res) => {
    tokens.delete(bearer(req) ?? '')
    res.writeHead(204).end()
  })

  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname
      const key = `${req.method} ${path}`
      log.push(key)
      if (path.startsWith('/api/') && path !== '/api/health') {
        if (req.headers.cookie) return error(res, 400, 'cookie_sent', 'The extension must not send cookies')
        const token = bearer(req)
        if (!token || !tokens.has(token)) return error(res, 401, 'invalid_token', 'This token is not valid')
        if (req.method !== 'GET' && req.headers.origin !== `chrome-extension://${EXTENSION_ID}`) {
          return error(res, 403, 'bad_origin', 'Cross-site request blocked')
        }
      }
      const found = match(routes, req.method ?? 'GET', path)
      if (!found) return error(res, 404, 'not_found', `No route ${key}`)
      ;(req as IncomingMessage & { params: Record<string, string> }).params = found.params
      await found.handler(req, raw && !String(req.headers['content-type']).startsWith('multipart/') ? JSON.parse(raw) : undefined, res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    tokens,
    log,
    routes,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

/** Exact routes first, then patterns with :params ("GET /api/runs/:id/events"). */
function match(routes: Map<string, Handler>, method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
  const exact = routes.get(`${method} ${path}`)
  if (exact) return { handler: exact, params: {} }
  for (const [key, handler] of routes) {
    const [m, pattern] = key.split(' ')
    if (m !== method || !pattern.includes(':')) continue
    const names: string[] = []
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_x, n: string) => (names.push(n), '([^/]+)'))}$`)
    const hit = re.exec(path)
    if (hit) return { handler, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(hit[i + 1])])) }
  }
  return null
}

export function params(req: IncomingMessage): Record<string, string> {
  return (req as IncomingMessage & { params?: Record<string, string> }).params ?? {}
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization
  return h?.startsWith('Bearer ') ? h.slice(7) : null
}
