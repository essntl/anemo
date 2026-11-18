import type { Model } from '@/features/providers/api'
import { msg } from '@/lib/i18n'
import type { ReasoningEffort } from './api'

/** The stops of the reasoning slider, from the least thinking to the most. */
export const EFFORT_LEVELS: readonly { id: ReasoningEffort; label: string; hint: string }[] = [
  { id: 'off', label: msg('Off'), hint: msg('Answers straight away') },
  { id: 'low', label: msg('Low'), hint: msg('Takes a quick think first') },
  { id: 'medium', label: msg('Medium'), hint: msg('Thinks it through') },
  { id: 'high', label: msg('High'), hint: msg('Thinks long and carefully') },
  { id: 'max', label: msg('Max'), hint: msg('Takes as long as it needs') },
]

export const effortIndex = (level: ReasoningEffort): number =>
  Math.max(0, EFFORT_LEVELS.findIndex((l) => l.id === level))

/**
 * Whether the reasoning slider means anything for a model: it can reason, and its
 * provider is told how hard to think. Generic OpenAI-compatible servers get no level
 * (they differ too much), so the slider would change nothing there.
 */
export const canSetEffort = (model: Pick<Model, 'capabilities' | 'provider_type'> | undefined): boolean =>
  !!model?.capabilities.reasoning && model.provider_type !== 'openai_compatible'
