import { afterEach, describe, expect, it, vi } from 'vitest'
import { extensionAlive, whileAlive } from './alive'

afterEach(() => vi.unstubAllGlobals())

describe('a script left in a page after the extension was reloaded', () => {
  it('knows the extension is gone, and stops instead of throwing', () => {
    vi.stubGlobal('chrome', { runtime: { id: 'abc' } })
    expect(extensionAlive()).toBe(true)
    expect(whileAlive(() => undefined)).toBe(true)
    // Chrome clears the id, and calls throw "Extension context invalidated".
    vi.stubGlobal('chrome', { runtime: {} })
    const call = vi.fn()
    expect(whileAlive(call)).toBe(false)
    expect(call).not.toHaveBeenCalled()
    vi.stubGlobal('chrome', { runtime: { id: 'abc' } })
    expect(whileAlive(() => { throw new Error('Extension context invalidated.') })).toBe(false)
  })
})
