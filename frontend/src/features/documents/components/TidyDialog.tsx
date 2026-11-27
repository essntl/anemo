/**
 * Tidy up (docs/specs/26-document-organisation.md, feature 5): the model's suggestions for
 * the documents in view, by document, every change with its own checkbox. Nothing changes
 * until Apply selected; then each change is a normal revision or move (undoable).
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Sparkles } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Dialog } from '@/components/ui/Dialog'
import { toast } from '@/components/ui/toast'
import { type PropertyDefinition, useProperties, valueLabel } from '@/features/properties/api'
import { plural, t } from '@/lib/i18n'
import { TIDY_MAX, type TidyChange, type TidySuggestion, useApplyTidy, useTidySuggestions } from '../api'

const id = (s: TidySuggestion, i: number) => `${s.document_id}:${i}`

/** What one change does, in words. */
function describe(c: TidyChange, s: TidySuggestion, definitions: Map<string, PropertyDefinition>) {
  if (c.kind === 'archive') return <>{t('Archive')}</>
  if (c.kind === 'title') return <>{t('Rename to “{title}”', { title: c.title ?? '' })}</>
  if (c.kind === 'folder') return <>{t('Move to')} <span className="font-medium">{c.folder || t('Documents')}</span></>
  const definition = definitions.get(c.key ?? '')
  const before = s.current[c.key ?? '']
  return (
    <>
      {definition?.label ?? c.key}:{' '}
      {before !== undefined && before !== null && <><span className="text-muted">{valueLabel(definition, before)}</span> <ArrowRight className="inline h-3 w-3" aria-label={t('to')} /> </>}
      <span className="font-medium">{valueLabel(definition, c.value)}</span>
    </>
  )
}

/**
 * `ids`: the documents in view (not archived, most recently changed first); only the first
 * TIDY_MAX are looked at, and the dialog says so. `within`: a project's folder (moves stay in it).
 */
export function TidyDialog({ ids, within, onClose }: { ids: string[]; within: string | null; onClose: () => void }) {
  const ask = useTidySuggestions()
  const apply = useApplyTidy()
  const properties = useProperties()
  const definitions = useMemo(() => new Map((properties.data ?? []).map((d) => [d.key, d])), [properties.data])
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const sent = useMemo(() => ids.slice(0, TIDY_MAX), [ids])
  const { mutate } = ask
  useEffect(() => {
    mutate({ ids: sent, within }, {
      onSuccess: (r) => setChosen(new Set(r.suggestions.flatMap((s) => s.changes.map((_, i) => id(s, i))))),
    })
    // Asked once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const result = ask.data
  const list = result?.suggestions ?? []
  const every = list.flatMap((s) => s.changes.map((_, i) => id(s, i)))
  const toggle = (key: string) => {
    const next = new Set(chosen)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setChosen(next)
  }
  const applySelected = () => {
    const changes = list.flatMap((s) => s.changes.filter((_, i) => chosen.has(id(s, i))).map((c) => ({ ...c, document_id: s.document_id })))
    apply.mutate({ changes, within }, {
      onSuccess: (r) => {
        toast({ message: [plural(r.applied, '{n} change made. Each one can be undone in Activity.', '{n} changes made. Each one can be undone in Activity.'), ...r.problems].join(' ') })
        onClose()
      },
      onError: (err) => toast({ message: errorMessage(err) }),
    })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} className="md:w-[min(94vw,720px)]"
      title={t('Tidy up')}
      description={t('Suggestions from the assistant for the documents in view. Nothing changes until you apply them.')}
      footer={result && list.length > 0 ? (
        <>
          <Button variant="ghost" onClick={() => setChosen(new Set())} disabled={chosen.size === 0}>{t('Reject all')}</Button>
          <Button variant="ghost" onClick={() => setChosen(new Set(every))} disabled={chosen.size === every.length}>{t('Accept all')}</Button>
          <Button variant="primary" disabled={chosen.size === 0} loading={apply.isPending} onClick={applySelected}>
            {plural(chosen.size, 'Apply {n} selected', 'Apply {n} selected')}
          </Button>
        </>
      ) : (
        <Button variant="ghost" onClick={onClose}>{t('Close')}</Button>
      )}>
      <div className="max-h-[60vh] space-y-3 overflow-auto text-[13px]">
        {ids.length > TIDY_MAX && (
          <p className="rounded-control bg-surface-2 px-3 py-2 text-muted">
            {t('Only the {max} most recently changed of the {count} documents in view are looked at.', { max: TIDY_MAX, count: ids.length })}
          </p>
        )}
        {ask.isPending && (
          <p className="flex items-center gap-2 py-6 text-muted">
            <Sparkles className="h-4 w-4 animate-pulse text-accent motion-reduce:animate-none" />
            {plural(sent.length, 'Looking at {n} document…', 'Looking at {n} documents…')}
          </p>
        )}
        {ask.isError && <p className="text-error">{errorMessage(ask.error)}</p>}
        {result && result.failed > 0 && (
          <p className="rounded-control bg-warning/10 px-3 py-2">
            {plural(result.failed, '{n} document couldn’t be looked at (the model didn’t answer in time).', '{n} documents couldn’t be looked at (the model didn’t answer in time).')}
          </p>
        )}
        {result && list.length === 0 && (
          <p className="py-6 text-center text-muted">
            {result.considered === 0 ? t('There is nothing to tidy here.') : t('Everything looks tidy: no suggestions.')}
          </p>
        )}
        {list.map((s) => (
          <section key={s.document_id} aria-label={s.title} className="rounded-card border border-border p-3">
            <div className="font-medium">{s.title}</div>
            <div className="text-[11.5px] text-subtle">{s.path}</div>
            {s.why && <div className="mt-1 text-[12px] italic text-muted">{s.why}</div>}
            <ul className="mt-2 space-y-1">
              {s.changes.map((c, i) => (
                <li key={id(s, i)}>
                  <label className="flex items-start gap-2">
                    <Checkbox checked={chosen.has(id(s, i))} onChange={() => toggle(id(s, i))} className="mt-0.5" />
                    <span>{describe(c, s, definitions)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  )
}
