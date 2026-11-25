/**
 * Uninstalling a plugin (contract §5): keep what it made as yours, or remove it too. The
 * dialog lists what each choice affects, from the plugin's data summary. Its files and
 * versions go either way.
 */
import { type ReactNode, useState } from 'react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { cn } from '@/lib/cn'
import { formatSize } from '@/lib/format'
import { t } from '@/lib/i18n'
import { usePluginData, useUninstallPlugin } from '../api'
import type { PluginDataOut, PluginOut } from '../types'

type Choice = 'keep' | 'remove'

function Option({ value, choice, onChoose, title, children }: { value: Choice; choice: Choice; onChoose: (c: Choice) => void; title: string; children: ReactNode }) {
  const on = value === choice
  return (
    <button type="button" role="radio" aria-checked={on} onClick={() => onChoose(value)}
      className={cn('flex w-full items-start gap-3 rounded-card border px-(--card-x) py-(--card-y) text-left transition-colors',
        on ? 'border-accent bg-accent-soft' : 'border-border hover:bg-surface-hover')}>
      <span aria-hidden className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2', on ? 'border-accent' : 'border-border-strong')}>
        {on && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-semibold">{title}</span>
        <span className="mt-0.5 block text-[12.5px] text-muted">{children}</span>
      </span>
    </button>
  )
}

/** "3 properties, 1 automation" from the data summary, for the items `pick` selects. */
function listOf(data: PluginDataOut | undefined, pick: (onRemove: 'delete' | 'trash') => boolean): string {
  return (data?.items ?? []).filter((i) => i.count > 0 && pick(i.on_remove)).map((i) => `${i.count} × ${i.label}`).join(', ')
}

export function UninstallDialog({ plugin, onClose, onDone }: { plugin: PluginOut; onClose: () => void; onDone: () => void }) {
  const [choice, setChoice] = useState<Choice>('keep')
  const data = usePluginData(plugin.id)
  const uninstall = useUninstallPlugin()
  const made = listOf(data.data, () => true)
  const deleted = listOf(data.data, (r) => r === 'delete')
  const trashed = listOf(data.data, (r) => r === 'trash')
  const storage = data.data?.storage_bytes ?? 0

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} className="md:w-[min(96vw,520px)]"
      title={t('Uninstall “{name}”?', { name: plugin.name })}
      description={t('Its files and all its versions are deleted either way. What about what it made?')}
      footer={
        <>
          {uninstall.isError && <span className="mr-auto self-center text-[12.5px] text-error">{errorMessage(uninstall.error)}</span>}
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="danger" loading={uninstall.isPending} onClick={() => uninstall.mutate({ id: plugin.id, data: choice }, { onSuccess: onDone })}>
            {t('Uninstall')}
          </Button>
        </>
      }>
      <div role="radiogroup" aria-label={t('What happens to its data')} className="flex flex-col gap-2">
        <Option value="keep" choice={choice} onChoose={setChoice} title={t('Keep its data')}>
          {t('What it created stays, as yours: properties, views, automations and scripts (switched off), profiles, skills, and the tasks, documents and events it wrote.')}
          {made && <span className="mt-1 block text-text">{made}</span>}
        </Option>
        <Option value="remove" choice={choice} onChoose={setChoice} title={t('Remove its data')}>
          {t('What it registered is deleted; tasks, documents and events it created go to the Trash; its own storage is deleted.')}
          {deleted && <span className="mt-1 block text-text">{t('Deleted: {list}', { list: deleted })}</span>}
          {trashed && <span className="mt-1 block text-text">{t('To the Trash: {list}', { list: trashed })}</span>}
          {storage > 0 && <span className="mt-1 block text-text">{t('Its storage: {size}', { size: formatSize(storage) })}</span>}
        </Option>
        {data.isPending && <p className="text-[12.5px] text-muted">{t('Looking at what it made…')}</p>}
      </div>
    </Dialog>
  )
}
