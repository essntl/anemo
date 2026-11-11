import { useState, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { useNavigate } from 'react-router'
import { Check, ChevronDown, ChevronsUpDown, CircleDashed, Layers, Settings2 } from 'lucide-react'
import { useProjects } from '@/features/tasks/api'
import { cn } from '@/lib/cn'
import { useProjectStore, useScope } from './projectStore'
import { t } from '@/lib/i18n'

const ITEM =
  'flex min-h-9 w-full items-center gap-2.5 rounded-control px-2.5 py-1 text-left text-[13.5px] hover:bg-surface-hover pointer-coarse:min-h-12 pointer-coarse:text-[15px]'
const DOT = 'block h-2 w-2 shrink-0 rounded-full'
const SEPARATOR = 'mx-1 my-1.5 h-px bg-border'

function Choice({ checked, mark, label, hint, onSelect }: {
  checked: boolean
  mark: ReactNode
  label: string
  hint?: string
  onSelect: () => void
}) {
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} aria-label={label} className={ITEM} onClick={onSelect}>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted [&>svg]:h-4 [&>svg]:w-4">{mark}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && !checked && <span className="shrink-0 text-[12px] text-subtle">{hint}</span>}
      {checked && <Check className="h-4 w-4 shrink-0 text-accent" />}
    </button>
  )
}

/**
 * What the app shows, as one button that names it and opens the choices: Uncategorized
 * (only what is in no project), All, or one project.
 *
 * `field` is the full-width button at the top of the sidebar. `inline` is the small line
 * under a page's title on a phone, where a row of its own would cost too much height.
 */
export function ScopeControl({ variant = 'field', className, onNavigate }: {
  variant?: 'field' | 'inline'
  className?: string
  onNavigate?: () => void
}) {
  const navigate = useNavigate()
  const projects = useProjects()
  const scope = useScope()
  const setProjectId = useProjectStore((s) => s.setProjectId)
  const setView = useProjectStore((s) => s.setView)
  const [open, setOpen] = useState(false)
  const active = (projects.data ?? []).filter((p) => !p.archived)
  const current = scope.kind === 'project' ? scope.project : null
  const label = current?.name ?? (scope.kind === 'all' ? t('All') : t('Uncategorized'))
  const mark = current
    ? <span className={DOT} style={{ backgroundColor: current.color }} />
    : scope.kind === 'all' ? <Layers /> : <CircleDashed />
  const choose = (pick: () => void) => {
    pick()
    setOpen(false)
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        {variant === 'field' ? (
          <button type="button" aria-label={t('Showing {what}', { what: label })} title={t('Choose what is shown: what is in no project, everything, or one project')}
            className={cn('flex h-9 w-full shrink-0 items-center gap-2.5 rounded-control border border-border bg-surface-2 px-2.5 text-left text-[13.5px] font-medium',
              'hover:border-border-strong pointer-coarse:h-11 pointer-coarse:text-[15px]', className)}>
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted [&>svg]:h-4 [&>svg]:w-4">{mark}</span>
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-subtle" />
          </button>
        ) : (
          // The line is slim; the area that takes the tap reaches a little past it (the `before`).
          <button type="button" aria-label={t('Showing {what}', { what: label })}
            className={cn('relative flex h-4 min-w-0 max-w-full items-center gap-1 text-[12px] font-medium leading-4 text-muted before:absolute before:-inset-x-2 before:-bottom-2.5 before:-top-1', className)}>
            <span className="flex h-3 w-3 shrink-0 items-center justify-center [&>svg]:h-3 [&>svg]:w-3">{mark}</span>
            <span className="min-w-0 truncate">{label}</span>
            <ChevronDown className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-180')} />
          </button>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} collisionPadding={12}
          className={cn('pop z-50 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto rounded-card border border-border bg-card p-1.5 shadow-float',
            variant === 'field' ? 'w-[var(--radix-popover-trigger-width)] min-w-56' : 'w-64')}>
          <div role="menu" aria-label={t('Show')}>
            <Choice checked={scope.kind === 'uncategorized'} mark={<CircleDashed />} label={t('Uncategorized')} hint={t('In no project')}
              onSelect={() => choose(() => setView('uncategorized'))} />
            <Choice checked={scope.kind === 'all'} mark={<Layers />} label={t('All')} hint={t('Everything')}
              onSelect={() => choose(() => setView('all'))} />
            <div aria-hidden className={SEPARATOR} />
            {active.length > 0 && <div aria-hidden className="px-2.5 pb-1 pt-0.5 text-[11px] font-semibold uppercase tracking-wider text-subtle">{t('Projects')}</div>}
            {active.map((p) => (
              <Choice key={p.id} checked={p.id === current?.id} mark={<span className={DOT} style={{ backgroundColor: p.color }} />} label={p.name}
                onSelect={() => choose(() => setProjectId(p.id))} />
            ))}
            <button type="button" role="menuitem" className={cn(ITEM, 'text-muted hover:text-text')}
              onClick={() => { setOpen(false); onNavigate?.(); void navigate('/projects') }}>
              <Settings2 className="h-4 w-4 shrink-0" />
              {active.length ? t('Manage projects…') : t('Create a project…')}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
