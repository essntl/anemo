import { CalendarDays, CheckSquare, RotateCcw, Trash2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { confirmDialog } from '@/components/ui/dialogs'
import { toast } from '@/components/ui/toast'
import { dateLocale, msg, t } from '@/lib/i18n'
import { usePurgeTrashed, useRestoreTrashed, useTrashed, type TrashKind } from './api'

const TEXT: Record<TrashKind, { title: string; description: string }> = {
  task: {
    title: msg('Deleted tasks'),
    description: msg('Tasks you or an agent deleted. Restore puts a task back as it was, with its subtasks and links.'),
  },
  event: {
    title: msg('Deleted events'),
    description: msg('Events and single occurrences you or an agent deleted. Restore puts them back in the calendar.'),
  },
}

/** The trash of tasks or of calendar events: restore, or delete for good. */
export function ItemTrashDialog({ kind, open, onOpenChange }: { kind: TrashKind; open: boolean; onOpenChange: (open: boolean) => void }) {
  const trash = useTrashed(kind, open)
  const restore = useRestoreTrashed()
  const purge = usePurgeTrashed()
  const items = trash.data ?? []
  const Icon = kind === 'task' ? CheckSquare : CalendarDays
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t(TEXT[kind].title)} description={t(TEXT[kind].description)}
      className="md:w-[min(94vw,620px)]">
      <div className="max-h-[55vh] overflow-y-auto rounded-control border border-border">
        {items.length === 0 && <p className="p-4 text-[13px] text-muted">{t('The trash is empty.')}</p>}
        {items.map((item) => (
          <div key={item.id} className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-0">
            <Icon className="h-4 w-4 shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{item.title}</div>
              <div className="text-[11.5px] text-muted">
                {item.deleted_by === 'agent'
                  ? t('Deleted {when} by an agent', { when: new Date(item.deleted_at).toLocaleString(dateLocale()) })
                  : t('Deleted {when}', { when: new Date(item.deleted_at).toLocaleString(dateLocale()) })}
              </div>
            </div>
            <Button size="sm" variant="secondary" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={restore.isPending && restore.variables === item.id}
              onClick={() => restore.mutate(item.id, { onSuccess: () => toast({ message: t('Restored “{title}”', { title: item.title }) }) })}>
              {t('Restore')}
            </Button>
            <Button size="icon" variant="ghost" aria-label={t('Delete “{title}” forever', { title: item.title })}
              onClick={async () => {
                if (await confirmDialog({ title: t('Delete “{title}” forever?', { title: item.title }), message: t('This cannot be undone.'),
                  confirmLabel: t('Delete forever'), danger: true })) purge.mutate(item.id)
              }}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
      {(trash.isError || restore.isError || purge.isError) && (
        <p className="mt-2 text-[13px] text-error">{errorMessage(trash.error ?? restore.error ?? purge.error)}</p>
      )}
    </Dialog>
  )
}
