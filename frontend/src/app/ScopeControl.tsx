import { useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { useNavigate } from 'react-router'
import { Check, ChevronDown, Settings2 } from 'lucide-react'
import { useProjects } from '@/features/tasks/api'
import { cn } from '@/lib/cn'
import { useProjectStore, useScope } from './projectStore'

const SEGMENT =
  'flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 text-[12.5px] transition-colors pointer-coarse:h-10 pointer-coarse:text-[14px]'
const ON = 'bg-surface font-semibold text-text shadow-soft'
const OFF = 'font-medium text-muted hover:text-text'
const ITEM =
  'flex h-9 w-full items-center gap-2.5 rounded-control px-2.5 text-left text-[13.5px] hover:bg-surface-hover pointer-coarse:h-12 pointer-coarse:text-[15px]'

/**
 * What the app shows, as one control at the top of the sidebar: Uncategorized (only
 * what is in no project), one project (the middle part opens the list), or All.
 */
export function ScopeControl({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  const navigate = useNavigate()
  const projects = useProjects()
  const scope = useScope()
  const setProjectId = useProjectStore((s) => s.setProjectId)
  const setView = useProjectStore((s) => s.setView)
  const [open, setOpen] = useState(false)
  const active = (projects.data ?? []).filter((p) => !p.archived)
  const current = scope.kind === 'project' ? scope.project : null

  return (
    <div role="group" aria-label="Show" className={cn('flex shrink-0 gap-0.5 rounded-control bg-surface-2 p-[3px]', className)}>
      <button type="button" aria-pressed={scope.kind === 'uncategorized'} onClick={() => setView('uncategorized')}
        title="Only what is in no project"
        className={cn(SEGMENT, 'flex-none', scope.kind === 'uncategorized' ? ON : OFF)}>
        Uncategorized
      </button>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button type="button" aria-label={current ? `Project: ${current.name}` : 'Project'} aria-pressed={Boolean(current)}
            className={cn(SEGMENT, 'flex-1', current ? ON : OFF)}>
            {current && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: current.color }} />}
            <span className="min-w-0 truncate">{current?.name ?? 'Projects'}</span>
            <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 opacity-70 transition-transform', open && 'rotate-180')} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="start" sideOffset={8} collisionPadding={12}
            className="pop z-50 max-h-[var(--radix-popover-content-available-height)] w-60 overflow-y-auto rounded-card border border-border bg-card p-1.5 shadow-float">
            <div role="menu" aria-label="Projects">
              {active.map((p) => (
                <button key={p.id} type="button" role="menuitemradio" aria-checked={p.id === current?.id} className={ITEM}
                  onClick={() => { setProjectId(p.id); setOpen(false) }}>
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.id === current?.id && <Check className="h-4 w-4 shrink-0 text-accent" />}
                </button>
              ))}
              {active.length > 0 && <div aria-hidden className="mx-1 my-1.5 h-px bg-border" />}
              <button type="button" role="menuitem" className={cn(ITEM, 'text-muted hover:text-text')}
                onClick={() => { setOpen(false); onNavigate?.(); void navigate('/projects') }}>
                <Settings2 className="h-4 w-4 shrink-0" />
                {active.length ? 'Manage projects…' : 'Create a project…'}
              </button>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <button type="button" aria-pressed={scope.kind === 'all'} onClick={() => setView('all')}
        title="Everything, whatever project it is in"
        className={cn(SEGMENT, 'flex-none px-3', scope.kind === 'all' ? ON : OFF)}>
        All
      </button>
    </div>
  )
}
