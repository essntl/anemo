/**
 * The first-run setup's steps and the helper models it suggests. Plain functions, so
 * they can be tested without a page.
 */
import type { Schemas } from '@/api/client'
import { msg } from '@/lib/i18n'

type Model = Schemas['ModelOut']
type ModelDefaults = Schemas['ModelDefaults']
export type StepId = NonNullable<Schemas['SetupSettings']['step']>

export const STEPS: { id: StepId; title: string; optional: boolean }[] = [
  { id: 'provider', title: msg('Model provider'), optional: false },
  { id: 'models', title: msg('Helper models'), optional: true },
  { id: 'you', title: msg('You'), optional: false },
  { id: 'parts', title: msg('Optional parts'), optional: true },
  { id: 'notifications', title: msg('Notifications'), optional: true },
]

/** Where the setup starts: where it was left, or at the beginning. */
export function startStep(saved: StepId | null | undefined): StepId {
  return saved && STEPS.some((s) => s.id === saved) ? saved : STEPS[0].id
}

/** The step after (or before) `id`; null past the ends. */
export function neighbour(id: StepId, by: 1 | -1): StepId | null {
  const i = STEPS.findIndex((s) => s.id === id)
  return STEPS[i + by]?.id ?? null
}

/** Small, fast models: good for summaries and memory, where the chat model is overkill. */
const SMALL = /(mini|haiku|flash|small|nano|lite|tiny|\b[1-9]b\b|-[1-9]b\b)/i

const usable = (m: Model) => m.enabled && m.provider_enabled !== false

/** Models that can do a task, as the defaults card offers them. */
export function modelsFor(task: 'chat' | 'summarization' | 'memory' | 'embeddings', models: Model[]): Model[] {
  return models.filter((m) => usable(m) && (task === 'embeddings' ? m.capabilities.embeddings : m.capabilities.chat !== false && !m.capabilities.embeddings))
}

/**
 * Suggestions for the helper models that are not set yet: a small model for summaries
 * and memory (from the chat model's provider when it has one), an embedding model for
 * search by meaning. A task already set keeps its model; no fitting model leaves it
 * unset (summaries and memory then use the chat model).
 */
export function suggestHelpers(models: Model[], defaults: ModelDefaults): Pick<ModelDefaults, 'summarization' | 'memory' | 'embeddings'> {
  const chat = models.find((m) => m.id === defaults.chat)
  const sameProviderFirst = (list: Model[]) =>
    chat ? [...list.filter((m) => m.provider_id === chat.provider_id), ...list.filter((m) => m.provider_id !== chat.provider_id)] : list
  const small = sameProviderFirst(modelsFor('chat', models).filter((m) => SMALL.test(`${m.model_key} ${m.display_name}`)))[0]
  const embedding = sameProviderFirst(modelsFor('embeddings', models))[0]
  return {
    summarization: defaults.summarization ?? small?.id ?? null,
    memory: defaults.memory ?? small?.id ?? null,
    embeddings: defaults.embeddings ?? embedding?.id ?? null,
  }
}

/** The time zone this device is in, e.g. "Europe/Oslo" (null when the browser can't say). */
export function deviceTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}
