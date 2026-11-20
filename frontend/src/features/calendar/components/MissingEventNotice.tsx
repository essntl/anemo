import { X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useTrashed } from '@/features/trash/api'
import { t } from '@/lib/i18n'

/**
 * An event's link (/calendar?event=<id>) led nowhere: a short note above the calendar,
 * saying whether the event is in the trash. It goes away when you move on.
 */
export function MissingEventNotice({ eventId, onOpenTrash, onClose }: { eventId: string; onOpenTrash: () => void; onClose: () => void }) {
  const trashed = useTrashed('event', true).data?.some((item) => item.item_id === eventId)
  return (
    <div role="status" className="mb-2 flex items-center gap-2 rounded-control border border-border bg-surface-2 px-3 py-1.5 text-[13px]">
      <span className="min-w-0 flex-1">{trashed ? t('This event is in the trash.') : t('Event not found. It may have been deleted.')}</span>
      {trashed && <Button size="sm" variant="ghost" onClick={onOpenTrash}>{t('Open the trash')}</Button>}
      <button type="button" aria-label={t('Close')} onClick={onClose} className="rounded-control p-1 text-muted hover:bg-surface-hover hover:text-text">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
