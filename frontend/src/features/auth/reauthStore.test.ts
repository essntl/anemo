import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import { useReauthStore, withReauth } from './reauthStore'

/* frontend-4: two changes needing the password at once must both get the answer. */
const needsPassword = () => new ApiError(403, 'reauth_required', 'Confirm your password')

describe('password confirmation', () => {
  it('answers every change waiting for it, not only the last one', async () => {
    let calls = 0
    const change = (name: string) => async () => {
      calls += 1
      if (calls <= 2) throw needsPassword()
      return name
    }
    const first = withReauth(change('first'))
    const second = withReauth(change('second'))
    await new Promise((r) => setTimeout(r, 0))
    expect(useReauthStore.getState().pending).toHaveLength(2)
    useReauthStore.getState().resolve(true)
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second'])
    expect(useReauthStore.getState().pending).toBeNull()
  })

  it('a cancelled dialog stops every waiting change', async () => {
    const fail = async () => { throw needsPassword() }
    const first = withReauth(fail)
    const second = withReauth(fail)
    await new Promise((r) => setTimeout(r, 0))
    useReauthStore.getState().resolve(false)
    await expect(first).rejects.toThrow('Confirm your password')
    await expect(second).rejects.toThrow('Confirm your password')
  })
})
