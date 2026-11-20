/**
 * Settings > Properties: what documents can be tagged with. Each property has a type,
 * where it may be used (everywhere or some projects) and, for select types, its list of
 * values. A value's label is only shown (changing it touches no file); changing its
 * name in the files ("slug") or merging two values rewrites every document that has it.
 * Folder defaults give new documents in a folder their properties.
 */
import { useState } from 'react'
import { FileCode, GitMerge, House, Pencil, Tag, Trash2 } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { ActionMenu } from '@/components/ui/ActionMenu'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { chooseDialog, confirmDialog, promptDialog } from '@/components/ui/dialogs'
import { Field, Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { toast } from '@/components/ui/toast'
import { useDocuments } from '@/features/documents/api'
import { useSaveSection, useSettings } from '@/features/settings/api'
import { useProjects } from '@/features/tasks/api'
import { msg, plural, t } from '@/lib/i18n'
import {
  type PropertyDefinition,
  type PropertyOption,
  type PropertyType,
  useAddOption,
  useCreateProperty,
  useDeleteOption,
  useDeleteProperty,
  useMergeOption,
  useProperties,
  useReindexDocuments,
  useRenameOption,
  useUpdateOption,
} from './api'

const TYPES: { value: PropertyType; label: string }[] = [
  { value: 'select', label: msg('One value from a list') },
  { value: 'multi_select', label: msg('Several values from a list') },
  { value: 'text', label: msg('Text') },
  { value: 'date', label: msg('Date') },
  { value: 'number', label: msg('Number') },
  { value: 'checkbox', label: msg('Yes or no') },
]
const typeLabel = (type: string) => t(TYPES.find((x) => x.value === type)?.label ?? type)

const keyOf = (label: string) =>
  label.trim().toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)

function useFail() {
  return (err: unknown) => toast({ message: errorMessage(err) })
}

function ValueChip({ definition, option }: { definition: PropertyDefinition; option: PropertyOption }) {
  const rewritten = (r: { documents: number; failed: string[] }) =>
    toast({
      message: r.failed.length
        ? t('Not changed yet: these documents can’t be rewritten. Fix them and try again. {list}', { list: r.failed.join('; ') })
        : plural(r.documents, '{n} document rewritten.', '{n} documents rewritten.'),
    })
  const update = useUpdateOption()
  const rename = useRenameOption()
  const merge = useMergeOption()
  const remove = useDeleteOption()
  const documents = useDocuments()
  const fail = useFail()
  const ids = { definitionId: definition.id, optionId: option.id }
  const hub = documents.data?.documents.find((d) => d.id === option.hub_document_id)

  const relabel = async () => {
    const label = await promptDialog({ title: t('Rename “{value}”', { value: option.label }), label: t('Label'), initial: option.label, confirmLabel: t('Rename'),
      message: t('Only what is shown changes; the documents keep it as {slug}.', { slug: option.slug }) })
    if (label && label !== option.label) update.mutate({ ...ids, body: { label } }, { onError: fail })
  }
  const reslug = async () => {
    const slug = await promptDialog({ title: t('Change how it is written in the files'), label: t('Name in the files'), initial: option.slug, confirmLabel: t('Change'),
      message: plural(option.count, 'The {n} document with it is rewritten (with a revision).', 'The {n} documents with it are rewritten (each with a revision).') })
    if (slug && slug !== option.slug) {
      rename.mutate({ ...ids, slug }, { onError: fail, onSuccess: rewritten })
    }
  }
  const mergeInto = async () => {
    const into = await chooseDialog({
      title: t('Merge “{value}” into…', { value: option.label }),
      message: t('Every document with it gets the other value instead, and this one is removed.'),
      options: definition.options.filter((o) => o.id !== option.id).map((o) => ({ value: o.id, label: o.label, hint: o.slug })),
      empty: t('There is no other value to merge into.'),
    })
    if (into) merge.mutate({ ...ids, into }, { onError: fail, onSuccess: rewritten })
  }
  const pickHub = async () => {
    const NONE = '-'
    const chosen = await chooseDialog({
      title: t('Hub page of “{value}”', { value: option.label }),
      message: t('The hub page lists every document with this value, e.g. a client’s main page.'),
      options: [
        { value: NONE, label: t('No hub page') },
        ...(documents.data?.documents ?? []).map((d) => ({ value: d.id, label: d.title, hint: d.path })),
      ],
    })
    if (chosen !== null) update.mutate({ ...ids, body: { hub_document_id: chosen === NONE ? null : chosen } }, { onError: fail })
  }
  const del = async () => {
    if (await confirmDialog({ title: t('Remove the value “{value}”?', { value: option.label }), confirmLabel: t('Remove'), danger: true })) {
      remove.mutate(ids, { onError: fail })
    }
  }
  return (
    <span className="inline-flex items-center gap-0.5 rounded-full bg-surface-2 py-0.5 pl-2.5 pr-0.5 text-[12.5px]">
      <span title={option.slug}>{option.label}</span>
      {option.count > 0 && <span className="text-subtle">{option.count}</span>}
      {hub && <span className="text-subtle" title={t('Hub page: {title}', { title: hub.title })}>· {hub.title}</span>}
      <ActionMenu label={t('Change “{value}”', { value: option.label })} className="h-6 w-6" actions={[
        { label: t('Rename'), icon: <Pencil />, onSelect: () => void relabel() },
        { label: t('Change how it is written in the files'), icon: <FileCode />, onSelect: () => void reslug() },
        { label: t('Hub page…'), icon: <House />, onSelect: () => void pickHub() },
        { label: t('Merge into…'), icon: <GitMerge />, onSelect: () => void mergeInto() },
        { label: t('Remove'), icon: <Trash2 />, danger: true, onSelect: () => void del() },
      ]} />
    </span>
  )
}

