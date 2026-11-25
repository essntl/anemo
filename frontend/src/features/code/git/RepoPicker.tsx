/**
 * Which repository the Git view shows: a button with its name and computer, opening a
 * list of the computer's local projects and of its owner's GitHub repositories that
 * aren't cloned there (only those with an owner/name: they are read by it). Another
 * computer can be picked at the top; the list can be searched. The arrows move through
 * it, Enter takes the marked one.
 */
import { type KeyboardEvent, useId, useMemo, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { ChevronsUpDown, Cloud, Folder, Laptop, Search } from 'lucide-react'
import { errorMessage } from '@/api/client'
import { Select } from '@/components/ui/Select'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { type CodeDevice, useCodeProjects } from '../api'
import { type GitRepoChoice, repoLabel } from './gitApi'

interface Option {
  choice: GitRepoChoice
  label: string
  detail: string
}

const sameChoice = (a: GitRepoChoice | null, b: GitRepoChoice | null) =>
  Boolean(a && b) && a!.deviceId === b!.deviceId && a!.project === b!.project && a!.repo === b!.repo

export function RepoPicker({ devices, value, onChange }: {
  devices: readonly CodeDevice[]
  value: GitRepoChoice | null
  onChange: (choice: GitRepoChoice) => void
}) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [active, setActive] = useState(0)
  const shownDevice = deviceId ?? value?.deviceId ?? devices.find((d) => d.online)?.id ?? devices[0]?.id ?? null
  const projects = useCodeProjects(open ? shownDevice : null)
  const device = devices.find((d) => d.id === value?.deviceId)

  const { local, remote } = useMemo(() => {
    const words = search.trim().toLowerCase()
    const has = (text: string) => !words || text.toLowerCase().includes(words)
    const data = projects.data
    if (!data || !shownDevice) return { local: [] as Option[], remote: [] as Option[] }
    return {
      local: data.projects.filter((p) => has(p.name) || has(p.repo ?? '')).map((p): Option => ({
        choice: { deviceId: shownDevice, project: p.name }, label: p.name, detail: p.repo ?? p.dir,
      })),
      remote: data.remote.filter((r): r is typeof r & { repo: string } => Boolean(r.repo) && (has(r.name) || has(r.repo ?? ''))).map((r): Option => ({
        choice: { deviceId: shownDevice, repo: r.repo }, label: r.repo, detail: t('GitHub, not cloned'),
      })),
    }
  }, [projects.data, search, shownDevice])
  const options = [...local, ...remote]

  const show = (next: boolean) => {
    setOpen(next)
    if (next) {
      setSearch('')
      setActive(0)
      setDeviceId(null)
    }
  }
  const pick = (choice: GitRepoChoice) => {
    onChange(choice)
    setOpen(false)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && options.length) { e.preventDefault(); setActive((i) => (i + 1) % options.length) }
    else if (e.key === 'ArrowUp' && options.length) { e.preventDefault(); setActive((i) => (i - 1 + options.length) % options.length) }
    else if (e.key === 'Enter' && options[active]) { e.preventDefault(); pick(options[active].choice) }
  }

  const row = (o: Option, i: number) => {
    const current = sameChoice(o.choice, value)
    return (
      <li key={`${o.choice.repo !== undefined ? 'r' : 'l'}:${o.label}`} id={`${listId}-${i}`} role="option" aria-selected={i === active}
        onClick={() => pick(o.choice)} onMouseMove={() => setActive(i)}
        className={cn('flex cursor-pointer items-center gap-2.5 rounded-control px-2.5 py-1.5 pointer-coarse:py-2.5', i === active && 'bg-surface-hover')}>
        <span aria-hidden="true" className="shrink-0 text-subtle">{o.choice.repo !== undefined ? <Cloud className="h-4 w-4" /> : <Folder className="h-4 w-4" />}</span>
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-[13px]', current && 'font-medium text-accent')}>{o.label}</span>
          <span className="block truncate font-mono text-[11px] text-muted">{o.detail}</span>
        </span>
      </li>
    )
  }
  const heading = (text: string) => (
    <li role="presentation" className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-subtle first:pt-1">{text}</li>
  )

  return (
    <Popover.Root open={open} onOpenChange={show}>
      <Popover.Trigger asChild>
        <button type="button" aria-label={value ? t('Repository: {name} on {device}', { name: repoLabel(value), device: device?.name ?? '' }) : t('Pick a repository')}
          className="inline-flex h-8 min-w-0 max-w-[22rem] items-center gap-2 rounded-control border border-border bg-surface pl-2 pr-1.5 text-left hover:border-border-strong hover:bg-surface-hover data-[state=open]:border-border-strong pointer-coarse:h-10">
          {value?.repo !== undefined ? <Cloud aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" /> : <Folder aria-hidden="true" className="h-4 w-4 shrink-0 text-muted" />}
          <span className="min-w-0 truncate text-[13px] font-semibold">{value ? repoLabel(value) : t('Pick a repository')}</span>
          {device && <span className="hidden min-w-0 shrink truncate text-[12px] text-muted sm:inline">{t('on {device}', { device: device.name })}</span>}
          <ChevronsUpDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} collisionPadding={12}
          className="pop glass z-50 flex max-h-[min(28rem,var(--radix-popover-content-available-height))] w-[min(24rem,calc(100vw-24px))] flex-col overflow-hidden rounded-card border border-border bg-card shadow-float">
          <div className="shrink-0 space-y-2 border-b border-border p-2">
            {devices.length > 1 && (
              <Select aria-label={t('Computer')} value={shownDevice ?? ''} onValueChange={(id) => { setDeviceId(id); setActive(0) }}
                options={devices.map((d) => ({ value: d.id, label: d.online ? d.name : t('{name} (offline)', { name: d.name }) }))} />
            )}
            {devices.length === 1 && (
              <p className="flex items-center gap-1.5 px-1 text-[12px] text-muted"><Laptop aria-hidden="true" className="h-3.5 w-3.5" />{devices[0].name}</p>
            )}
            <label className="relative block">
              <span className="sr-only">{t('Search repositories')}</span>
              <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
              <input autoFocus role="combobox" aria-expanded aria-controls={listId} aria-autocomplete="list"
                aria-activedescendant={options[active] ? `${listId}-${active}` : undefined}
                value={search} onChange={(e) => { setSearch(e.target.value); setActive(0) }} onKeyDown={onKeyDown}
                placeholder={t('Search repositories')} spellCheck={false} autoComplete="off"
                className="h-9 w-full rounded-control border border-border bg-surface pl-8 pr-2 text-[13px] placeholder:text-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft" />
            </label>
          </div>
          <ul id={listId} role="listbox" aria-label={t('Repositories')} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
            {projects.isPending && <li role="presentation" className="px-2.5 py-2 text-[13px] text-muted">{t('Asking the computer for its projects…')}</li>}
            {projects.isError && <li role="presentation" className="px-2.5 py-2 text-[13px] text-error">{errorMessage(projects.error)}</li>}
            {projects.data?.note && <li role="presentation" className="px-2.5 py-1.5 text-[12px] text-muted">{projects.data.note}</li>}
            {local.length > 0 && heading(t('On this computer'))}
            {local.map((o, i) => row(o, i))}
            {remote.length > 0 && heading(t('On GitHub, not cloned'))}
            {remote.map((o, i) => row(o, local.length + i))}
            {projects.isSuccess && options.length === 0 && (
              <li role="presentation" className="px-2.5 py-2 text-[13px] text-muted">{search ? t('No repository matches “{search}”.', { search }) : t('No repositories on this computer.')}</li>
            )}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
