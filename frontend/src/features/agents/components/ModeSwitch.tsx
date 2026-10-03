import { useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Link } from 'react-router'
import {
  AppWindow,
  Ban,
  Bell,
  Bot,
  Brain,
  CalendarDays,
  CheckSquare,
  Check,
  CircleHelp,
  Contrast,
  FilePen,
  FileSearch,
  Globe,
  type LucideIcon,
  MessageSquare,
  Network,
  NotebookPen,
  Plug,
  Search,
  ShieldCheck,
  Terminal,
  Trash2,
  Users,
  Webhook,
  Wrench,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { usePermissionSummary } from '../api'

export type Mode = 'chat' | 'agent'

/** Chat answers directly; Agent may use tools within the user's permission settings. */
export function ModeSwitch({
  mode,
  onChange,
  profileId = null,
}: {
  mode: Mode
  onChange: (mode: Mode) => void
  /** Agent profile whose permissions the chip shows (null: the default agent). */
  profileId?: string | null
}) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 md:gap-1">
      <div className="inline-flex rounded-lg bg-surface-2 p-0.5" role="radiogroup" aria-label="Mode">
        {(['chat', 'agent'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => onChange(m)}
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium transition-colors md:px-2.5 pointer-coarse:h-9',
              mode === m ? 'bg-surface text-text shadow-soft' : 'text-muted hover:text-text',
            )}
          >
            {m === 'chat' ? <MessageSquare className="hidden h-3.5 w-3.5 sm:block" /> : <Bot className="hidden h-3.5 w-3.5 sm:block" />}
            {m === 'chat' ? 'Chat' : 'Agent'}
          </button>
        ))}
      </div>
      {mode === 'agent' && <PermissionChip profileId={profileId} />}
    </div>
  )
}

/** The four answers to "may it do this?", with how each looks. */
const GROUPS = {
  allowed: { title: 'Without asking', short: 'Free', icon: Check, tone: 'text-success', tint: 'bg-success/12' },
  partly: { title: 'Mostly without asking', short: 'Mostly', icon: Contrast, tone: 'text-success', tint: 'bg-success/8' },
  ask: { title: 'Asks you first', short: 'Asks', icon: CircleHelp, tone: 'text-warning', tint: 'bg-warning/12' },
  never: { title: 'Not allowed', short: 'Never', icon: Ban, tone: 'text-error', tint: 'bg-error/10' },
} as const
type GroupKey = keyof typeof GROUPS
const ORDER: GroupKey[] = ['allowed', 'partly', 'ask', 'never']

/** An icon for each kind of thing an agent can do (see policy/presets.py). */
const ICONS: Record<string, LucideIcon> = {
  'fs.read': FileSearch,
  'fs.write': FilePen,
  'fs.delete': Trash2,
  'shell.exec': Terminal,
  'shell.network': Network,
  'net.search': Search,
  'net.fetch': Globe,
  'browser.use': AppWindow,
  'http.request': Webhook,
  'docs.write': NotebookPen,
  'tasks.write': CheckSquare,
  'calendar.write': CalendarDays,
  'memory.write': Brain,
  'notify.send': Bell,
  'mcp.*': Plug,
  'agent.spawn': Users,
}

/**
 * Shows, before starting, exactly what an agent run may do: one small tile per kind of
 * action, coloured by whether it happens without asking, mostly without asking, only
 * after asking, or never. Pointing at (or tapping) a tile explains it below the grid.
 */
function PermissionChip({ profileId }: { profileId: string | null }) {
  const summary = usePermissionSummary(profileId)
  const items = (summary.data?.items ?? [])
    .filter((i) => i.available)
    .sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group))
  const [focused, setFocused] = useState<string | null>(null)
  const shown = items.find((i) => i.capability === focused)
  return (
    <Popover.Root onOpenChange={() => setFocused(null)}>
      <Popover.Trigger asChild>
        <button type="button" aria-label="Permissions"
          className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-9">
          <ShieldCheck className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Permissions</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={8} collisionPadding={12}
          className="pop z-50 max-h-[var(--radix-popover-content-available-height)] w-[26rem] max-w-[calc(100vw-24px)] overflow-y-auto rounded-card border border-border bg-card p-3.5 text-[13px] shadow-float">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-accent" />
            <span className="flex-1 font-semibold">What the agent may do</span>
          </div>
          {/* The legend, with how many of each. */}
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {ORDER.map((key) => {
              const count = items.filter((i) => i.group === key).length
              if (!count) return null
              const g = GROUPS[key]
              return (
                <span key={key} title={g.title}
                  className={cn('flex h-6 items-center gap-1 rounded-full px-2 text-[11.5px] font-medium', g.tint, g.tone)}>
                  <g.icon className="h-3 w-3" /> {g.short} <span className="tabular-nums opacity-70">{count}</span>
                </span>
              )
            })}
          </div>
          <ul className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3" aria-label="Permissions">
            {items.map((i) => {
              const g = GROUPS[i.group]
              const Icon = ICONS[i.capability] ?? Wrench
              return (
                <li key={i.capability}>
                  <button type="button" aria-label={`${i.label}: ${i.detail}`} aria-pressed={focused === i.capability}
                    onMouseEnter={() => setFocused(i.capability)} onFocus={() => setFocused(i.capability)}
                    onClick={() => setFocused(i.capability)}
                    className={cn('relative flex h-full w-full items-center gap-2 rounded-lg border py-1.5 pl-2 pr-3.5 text-left transition-colors',
                      focused === i.capability ? 'border-border-strong bg-surface-hover' : 'border-border hover:bg-surface-hover')}>
                    <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', g.tint, g.tone)}>
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <span className={cn('min-w-0 flex-1 text-[12px] leading-tight', i.group === 'never' && 'text-muted line-through')}>
                      {i.label}
                    </span>
                    <g.icon className={cn('absolute right-1 top-1 h-2.5 w-2.5', g.tone)} aria-hidden />
                  </button>
                </li>
              )
            })}
          </ul>
          {/* What the tile pointed at means; without one, how to find out. Tall enough for the
              longest explanation (two lines; three on a phone), so the card keeps its size, instead
              of jumping, while the pointer moves over the tiles. */}
          <p className="mt-2.5 min-h-[calc(2*1.5em+0.75rem)] rounded-lg bg-surface-2 px-2.5 py-1.5 text-[12px] leading-[1.5] text-muted max-sm:min-h-[calc(3*1.5em+0.75rem)]" aria-live="polite">
            {shown ? (
              <><span className="font-medium text-text">{shown.label}:</span> {shown.detail}. {shown.description}</>
            ) : (
              'Point at or tap a permission to see what it covers.'
            )}
          </p>
          {summary.data && (
            <div className="mt-2.5 flex flex-wrap items-center gap-x-1 border-t border-border pt-2.5 text-[12px] text-muted">
              <span>
                Limits: {summary.data.max_steps} steps, {summary.data.max_tool_calls} tool calls,{' '}
                {Math.round(summary.data.max_runtime_s / 60)} min.
                {summary.data.plan_review === 'always' && ' You review its plan first.'}
              </span>
              <Link to={profileId ? '/agents' : '/settings/permissions'} className="ml-auto text-accent underline">Change</Link>
            </div>
          )}
          <Popover.Arrow className="fill-card" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
