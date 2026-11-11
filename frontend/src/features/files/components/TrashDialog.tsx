import { File, Folder, RotateCcw, Trash2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { usePurge, useRestore, useTrash } from '../api'
import { confirmDialog } from '@/components/ui/dialogs'
import { dateLocale, t } from '@/lib/i18n'

export function TrashDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const trash = useTrash(open)
  const restore = useRestore()
  const purge = usePurge()
  const items = trash.data ?? []
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('Trash')}
      description={t('Deleted files and folders, including anything agents deleted. Restore puts them back where they were.')}
      className="md:w-[min(94vw,620px)]">
      <div className="max-h-[55vh] overflow-y-auto rounded-control border border-border">
        {items.length === 0 && <p className="p-4 text-[13px] text-muted">{t('The trash is empty.')}</p>}
        {items.map((item) => (
          <div key={item.id} className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-0">
            {item.is_dir ? <Folder className="h-4 w-4 text-accent" /> : <File className="h-4 w-4 text-muted" />}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{item.original_path}</div>
              <div className="text-[11.5px] text-muted">
                {item.deleted_by === 'user'
                  ? t('Deleted {date}', { date: new Date(item.deleted_at).toLocaleString(dateLocale()) })
                  : item.deleted_by === 'agent'
                    ? t('Deleted {date} by agent', { date: new Date(item.deleted_at).toLocaleString(dateLocale()) })
                    : t('Deleted {date} by {who}', { date: new Date(item.deleted_at).toLocaleString(dateLocale()), who: item.deleted_by })}
              </div>
            </div>
            <Button size="sm" variant="secondary" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => restore.mutate(item.id)}>
              {t('Restore')}
            </Button>
            <Button size="icon" variant="ghost" aria-label={t('Delete forever')}
              onClick={async () => {
                if (await confirmDialog({ title: t('Delete "{name}" forever?', { name: item.name }), message: t('This cannot be undone.'),
                  confirmLabel: t('Delete forever'), danger: true })) purge.mutate(item.id)
              }}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
      {(restore.isError || purge.isError) && (
        <p className="mt-2 text-[13px] text-error">{errorMessage(restore.error ?? purge.error)}</p>
      )}
    </Dialog>
  )
}
