import * as Popover from '@radix-ui/react-popover'
import { Brain } from 'lucide-react'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { useReasoningEffort } from '../api'
import { EFFORT_LEVELS, effortIndex } from '../reasoning'
import { EffortSlider } from './EffortSlider'

/**
 * Next to the model in the message box: how hard a model that can reason thinks. The
 * button shows the level as a small meter (and its name where there is room); it opens
 * the slider. The level is saved as the default for every chat (Settings > Models) and
 * sent with each message.
 */
export function ReasoningControl() {
  const effort = useReasoningEffort()
  const index = effortIndex(effort.value)
  const level = EFFORT_LEVELS[index]
  const hot = index >= 3
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={!effort.ready}
          aria-label={t('Reasoning: {level}', { level: t(level.label) })}
          title={t('Reasoning effort')}
          className={cn(
            'flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12.5px] transition-[background-color,color,box-shadow] duration-200 pointer-coarse:h-10',
            'data-[state=open]:bg-surface-hover',
            hot ? 'bg-accent-soft text-accent hover:bg-accent-soft' : 'text-muted hover:bg-surface-hover hover:text-text',
            // Max glows a little, without moving: the toolbar is in view all the time.
            index === 4 && 'shadow-[0_0_0_1px_color-mix(in_oklch,var(--accent)_30%,transparent),0_0_14px_-4px_var(--accent)]',
          )}
        >
          <Brain className={cn('h-3.5 w-3.5', index > 0 && 'text-accent')} />
          <span className="hidden sm:inline">{t(level.label)}</span>
          <EffortMeter index={index} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="pop z-50 w-[19rem] max-w-[calc(100vw-24px)] rounded-card border border-border bg-card p-3.5 text-[13px] shadow-float"
        >
          <div className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-accent" />
            <span className="flex-1 font-semibold">{t('Reasoning')}</span>
            <span className={cn('font-medium', index > 0 ? 'text-accent' : 'text-muted')}>{t(level.label)}</span>
          </div>
          <p className="mt-0.5 pl-6 text-[12px] text-muted">{t(level.hint)}</p>
          <EffortSlider value={effort.value} onChange={effort.set} />
          <p className="mt-2.5 border-t border-border pt-2.5 text-[12px] leading-[1.5] text-muted">
            {t('Higher levels answer better on hard questions, but take longer and use more tokens. Saved for all chats.')}
          </p>
          {effort.error && <p className="mt-1.5 text-[12px] text-error">{t('Could not save the reasoning level.')}</p>}
          <Popover.Arrow className="fill-card" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** Four bars rising like a signal meter, as many lit as the level (none for Off). */
function EffortMeter({ index }: { index: number }) {
  return (
    <span aria-hidden className="flex h-2.5 items-end gap-[2px]">
      {[1, 2, 3, 4].map((bar) => (
        <span
          key={bar}
          className={cn('w-[2px] rounded-full transition-colors duration-200', bar <= index ? 'bg-accent' : 'bg-border-strong')}
          style={{ height: `${bar * 2 + 2}px` }}
        />
      ))}
    </span>
  )
}
