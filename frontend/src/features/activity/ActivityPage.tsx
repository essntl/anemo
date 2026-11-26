/**
 * Activity: everything that was changed (tasks, events, documents, files, projects), by
 * whom (you, the assistant in a chat, an automation, a script, a plugin), newest first,
 * with Undo where the change can be put back. A batch (one tool call that changed many
 * items) is one row that opens. The server keeps 90 days (docs/specs/19-activity-log.md).
 */
import { type ReactNode, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ChevronDown, ChevronRight, History, Undo2, X } from 'lucide-react'
import { ApiError, errorMessage } from '@/api/client'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { confirmDialog } from '@/components/ui/dialogs'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { Select } from '@/components/ui/Select'
import { toast } from '@/components/ui/toast'
import { cn } from '@/lib/cn'
import { formatAgo, formatDateTime } from '@/lib/format'
import { plural, rich, t } from '@/lib/i18n'
import { type ActivityEntry, type ActorKind, type ObjectType, useActivity, useUndoEntry, useUndoGroup } from './api'
import { type Row, toRows } from './rows'
import {
  ACTOR_FILTERS, blockedReason, fieldsText, OBJECT_FILTERS, objectWord, sinceFor, TIME_FILTERS, type TimeRange, verbOf,
} from './labels'

const linkClass = 'font-medium text-text underline-offset-2 hover:text-accent hover:underline'

/** Who did it: "You", "The assistant in ‹chat›", "Automation ‹name›", "Script ‹name›", "Plugin ‹name›". */
export function ActorName({ actor }: { actor: ActivityEntry['actor'] }) {
  if (!actor) return <>{t('Someone')}</>
  const name = { name: actor.label }
  const to = (c: string) => (actor.url ? <Link to={actor.url} className={linkClass}>{c}</Link> : c)
  switch (actor.kind) {
    case 'chat':
      return <>{actor.url ? rich('The assistant in <chat>{name}</chat>', { chat: to }, name) : t('The assistant in a deleted chat')}</>
    case 'automation':
      if (!actor.url) return <>{t('A deleted automation')}</>
      return <>{actor.automation_kind === 'script' ? rich('Script <run>{name}</run>', { run: to }, name) : rich('Automation <run>{name}</run>', { run: to }, name)}</>
    case 'plugin':
      // The server names it "the plugin ‹name›" (provenance), the page "Plugin ‹name›".
      return <>{actor.url ? rich('Plugin <page>{name}</page>', { page: to }, { name: actor.label.replace(/^the plugin /, '') }) : t('A removed plugin')}</>
    case 'external':
      return <>{t('Outside Anemo')}</>
    default:
      return <>{t('You')}</>
  }
}

/**
 * What happened: "[Changed] task Buy milk: title, due date", with a link to the item while
 * it exists. The verb, the kind of item and its name stand apart, so each language can
 * translate them as words without building a sentence.
 */
function What({ entry }: { entry: ActivityEntry }) {
  const name = entry.object_label ?? entry.summary
  const target = entry.object_url ? <Link to={entry.object_url} className={linkClass}>{name}</Link> : <span className="font-medium text-text">{name}</span>
  return (
    <span>
      <span className="rounded bg-surface-2 px-1.5 py-px text-[11.5px] font-medium text-muted">{verbOf(entry)}</span>{' '}
      <span className="text-muted">{objectWord(entry.object_type)}</span> {target}
      {entry.fields.length > 0 && <span className="text-muted">{': '}{fieldsText(entry.fields)}</span>}
    </span>
  )
}

function When({ iso }: { iso: string }) {
  return <time dateTime={iso} title={formatDateTime(iso)} className="shrink-0 text-[12px] text-muted">{formatAgo(iso)}</time>
}

/** The details of a 409 activity_conflict, as a line for the "Undo anyway?" question. */
function conflictText(err: ApiError): string {
  const differs = (err.details as { differs?: { field: string }[] } | null)?.differs ?? []
  const fields = fieldsText(differs.map((d) => d.field).filter((f) => f !== 'later_changes' && f !== 'content'))
  return fields ? t('Changed since: {fields}.', { fields }) : err.message
}

function UndoButton({ entry }: { entry: ActivityEntry }) {
  const undo = useUndoEntry()
  if (entry.undo_blocked) {
    return (
      <span title={blockedReason(entry.undo_blocked)}>
        <Button size="sm" variant="ghost" icon={<Undo2 className="h-3.5 w-3.5" />} disabled aria-label={t('Undo')}>{t('Undo')}</Button>
      </span>
    )
  }
  const run = async (force = false) => {
    try {
      const done = await undo.mutateAsync({ id: entry.id, force })
      toast({ message: done.message })
    } catch (err) {
      if (!force && err instanceof ApiError && err.code === 'activity_conflict') {
        const sure = await confirmDialog({
          title: t('It was changed since. Undo anyway?'),
          message: conflictText(err),
          confirmLabel: t('Undo anyway'),
          focusCancel: true,
          danger: true,
        })
        if (sure) await run(true)
        return
      }
      toast({ message: errorMessage(err) })
    }
  }
  return (
    <Button size="sm" variant="ghost" icon={<Undo2 className="h-3.5 w-3.5" />} loading={undo.isPending} onClick={() => void run()} title={t('Undo this change')}>
      {t('Undo')}
    </Button>
  )
}

function EntryRow({ entry, nested = false }: { entry: ActivityEntry; nested?: boolean }) {
  return (
    <li className={cn('flex items-start gap-3 py-2.5', nested ? 'pl-6' : 'px-1', entry.undone_at && 'opacity-60')} data-testid="activity-entry">
      <div className="min-w-0 flex-1 text-[13.5px] leading-snug">
        {!nested && <div className="text-[12.5px] text-muted"><ActorName actor={entry.actor} /></div>}
        <What entry={entry} />
        {entry.undone_at && <Badge className="ml-2">{t('Undone')}</Badge>}
      </div>
      <When iso={entry.created_at} />
      <UndoButton entry={entry} />
    </li>
  )
}

