import { describe, expect, it } from 'vitest'
import type { Schemas } from '@/api/client'
import { modelsFor, neighbour, startStep, STEPS, suggestHelpers } from './steps'

type Model = Schemas['ModelOut']

function model(id: string, key: string, provider = 'p1', caps: Partial<Model['capabilities']> = {}, enabled = true): Model {
  return {
    id, model_key: key, display_name: key, provider_id: provider, provider_name: provider, provider_type: 'openai',
    capabilities: { chat: true, ...caps }, enabled, provider_enabled: true,
    context_window: null, max_output: null, pricing: {}, provider_options: {},
  } as unknown as Model
}

const defaults = (values: Partial<Schemas['ModelDefaults']> = {}) =>
  ({ chat: null, agent: null, summarization: null, memory: null, background: null, automation: null, embeddings: null, title: null, fallbacks: {}, ...values }) as Schemas['ModelDefaults']

describe('setup steps', () => {
  it('starts where it was left, or at the beginning', () => {
    expect(startStep(null)).toBe('provider')
    expect(startStep('parts')).toBe('parts')
    expect(startStep('gone' as never)).toBe('provider')
  })

  it('moves forward and back within the steps', () => {
    expect(STEPS.map((s) => s.id)).toEqual(['provider', 'models', 'you', 'parts', 'notifications'])
    expect(neighbour('provider', 1)).toBe('models')
    expect(neighbour('provider', -1)).toBeNull()
    expect(neighbour('notifications', 1)).toBeNull()
  })
})

describe('helper model suggestions', () => {
  const models = [
    model('big', 'gpt-5'),
    model('small', 'gpt-5-mini'),
    model('other-small', 'claude-haiku-5', 'p2'),
    model('embed', 'text-embedding-3-small', 'p1', { chat: false, embeddings: true }),
    model('off', 'gpt-5-nano', 'p1', {}, false),
  ]

  it('suggests a small model from the chat model\'s provider, and an embedding model', () => {
    expect(suggestHelpers(models, defaults({ chat: 'big' }))).toEqual({ summarization: 'small', memory: 'small', embeddings: 'embed' })
    expect(suggestHelpers(models, defaults({ chat: 'other-small' })).summarization).toBe('other-small')
  })

  it('keeps what is set, and leaves a task unset when nothing fits', () => {
    expect(suggestHelpers(models, defaults({ chat: 'big', memory: 'big' })).memory).toBe('big')
    expect(suggestHelpers([model('big', 'gpt-5')], defaults({ chat: 'big' }))).toEqual({ summarization: null, memory: null, embeddings: null })
  })

  it('offers only switched-on models that can do the task', () => {
    expect(modelsFor('chat', models).map((m) => m.id)).toEqual(['big', 'small', 'other-small'])
    expect(modelsFor('embeddings', models).map((m) => m.id)).toEqual(['embed'])
  })
})
