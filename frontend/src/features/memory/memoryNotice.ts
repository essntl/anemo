import { toast } from '@/components/ui/toast'
import type { RunEvent } from '@/features/chat/runStream'
import { deleteMemory } from './api'

/**
 * Call for every run event: when the assistant saved a memory, the user gets a
 * notice. A newly created memory can be undone on the spot.
 */
export function noticeMemoryEvent(event: RunEvent, onChanged: () => void): void {
  if (event.type !== 'memory.saved') return
  const { memory_id: id, content, action } = event.data as { memory_id: string; content: string; action: string }
  const text = content.length > 90 ? `${content.slice(0, 90)}…` : content
  onChanged()
  toast({
    message: `${action === 'created' ? 'Saved to memory' : 'Memory updated'}: ${text}`,
    action:
      action === 'created'
        ? { label: 'Undo', onClick: () => void deleteMemory(id).then(onChanged, onChanged) }
        : undefined,
  })
}
