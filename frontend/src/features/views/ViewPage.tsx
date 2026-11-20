/**
 * One saved view: every document, task and event its query matches (`types`), as a
 * list, a table (properties as columns, sortable, editable in place) or a board
 * (grouped by a select property). An item shows in every view it matches; nothing is
 * moved or copied.
 */
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Filter, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { api, errorMessage, unwrap } from '@/api/client'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { confirmDialog, promptDialog } from '@/components/ui/dialogs'
import { EmptyState } from '@/components/ui/EmptyState'
import { PageHeader } from '@/components/ui/PageHeader'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { toast } from '@/components/ui/toast'
import { TYPE_ICONS } from '@/features/links/linkTypes'
import { type PropertyDefinition, useProperties, valueLabel } from '@/features/properties/api'
import { useProjects } from '@/features/tasks/api'
import { cn } from '@/lib/cn'
import { formatWhen } from '@/lib/format'
import { msg, plural, t } from '@/lib/i18n'
import { type SavedView, type ViewLayout, type ViewRow, useDeleteView, useSetRowProperty, useUpdateView, useView, useViewRows, viewRowsKey } from './api'
import { groupRows, queryText, sortRows, tableColumns } from './query'

type Shows = 'document' | 'task' | 'event' | 'all'
const SHOWS: { value: Shows; label: string }[] = [
  { value: 'document', label: msg('Documents') },
  { value: 'task', label: msg('Tasks') },
  { value: 'event', label: msg('Events') },
  { value: 'all', label: msg('Documents, tasks and events') },
]
/** What a view shows, from its types. */
function showsOf(types: string[] | undefined): Shows {
  const list = types?.length ? types : ['document']
  if (list.length === 1) return list[0] as Shows
  return 'all'
}

const LAYOUTS: { value: ViewLayout; label: string }[] = [
  { value: 'list', label: msg('List') },
  { value: 'table', label: msg('Table') },
  { value: 'board', label: msg('Board') },
]

function Chips({ row, definitions }: { row: ViewRow; definitions: Map<string, PropertyDefinition> }) {
  const entries = Object.entries(row.properties)
  if (entries.length === 0) return null
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {entries.map(([key, value]) => (
        <span key={key} className="rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] text-muted">
          {definitions.get(key)?.label ?? key}: {valueLabel(definitions.get(key), value)}
        </span>
      ))}
    </span>
  )
}

