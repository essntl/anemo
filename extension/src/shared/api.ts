/**
 * The Anemo API client: typed from Anemo's OpenAPI schema (frontend/src/api/schema.d.ts),
 * authenticated with the API token, and turning every way a request can fail into an
 * `ApiError` with a `kind` the UI can explain.
 *
 * Requests never send cookies (`credentials: 'omit'`): only the token counts, so a revoked
 * token always ends in a 401 and the extension goes back to setup.
 */
import createClient, { type Middleware } from 'openapi-fetch'
import type { components, paths } from '@anemo/schema'

export type Schemas = components['schemas']

export type ErrorKind =
  | 'offline' // this computer has no network
  | 'unreachable' // DNS, TLS, refused: nothing answered at that address
  | 'timeout'
  | 'permission' // the extension may not reach this address (host permission missing)
  | 'server_down' // the proxy answered, Anemo didn't (502/503/504, Cloudflare 52x)
  | 'challenge' // Cloudflare (or similar) wants a browser check
  | 'html' // a web page came back instead of the API (wrong address, a login portal)
  | 'not_anemo' // something answered, but it isn't Anemo
  | 'unauthorized' // token missing, revoked or mistyped
  | 'origin' // the server refuses this extension (EXTENSION_IDS, or Anemo too old)
  | 'http' // any other error answer from Anemo, with its code and message

export class ApiError extends Error {
  readonly kind: ErrorKind
  readonly status: number
  readonly code: string

  constructor(kind: ErrorKind, message: string, status = 0, code: string = kind) {
    super(message)
    this.name = 'ApiError'
    this.kind = kind
    this.status = status
    this.code = code
  }
}

const MESSAGES: Record<Exclude<ErrorKind, 'http'>, string> = {
  offline: 'You are offline.',
  unreachable: 'Nothing answered at this address. Check it, and that Anemo is running.',
  timeout: 'Anemo took too long to answer.',
  permission: 'The extension isn’t allowed to reach this address yet.',
  server_down: 'Your proxy answered, but Anemo didn’t: it may be down or restarting.',
  challenge: 'Cloudflare is asking for a browser check, so the extension can’t get through.',
  html: 'A web page came back instead of Anemo’s API. Is this the right address?',
  not_anemo: 'Something answered at this address, but it isn’t Anemo.',
  unauthorized: 'The token was revoked or is mistyped.',
  origin: 'Anemo refuses requests from this extension. Update Anemo, or check EXTENSION_IDS.',
}

export function messageFor(kind: Exclude<ErrorKind, 'http'>): string {
  return MESSAGES[kind]
}

const DOWN_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530])

/**
 * Classifies a response that isn't a normal JSON answer from Anemo, or returns null when it
 * is one (the caller then reads Anemo's own error body).
 */
export async function classifyResponse(res: Response): Promise<ApiError | null> {
  const type = res.headers.get('content-type') ?? ''
  if (res.headers.get('cf-mitigated') === 'challenge') return new ApiError('challenge', MESSAGES.challenge, res.status)
  const isJson = type.includes('application/json')
  if (!isJson && type.includes('text/html')) {
    const body = await res.clone().text().catch(() => '')
    if (/challenge-platform|cf-chl|cf_chl|Just a moment\.\.\./i.test(body)) {
      return new ApiError('challenge', MESSAGES.challenge, res.status)
    }
    if (DOWN_STATUSES.has(res.status)) return new ApiError('server_down', MESSAGES.server_down, res.status)
    return new ApiError('html', MESSAGES.html, res.status)
  }
  if (DOWN_STATUSES.has(res.status) && !isJson) return new ApiError('server_down', MESSAGES.server_down, res.status)
  // Anemo's errors are always JSON; an error in any other format came from something else.
  if (!res.ok && !isJson) return new ApiError('not_anemo', MESSAGES.not_anemo, res.status)
  return null
}

interface ErrorBody {
  error?: { code?: string; message?: string }
}

/** The ApiError for one of Anemo's own JSON error answers. */
export function fromErrorBody(status: number, body: unknown): ApiError {
  const err = (body as ErrorBody | undefined)?.error
  const code = err?.code ?? `http_${status}`
  const message = err?.message ?? `Anemo answered with an error (${status}).`
  if (status === 401) return new ApiError('unauthorized', MESSAGES.unauthorized, status, code)
  if (status === 403 && code === 'bad_origin') return new ApiError('origin', MESSAGES.origin, status, code)
  return new ApiError('http', message, status, code)
}

/** The ApiError for a fetch that threw (no answer at all). */
export async function fromNetworkError(err: unknown, serverUrl: string): Promise<ApiError> {
  if (err instanceof ApiError) return err
  if (err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return err.name === 'TimeoutError' ? new ApiError('timeout', MESSAGES.timeout) : new ApiError('http', 'Stopped.', 0, 'aborted')
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return new ApiError('offline', MESSAGES.offline)
  try {
    const allowed = await chrome.permissions.contains({ origins: [`${new URL(serverUrl).origin}/*`] })
    if (!allowed) return new ApiError('permission', MESSAGES.permission)
  } catch {
    // not in an extension context (tests): fall through
  }
  return new ApiError('unreachable', MESSAGES.unreachable)
}

export const DEFAULT_TIMEOUT_MS = 20_000

export interface ClientOptions {
  serverUrl: string
  token: string | null
  /** Called once per 401, so the extension can go back to setup. */
  onUnauthorized?: (err: ApiError) => void
  timeoutMs?: number
}

/** The headers every request carries. */
export function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export function createApi(opts: ClientOptions) {
  const client = createClient<paths>({
    baseUrl: opts.serverUrl,
    credentials: 'omit',
    headers: authHeaders(opts.token),
    fetch: async (request: Request) => {
      try {
        // A timeout unless the caller brought its own signal (streams, Stop buttons).
        const signal = request.signal.aborted ? request.signal : AbortSignal.any([request.signal, AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)])
        return await fetch(new Request(request, { signal }))
      } catch (err) {
        throw await fromNetworkError(err, opts.serverUrl)
      }
    },
  })
  const classify: Middleware = {
    async onResponse({ response }) {
      const problem = await classifyResponse(response)
      if (problem) throw problem
      if (response.status === 401) {
        const err = fromErrorBody(401, await response.clone().json().catch(() => undefined))
        opts.onUnauthorized?.(err)
      }
      return response
    },
  }
  client.use(classify)
  return client
}

export type Api = ReturnType<typeof createApi>

/** The data of an openapi-fetch result, or the ApiError for its error. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || !result.response.ok) throw fromErrorBody(result.response.status, result.error)
  return result.data as T
}
