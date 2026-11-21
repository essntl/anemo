import { useModels } from '@/features/providers/api'
import { t } from '@/lib/i18n'
import { useReasoningEffort } from './api'
import { canSetEffort, EFFORT_LEVELS, effortIndex } from './reasoning'

/**
 * The model a message would go to: its name, whether its reasoning level can be set,
 * and that level's name when it can.
 */
export function useChatModel(id: string | null): { name: string | undefined; reasons: boolean; level: string | undefined } {
  const model = useModels().data?.find((m) => m.id === id)
  const effort = useReasoningEffort()
  const reasons = canSetEffort(model)
  return { name: model?.display_name, reasons, level: reasons ? t(EFFORT_LEVELS[effortIndex(effort.value)].label) : undefined }
}
