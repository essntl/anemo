import * as Popover from '@radix-ui/react-popover'
import { Link } from 'react-router'
import { Bot, MessageSquare, ShieldCheck } from 'lucide-react'
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

const GROUPS = [
  { key: 'allowed', title: 'Can do without asking' },
  { key: 'partly', title: 'Mostly without asking' },
  { key: 'ask', title: 'Asks you first' },
  { key: 'never', title: 'Not allowed' },
] as const

/** Shows, before starting, exactly what an agent run may do. */
function PermissionChip({ profileId }: { profileId: string | null }) {
  const summary = usePermissionSummary(profileId)
  const items = (summary.data?.items ?? []).filter((i) => i.available)
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" aria-label="Permissions"
          className="flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] text-muted hover:bg-surface-hover hover:text-text pointer-coarse:h-9">
          <ShieldCheck className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Permissions</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={8} collisionPadding={12}
          className="z-50 w-80 max-w-[calc(100vw-24px)] rounded-card border border-border bg-card p-4 text-[13px] shadow-float">
          <div className="mb-2 font-semibold">What the agent may do</div>
          {GROUPS.map((g) => {
            const group = items.filter((i) => i.group === g.key)
            if (!group.length) return null
            return (
              <div key={g.key} className="mb-2">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-subtle">{g.title}</div>
                {group.map((i) => (
                  <div key={i.capability} className="flex justify-between gap-3 py-0.5">
                    <span>{i.label}</span>
                    <span className="text-right text-[12px] text-muted">{g.key === 'partly' ? i.detail : ''}</span>
                  </div>
                ))}
              </div>
            )
          })}
          {summary.data && (
            <div className="mt-2 border-t border-border pt-2 text-[12px] text-muted">
              Limits: {summary.data.max_steps} steps, {summary.data.max_tool_calls} tool calls,{' '}
              {Math.round(summary.data.max_runtime_s / 60)} min.
              {summary.data.plan_review === 'always' && ' You review its plan first.'}{' '}
              <Link to={profileId ? '/agents' : '/settings/permissions'} className="text-accent underline">Change</Link>
            </div>
          )}
          <Popover.Arrow className="fill-card" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
