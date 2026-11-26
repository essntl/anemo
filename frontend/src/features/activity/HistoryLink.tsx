import { Link } from 'react-router'
import { cn } from '@/lib/cn'
import { t } from '@/lib/i18n'
import { historyLink, type ObjectType } from './api'

/** "History": the Activity page filtered to this task, event or document. */
export function HistoryLink({ type, id, className }: { type: ObjectType; id: string; className?: string }) {
  return (
    <Link to={historyLink(type, id)} className={cn('text-[12px] text-muted underline-offset-2 hover:text-accent hover:underline', className)}
      title={t('What was changed in it, by whom, with Undo')}>
      {t('History')}
    </Link>
  )
}
