/**
 * Typed API client generated from the backend's OpenAPI schema.
 *
 *   const me = unwrap(await api.GET('/api/auth/me'))
 *
 * Regenerate types after backend changes with `make gen-api`.
 */
import createClient from 'openapi-fetch'
import { noteServerTime } from '@/lib/serverClock'
import type { components, paths } from './schema'

export type Schemas = components['schemas']

export const api = createClient<paths>({ baseUrl: '', credentials: 'same-origin' })

// Every answer says what time it is on the server, so server times show right here.
const sentAt = new WeakMap<Request, number>()
api.use({
  onRequest({ request }) {
    sentAt.set(request, Date.now())
  },
  onResponse({ request, response }) {
    noteServerTime(response, sentAt.get(request))
  },
})

/** Error thrown for non-2xx responses, carrying the backend's stable error code. */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown }
}

/** Listeners notified when any request reports the session is gone. */
const unauthorizedListeners = new Set<() => void>()
export function onUnauthorized(fn: () => void): () => void {
  unauthorizedListeners.add(fn)
  return () => unauthorizedListeners.delete(fn)
}

type FetchResult<T> = { data?: T; error?: unknown; response: Response }

/** The server's code for a password that didn't match (features/auth/router.py). */
const WRONG_PASSWORD = 'wrong_password'

/** Return `data` or throw an ApiError. */
export function unwrap<T>(result: FetchResult<T>): T {
  const { data, error, response } = result
  if (response.ok) return data as T
  const body = (error ?? {}) as ErrorBody
  const code = body.error?.code ?? `http_${response.status}`
  // A wrong password (the login form, the "Confirm it's you" dialog) is also a 401, but
  // the session is still there: the form says so, and nobody is sent to the login page.
  const sessionGone =
    response.status === 401 &&
    code !== WRONG_PASSWORD &&
    !response.url.endsWith('/api/auth/login')
  if (sessionGone) unauthorizedListeners.forEach((fn) => fn())
  throw new ApiError(
    response.status,
    code,
    body.error?.message ?? response.statusText ?? 'Request failed',
    body.error?.details,
  )
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong'
}
