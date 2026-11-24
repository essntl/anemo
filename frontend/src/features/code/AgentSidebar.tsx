/**
 * The sub-agents of a thread (agents.ts): a list of "Main" and every sub-agent, with its
 * state, time and number of tool calls. Picking one shows only its events in the thread
 * (`?agent=<call id>` in the address, so a reload keeps it).
 *
 *  - `AgentSidebar`: the list in a column right of the thread, on wide screens;
 *  - `AgentSwitcher`: on narrower ones, a button in the thread's top bar that opens the
 *    same list (a popup from `md` up, a sheet along the bottom edge on a phone).
 */
import { type ReactNode, useCallback, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import * as RadixDialog from '@radix-ui/react-dialog'
import { Ban, Bot, CheckCircle2, ChevronDown, Loader2, Network, XCircle } from 'lucide-react'
import { Elapsed } from '@/components/ui/Elapsed'
import { useCloseOnScroll } from '@/hooks/useCloseOnScroll'
import { DESKTOP, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/lib/cn'
import { formatDuration } from '@/lib/format'
import { msg, plural, t } from '@/lib/i18n'
import { type AgentInfo, type AgentStatus, MAIN, agentDurationMs } from './agents'
import type { ThreadAgent } from './agentNav'

const STATUS: Record<AgentStatus, { label: string; className: string }> = {
  running: { label: msg('Running'), className: 'text-tool-running' },
  done: { label: msg('Done'), className: 'text-tool-ok' },
  failed: { label: msg('Failed'), className: 'text-error' },
  stopped: { label: msg('Stopped'), className: 'text-muted' },
}

/** The agent's state as an icon (a spinner while it runs), with its name for screen readers. */
export function AgentStatusIcon({ status, className }: { status: AgentStatus; className?: string }) {
  const s = STATUS[status]
  const Icon = status === 'running' ? Loader2 : status === 'done' ? CheckCircle2 : status === 'failed' ? XCircle : Ban
  return (
    <Icon role="img" aria-label={t(s.label)}
      className={cn('h-3.5 w-3.5 shrink-0', s.className, status === 'running' && 'animate-spin', className)} />
  )
}

/** "1 m 05 s · 12 tool calls": a running agent's time counts up. */
export function AgentFacts({ agent }: { agent: AgentInfo }) {
  const ms = agent.status === 'running' ? undefined : agentDurationMs(agent)
  return (
    <span className="tabular-nums">
      {agent.status === 'running' && agent.startedAt ? <Elapsed since={agent.startedAt} />
        : ms !== undefined ? formatDuration(ms / 1000) : null}
      {(agent.status === 'running' ? agent.startedAt : ms !== undefined) ? ' · ' : ''}
      {plural(agent.toolCalls, '{n} tool call', '{n} tool calls')}
    </span>
  )
}

function Row({ active, onClick, depth, icon, title, children }: {
  active: boolean; onClick: () => void; depth: number; icon: ReactNode; title: string; children?: ReactNode
}) {
  return (
    <button type="button" onClick={onClick} aria-current={active ? 'true' : undefined} title={title}
      style={{ paddingLeft: `${0.5 + Math.min(depth, 4) * 0.875}rem` }}
      className={cn('flex w-full min-w-0 items-start gap-2 rounded-control py-1.5 pr-2 text-left text-[13px] pointer-coarse:py-2.5',
        active ? 'bg-accent-soft text-text' : 'hover:bg-surface-hover')}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate', active && 'font-medium')}>{title}</span>
        {children && <span className="block truncate text-[11.5px] text-muted">{children}</span>}
      </span>
    </button>
  )
}

/** "Main" and the sub-agents (in `agentTree` order), the selected one marked. */
export function AgentList({ agents, selected, onSelect }: { agents: readonly ThreadAgent[]; selected: string; onSelect: (agent: string) => void }) {
  const running = agents.filter((a) => a.status === 'running').length
  return (
    <div role="list" aria-label={t('Agents')} className="space-y-0.5">
      <div role="listitem">
        <Row active={selected === MAIN} onClick={() => onSelect(MAIN)} depth={0} title={t('Main agent')}
          icon={<Network aria-hidden="true" className="h-3.5 w-3.5 text-muted" />}>
          {running > 0 ? plural(running, '{n} sub-agent running', '{n} sub-agents running') : plural(agents.length, '{n} sub-agent', '{n} sub-agents')}
        </Row>
      </div>
      {agents.map((a) => (
        <div role="listitem" key={a.id}>
          <Row active={selected === a.id} onClick={() => onSelect(a.id)} depth={a.depth} title={a.description}
            icon={<AgentStatusIcon status={a.status} />}>
            {a.type && <span className="font-mono">{a.type} · </span>}
            <AgentFacts agent={a} />
          </Row>
        </div>
      ))}
    </div>
  )
}

/** The column right of the thread (wide screens). */
export function AgentSidebar(props: { agents: readonly ThreadAgent[]; selected: string; onSelect: (agent: string) => void }) {
  return (
    <aside aria-label={t('Agents')} className="h-full w-64 shrink-0 overflow-y-auto border-l border-border px-2 py-3">
      <h3 className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-subtle">{t('Agents')}</h3>
      <AgentList {...props} />
    </aside>
  )
}

/** The compact switcher in the top bar (narrower screens): the agent shown, and the list on a tap. */
export function AgentSwitcher({ agents, selected, onSelect }: { agents: readonly ThreadAgent[]; selected: string; onSelect: (agent: string) => void }) {
  const [open, setOpen] = useState(false)
  const desktop = useMediaQuery(DESKTOP)
  useCloseOnScroll(open && desktop, useCallback(() => setOpen(false), []))
  const current = agents.find((a) => a.id === selected)
  const running = agents.some((a) => a.status === 'running')
  const pick = (agent: string) => {
    setOpen(false)
    onSelect(agent)
  }
  const trigger = (
    <button type="button" aria-label={t('Agent: {name}', { name: current?.description ?? t('Main agent') })}
      className="inline-flex h-8 min-w-0 max-w-[9rem] shrink-0 items-center gap-1 rounded-control border border-border px-2 text-[12.5px] hover:bg-surface-hover pointer-coarse:h-10 sm:max-w-[13rem]">
      {current ? <AgentStatusIcon status={current.status} />
        : <Bot aria-hidden="true" className={cn('h-3.5 w-3.5 shrink-0', running ? 'animate-pulse text-tool-running' : 'text-muted')} />}
      <span className="min-w-0 truncate">{current?.description ?? t('Main agent')}</span>
      <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />
    </button>
  )
  const list = <AgentList agents={agents} selected={selected} onSelect={pick} />

  if (!desktop) {
    return (
      <RadixDialog.Root open={open} onOpenChange={setOpen}>
        <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger>
        <RadixDialog.Portal>
          <RadixDialog.Overlay className="fade fixed inset-0 z-50 bg-black/30" />
          <RadixDialog.Content aria-describedby={undefined}
            className="sheet fixed inset-x-0 bottom-0 z-50 flex max-h-[70dvh] flex-col rounded-t-panel border border-border bg-card px-2 pt-3 shadow-float focus:outline-none pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            <RadixDialog.Title className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-subtle">{t('Agents')}</RadixDialog.Title>
            <div className="min-h-0 overflow-y-auto">{list}</div>
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>
    )
  }
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={4} collisionPadding={12}
          className="pop z-50 max-h-[var(--radix-popover-content-available-height)] w-72 overflow-y-auto rounded-card border border-border bg-card p-1.5 shadow-float">
          {list}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
