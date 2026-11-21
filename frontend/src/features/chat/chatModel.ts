import { useModels } from '@/features/providers/api'
import { canSetEffort } from './reasoning'

/** The model a message would go to: its name, and whether its reasoning level can be set. */
export function useChatModel(id: string | null): { name: string | undefined; reasons: boolean } {
  const model = useModels().data?.find((m) => m.id === id)
  return { name: model?.display_name, reasons: canSetEffort(model) }
}
