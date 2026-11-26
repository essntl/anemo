import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { lineDiff } from '@/lib/lineDiff'

/**
 * A text for review, line by line: with `before`, the lines that were removed (red, "−")
 * and added (green, "+") on the way to `after`; without it, `after` as it is. Used for a
 * script's change (Automations) and a plugin's update (Settings > Plugins).
 *
 *   <DiffView before={approved.code} after={pending.code} />
 */
export function DiffView({ before, after, label, className }: { before: string | null; after: string; label?: string; className?: string }) {
  const lines = before === null ? after.split('\n').map((text) => ({ kind: 'same' as const, text })) : lineDiff(before, after)
  return (
    <pre aria-label={label ?? t('Code')} className={cn('max-h-[50vh] overflow-auto rounded-control border border-border bg-surface-2 py-2 font-mono text-[12px] leading-relaxed', className)}>
      {lines.map((line, i) => (
        <div key={i} className={cn('whitespace-pre px-3',
          line.kind === 'added' && 'bg-success/12 text-success',
          line.kind === 'removed' && 'bg-error/12 text-error')}>
          <span aria-hidden className="mr-2 inline-block w-3 select-none text-subtle">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</span>
          {line.kind === 'removed' && <span className="sr-only">{t('removed:')} </span>}
          {line.kind === 'added' && <span className="sr-only">{t('added:')} </span>}
          {line.text || ' '}
        </div>
      ))}
    </pre>
  )
}
