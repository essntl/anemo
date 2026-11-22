import { describe, expect, it, vi } from 'vitest'
import { ApiError, onUnauthorized, unwrap } from './client'

function failed(status: number, code: string, url: string) {
  const response = { ok: false, status, statusText: '', url } as Response
  return { error: { error: { code, message: code } }, response }
}

function listen() {
  const gone = vi.fn()
  const stop = onUnauthorized(gone)
  return { gone, stop }
}

describe('unwrap and a lost session', () => {
  it('tells the app when a request says the session is gone', () => {
    const { gone, stop } = listen()
    expect(() => unwrap(failed(401, 'unauthorized', 'http://x/api/tasks'))).toThrow(ApiError)
    expect(gone).toHaveBeenCalledTimes(1)
    stop()
  })

  it('does not take a wrong password in the password dialog for a lost session', () => {
    const { gone, stop } = listen()
    expect(() => unwrap(failed(401, 'wrong_password', 'http://x/api/auth/reauth'))).toThrow(
      ApiError,
    )
    expect(gone).not.toHaveBeenCalled()
    stop()
  })

  it('still notices a session that ended while the password dialog was open', () => {
    const { gone, stop } = listen()
    expect(() => unwrap(failed(401, 'unauthorized', 'http://x/api/auth/reauth'))).toThrow(ApiError)
    expect(gone).toHaveBeenCalledTimes(1)
    stop()
  })

  it('leaves the login form alone', () => {
    const { gone, stop } = listen()
    expect(() => unwrap(failed(401, 'invalid_credentials', 'http://x/api/auth/login'))).toThrow(
      ApiError,
    )
    expect(gone).not.toHaveBeenCalled()
    stop()
  })
})
