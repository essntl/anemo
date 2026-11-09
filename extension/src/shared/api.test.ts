import { describe, expect, it, vi } from 'vitest'
import { ApiError, classifyResponse, createApi, fromErrorBody, fromNetworkError, unwrap } from './api'

const html = (status: number, body = '<html></html>', headers: Record<string, string> = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('classifyResponse', () => {
  it('passes Anemo’s JSON answers through', async () => {
    expect(await classifyResponse(json(200, { ok: 1 }))).toBeNull()
    expect(await classifyResponse(json(404, { error: { code: 'not_found' } }))).toBeNull()
  })

  it('recognises a Cloudflare challenge by header or page', async () => {
    expect((await classifyResponse(html(403, '', { 'cf-mitigated': 'challenge' })))?.kind).toBe('challenge')
    expect((await classifyResponse(html(503, '<title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/x">')))?.kind).toBe('challenge')
  })

  it('tells a proxy error page (Anemo down) from any other web page', async () => {
    expect((await classifyResponse(html(502, '<h1>502 Bad Gateway</h1>')))?.kind).toBe('server_down')
    expect((await classifyResponse(html(522)))?.kind).toBe('server_down')
    expect((await classifyResponse(html(200, '<h1>Welcome to nginx</h1>')))?.kind).toBe('html')
    expect((await classifyResponse(new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } })))?.kind).toBe('not_anemo')
  })
})

describe('fromErrorBody', () => {
  it('maps 401 and the Origin check, keeps Anemo’s message otherwise', () => {
    expect(fromErrorBody(401, { error: { code: 'invalid_token', message: 'x' } })).toMatchObject({ kind: 'unauthorized', code: 'invalid_token' })
    expect(fromErrorBody(403, { error: { code: 'bad_origin', message: 'x' } }).kind).toBe('origin')
    expect(fromErrorBody(409, { error: { code: 'run_active', message: 'A run is active' } })).toMatchObject({ kind: 'http', code: 'run_active', message: 'A run is active' })
    expect(fromErrorBody(500, undefined)).toMatchObject({ kind: 'http', code: 'http_500' })
  })
})

describe('fromNetworkError', () => {
  it('says offline, missing permission, timeout or unreachable', async () => {
    const online = vi.spyOn(navigator, 'onLine', 'get')
    online.mockReturnValue(false)
    expect((await fromNetworkError(new TypeError('Failed to fetch'), 'https://a.example')).kind).toBe('offline')
    online.mockReturnValue(true)
    expect((await fromNetworkError(new TypeError('Failed to fetch'), 'https://a.example')).kind).toBe('permission')
    await chrome.permissions.request({ origins: ['https://a.example/*'] })
    expect((await fromNetworkError(new TypeError('Failed to fetch'), 'https://a.example')).kind).toBe('unreachable')
    expect((await fromNetworkError(new DOMException('t', 'TimeoutError'), 'https://a.example')).kind).toBe('timeout')
    online.mockRestore()
  })
})

describe('createApi', () => {
  it('sends the token, never cookies, and reports a 401 once', async () => {
    const seen: Request[] = []
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      seen.push(input as Request)
      return json(401, { error: { code: 'invalid_token', message: 'x' } })
    })
    const onUnauthorized = vi.fn()
    const api = createApi({ serverUrl: 'https://a.example', token: 'anemo_t', onUnauthorized })
    const result = await api.GET('/api/auth/me')
    expect(() => unwrap(result)).toThrow(ApiError)
    expect(seen[0].headers.get('authorization')).toBe('Bearer anemo_t')
    expect(seen[0].credentials).toBe('omit')
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    fetchMock.mockRestore()
  })

  it('throws the classified error for a challenge page', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(html(403, '', { 'cf-mitigated': 'challenge' }))
    const api = createApi({ serverUrl: 'https://a.example', token: 'anemo_t' })
    await expect(api.GET('/api/auth/me')).rejects.toMatchObject({ kind: 'challenge' })
    fetchMock.mockRestore()
  })
})
