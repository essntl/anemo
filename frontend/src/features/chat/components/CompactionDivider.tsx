/**
 * Where a chat was compacted (docs/specs/24-chat-compaction.md): from here on the model
 * reads the summary instead of the messages above. The messages stay; the divider opens
 * to show the summary.
 */
import { ChevronDown, Shrink } from 'lucide-react'
import { useId, useState } from 'react'
import type { Schemas } from '@/api/client'
import { Markdown } from '@/components/ui/Markdown'
import { cn } from '@/lib/cn'
import { formatCount } from '@/lib/format'
import { t } from '@/lib/i18n'

type Message = Schemas['MessageOut']

export function CompactionDivider({ message }: { message: Message }) {
  const [open, setOpen] = useState(false)
  const panel = useId()
  const numbers = message.compaction
  let label: string
  if (message.status === 'streaming') label = t('Compacting the chat…')
  else if (message.status !== 'complete') label = t('The chat could not be compacted')
  else if (numbers?.tokens_before != null && numbers.tokens_after != null) {
    label = t('Compacted here ({before} → {after} tokens)', {
      before: formatCount(numbers.tokens_before),
      after: formatCount(numbers.tokens_after),
    })
  } else label = t('Compacted here')
  const canOpen = message.status === 'complete' && Boolean(message.text)
  return (
    <div role="separator" aria-label={label} className="flex flex-col items-center gap-2">
      <div className="flex w-full items-center gap-3 text-[12px] text-muted">
        <span className="h-px flex-1 bg-border" aria-hidden />
        <button type="button" disabled={!canOpen} aria-expanded={canOpen ? open : undefined}
          aria-controls={canOpen ? panel : undefined} onClick={() => setOpen((v) => !v)}
          className={cn('flex items-center gap-1.5 rounded-full px-2 py-0.5',
            canOpen && 'hover:bg-surface-2 hover:text-text focus-visible:bg-surface-2')}>
          <Shrink className="h-3.5 w-3.5" aria-hidden />
          <span>{label}</span>
          {canOpen && <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} aria-hidden />}
        </button>
        <span className="h-px flex-1 bg-border" aria-hidden />
      </div>
      {message.status !== 'complete' && message.status !== 'streaming' && message.error && (
        <p className="text-[12px] text-muted">{message.error}</p>
      )}
      {open && canOpen && (
        <div id={panel} className="w-full rounded-card border border-border bg-surface-2 px-4 py-3 text-[13px]">
          {numbers?.focus && <p className="mb-2 text-muted">{t('Kept in detail: {focus}', { focus: numbers.focus })}</p>}
          <Markdown text={message.text} />
        </div>
      )}
    </div>
  )
}
