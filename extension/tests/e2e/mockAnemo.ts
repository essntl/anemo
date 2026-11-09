/**
 * A small stand-in for Anemo's API, enough for the extension's end-to-end tests. It checks
 * what the real server checks for the extension: the Bearer token, and the Origin on
 * changes (only Anemo Companion's id may make them).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export const EXTENSION_ID = 'jpmimgldkledmklijfmfnbaaimmfjaaf'

type Handler = (req: IncomingMessage, body: unknown, res: ServerResponse) => void | Promise<void>

export interface MockAnemo {
  url: string
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
  routes.set('GET /api/auth/me', (_req, _b, res) => send(res, 200, { username: 'admin', session_id: 't1', recent_auth: false, via: 'token' }))
  routes.set('POST /api/permissions/preview', (_req, _b, res) => send(res, 200, {}))
  routes.set('GET /api/settings', (_req, _b, res) => send(res, 200, { appearance: { accent: '#3478f6', mode: 'system', density: 'comfortable' } }))
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
      if (path !== '/api/health') {
        if (req.headers.cookie) return error(res, 400, 'cookie_sent', 'The extension must not send cookies')
        const token = bearer(req)
        if (!token || !tokens.has(token)) return error(res, 401, 'invalid_token', 'This token is not valid')
        if (req.method !== 'GET' && req.headers.origin !== `chrome-extension://${EXTENSION_ID}`) {
          return error(res, 403, 'bad_origin', 'Cross-site request blocked')
        }
      }
      const handler = routes.get(key)
      if (!handler) return error(res, 404, 'not_found', `No route ${key}`)
      await handler(req, raw ? JSON.parse(raw) : undefined, res)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    tokens,
    log,
    routes,
    close: () => new Promise((r) => server.close(() => r())),
  }
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization
  return h?.startsWith('Bearer ') ? h.slice(7) : null
}