function PropertyRow({ definition }: { definition: PropertyDefinition }) {
  const projects = useProjects()
  const addOption = useAddOption()
  const remove = useDeleteProperty()
  const fail = useFail()
  const [value, setValue] = useState('')
  const listed = definition.type === 'select' || definition.type === 'multi_select'
  const scope = definition.project_ids === null
    ? t('Everywhere')
    : (projects.data ?? []).filter((p) => definition.project_ids?.includes(p.id)).map((p) => p.name).join(', ') || t('Deleted projects')
  const del = async () => {
    const ok = await confirmDialog({
      title: t('Remove the property “{label}”?', { label: definition.label }),
      message: t('Documents keep what their files say; it is just no longer shown or searchable.'),
      confirmLabel: t('Remove'),
      danger: true,
    })
    if (ok) remove.mutate(definition.id, { onError: fail })
  }
  return (
    <li className="flex flex-col gap-2 border-b border-border py-3 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-semibold">{definition.label}</span>
        <code className="text-[12px] text-muted">{definition.key}</code>
        <Badge>{typeLabel(definition.type)}</Badge>
        <span className="text-[12px] text-muted">{scope}</span>
        {definition.open_vocabulary && <span className="text-[12px] text-muted">· {t('new values need no approval')}</span>}
        <span className="flex-1" />
        {!definition.builtin && (
          <Button size="icon" variant="ghost" aria-label={t('Remove {label}', { label: definition.label })} onClick={() => void del()}>
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
      {listed && (
        <div className="flex flex-wrap items-center gap-1.5">
          {definition.options.map((o) => <ValueChip key={o.id} definition={definition} option={o} />)}
          <form className="flex items-center gap-1" onSubmit={(e) => {
            e.preventDefault()
            if (!value.trim()) return
            addOption.mutate({ definitionId: definition.id, label: value.trim() }, { onError: fail, onSuccess: () => setValue('') })
          }}>
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={t('Add a value')} aria-label={t('Add a value to {label}', { label: definition.label })} className="h-8 w-40" />
          </form>
        </div>
      )}
    </li>
  )
}

function NewProperty() {
  const create = useCreateProperty()
  const projects = useProjects()
  const fail = useFail()
  const [label, setLabel] = useState('')
  const [type, setType] = useState<PropertyType>('select')
  const [project, setProject] = useState('')
  const [values, setValues] = useState('')
  const submit = () => {
    create.mutate(
      {
        key: keyOf(label),
        label: label.trim(),
        type,
        project_ids: project ? [project] : null,
        options: values.split(',').map((v) => v.trim()).filter(Boolean),
      },
      { onError: fail, onSuccess: () => { setLabel(''); setValues('') } },
    )
  }
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (keyOf(label)) submit() }}>
      <Field label={t('Name')} hint={keyOf(label) ? t('Written in the files as {key}', { key: keyOf(label) }) : t('e.g. Client')}>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <Field label={t('Kind')}>
        <Select value={type} onValueChange={(v) => setType(v as PropertyType)} options={TYPES.map((x) => ({ value: x.value, label: t(x.label) }))} />
      </Field>
      <Field label={t('Where it can be used')}>
        <Select value={project} onValueChange={setProject}
          options={[{ value: '', label: t('Everywhere') }, ...(projects.data ?? []).filter((p) => !p.archived).map((p) => ({ value: p.id, label: t('Only in {project}', { project: p.name }) }))]} />
      </Field>
      {(type === 'select' || type === 'multi_select') && (
        <Field label={t('Values')} hint={t('Separated by commas; more can be added later.')}>
          <Input value={values} onChange={(e) => setValues(e.target.value)} />
        </Field>
      )}
      <div className="sm:col-span-2">
        <Button type="submit" variant="primary" disabled={!keyOf(label)} loading={create.isPending}>{t('Add property')}</Button>
      </div>
    </form>
  )
}