function GroupRow({ row }: { row: Extract<Row, { kind: 'group' }> }) {
  const [open, setOpen] = useState(false)
  const undoGroup = useUndoGroup()
  const first = row.entries[0]
  const undoable = row.entries.filter((e) => !e.undo_blocked).length
  const run = async (force = false) => {
    try {
      const { results } = await undoGroup.mutateAsync({ groupId: row.id, force })
      const failed = results.filter((r) => !r.ok)
      const conflicts = failed.filter((r) => r.code === 'activity_conflict')
      if (!force && conflicts.length > 0) {
        const sure = await confirmDialog({
          title: plural(conflicts.length, '{n} item was changed since. Undo it anyway?', '{n} items were changed since. Undo them anyway?'),
          message: t('The others were undone.'),
          confirmLabel: t('Undo anyway'),
          focusCancel: true,
          danger: true,
        })
        if (sure) await run(true)
        return
      }
      toast({ message: failed.length ? plural(failed.length, '{n} change could not be undone', '{n} changes could not be undone') : t('Undone') })
    } catch (err) {
      toast({ message: errorMessage(err) })
    }
  }
  return (
    <li className="py-2.5 px-1" data-testid="activity-group">
      <div className="flex items-start gap-3">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
          className="flex min-w-0 flex-1 items-start gap-1 text-left text-[13.5px] leading-snug">
          {open ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted" />}
          <span className="min-w-0">
            <span className="block text-[12.5px] text-muted"><ActorName actor={first.actor} /></span>
            <span className="font-medium">{row.label}</span>{' '}
            <span className="text-muted">{plural(row.entries.length, '({n} change)', '({n} changes)')}</span>
          </span>
        </button>
        <When iso={first.created_at} />
        {undoable > 0 ? (
          <Button size="sm" variant="ghost" icon={<Undo2 className="h-3.5 w-3.5" />} loading={undoGroup.isPending} onClick={() => void run()}>
            {t('Undo all')}
          </Button>
        ) : (
          <span title={t('Nothing in it can be undone')}>
            <Button size="sm" variant="ghost" icon={<Undo2 className="h-3.5 w-3.5" />} disabled>{t('Undo all')}</Button>
          </span>
        )}
      </div>
      {open && <ul className="mt-1 divide-y divide-border">{row.entries.map((e) => <EntryRow key={e.id} entry={e} nested />)}</ul>}
    </li>
  )
}

function Filter<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return <Select variant="pill" aria-label={label} value={value} onValueChange={(v) => onChange(v as T)} options={options.map((o) => ({ value: o.value, label: t(o.label) }))} />
}

export function ActivityPage() {
  const [params, setParams] = useSearchParams()
  const actorKind = (params.get('actor') ?? '') as ActorKind | ''
  const objectType = (params.get('object_type') ?? '') as ObjectType | ''
  const objectId = params.get('object_id') ?? ''
  const range = (params.get('time') ?? '') as TimeRange
  const since = useMemo(() => sinceFor(range), [range])
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value)
    else next.delete(key)
    if (key === 'object_type') next.delete('object_id')
    setParams(next, { replace: true })
  }

  const activity = useActivity({ actorKind: actorKind || undefined, objectType: objectType || undefined, objectId: objectId || undefined, since })
  const entries = useMemo(() => activity.data?.pages.flatMap((p) => p.items) ?? [], [activity.data])
  const rows = useMemo(() => toRows(entries), [entries])

  let body: ReactNode
  if (activity.isError) body = <p className="p-4 text-[13px] text-error">{errorMessage(activity.error)}</p>
  else if (activity.isPending) body = <p className="p-4 text-[13px] text-muted">{t('Loading…')}</p>
  else if (rows.length === 0) {
    body = <EmptyState icon={<History className="h-5 w-5" />} title={t('Nothing here yet')}
      description={t('Changes to tasks, events, documents, files and projects appear here, by you and by the assistant, automations, scripts and plugins.')} />
  } else {
    body = (
      <ul className="divide-y divide-border px-3">
        {rows.map((row) => (row.kind === 'group' ? <GroupRow key={row.id} row={row} /> : <EntryRow key={row.entry.id} entry={row.entry} />))}
      </ul>
    )
  }

  return (
    <div className="mx-auto max-w-4xl p-4 md:px-8 md:pb-8 md:pt-2">
      <PageHeader title={t('Activity')} />
      <p className="mb-3 max-w-2xl text-[13px] text-muted">{t('What was changed, by whom, and Undo where it can be put back. Kept for 90 days.')}</p>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Filter label={t('Who')} value={actorKind} options={ACTOR_FILTERS} onChange={(v) => set('actor', v)} />
        <Filter label={t('What')} value={objectType} options={OBJECT_FILTERS} onChange={(v) => set('object_type', v)} />
        <Filter label={t('When')} value={range} options={TIME_FILTERS} onChange={(v) => set('time', v)} />
        {objectId && (
          <span className="inline-flex h-8 items-center gap-1 rounded-full bg-accent-soft pl-3 pr-1 text-[12.5px] text-accent">
            {t('History of one item')}
            <button type="button" aria-label={t('Show everything')} onClick={() => set('object_id', '')} className="rounded-full p-1 hover:bg-surface-hover">
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
      </div>
      <Card className="p-0">{body}</Card>
      {activity.hasNextPage && (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" loading={activity.isFetchingNextPage} onClick={() => void activity.fetchNextPage()}>{t('Show more')}</Button>
        </div>
      )}
    </div>
  )
}
