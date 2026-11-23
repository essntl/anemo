/**
 * The project of a new job: a text field (any folder or repository name may be typed)
 * with the computer's projects under it, narrowed by what is typed: its folders first,
 * then its owner's repositories not cloned yet. A combobox by the ARIA pattern: the
 * arrows move through the list, Enter takes the marked one, Escape closes the list.
 */
import { type KeyboardEvent, type Ref, useId, useMemo, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { ChevronDown, Cloud, Folder } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import type { CodeProjects } from './api'

interface Option {
  name: string
  /** The folder, for a local project. */
  dir?: string
}

export function ProjectPicker({ value, onChange, projects, loading, disabled, ref }: {
  ref?: Ref<HTMLInputElement>
  value: string
  onChange: (name: string) => void
  projects: CodeProjects | undefined
  loading?: boolean
  disabled?: boolean
}) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  // Narrowed only by what was typed since the list opened.
  const [typed, setTyped] = useState('')

  const { local, remote } = useMemo(() => {
    const has = (name: string) => name.toLowerCase().includes(typed.trim().toLowerCase())
    return {
      local: (projects?.projects ?? []).filter((p) => has(p.name)).map((p): Option => ({ name: p.name, dir: p.dir })),
      remote: (projects?.remote ?? []).filter((r) => has(r.name)).map((r): Option => ({ name: r.name })),
    }
  }, [projects, typed])
  const options = [...local, ...remote]
  const shown = open && !disabled && (options.length > 0 || Boolean(loading))
  const optionId = (i: number) => `${listId}-${i}`

  /** Open with every project: what narrowed it last time was taken or given up. */
  const show = () => {
    if (shown) return
    setTyped('')
    setActive(-1)
    setOpen(true)
  }
  const pick = (name: string) => {
    onChange(name)
    setActive(-1)
    setOpen(false)
  }
  const move = (by: number) => {
    if (!shown) {
      // Closed: the arrows open the whole list, at its first or last project.
      show()
      setActive(by > 0 ? 0 : (projects?.projects.length ?? 0) + (projects?.remote.length ?? 0) - 1)
      return
    }
    if (options.length) setActive((i) => (i + by + options.length) % options.length)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
    else if (e.key === 'Enter' && shown && options[active]) { e.preventDefault(); pick(options[active].name) }
    else if (e.key === 'Escape' && shown) { e.preventDefault(); e.stopPropagation(); setOpen(false) }
  }

  const row = (o: Option, i: number) => (
    <li key={`${o.dir ? 'l' : 'r'}:${o.name}`} id={optionId(i)} role="option" aria-selected={i === active}
      // The field keeps the focus: a press on a row must not take it.
      onMouseDown={(e) => e.preventDefault()} onClick={() => pick(o.name)} onMouseMove={() => setActive(i)}
      className={cn('flex cursor-pointer items-center gap-2.5 rounded-control px-2.5 py-1.5 pointer-coarse:py-2.5', i === active && 'bg-surface-hover')}>
      <span className="shrink-0 text-subtle" aria-hidden="true">{o.dir ? <Folder className="h-4 w-4" /> : <Cloud className="h-4 w-4" />}</span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-[13.5px]', o.name === value.trim() && 'font-medium text-accent')}>{o.name}</span>
        {o.dir && <span className="block truncate font-mono text-[11.5px] text-muted">{o.dir}</span>}
      </span>
    </li>
  )
  const heading = (text: string) => (
    <li role="presentation" className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-subtle first:pt-1">{text}</li>
  )

  return (
    <Popover.Root open={shown} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <div className="relative">
          <Input ref={ref} role="combobox" aria-expanded={shown} aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={shown && active >= 0 ? optionId(active) : undefined}
            value={value} disabled={disabled} autoComplete="off" spellCheck={false} className="pr-9"
            placeholder={t('A project folder or a GitHub repository')}
            onChange={(e) => { onChange(e.target.value); setTyped(e.target.value); setActive(e.target.value.trim() ? 0 : -1); setOpen(true) }}
            onClick={show} onBlur={() => setOpen(false)} onKeyDown={onKeyDown} />
          <ChevronDown aria-hidden="true"
            className={cn('pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 opacity-60 transition-transform', shown && 'rotate-180')} />
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content role="presentation" align="start" sideOffset={6} collisionPadding={12}
          // The field keeps the focus, and a press on it isn't a press outside.
          onOpenAutoFocus={(e) => e.preventDefault()} onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
          className="pop z-50 w-[var(--radix-popover-trigger-width)] overflow-hidden rounded-card border border-border bg-card shadow-float">
          <ul id={listId} role="listbox" aria-label={t('Projects')}
            className="max-h-[min(17rem,var(--radix-popover-content-available-height))] overflow-y-auto overscroll-contain p-1.5">
            {loading && options.length === 0 && <li role="presentation" className="px-2.5 py-2 text-[13px] text-muted">{t('Asking the computer for its projects…')}</li>}
            {local.length > 0 && heading(t('On this computer'))}
            {local.map((o, i) => row(o, i))}
            {remote.length > 0 && heading(t('On GitHub, not cloned'))}
            {remote.map((o, i) => row(o, local.length + i))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
