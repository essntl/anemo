import { describe, expect, it } from 'vitest'
import { canSetEffort } from './reasoning'

const model = (provider_type: string, reasoning = true) => ({ provider_type, capabilities: { reasoning } })

describe('the reasoning slider', () => {
  it('is offered where the provider is told the level', () => {
    expect(canSetEffort(model('openai'))).toBe(true)
    expect(canSetEffort(model('openrouter'))).toBe(true)
    expect(canSetEffort(model('anthropic'))).toBe(true)
  })

  it('is not offered where the level would change nothing', () => {
    expect(canSetEffort(model('openai_compatible'))).toBe(false)
    expect(canSetEffort(model('google'))).toBe(false)
    expect(canSetEffort(model('openai', false))).toBe(false)
    expect(canSetEffort(undefined)).toBe(false)
  })
})
