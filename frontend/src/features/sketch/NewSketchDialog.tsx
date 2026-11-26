import { type FormEvent, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Input } from '@/components/ui/Input'
import { Segmented } from '@/components/ui/Segmented'
import { msg, t } from '@/lib/i18n'
import type { SketchLayout } from '@/features/documents/api'

const LAYOUTS: { value: SketchLayout; label: string; hint: string }[] = [
  { value: 'infinite', label: msg('Endless sheet'), hint: msg('One sheet that grows in every direction: for boards, maps and diagrams.') },
  { value: 'pages', label: msg('A4 pages'), hint: msg('Pages one under the other: for notes by hand, to print or export.') },
]

/** The title and the kind of sheet for a new sketch. */
export function NewSketchDialog({ onCreate, onClose, busy }: {
  onCreate: (title: string, layout: SketchLayout) => void
  onClose: () => void
  busy?: boolean
}) {
  const [title, setTitle] = useState('')
  const [layout, setLayout] = useState<SketchLayout>('infinite')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (title.trim()) onCreate(title.trim(), layout)
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={t('New sketch')}
      description={t('A drawing sheet, kept as a document: it can be moved, linked, embedded in a document and shown to the assistant.')}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-[13px] font-medium">
          {t('Title')}
          <Input value={title} autoFocus placeholder={t('e.g. Kitchen plan')} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        </label>
        <div className="flex flex-col gap-1.5">
          <Segmented label={t('Sheet')} value={layout} onChange={setLayout}
            options={LAYOUTS.map((l) => ({ value: l.value, label: t(l.label) }))} />
          <p className="text-[12.5px] text-muted">{t(LAYOUTS.find((l) => l.value === layout)!.hint)}</p>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!title.trim()}>{t('Create')}</Button>
        </div>
      </form>
    </Dialog>
  )
}
