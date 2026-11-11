import { Bot } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { formatWhen } from '@/lib/format'
import { t } from '@/lib/i18n'
import type { AgentEdit } from '../agentEdit'

/**
 * At the top of the panel beside a document whose latest version an agent wrote: says so,
 * and offers to look at the versions, keep it, or go back to the version before it.
 */
export function AgentEditNotice({ edit, onReview }: { edit: AgentEdit; onReview: () => void }) {
  return (
    <div role="status" className="m-2 mb-0 shrink-0 rounded-card border border-accent/25 bg-accent-soft p-2.5 text-[13px]">
      <div className="flex items-start gap-2 px-0.5">
        <Bot className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-snug">{t('An agent edited this document')}</div>
          <div className="text-[12px] text-muted">{formatWhen(edit.at)}</div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        <Button size="sm" variant="secondary" onClick={onReview}>{t('Review')}</Button>
        <Button size="sm" variant="ghost" onClick={edit.keep}>{t('Keep')}</Button>
        {edit.undo && <Button size="sm" variant="ghost" loading={edit.undoing} onClick={edit.undo}>{t('Undo')}</Button>}
      </div>
    </div>
  )
}
