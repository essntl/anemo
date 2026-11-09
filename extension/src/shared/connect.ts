/**
 * The setup screen's connection test, step by step, so a failure says which step failed:
 *   1. something answers at the address, and it is Anemo  (GET /api/health)
 *   2. the token is valid                                  (GET /api/auth/me)
 *   3. Anemo accepts changes from this extension           (a harmless POST)
 */
import { ApiError, classifyResponse, createApi, fromErrorBody, fromNetworkError, messageFor, unwrap } from './api'

export type Step = 'server' | 'token' | 'origin'

export type TestResult =
  | { ok: true; username: string; accent: string | null }
  | { ok: false; step: Step; error: ApiError }

async function checkHealth(serverUrl: string): Promise<void> {
  let res: Response
  try {
    res = await fetch(`${serverUrl}/api/health`, { credentials: 'omit', signal: AbortSignal.timeout(10_000) })
  } catch (err) {
    throw await fromNetworkError(err, serverUrl)
  }
  const problem = await classifyResponse(res)
  if (problem) throw problem
  const body = (await res.json().catch(() => null)) as { status?: string } | null
  if (!res.ok || body?.status !== 'ok') {
    throw res.ok || res.status === 404 ? new ApiError('not_anemo', messageFor('not_anemo'), res.status) : fromErrorBody(res.status, body)
  }
}

export async function testConnection(serverUrl: string, token: string): Promise<TestResult> {
  try {
    await checkHealth(serverUrl)
  } catch (err) {
    return { ok: false, step: 'server', error: err as ApiError }
  }
  const api = createApi({ serverUrl, token })
  let username: string
  try {
    const me = unwrap(await api.GET('/api/auth/me'))
    username = me.username
  } catch (err) {
    return { ok: false, step: 'token', error: err as ApiError }
  }
  try {
    // Computes a permission summary and changes nothing: proves the Origin check lets us in.
    unwrap(await api.POST('/api/permissions/preview', { body: { plan_review: 'off' } }))
  } catch (err) {
    return { ok: false, step: 'origin', error: err as ApiError }
  }
  let accent: string | null = null
  try {
    accent = unwrap(await api.GET('/api/settings')).appearance.accent ?? null
  } catch {
    // only the colour; not worth failing the setup for
  }
  return { ok: true, username, accent }
}
