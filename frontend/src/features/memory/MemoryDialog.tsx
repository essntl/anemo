import { useState } from 'react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field, Textarea } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { msg, t } from '@/lib/i18n'
import { KIND_LABELS, type Memory, type MemoryKind, useApproveMemory, useCreateMemory, useUpdateMemory } from './api'

const KIND_HINTS: Record<MemoryKind, string> = {
  preference: msg('How you like things'),
  fact: msg('About you, your life or work'),
  project: msg('Something you are working on'),
  instruction: msg('A standing order: always in context'),
}
const IMPORTANCE = [
  { value: '0.3', label: msg('Low') },
  { value: '0.5', label: msg('Normal') },
  { value: '0.8', label: msg('High') },
]
const nearest = (importance: number) => (importance < 0.4 ? '0.3' : importance > 0.65 ? '0.8' : '0.5')

/** Add or edit a memory. `memory` null: a new one. A suggestion is approved on save. */
export function MemoryDialog({ memory, onClose }: { memory: Memory | null; onClose: () => void }) {
  const create = useCreateMemory()
  const update = useUpdateMemory()
  const approve = useApproveMemory()
  const [content, setContent] = useState(memory?.content ?? '')
  const [kind, setKind] = useState<MemoryKind>(memory?.kind ?? 'fact')
  const [importance, setImportance] = useState(nearest(memory?.importance ?? 0.5))
  const [pinned, setPinned] = useState(memory?.pinned ?? false)
  const suggestion = memory?.status === 'pending'
  const pending = create.isPending || update.isPending || approve.isPending
  const error = create.error ?? update.error ?? approve.error

  const save = async () => {
    const body = { content: content.trim(), kind, importance: Number(importance), pinned }
    try {
      if (!memory) await create.mutateAsync(body)
      else {
        await update.mutateAsync({ id: memory.id, body })
        if (suggestion) await approve.mutateAsync({ id: memory.id })
      }
      onClose()
    } catch {
      // shown below
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} className="md:w-[min(94vw,520px)]"
      title={!memory ? t('Add a memory') : suggestion ? t('Edit and save suggestion') : t('Edit memory')}
      footer={
        <>
          {error && <span className="mr-auto self-center text-[12.5px] text-error">{errorMessage(error)}</span>}
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" loading={pending} disabled={content.trim().length < 1} onClick={() => void save()}>
            {suggestion ? t('Save to memory') : t('Save')}
          </Button>
        </>
      }>
      <Field label={t('What to remember')} hint={t('One clear statement works best. Never passwords or keys.')}>
        <Textarea autoFocus rows={3} maxLength={2000} value={content} placeholder={t('Prefers short answers with examples.')}
          onChange={(e) => setContent(e.target.value)} />
      </Field>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Field label={t('Kind')} hint={t(KIND_HINTS[kind])}>
          <Select value={kind} onValueChange={(v) => setKind(v as MemoryKind)}
            options={Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label: t(label) }))} />
        </Field>
        <Field label={t('Importance')}>
          <Select value={importance} onValueChange={setImportance} options={IMPORTANCE.map((o) => ({ value: o.value, label: t(o.label) }))} />
        </Field>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 text-[13px]">
        <div>
          <div className="font-medium">{t('Always in context')}</div>
          <div className="text-[12px] text-muted">{t('Otherwise it is used when a message relates to it.')}</div>
        </div>
        <Switch label={t('Always in context')} checked={pinned} onChange={setPinned} />
      </div>
    </Dialog>
  )
}
