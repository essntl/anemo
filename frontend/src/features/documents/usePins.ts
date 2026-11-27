import { useCallback } from 'react'
import { errorMessage } from '@/api/client'
import { useScope } from '@/app/projectStore'
import { toast } from '@/components/ui/toast'
import { usePins, useSetPinned } from './api'

/**
 * The pins of the place being looked at: the chosen project's, or (Uncategorized, All)
 * those outside projects. `toggle` pins or unpins a document there.
 */
export function useDocumentPins() {
  const scope = useScope()
  const projectId = scope.kind === 'project' ? scope.project.id : null
  const pins = usePins(projectId)
  const set = useSetPinned(projectId)
  const ids = pins.data
  const isPinned = useCallback((id: string) => (ids ?? []).includes(id), [ids])
  const { mutate } = set
  const toggle = useCallback(
    (id: string) => mutate({ id, pinned: !(ids ?? []).includes(id) }, { onError: (err) => toast({ message: errorMessage(err) }) }),
    [mutate, ids],
  )
  return { projectId, ids: ids ?? [], isPinned, toggle }
}
