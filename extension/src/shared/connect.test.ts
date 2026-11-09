import { afterEach, describe, expect, it, vi } from 'vitest'
import { testConnection } from './connect'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function server(routes: Record<string, (req: Request) => Response>) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init)
    const path = new URL(req.url).pathname
    const handler = routes[`${req.method} ${path}`]
    return handler ? handler(req) : json(404, { error: { code: 'not_found', message: 'nope' } })
  })
}

const healthy = {
  'GET /api/health': () => json(200, { status: 'ok' }),
  'GET /api/auth/me': (r: Request) =>
    r.headers.get('authorization') === 'Bearer anemo_good'
      ? json(200, { username: 'admin', session_id: 'x', recent_auth: false, via: 'token' })
      : json(401, { error: { code: 'invalid_token', message: 'bad' } }),
  'POST /api/permissions/preview': () => json(200, {}),
  'GET /api/settings': () => json(200, { appearance: { accent: '#ff0066' } }),
}

afterEach(() => vi.restoreAllMocks())

describe('testConnection', () => {
  it('succeeds with the username and accent', async () => {
    server(healthy)
    expect(await testConnection('https://a.example', 'anemo_good')).toEqual({ ok: true, username: 'admin', accent: '#ff0066' })
  })

  it('fails at the token step for a bad token', async () => {
    server(healthy)
    expect(await testConnection('https://a.example', 'anemo_bad')).toMatchObject({ ok: false, step: 'token', error: { kind: 'unauthorized' } })
  })

  it('fails at the server step when it isn’t Anemo', async () => {
    server({ 'GET /api/health': () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }) })
    expect(await testConnection('https://a.example', 'anemo_good')).toMatchObject({ ok: false, step: 'server', error: { kind: 'html' } })
  })

  it('fails at the origin step when Anemo refuses the extension', async () => {
    server({ ...healthy, 'POST /api/permissions/preview': () => json(403, { error: { code: 'bad_origin', message: 'x' } }) })
    expect(await testConnection('https://a.example', 'anemo_good')).toMatchObject({ ok: false, step: 'origin', error: { kind: 'origin' } })
  })
})