/** Folder defaults: one rule per folder, a list of `key: value` pairs. */
function FolderDefaults({ definitions }: { definitions: PropertyDefinition[] }) {
  const settings = useSettings()
  const save = useSaveSection('properties')
  const rules = settings.data?.properties?.folder_defaults ?? []
  const [folder, setFolder] = useState('')
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const definition = definitions.find((d) => d.key === key)
  const persist = (next: typeof rules) => save.mutate({ folder_defaults: next }, { onError: (err) => toast({ message: errorMessage(err) }) })
  const add = () => {
    const name = folder.trim().replace(/^\/+|\/+$/g, '').replace(/^documents\//, '')
    if (!name || !definition || !value) return
    const typed = definition.type === 'multi_select' ? [value] : definition.type === 'number' ? Number(value) : definition.type === 'checkbox' ? value === 'true' : value
    const existing = rules.find((r) => r.folder === name)
    persist(existing
      ? rules.map((r) => (r === existing ? { ...r, properties: { ...r.properties, [key]: typed } } : r))
      : [...rules, { folder: name, properties: { [key]: typed } }])
    setValue('')
  }
  const listed = definition && (definition.type === 'select' || definition.type === 'multi_select')
  return (
    <div className="flex flex-col gap-3">
      {rules.length === 0 && <p className="text-[13px] text-muted">{t('No folder has default properties yet.')}</p>}
      <ul className="flex flex-col gap-1.5">
        {rules.map((r) => (
          <li key={r.folder} className="flex flex-wrap items-center gap-2 text-[13px]">
            <code className="rounded bg-surface-2 px-1.5 py-0.5">documents/{r.folder}/</code>
            <span className="text-muted">→</span>
            <span className="min-w-0 flex-1">{Object.entries(r.properties ?? {}).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join(' · ')}</span>
            <Button size="icon" variant="ghost" aria-label={t('Remove the defaults of {folder}', { folder: r.folder })} onClick={() => persist(rules.filter((x) => x !== r))}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </li>
        ))}
      </ul>
      <form className="grid gap-2 sm:grid-cols-[1fr_10rem_10rem_auto]" onSubmit={(e) => { e.preventDefault(); add() }}>
        <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={t('Folder, e.g. tech-services/clients/ludmyla-doula')} aria-label={t('Folder')} />
        <Select value={key} onValueChange={(k) => { setKey(k); setValue('') }} placeholder={t('Property')} aria-label={t('Property')}
          options={definitions.map((d) => ({ value: d.key, label: d.label }))} />
        {listed ? (
          <Select value={value} onValueChange={setValue} placeholder={t('Value')} aria-label={t('Value')}
            options={definition.options.map((o) => ({ value: o.slug, label: o.label }))} />
        ) : (
          <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={t('Value')} aria-label={t('Value')} type={definition?.type === 'date' ? 'date' : 'text'} />
        )}
        <Button type="submit" disabled={!folder.trim() || !definition || !value}>{t('Add')}</Button>
      </form>
    </div>
  )
}

export function PropertiesSettingsPage() {
  const properties = useProperties()
  const reindex = useReindexDocuments()
  const definitions = properties.data ?? []
  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader title={t('Properties')}
          description={t('What a document is about: its type, status, tags, client… A folder says where a document lives; properties say what it is, and views and search filter by them. They are written at the top of each file.')} />
        <CardBody>
          {properties.isError && <p className="text-[13px] text-error">{errorMessage(properties.error)}</p>}
          <ul className="flex flex-col">
            {definitions.map((d) => <PropertyRow key={d.id} definition={d} />)}
          </ul>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={t('New property')} description={t('For example a Client property only in your business project, with one value per client.')} />
        <CardBody><NewProperty /></CardBody>
      </Card>
      <Card>
        <CardHeader title={t('Folder defaults')}
          description={t('New documents in a folder (or below it) start with these properties. Moving a document into the folder offers them; nothing changes by itself.')} />
        <CardBody><FolderDefaults definitions={definitions.filter((d) => d.applies_to.includes('document'))} /></CardBody>
      </Card>
      <Card>
        <CardHeader title={t('Changed outside Anemo')}
          description={t('Documents edited by other programs are read again when Anemo starts. Do it now:')} />
        <CardBody>
          <Button icon={<Tag className="h-4 w-4" />} loading={reindex.isPending}
            onClick={() => reindex.mutate(undefined, { onSuccess: (r) => toast({ message: plural(r.documents, '{n} document read again.', '{n} documents read again.') }) })}>
            {t('Read the documents again')}
          </Button>
        </CardBody>
      </Card>
    </div>
  )
}
