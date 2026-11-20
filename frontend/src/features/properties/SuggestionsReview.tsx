/**
 * Properties the assistant suggested for existing documents (bulk tagging), as a table
 * to review: apply all, some or none. Nothing is written to a document until applied.
 */
import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Dialog } from '@/components/ui/Dialog'
import { toast } from '@/components/ui/toast'
import { plural, t } from '@/lib/i18n'
import { type PropertyDefinition, useApplySuggestions, useDismissSuggestions, useProperties, useSuggestions, valueLabel } from './api'

function Values({ values, definitions }: { values: Record<string, unknown>; definitions: Map<string, PropertyDefinition> }) {
  const entries = Object.entries(values)
  if (entries.length === 0) return <span className="text-subtle">–</span>
  return (
    <span className="flex flex-wrap gap-1">
      {entries.map(([key, value]) => (
        <span key={key} className="rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px]">
          {definitions.get(key)?.label ?? key}: {value === null ? t('none') : valueLabel(definitions.get(key), value)}
        </span>
      ))}
    </span>
  )
}

export function SuggestionsReview() {
  const suggestions = useSuggestions()
  const properties = useProperties()
  const apply = useApplySuggestions()
  const dismiss = useDismissSuggestions()
  const [open, setOpen] = useState(false)
  const [chosen, setChosen] = useState<Set<string> | null>(null)
  const list = suggestions.data ?? []
  if (list.length === 0) return null
  const definitions = new Map((properties.data ?? []).map((d) => [d.key, d]))
  const selected = chosen ?? new Set(list.map((s) => s.id))
  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setChosen(next)
  }
  const ids = [...selected]
  const close = () => { setOpen(false); setChosen(null) }
  const fail = (err: unknown) => toast({ message: errorMessage(err) })

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="mx-3 mt-2 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-control bg-accent-soft px-3 py-2 text-left text-[12.5px] font-medium text-accent hover:opacity-90">
        <Sparkles className="h-4 w-4 shrink-0" />
        {plural(list.length, '{n} suggested property change to review', '{n} suggested property changes to review')}
      </button>
      <Dialog open={open} onOpenChange={(next) => !next && close()} className="md:w-[min(94vw,760px)]"
        title={t('Suggested properties')}
        description={t('The assistant suggested these for existing documents. Applying one writes it into the document, with a revision.')}
        footer={
          <>
            <Button variant="ghost" disabled={ids.length === 0} loading={dismiss.isPending}
              onClick={() => dismiss.mutate(ids, { onError: fail, onSuccess: () => setChosen(null) })}>
              {t('Dismiss selected')}
            </Button>
            <Button variant="primary" disabled={ids.length === 0} loading={apply.isPending}
              onClick={() => apply.mutate(ids, {
                onError: fail,
                onSuccess: (r) => {
                  setChosen(null)
                  toast({ message: r.problems.length ? r.problems.join(' ') : plural(r.applied, '{n} document changed.', '{n} documents changed.') })
                },
              })}>
              {t('Apply selected')}
            </Button>
          </>
        }>
        <div className="max-h-[60vh] overflow-auto">
          <table className="w-full text-[13px]">
            <thead className="text-left text-[12px] text-muted">
              <tr>
                <th className="w-8 py-1.5">
                  <Checkbox aria-label={t('Select all')} checked={selected.size === list.length}
                    onChange={(e) => setChosen(e.target.checked ? new Set(list.map((s) => s.id)) : new Set())} />
                </th>
                <th className="py-1.5 font-medium">{t('Document')}</th>
                <th className="py-1.5 font-medium">{t('Now')}</th>
                <th className="py-1.5 font-medium">{t('Suggested')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id} className="border-t border-border align-top">
                  <td className="py-2"><Checkbox aria-label={t('Apply to {title}', { title: s.title })} checked={selected.has(s.id)} onChange={() => toggle(s.id)} /></td>
                  <td className="py-2 pr-2"><div className="font-medium">{s.title}</div><div className="text-[11.5px] text-subtle">{s.path}</div></td>
                  <td className="py-2 pr-2"><Values values={s.current} definitions={definitions} /></td>
                  <td className="py-2"><Values values={s.suggested} definitions={definitions} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Dialog>
    </>
  )
}