function ListLayout({ rows, definitions }: { rows: ViewRow[]; definitions: Map<string, PropertyDefinition> }) {
  return (
    <ul className="overflow-hidden rounded-card border border-border bg-card shadow-soft">
      {rows.map((row) => (
        <li key={row.id} className="border-t border-border first:border-t-0">
          <Link to={row.url} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-surface-hover [&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0 [&>svg]:text-muted">
            {TYPE_ICONS[row.type]}
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{row.title}</span>
            <Chips row={row} definitions={definitions} />
            <span className="shrink-0 text-[12px] text-subtle">{formatWhen(row.updated_at)}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

function Cell({ row, definition, onChange }: { row: ViewRow; definition: PropertyDefinition | undefined; onChange: (value: unknown) => void }) {
  const value = row.properties[definition?.key ?? '']
  if (definition?.type === 'select') {
    return (
      <Select variant="ghost" value={value === undefined ? '' : String(value)} aria-label={t('{property} of {title}', { property: definition.label, title: row.title })}
        onValueChange={onChange}
        options={[{ value: '', label: '–' }, ...definition.options.map((o) => ({ value: o.slug, label: o.label }))]} />
    )
  }
  return <span className="text-[13px]">{valueLabel(definition, value)}</span>
}

export function TableLayout({ view, rows, definitions, onChange }: { view: SavedView; rows: ViewRow[]; definitions: Map<string, PropertyDefinition>; onChange: (row: ViewRow, key: string, value: unknown) => void }) {
  const first = view.query.sort?.[0]
  const [sort, setSort] = useState<{ key: string; desc: boolean }>(first ? { key: first.key, desc: first.desc ?? false } : { key: 'title', desc: false })
  const columns = tableColumns(view.query, rows, [...definitions.keys()])
  const sorted = sortRows(rows, sort.key, sort.desc)
  // Grouped by a select property ("Clients", table grouped by client): a section per value.
  const groupBy = view.query.group_by ? definitions.get(view.query.group_by) : undefined
  const groups: [string, ViewRow[]][] = groupBy
    ? groupRows(sorted, groupBy.key, groupBy.options.map((o) => o.slug))
    : [['', sorted]]
  const header = (key: string, label: string) => (
    <th key={key} scope="col" className="px-3 py-2 text-left font-medium" aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
      <button type="button" className="inline-flex items-center gap-1 hover:text-text" onClick={() => setSort({ key, desc: sort.key === key ? !sort.desc : false })}>
        {label}
        {sort.key === key && (sort.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
      </button>
    </th>
  )
  return (
    <div className="overflow-x-auto rounded-card border border-border bg-card shadow-soft">
      <table className="w-full min-w-[32rem] text-[13px]">
        <thead className="border-b border-border text-[12px] text-muted">
          <tr>
            {header('title', t('Title'))}
            {columns.map((key) => header(key, definitions.get(key)?.label ?? key))}
            {header('updated_at', t('Changed'))}
          </tr>
        </thead>
        {groups.map(([value, items]) => (
          <tbody key={value || '-'}>
            {groupBy && (
              <tr className="border-t border-border bg-surface-2">
                <th scope="rowgroup" colSpan={columns.length + 2} className="px-3 py-1.5 text-left text-[12px] font-semibold text-muted">
                  {value ? valueLabel(groupBy, value) : t('No {property}', { property: groupBy.label })} <span className="text-subtle">{items.length}</span>
                </th>
              </tr>
            )}
            {items.map((row) => (
            <tr key={row.id} className="border-t border-border hover:bg-surface-hover">
              <td className="px-3 py-1.5"><Link to={row.url} className="font-medium hover:underline">{row.title}</Link></td>
              {columns.map((key) => (
                <td key={key} className="px-1.5 py-1">
                  <Cell row={row} definition={definitions.get(key)} onChange={(v) => onChange(row, key, v)} />
                </td>
              ))}
              <td className="whitespace-nowrap px-3 py-1.5 text-[12px] text-subtle">{formatWhen(row.updated_at)}</td>
            </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
  )
}

function BoardLayout({ view, rows, definitions, onChange }: { view: SavedView; rows: ViewRow[]; definitions: Map<string, PropertyDefinition>; onChange: (row: ViewRow, key: string, value: unknown) => void }) {
  const selects = [...definitions.values()].filter((d) => d.type === 'select')
  const key = view.query.group_by ?? (selects.find((d) => d.key === 'status') ?? selects[0])?.key
  const definition = key ? definitions.get(key) : undefined
  if (!definition) return <p className="text-[13px] text-muted">{t('A board needs a property with a list of values to group by.')}</p>
  const groups = groupRows(rows, definition.key, definition.options.map((o) => o.slug))
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {groups.map(([value, items]) => (
        <section key={value || '-'} aria-label={value ? valueLabel(definition, value) : t('No {property}', { property: definition.label })}
          className="flex w-64 shrink-0 flex-col gap-1.5 rounded-card bg-surface-2 p-2">
          <h2 className="px-1 text-[12px] font-semibold text-muted">
            {value ? valueLabel(definition, value) : t('No {property}', { property: definition.label })} <span className="text-subtle">{items.length}</span>
          </h2>
          {items.map((row) => (
            <div key={row.id} className="flex flex-col gap-1 rounded-control border border-border bg-card p-2 shadow-soft">
              <Link to={row.url} className="text-[13px] font-medium hover:underline">{row.title}</Link>
              <Select variant="ghost" value={value} aria-label={t('Move {title} to', { title: row.title })} onValueChange={(v) => onChange(row, definition.key, v)}
                options={[{ value: '', label: t('No {property}', { property: definition.label }) }, ...definition.options.map((o) => ({ value: o.slug, label: o.label }))]} />
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

export function ViewPage() {
  const { viewId = '' } = useParams()
  const navigate = useNavigate()
  const view = useView(viewId)
  const rows = useViewRows(viewId)
  const properties = useProperties()
  const projects = useProjects()
  const update = useUpdateView()
  const remove = useDeleteView()
  const setProperty = useSetRowProperty(viewId)
  const qc = useQueryClient()
  const definitions = new Map((properties.data ?? []).map((d) => [d.key, d]))
  const fail = (err: unknown) => toast({ message: errorMessage(err) })

  if (view.isError) {
    return <div className="p-8 text-[13px] text-error">{errorMessage(view.error)}</div>
  }
  const v = view.data
  if (!v) return null
  const text = queryText(v.query, projects.data ?? [])
  const refresh = () => void qc.invalidateQueries({ queryKey: viewRowsKey(viewId) })

  const rename = async () => {
    const name = await promptDialog({ title: t('Rename view'), label: t('Name'), initial: v.name, confirmLabel: t('Rename') })
    if (name?.trim()) update.mutate({ id: v.id, body: { name: name.trim() } }, { onError: fail, onSuccess: () => void view.refetch() })
  }
  const editFilters = async () => {
    const next = await promptDialog({
      title: t('What the view shows'),
      label: t('Filters and words'),
      initial: text ?? '',
      placeholder: 'client:ludmyla-doula tags:legal in:tech-services',
      message: t('As in search: property:value for each property, in:project or folder, and words to look for.'),
      confirmLabel: t('Save'),
      allowEmpty: true,
    })
    if (next === null) return
    try {
      const parsed = unwrap(await api.GET('/api/search', { params: { query: { q: next.trim() || ' ', kinds: 'document', limit: 1, mode: 'keyword' } } }))
      const bad = (parsed.filters ?? []).find((f) => !f.ok)
      if (bad) return toast({ message: `${bad.label}: ${bad.message}` })
      const query = { ...v.query, ...(parsed.view ?? { text: null, folder: null, project_id: null, properties: {} }) }
      update.mutate({ id: v.id, body: { query } }, { onError: fail, onSuccess: () => { void view.refetch(); refresh() } })
    } catch (err) {
      fail(err)
    }
  }
  const setLayout = (layout: ViewLayout) => update.mutate({ id: v.id, body: { layout } }, { onError: fail, onSuccess: () => void view.refetch() })
  const del = async () => {
    if (await confirmDialog({ title: t('Delete the view “{name}”?', { name: v.name }), message: t('The documents stay as they are.'), confirmLabel: t('Delete'), danger: true })) {
      remove.mutate(v.id, { onSuccess: () => navigate('/documents'), onError: fail })
    }
  }
  const list = rows.data?.rows ?? []
  const onChange = (row: ViewRow, key: string, value: unknown) => setProperty.mutate({ row, key, value }, { onError: fail })

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-3 p-4 md:px-8 md:pb-8 md:pt-2">
      <PageHeader title={v.name}
        detail={rows.data ? plural(list.length, '{n} item', '{n} items') + (rows.data.truncated ? '+' : '') : undefined}
        after={
          <ActionMenu actions={[
            { label: t('Rename'), icon: <Pencil />, onSelect: () => void rename() },
            { label: t('Change what it shows'), icon: <Filter />, onSelect: () => void editFilters() },
            v.pinned
              ? { label: t('Take out of the sidebar'), icon: <PinOff />, onSelect: () => update.mutate({ id: v.id, body: { pinned: false } }, { onError: fail, onSuccess: () => void view.refetch() }) }
              : { label: t('Show in the sidebar'), icon: <Pin />, onSelect: () => update.mutate({ id: v.id, body: { pinned: true } }, { onError: fail, onSuccess: () => void view.refetch() }) },
            { label: t('Delete'), icon: <Trash2 />, danger: true, onSelect: () => void del() },
          ]} />
        } />
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label={t('Layout')} size="sm" value={v.layout} onChange={setLayout} options={LAYOUTS.map((l) => ({ value: l.value, label: t(l.label) }))} />
        <Select variant="pill" aria-label={t('Shows')} value={showsOf(v.query.types)}
          onValueChange={(shows) => update.mutate(
            { id: v.id, body: { query: { ...v.query, types: shows === 'all' ? ['document', 'task', 'event'] : [shows as 'document' | 'task' | 'event'] } } },
            { onError: fail, onSuccess: () => { void view.refetch(); refresh() } },
          )}
          options={SHOWS.map((o) => ({ value: o.value, label: t(o.label) }))} />
        {v.layout !== 'list' && (
          <Select variant="pill" aria-label={t('Group by')} value={v.query.group_by ?? ''}
            onValueChange={(key) => update.mutate({ id: v.id, body: { query: { ...v.query, group_by: key || null } } }, { onError: fail, onSuccess: () => void view.refetch() })}
            options={[{ value: '', label: t('Not grouped') }, ...[...definitions.values()].filter((d) => d.type === 'select' || d.type === 'multi_select').map((d) => ({ value: d.key, label: t('Grouped by {property}', { property: d.label }) }))]} />
        )}
        <button type="button" onClick={() => void editFilters()} className={cn('min-w-0 flex-1 truncate rounded-control px-2 py-1 text-left text-[12.5px] text-muted hover:bg-surface-hover')}>
          {text ? <code>{text}</code> : t('Every document')}
        </button>
      </div>
      {rows.isError && <p className="text-[13px] text-error">{errorMessage(rows.error)}</p>}
      {rows.data && list.length === 0 && (
        <EmptyState icon={<Filter className="h-5 w-5" />} title={t('Nothing matches this view yet')}
          description={t('Give documents, tasks or events the properties it looks for, or change what it shows.')} />
      )}
      {list.length > 0 && v.layout === 'list' && <ListLayout rows={list} definitions={definitions} />}
      {list.length > 0 && v.layout === 'table' && <TableLayout view={v} rows={list} definitions={definitions} onChange={onChange} />}
      {list.length > 0 && v.layout === 'board' && <BoardLayout view={v} rows={list} definitions={definitions} onChange={onChange} />}
    </div>
  )
}
